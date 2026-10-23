import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { shareFile } from '../../platform/files';
import { createRecourse, supplierCauses } from '../recovery/recourse';
import { unfreezeDefault } from '../recovery/service';
import { issueCreditNote } from './credit-notes';
import { disputeTimers } from './service';
import { transition } from './state';

const OPEN = ['Open', 'UnderReview', 'Escalated'];

export const NON_SUPPLIER_CAUSES = ['buyer_error', 'goods_accepted', 'other'];
export async function allowedCauses(tx: Tx) { return [...(await supplierCauses(tx)), ...NON_SUPPLIER_CAUSES]; }

async function load(tx: Tx, id: string, lock = false) {
  const d = await tx.maybe<any>(`select * from invoicing.disputes where id = $1 ${lock ? 'for update' : ''}`, [id]);
  if (!d) throw notFound('Dispute');
  return d;
}

const involved = (d: any) => [d.supplier_org_id, d.buyer_org_id, ...(d.bank_org_id ? [d.bank_org_id] : [])];

async function say(tx: Tx, svc: Services, d: any, a: { orgId: string | null; name: string; userId?: string; kind: 'message' | 'evidence' | 'system'; body: string; fileId?: string | null }) {
  await tx.query(
    `insert into invoicing.dispute_messages (dispute_id, invoice_id, supplier_org_id, buyer_org_id, bank_org_id, author_org_id, author_name, author_user, kind, body, file_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [d.id, d.invoice_id, d.supplier_org_id, d.buyer_org_id, d.bank_org_id, a.orgId, a.name, a.userId ?? null, a.kind, a.body, a.fileId ?? null, svc.clock.now()]);
}

/** SH-05: parties exchange messages and evidence on the case; platform staff can join in. */
export async function addDisputeMessage(tx: Tx, svc: Services, ctx: Ctx, disputeId: string, myOrgId: string | null, a: { body: string; fileId?: string; kind: 'message' | 'evidence' }) {
  const d = await load(tx, disputeId);
  if (myOrgId && !involved(d).includes(myOrgId)) throw notFound('Dispute');
  if (!OPEN.includes(d.status)) throw conflict('closed', 'This dispute is resolved; the thread is read-only.');
  if (!a.body || a.body.trim().length < 1) throw invalid('Write a message.');
  if (a.kind === 'evidence' && !a.fileId) throw invalid('Attach the evidence file.');
  let name = 'Earlio';
  if (myOrgId) name = (await tx.one<{ legal_name: string }>('select legal_name from identity.organisations where id = $1', [myOrgId])).legal_name;
  if (a.fileId) {
    const f = await tx.maybe<any>('select id from platform.files where id = $1', [a.fileId]);
    if (!f) throw notFound('File');
    await shareFile(tx, a.fileId, involved(d).filter((o) => o !== myOrgId));
  }
  await say(tx, svc, d, { orgId: myOrgId, name, userId: ctx.userId, kind: a.kind, body: a.body.trim(), fileId: a.fileId });
  await emit(tx, svc.clock.now(), 'dispute.message', { disputeId, invoiceId: d.invoice_id, from: name }, involved(d).filter((o) => o !== myOrgId));
}

export async function startReview(tx: Tx, svc: Services, ctx: Ctx, disputeId: string) {
  const d = await load(tx, disputeId, true);
  if (!['Open', 'Escalated'].includes(d.status)) throw conflict('wrong_state', `This dispute is ${d.status}.`);
  await tx.query("update invoicing.disputes set status = 'UnderReview' where id = $1", [disputeId]);
  await say(tx, svc, d, { orgId: null, name: 'Earlio', userId: ctx.userId, kind: 'system', body: 'Earlio has started reviewing this dispute.' });
  await audit(tx, ctx, svc.clock.now(), { action: 'dispute.review_started', entityType: 'dispute', entityId: disputeId, orgId: d.supplier_org_id });
}

/** Release the invoice from its dispute freeze unless another freezing dispute is still open. */
async function release(tx: Tx, svc: Services, ctx: Ctx, d: any) {
  const others = await tx.query("select 1 as x from invoicing.disputes where invoice_id = $1 and freezes and id <> $2 and status in ('Open','UnderReview','Escalated')", [d.invoice_id, d.id]);
  if (others.length) return;
  const inv = await tx.one<any>('select * from invoicing.invoices where id = $1 for update', [d.invoice_id]);
  if (inv.status === 'Disputed') {
    await transition(tx, svc, ctx, inv, (d.frozen_status ?? inv.status_before_dispute ?? 'Accepted') as any, { note: 'Dispute resolved', event: 'invoice.dispute_resolved', set: { dispute_flag: false } });
  }
  await unfreezeDefault(tx, svc, d.invoice_id);
}

export interface DisputeDecision { outcome: 'buyer' | 'supplier'; cause?: string; creditAmount?: string; note: string }

/** ADM-04: the platform admin decides; the decision is applied to the financing (credit note, recourse, unfreeze). */
export async function decideDispute(tx: Tx, svc: Services, ctx: Ctx, disputeId: string, dec: DisputeDecision) {
  const d = await load(tx, disputeId, true);
  if (!OPEN.includes(d.status)) throw conflict('wrong_state', `This dispute is already ${d.status}.`);
  if (!dec.note || dec.note.trim().length < 3) throw invalid('Record the reasons for the decision.');
  const causes = await allowedCauses(tx);
  if (dec.cause && !causes.includes(dec.cause)) throw invalid(`The cause must be one of: ${causes.join(', ')}.`);
  if (dec.outcome === 'supplier' && (dec.creditAmount || (dec.cause && (await supplierCauses(tx)).includes(dec.cause)))) throw invalid('A decision for the supplier cannot carry a credit note or a supplier-caused cause.');
  const now = svc.clock.now();
  const status = dec.outcome === 'buyer' ? 'ResolvedForBuyer' : 'ResolvedForSupplier';
  await tx.query('update invoicing.disputes set status = $2, cause = $3, decision_note = $4, decided_by = $5, decided_at = $6, resolved_at = $6, credit_amount = $7, outcome = $8 where id = $1',
    [disputeId, status, dec.cause ?? null, dec.note.trim(), ctx.userId ?? null, now, dec.creditAmount ?? null, dec.outcome]);
  await release(tx, svc, ctx, d);
  let credit = null, recourse = null;
  if (dec.outcome === 'buyer') {
    if (dec.creditAmount) credit = await issueCreditNote(tx, svc, ctx, d.invoice_id, null, { amount: dec.creditAmount, reason: `Dispute decision: ${dec.note.trim()}`, disputeId });
    else if (d.phase === 'post_funding' && d.bank_org_id && dec.cause && (await supplierCauses(tx)).includes(dec.cause)) {
      // A-9: recourse only for supplier-caused disputes adjudicated by the platform admin. The bank's exposure on the disputed part is what comes back.
      const exp = await tx.elevated(() => tx.maybe<any>('select expected_amount, advance_amount from settlement.expectations where invoice_id = $1', [d.invoice_id]));
      const inv = await tx.one<any>('select human_id, currency, supplier_org_id from invoicing.invoices where id = $1', [d.invoice_id]);
      if (exp) {
        const share = d.amount ? D(d.amount).div(exp.expected_amount) : D(1);
        recourse = await createRecourse(tx, svc, ctx, { invoiceId: d.invoice_id, invoiceNumber: inv.human_id, supplierOrgId: inv.supplier_org_id, bankOrgId: d.bank_org_id, currency: inv.currency, amount: D(exp.advance_amount).times(share.gt(1) ? 1 : share).toDecimalPlaces(2).toFixed(2), cause: dec.cause, note: dec.note.trim() });
      }
    }
  }
  await say(tx, svc, d, { orgId: null, name: 'Earlio', userId: ctx.userId, kind: 'system', body: `Decision: ${dec.outcome === 'buyer' ? 'in favour of the buyer' : 'in favour of the supplier'}. ${dec.note.trim()}` });
  await audit(tx, ctx, now, { action: 'dispute.decided', entityType: 'dispute', entityId: disputeId, orgId: d.supplier_org_id, after: { outcome: dec.outcome, cause: dec.cause ?? null, credit: dec.creditAmount ?? null } });
  await audit(tx, ctx, now, { action: 'dispute.decided', entityType: 'dispute', entityId: disputeId, orgId: d.buyer_org_id });
  await emit(tx, now, 'dispute.resolved', { disputeId, invoiceId: d.invoice_id, outcome: dec.outcome, cause: dec.cause ?? null }, involved(d));
  return { status, creditNote: credit?.number ?? null, recourseId: recourse?.id ?? null };
}

/** The party that raised a dispute can withdraw it, which concedes the point. */
export async function withdrawDispute(tx: Tx, svc: Services, ctx: Ctx, disputeId: string, myOrgId: string) {
  const d = await load(tx, disputeId, true);
  if (d.raised_by_org !== myOrgId) throw forbidden('Only the party that raised the dispute can withdraw it.');
  if (!OPEN.includes(d.status)) throw conflict('wrong_state', `This dispute is already ${d.status}.`);
  const now = svc.clock.now();
  const conceded = d.raised_by_org === d.buyer_org_id ? 'ResolvedForSupplier' : 'ResolvedForBuyer';
  await tx.query("update invoicing.disputes set status = $2, outcome = 'withdrawn', resolved_at = $3, decided_at = $3 where id = $1", [disputeId, conceded, now]);
  await release(tx, svc, ctx, d);
  const who = await tx.one<{ legal_name: string }>('select legal_name from identity.organisations where id = $1', [myOrgId]);
  await say(tx, svc, d, { orgId: myOrgId, name: who.legal_name, userId: ctx.userId, kind: 'system', body: `${who.legal_name} withdrew the dispute.` });
  await audit(tx, ctx, now, { action: 'dispute.withdrawn', entityType: 'dispute', entityId: disputeId, orgId: d.supplier_org_id });
  await emit(tx, now, 'dispute.resolved', { disputeId, invoiceId: d.invoice_id, outcome: 'withdrawn' }, involved(d));
}

/** Worker: escalate quiet disputes to the platform queue, and time out the ones nobody decided (the freeze lifts; nothing is decided for anyone). */
export async function processDisputeTimers(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = svc.clock.now();
  let n = 0;
  const esc = await tx.query<any>("select * from invoicing.disputes where freezes and status = 'Open' and escalate_at <= $1 for update", [now]);
  for (const d of esc) {
    await tx.query("update invoicing.disputes set status = 'Escalated' where id = $1", [d.id]);
    await say(tx, svc, d, { orgId: null, name: 'Earlio', kind: 'system', body: 'No response within the response window, so this dispute was escalated to Earlio.' });
    await emit(tx, now, 'dispute.escalated', { disputeId: d.id, invoiceId: d.invoice_id }, involved(d));
    n++;
  }
  const dead = await tx.query<any>("select * from invoicing.disputes where freezes and status in ('Open','UnderReview','Escalated') and timeout_at <= $1 for update", [now]);
  for (const d of dead) {
    await tx.query("update invoicing.disputes set status = 'TimedOut', outcome = 'timed_out', resolved_at = $2 where id = $1", [d.id, now]);
    await release(tx, svc, ctx, d);
    await say(tx, svc, d, { orgId: null, name: 'Earlio', kind: 'system', body: 'The dispute timed out without a decision. The invoice is released from its freeze.' });
    await audit(tx, ctx, now, { action: 'dispute.timed_out', entityType: 'dispute', entityId: d.id, orgId: d.supplier_org_id });
    await emit(tx, now, 'dispute.resolved', { disputeId: d.id, invoiceId: d.invoice_id, outcome: 'timed_out' }, involved(d));
    n++;
  }
  return n;
}

export async function saveTimers(tx: Tx, svc: Services, ctx: Ctx, t: { responseHours: number; escalateAfterHours: number; timeoutAfterHours: number }) {
  if (!(t.responseHours > 0 && t.escalateAfterHours >= t.responseHours && t.timeoutAfterHours > t.escalateAfterHours)) throw invalid('Timers must satisfy: response ≤ escalation < timeout.');
  await tx.query(`insert into platform.settings (key, value, updated_at) values ('dispute_timers', $1, $2) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify(t), svc.clock.now()]);
  await audit(tx, ctx, svc.clock.now(), { action: 'dispute.timers_set', entityType: 'settings', entityId: 'dispute_timers', after: t });
  return disputeTimers(tx);
}
