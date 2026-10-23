import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { conflict, invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { recourseOffset, recoursePlan } from './waterfall';

/** Causes the platform admin can attribute a dispute to the supplier (A-9). Configurable in platform.settings `recourse_causes`. */
export const DEFAULT_SUPPLIER_CAUSES = ['non_delivery', 'quality_failure', 'wrong_documents', 'misrepresentation'];
export async function supplierCauses(tx: Tx): Promise<string[]> {
  const s = await tx.elevated(() => tx.maybe<{ value: any }>("select value from platform.settings where key = 'recourse_causes'"));
  return Array.isArray(s?.value) ? s!.value : DEFAULT_SUPPLIER_CAUSES;
}

/** Records what a supplier owes its bank. Small suppliers repay by 20% offsets or a 90-day plan, with no penalty interest (BR-11.6). */
export async function createRecourse(tx: Tx, svc: Services, ctx: Ctx, a: { invoiceId: string; invoiceNumber: string; supplierOrgId: string; bankOrgId: string; currency: string; amount: string; cause: string; note?: string }) {
  if (D(a.amount).lte(0)) return null;
  const now = svc.clock.now();
  const sup = await tx.elevated(() => tx.one<any>('select small, legal_name from identity.organisations where id = $1', [a.supplierOrgId]));
  const row = await tx.elevated(() => tx.one<any>(
    `insert into recovery.recourse (invoice_id, invoice_number, supplier_org_id, bank_org_id, currency, cause, amount_owed, outstanding, small_supplier, mode, note, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$11) returning *`,
    [a.invoiceId, a.invoiceNumber, a.supplierOrgId, a.bankOrgId, a.currency, a.cause, a.amount, sup.small, sup.small ? 'offset_20pct' : 'bank_terms', a.note ?? null, now]));
  await audit(tx, ctx, now, { action: 'recourse.created', entityType: 'recourse', entityId: row.id, orgId: a.supplierOrgId, after: { amount: a.amount, cause: a.cause } });
  await audit(tx, ctx, now, { action: 'recourse.created', entityType: 'recourse', entityId: row.id, orgId: a.bankOrgId });
  await emit(tx, now, 'recourse.created', { recourseId: row.id, invoiceId: a.invoiceId, humanId: a.invoiceNumber, amount: a.amount, currency: a.currency, cause: a.cause, small: sup.small }, [a.supplierOrgId, a.bankOrgId]);
  return row;
}

async function payment(tx: Tx, svc: Services, r: any, amount: string, source: 'offset' | 'installment' | 'manual', note?: string) {
  const now = svc.clock.now();
  const left = D(r.outstanding).minus(amount);
  await tx.query('insert into recovery.recourse_payments (recourse_id, supplier_org_id, bank_org_id, amount, source, note, at) values ($1,$2,$3,$4,$5,$6,$7)', [r.id, r.supplier_org_id, r.bank_org_id, amount, source, note ?? null, now]);
  await tx.query('update recovery.recourse set outstanding = $2, status = $3, updated_at = $4 where id = $1', [r.id, left.toFixed(2), left.lte(0) ? 'settled' : 'open', now]);
  await tx.query(
    `insert into settlement.ledger_entries (invoice_id, invoice_number, bank_org_id, supplier_org_id, kind, party, currency, amount, note, at) values ($1,$2,$3,$4,'recourse_repayment','supplier',$5,$6,$7,$8)`,
    [r.invoice_id, r.invoice_number, r.bank_org_id, r.supplier_org_id, r.currency, amount, note ?? `Recourse repaid (${source})`, now]);
}

/**
 * A payout to a small supplier in `currency` first repays recourse by offset: at most 20% of the payout per recourse and never more than is owed.
 * Returns the amount withheld. Suppliers on a 90-day plan and non-small suppliers are not offset automatically.
 */
export async function applyRecourseOffset(tx: Tx, svc: Services, supplierOrgId: string, currency: string, payout: string): Promise<string> {
  const rows = await tx.elevated(() => tx.query<any>("select * from recovery.recourse where supplier_org_id = $1 and currency = $2 and status = 'open' and mode = 'offset_20pct' order by created_at for update", [supplierOrgId, currency]));
  const totalCap = D(recourseOffset(payout, payout)); // 20% of the payout in total, however many recourses are open
  let withheld = D(0);
  for (const r of rows) {
    const room = totalCap.minus(withheld);
    const o = D(recourseOffset(r.outstanding, payout));
    const take = o.gt(room) ? room : o;
    if (take.lte(0)) break;
    await tx.elevated(() => payment(tx, svc, r, take.toFixed(2), 'offset', `Offset against a payout of ${payout} ${currency}`));
    withheld = withheld.plus(take);
  }
  return withheld.toFixed(2);
}

/** When the buyer finally pays an invoice, recourse raised for that invoice's default is repaid from the bank's principal received. */
export async function settleRecourseForInvoice(tx: Tx, svc: Services, invoiceId: string) {
  const rows = await tx.elevated(() => tx.query<any>("select * from recovery.recourse where invoice_id = $1 and status = 'open' and cause <> 'credit_note' for update", [invoiceId]));
  for (const r of rows) await tx.elevated(() => payment(tx, svc, r, D(r.outstanding).toFixed(2), 'manual', 'Cleared: the buyer paid the invoice'));
}

export async function setRecourseMode(tx: Tx, svc: Services, ctx: Ctx, supplierOrgId: string, id: string, mode: 'offset_20pct' | 'plan_90d') {
  const r = await tx.maybe<any>('select * from recovery.recourse where id = $1 and supplier_org_id = $2 for update', [id, supplierOrgId]);
  if (!r) throw notFound('Recourse');
  if (!r.small_supplier) throw conflict('not_small', 'The repayment options are for small suppliers; your bank’s terms apply to this recourse.');
  if (r.status !== 'open') throw conflict('settled', 'This recourse is already settled.');
  const now = svc.clock.now();
  const plan = mode === 'plan_90d' ? recoursePlan(r.outstanding, now).map((p) => ({ ...p, paid: false })) : null;
  await tx.query('update recovery.recourse set mode = $2, plan = $3, updated_at = $4 where id = $1', [id, mode, plan ? JSON.stringify(plan) : null, now]);
  await audit(tx, ctx, now, { action: 'recourse.mode_set', entityType: 'recourse', entityId: id, orgId: supplierOrgId, after: { mode } });
  return { mode, plan };
}

/** The bank records a repayment received outside the platform (bank terms, or a plan instalment). */
export async function recordRecoursePayment(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, id: string, amount: string, note?: string) {
  const r = await tx.maybe<any>('select * from recovery.recourse where id = $1 and bank_org_id = $2 for update', [id, bankOrgId]);
  if (!r) throw notFound('Recourse');
  if (D(amount).lte(0) || D(amount).gt(r.outstanding)) throw invalid(`The amount must be between 0.01 and the ${r.outstanding} still owed.`);
  await payment(tx, svc, r, D(amount).toFixed(2), r.mode === 'plan_90d' ? 'installment' : 'manual', note);
  if (r.mode === 'plan_90d' && r.plan) {
    let left = D(amount);
    const plan = (r.plan as any[]).map((p) => { if (!p.paid && left.gte(p.amount)) { left = left.minus(p.amount); return { ...p, paid: true }; } return p; });
    await tx.query('update recovery.recourse set plan = $2 where id = $1', [id, JSON.stringify(plan)]);
  }
  await audit(tx, ctx, svc.clock.now(), { action: 'recourse.payment', entityType: 'recourse', entityId: id, orgId: bankOrgId, after: { amount } });
}

/** Worker: remind suppliers of plan instalments that have fallen due (no penalty interest is ever charged). */
export async function remindInstallments(tx: Tx, svc: Services): Promise<number> {
  const now = svc.clock.now(); const today = now.toISOString().slice(0, 10);
  const rows = await tx.query<any>("select * from recovery.recourse where status = 'open' and mode = 'plan_90d' and plan is not null");
  let n = 0;
  for (const r of rows) {
    const due = (r.plan as any[]).find((p) => !p.paid && p.dueOn <= today && !p.reminded);
    if (!due) continue;
    due.reminded = true;
    await tx.query('update recovery.recourse set plan = $2 where id = $1', [r.id, JSON.stringify(r.plan)]);
    await emit(tx, now, 'recourse.installment_due', { recourseId: r.id, humanId: r.invoice_number, amount: due.amount, currency: r.currency, dueOn: due.dueOn }, [r.supplier_org_id, r.bank_org_id]);
    n++;
  }
  return n;
}
