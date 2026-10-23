import { createHash } from 'node:crypto';
import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, invalid, notFound } from '../../kernel/errors';
import { D, round2 } from '../../kernel/money';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { transition } from '../invoicing/state';
import { releaseUsed } from '../identity/limits';
import { releaseCover } from '../insurance/service';
import { bankRate } from '../pricing/fx';
import { acceptMismatch, raiseException } from './disbursement';

const ref = (humanId: string, invoiceId: string) => `EARL-${humanId}-${createHash('sha256').update(invoiceId).digest('hex').slice(0, 4).toUpperCase()}`;
const now_ = (svc: Services) => svc.clock.now();

async function ledger(tx: Tx, svc: Services, e: { invoiceId: string; invoiceNumber: string; bankOrgId?: string | null; supplierOrgId?: string | null; buyerOrgId?: string | null; kind: string; party: string; currency: string; amount: string; amountInr?: string | null; fxRate?: string | null; note?: string }) {
  await tx.query(
    `insert into settlement.ledger_entries (invoice_id, invoice_number, bank_org_id, supplier_org_id, buyer_org_id, kind, party, currency, amount, amount_inr, fx_rate, note, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [e.invoiceId, e.invoiceNumber, e.bankOrgId ?? null, e.supplierOrgId ?? null, e.buyerOrgId ?? null, e.kind, e.party, e.currency, e.amount, e.amountInr ?? null, e.fxRate ?? null, e.note ?? null, now_(svc)]);
}

async function collectionAccount(tx: Tx, bankOrgId: string, currency: string) {
  const bank = await tx.one<any>('select legal_name from identity.organisations where id = $1', [bankOrgId]);
  const digits = createHash('sha256').update(bankOrgId + currency).digest('hex').replace(/[a-f]/g, '').slice(0, 12).padEnd(12, '7');
  return tx.one<any>(
    `insert into settlement.collection_accounts (bank_org_id, currency, account_number, account_name, swift) values ($1,$2,$3,$4,$5)
     on conflict (bank_org_id, currency) do update set account_name = excluded.account_name returning *`,
    [bankOrgId, currency, `SIM${digits}`, `${bank.legal_name} Collections ${currency}`, `SIM${bankOrgId.slice(0, 5).toUpperCase().replace(/-/g, 'X')}`]);
}

/** On `financing.funded`: one unique payment reference per invoice, issued to the buyer and its bank (ST-2). */
export async function createExpectation(tx: Tx, svc: Services, ctx: Ctx, frId: string) {
  const prior = await tx.maybe<any>('select e.* from settlement.expectations e join marketplace.financing_requests f on f.invoice_id = e.invoice_id where f.id = $1', [frId]);
  if (prior) return prior;
  const fr = await tx.one<any>('select * from marketplace.financing_requests where id = $1', [frId]);
  const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [fr.invoice_id]);
  const offer = await tx.one<any>('select * from marketplace.offers where id = $1', [fr.offer_id]);
  const acct = await collectionAccount(tx, fr.bank_org_id, inv.currency);
  const b = (offer.quote as any).breakdown;
  const now = now_(svc);
  const face = inv.accepted_amount ?? inv.gross_amount;
  const row = await tx.one<any>(
    `insert into settlement.expectations (invoice_id, invoice_number, reference, bank_org_id, supplier_org_id, buyer_org_id, collection_account_id, currency, expected_amount, advance_amount, retention_amount, fx_spread_pct, platform_fee_note, due_date, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) returning *`,
    [inv.id, inv.human_id, ref(inv.human_id, inv.id), fr.bank_org_id, fr.supplier_org_id, fr.buyer_org_id, acct.id, inv.currency, face, b.advance, b.retention, offer.fx_spread_pct, b.platformFee, inv.due_date, now]);
  await audit(tx, ctx, now, { action: 'settlement.expectation_created', entityType: 'invoice', entityId: inv.id, orgId: fr.buyer_org_id, after: { reference: row.reference } });
  await emit(tx, now, 'settlement.payment_due', { invoiceId: inv.id, humanId: inv.human_id, reference: row.reference, dueDate: String(inv.due_date).slice(0, 10), amount: face, currency: inv.currency }, [fr.buyer_org_id, fr.bank_org_id, fr.supplier_org_id]);
  return row;
}

export interface BankTxnIn { source: 'callback' | 'statement'; bankTxnId: string; reference: string | null; currency: string; amount: string; valueDate: string; payer?: string | null }

/** A payment (or statement line) arrives: store it once, match it by reference and amount, and distribute when it matches. */
export async function ingestBankTransaction(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, t: BankTxnIn): Promise<{ duplicate: boolean; outcome: string }> {
  const now = now_(svc);
  const ins = await tx.query<any>(
    `insert into settlement.bank_transactions (bank_org_id, source, bank_txn_id, reference, currency, amount, value_date, payer, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (bank_org_id, source, bank_txn_id) do nothing returning *`, [bankOrgId, t.source, t.bankTxnId, t.reference?.trim().toUpperCase() ?? null, t.currency, t.amount, t.valueDate, t.payer ?? null, now]);
  if (!ins.length) return { duplicate: true, outcome: 'duplicate' };
  const row = ins[0];
  const exp = row.reference ? await tx.maybe<any>('select * from settlement.expectations where upper(reference) = $1 and bank_org_id = $2 for update', [row.reference, bankOrgId]) : undefined;
  if (t.source === 'statement') {
    const cb = await tx.maybe<any>("select 1 as x from settlement.bank_transactions where bank_org_id = $1 and source = 'callback' and bank_txn_id = $2", [bankOrgId, t.bankTxnId]);
    if (cb || (exp && ['Distributed', 'Reconciled'].includes(exp.status))) {
      await tx.query("update settlement.bank_transactions set expectation_id = $2, match_status = $3 where id = $1", [row.id, exp?.id ?? null, exp ? 'matched' : 'unmatched']);
      return { duplicate: false, outcome: 'statement_linked' };
    }
  }
  if (!exp) {
    await tx.query("update settlement.bank_transactions set match_status = 'exception' where id = $1", [row.id]);
    await raiseException(tx, svc, { type: 'Unmatched', bankOrgId, bankTxnId: row.id, amount: t.amount, currency: t.currency, detail: `A payment of ${t.currency} ${t.amount}${t.payer ? ` from ${t.payer}` : ''} carries ${row.reference ? `the unknown reference ${row.reference}` : 'no payment reference'}.` });
    return { duplicate: false, outcome: 'unmatched' };
  }
  await tx.query("update settlement.bank_transactions set expectation_id = $2, match_status = 'matched' where id = $1", [row.id, exp.id]);
  return { duplicate: false, outcome: await applyPayment(tx, svc, ctx, exp, row) };
}

async function applyPayment(tx: Tx, svc: Services, ctx: Ctx, exp: any, txn: any): Promise<string> {
  const now = now_(svc);
  if (txn.currency !== exp.currency) {
    await raiseException(tx, svc, { type: 'AmountMismatch', bankOrgId: exp.bank_org_id, invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, expectationId: exp.id, bankTxnId: txn.id, amount: txn.amount, currency: txn.currency,
      detail: `The payment is in ${txn.currency} but ${exp.currency} was expected.` });
    return 'currency_mismatch';
  }
  if (['Distributed', 'Reconciled'].includes(exp.status)) {
    await raiseException(tx, svc, { type: 'OverPaid', bankOrgId: exp.bank_org_id, invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, expectationId: exp.id, bankTxnId: txn.id, amount: txn.amount, currency: txn.currency,
      detail: `${exp.invoice_number} is already settled; this payment of ${txn.currency} ${txn.amount} is an overpayment to refund.` });
    return 'already_settled';
  }
  const total = D(exp.received_amount).plus(txn.amount);
  const expected = D(exp.expected_amount);
  const late = String(txn.value_date).slice(0, 10) > String(exp.due_date).slice(0, 10);
  await tx.query('update settlement.expectations set received_amount = $2, received_at = $3, late = $4, updated_at = $3, status = $5 where id = $1',
    [exp.id, total.toFixed(2), now, late, total.gte(expected) ? 'Received' : 'PartiallyReceived']);
  await ledger(tx, svc, { invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, bankOrgId: exp.bank_org_id, supplierOrgId: exp.supplier_org_id, buyerOrgId: exp.buyer_org_id, kind: 'payment_received', party: 'buyer', currency: exp.currency, amount: txn.amount, note: `Received into the collection account (${txn.bank_txn_id})` });
  if (total.lt(expected)) {
    await raiseException(tx, svc, { type: 'ShortPaid', bankOrgId: exp.bank_org_id, invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, expectationId: exp.id, bankTxnId: txn.id, amount: expected.minus(total).toFixed(2), currency: exp.currency,
      detail: `${exp.currency} ${total.toFixed(2)} received against ${expected.toFixed(2)} expected; ${expected.minus(total).toFixed(2)} is outstanding.` });
    await emit(tx, now, 'settlement.short_paid', { invoiceId: exp.invoice_id, humanId: exp.invoice_number, shortBy: expected.minus(total).toFixed(2) }, [exp.bank_org_id, exp.buyer_org_id, exp.supplier_org_id]);
    return 'short_paid';
  }
  if (total.gt(expected)) {
    await raiseException(tx, svc, { type: 'OverPaid', bankOrgId: exp.bank_org_id, invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, expectationId: exp.id, bankTxnId: txn.id, amount: total.minus(expected).toFixed(2), currency: exp.currency,
      detail: `${total.minus(expected).toFixed(2)} was paid over the amount due and should be refunded to the buyer.` });
  }
  if (late) {
    await raiseException(tx, svc, { type: 'Late', bankOrgId: exp.bank_org_id, invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, expectationId: exp.id, bankTxnId: txn.id, detail: `Payment arrived on ${String(txn.value_date).slice(0, 10)}, after the due date ${String(exp.due_date).slice(0, 10)}.` });
  }
  await tx.query("update settlement.expectations set status = 'Matched', updated_at = $2 where id = $1", [exp.id, now]);
  await distribute(tx, svc, ctx, exp.id, expected.toFixed(2));
  return total.gt(expected) ? 'over_paid' : late ? 'late' : 'matched';
}

/** Distribution lines (ST-3): principal to the bank, retention released to the supplier at the settlement FX rate, platform fee noted. */
async function distribute(tx: Tx, svc: Services, ctx: Ctx, expId: string, available: string) {
  const exp = await tx.one<any>('select * from settlement.expectations where id = $1 for update', [expId]);
  const now = now_(svc);
  const fr = await tx.one<any>("select * from marketplace.financing_requests where invoice_id = $1 and status = 'Funded'", [exp.invoice_id]);
  const avail = D(available);
  const toBank = D(exp.advance_amount).gt(avail) ? avail : D(exp.advance_amount);
  const toSupplier = avail.minus(toBank);
  const pair = exp.currency === 'USD' ? 'USDINR' : 'SGDINR';
  const rate = bankRate(await svc.adapters.fx.mid(pair, now), exp.fx_spread_pct);
  const common = { invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, bankOrgId: exp.bank_org_id, supplierOrgId: exp.supplier_org_id, buyerOrgId: exp.buyer_org_id, currency: exp.currency };
  await ledger(tx, svc, { ...common, kind: 'bank_principal', party: 'bank', amount: toBank.toFixed(2), note: 'Principal advanced, returned to the funding bank' });
  if (toSupplier.gt(0)) await ledger(tx, svc, { ...common, kind: 'retention_release', party: 'supplier', amount: toSupplier.toFixed(2), amountInr: round2(toSupplier.times(rate)).toFixed(2), fxRate: rate.toFixed(4), note: `Retention released, converted at settlement FX ${rate.toFixed(4)}` });
  if (D(exp.platform_fee_note).gt(0)) await ledger(tx, svc, { ...common, kind: 'platform_fee_note', party: 'platform', amount: D(exp.platform_fee_note).toFixed(2), note: 'Platform fee noted (paid by the bank under its terms)' });
  if (toBank.lt(exp.advance_amount)) await ledger(tx, svc, { ...common, kind: 'shortfall', party: 'bank', amount: D(exp.advance_amount).minus(toBank).toFixed(2), note: 'Shortfall against the advance (see exceptions)' });
  await tx.query("update settlement.expectations set status = 'Distributed', updated_at = $2 where id = $1", [exp.id, now]);
  // Settlement frees the lien, the bank's limits and the insurer's used limit.
  await tx.query("update marketplace.liens set status = 'Released', released_at = $2, release_reason = 'Settled' where invoice_id = $1 and status = 'Active'", [exp.invoice_id, now]);
  await tx.query("insert into marketplace.lien_events (invoice_id, invoice_number, event, bank_org_id, detail, at) values ($1,$2,'released_settled',$3,'Invoice settled',$4)", [exp.invoice_id, exp.invoice_number, exp.bank_org_id, now]);
  await releaseUsed(tx, svc, { bankOrgId: exp.bank_org_id, buyerOrgId: exp.buyer_org_id, supplierOrgId: exp.supplier_org_id, amountUsd: fr.reserved_usd });
  await releaseCover(tx, svc, exp.invoice_id);
  let inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [exp.invoice_id]);
  if (inv.status === 'Funded' && exp.late) { await transition(tx, svc, ctx, inv, 'Overdue', { note: 'Paid after the due date', event: 'invoice.overdue' }); inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [exp.invoice_id]); }
  if (['Funded', 'Overdue', 'Disputed'].includes(inv.status)) await transition(tx, svc, ctx, inv, 'Settled', { note: 'Buyer payment received and distributed', event: 'invoice.settled' });
  await audit(tx, ctx, now, { action: 'settlement.distributed', entityType: 'invoice', entityId: exp.invoice_id, orgId: exp.bank_org_id, after: { toBank: toBank.toFixed(2), toSupplier: toSupplier.toFixed(2) } });
  await audit(tx, ctx, now, { action: 'settlement.distributed', entityType: 'invoice', entityId: exp.invoice_id, orgId: exp.supplier_org_id });
  await emit(tx, now, 'settlement.distributed', { invoiceId: exp.invoice_id, humanId: exp.invoice_number, toBank: toBank.toFixed(2), retention: toSupplier.toFixed(2), currency: exp.currency }, [exp.bank_org_id, exp.supplier_org_id, exp.buyer_org_id]);
}

/** Worker: pull each bank's statement for today from the simulated bank feed (ST-4). Callback and statement lines reconcile against each other. */
export async function fetchStatements(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const today = now_(svc).toISOString().slice(0, 10);
  const lines = await tx.query<any>('select * from settlement.sim_bank_feed where value_date <= $1 order by id', [today]);
  let n = 0;
  for (const l of lines) {
    const r = await ingestBankTransaction(tx, svc, ctx, l.bank_org_id, { source: 'statement', bankTxnId: l.bank_txn_id, reference: l.reference, currency: l.currency, amount: l.amount, valueDate: String(l.value_date).slice(0, 10), payer: l.payer });
    if (!r.duplicate) n++;
  }
  return n;
}

/** Reconciled = a statement line backs every distributed payment. The invoice then moves from Settled to Closed. */
export async function reconcile(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const rows = await tx.query<any>(
    `select e.* from settlement.expectations e where e.status = 'Distributed'
       and (select coalesce(sum(t.amount),0) from settlement.bank_transactions t where t.expectation_id = e.id and t.source = 'statement') >= e.received_amount`);
  const now = now_(svc);
  for (const e of rows) {
    await tx.query("update settlement.expectations set status = 'Reconciled', updated_at = $2 where id = $1", [e.id, now]);
    const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [e.invoice_id]);
    if (inv.status === 'Settled') await transition(tx, svc, ctx, inv, 'Closed', { note: 'Statement and ledger agree', event: 'invoice.closed' });
    await audit(tx, ctx, now, { action: 'settlement.reconciled', entityType: 'invoice', entityId: e.invoice_id, orgId: e.bank_org_id });
    await emit(tx, now, 'settlement.reconciled', { invoiceId: e.invoice_id, humanId: e.invoice_number }, [e.bank_org_id, e.supplier_org_id]);
  }
  return rows.length;
}

/** Worker: a funded invoice still unpaid after its due date is Overdue (dunning and claims continue in M8). */
export async function markOverdue(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const today = now_(svc).toISOString().slice(0, 10);
  const rows = await tx.query<any>("select * from invoicing.invoices where status = 'Funded' and route = 'financing' and due_date < $1", [today]);
  for (const inv of rows) await transition(tx, svc, ctx, inv, 'Overdue', { note: `Not paid by the due date ${String(inv.due_date).slice(0, 10)}`, event: 'invoice.overdue' });
  return rows.length;
}

/** Early-payment settlement: the supplier is credited and the bank's commission is booked, then the invoice closes. */
export async function settleEarlyPayments(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = now_(svc);
  const rows = await tx.query<any>("select p.*, i.human_id, i.currency from marketplace.early_payments p join invoicing.invoices i on i.id = p.invoice_id where p.settled_at is null and p.executed_at <= $1", [new Date(now.getTime() - 3_600_000)]);
  for (const p of rows) {
    const common = { invoiceId: p.invoice_id, invoiceNumber: p.human_id, supplierOrgId: p.supplier_org_id, buyerOrgId: p.buyer_org_id, currency: p.currency };
    await ledger(tx, svc, { ...common, kind: 'early_payment', party: 'buyer', amount: p.buyer_pays, note: `Paid ${p.days_early} days early (${p.funding_source === 'cash' ? 'cash' : 'bank loan'})` });
    await ledger(tx, svc, { ...common, kind: 'supplier_credit', party: 'supplier', amount: p.buyer_pays, note: 'Credited to the supplier' });
    if (D(p.commission).gt(0)) await ledger(tx, svc, { ...common, bankOrgId: p.buyer_bank_org_id, kind: 'commission', party: 'bank', amount: p.commission, note: 'Share of the discount booked to the buyer’s bank' });
    await tx.query('update marketplace.early_payments set settled_at = $2 where id = $1', [p.id, now]);
    let inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [p.invoice_id]);
    if (inv.status === 'Funded') { await transition(tx, svc, ctx, inv, 'Settled', { note: 'Early payment credited to the supplier', event: 'invoice.settled' }); inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [p.invoice_id]); }
    if (inv.status === 'Settled') await transition(tx, svc, ctx, inv, 'Closed', { note: 'Early payment complete', event: 'invoice.closed' });
  }
  return rows.length;
}

// ---------------------------------------------------------------- exceptions (operations queue)
export type ResolveAction = 'assign' | 'wait' | 'accept_short' | 'refund' | 'acknowledge' | 'accept_credit';
const ALLOWED: Record<string, ResolveAction[]> = {
  Unmatched: ['assign'], ShortPaid: ['wait', 'accept_short'], OverPaid: ['refund'], Late: ['acknowledge'],
  AmountMismatch: ['accept_credit', 'acknowledge'], DisbursementFailed: ['acknowledge'], DisbursementReturned: ['acknowledge'],
};

export async function resolveException(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string | null, id: string, action: ResolveAction, input: { note?: string; invoiceNumber?: string } = {}) {
  const e = await tx.maybe<any>('select * from settlement.exceptions where id = $1 for update', [id]);
  if (!e || (bankOrgId && e.bank_org_id !== bankOrgId)) throw notFound('Exception');
  if (e.status !== 'open') throw conflict('already_resolved', 'This exception is already resolved.');
  if (!ALLOWED[e.type]?.includes(action)) throw invalid(`A ${e.type} exception can be resolved with: ${ALLOWED[e.type]?.join(', ')}.`);
  const now = now_(svc);
  let resolution: string = action;
  if (action === 'assign') {
    if (!input.invoiceNumber) throw invalid('Say which invoice this payment belongs to.');
    const exp = await tx.maybe<any>('select * from settlement.expectations where invoice_number = $1 and bank_org_id = $2 for update', [input.invoiceNumber.trim().toUpperCase(), e.bank_org_id]);
    if (!exp) throw new DomainError('no_such_invoice', `No open collection for ${input.invoiceNumber} at this bank.`, 404);
    const txn = await tx.one<any>('select * from settlement.bank_transactions where id = $1', [e.bank_txn_id]);
    await tx.query("update settlement.bank_transactions set expectation_id = $2, match_status = 'matched' where id = $1", [txn.id, exp.id]);
    await tx.elevated(() => applyPayment(tx, svc, ctx, exp, txn)); // acts on the invoice, which the bank cannot update directly
    resolution = `assigned to ${exp.invoice_number}`;
  } else if (action === 'accept_short') {
    const exp = await tx.one<any>('select * from settlement.expectations where id = $1 for update', [e.expectation_id]);
    await tx.elevated(() => distribute(tx, svc, ctx, exp.id, exp.received_amount));
    resolution = `accepted ${exp.received_amount} as full settlement; shortfall ${D(exp.expected_amount).minus(exp.received_amount).toFixed(2)} flagged`;
  } else if (action === 'refund') {
    const exp = await tx.one<any>('select * from settlement.expectations where id = $1', [e.expectation_id]);
    await ledger(tx, svc, { invoiceId: exp.invoice_id, invoiceNumber: exp.invoice_number, bankOrgId: exp.bank_org_id, buyerOrgId: exp.buyer_org_id, kind: 'refund_to_buyer', party: 'buyer', currency: e.currency, amount: e.amount, note: 'Overpayment refunded' });
    resolution = `refunded ${e.amount} to the buyer`;
  } else if (action === 'accept_credit') {
    await acceptMismatch(tx, svc, ctx, e.disbursement_id);
    resolution = 'accepted the credited amount';
  }
  await tx.query("update settlement.exceptions set status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = $4 where id = $1", [e.id, input.note ? `${resolution} — ${input.note}` : resolution, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'settlement.exception_resolved', entityType: 'exception', entityId: e.id, orgId: e.bank_org_id, after: { type: e.type, resolution } });
  return { resolution };
}
