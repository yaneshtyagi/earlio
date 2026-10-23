import { validateAnswers } from '../governance/requirements';
import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { shareFile } from '../../platform/files';
import { transition } from '../invoicing/state';
import { resolveTerms } from '../terms/service';
import { releaseUsed } from '../identity/limits';
import { createRecourse, supplierCauses } from './recourse';
import { lateInterest, payoutWaterfall, shareRecovery } from './waterfall';

const DAY = 86_400_000;
const dateOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => dateOf(new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY));
const daysBetween = (fromIso: string, toIso: string) => Math.round((new Date(toIso + 'T00:00:00Z').getTime() - new Date(fromIso + 'T00:00:00Z').getTime()) / DAY);
const sys = (svc: Services, id: string): Ctx => ({ platform: true, correlationId: id });

export async function dunningDays(tx: Tx): Promise<number[]> {
  const s = await tx.elevated(() => tx.maybe<{ value: any }>("select value from platform.settings where key = 'dunning_days'"));
  return Array.isArray(s?.value) && s!.value.length ? s!.value : [1, 7, 30];
}

// ---------------------------------------------------------------- overdue → default
/** `invoice.overdue` for a financed invoice: start the default clock using the insurer's waiting period (XB-7). */
export async function openDefault(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  const prior = await tx.maybe<any>('select id from recovery.defaults where invoice_id = $1', [invoiceId]);
  if (prior) return;
  const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [invoiceId]);
  if (inv.route !== 'financing') return; // early-payment invoices are not financed: nothing to claim
  const fr = await tx.maybe<any>("select * from marketplace.financing_requests where invoice_id = $1 and status = 'Funded'", [invoiceId]);
  const exp = await tx.maybe<any>('select * from settlement.expectations where invoice_id = $1', [invoiceId]);
  if (!fr || !exp) return;
  const offer = await tx.one<any>('select rate_pct from marketplace.offers where id = $1', [fr.offer_id]);
  const cover = await tx.maybe<any>('select insurer_org_id from insurance.cover_records where invoice_id = $1', [invoiceId]);
  let waiting = 90;
  if (cover?.insurer_org_id) waiting = (await resolveTerms(tx, svc.clock.now(), 'insurer', cover.insurer_org_id, {})).terms.waitingPeriodDays.protractedDefault;
  const now = svc.clock.now();
  const due = String(inv.due_date).slice(0, 10);
  await tx.query(
    `insert into recovery.defaults (invoice_id, invoice_number, supplier_org_id, buyer_org_id, bank_org_id, insurer_org_id, currency, principal, financing_rate_pct, due_date, overdue_since, status, waiting_days, waiting_ends_on, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'Overdue',$11,$12,$13,$13)`,
    [inv.id, inv.human_id, inv.supplier_org_id, inv.buyer_org_id, fr.bank_org_id, cover?.insurer_org_id ?? null, inv.currency, exp.advance_amount, offer.rate_pct, due, waiting, addDays(due, waiting), now]);
  await audit(tx, ctx, now, { action: 'default.opened', entityType: 'invoice', entityId: inv.id, orgId: fr.bank_org_id, after: { waitingDays: waiting } });
}

/** Frozen days: while a dispute is open, interest, dunning and the waiting period stand still. */
export function frozenDays(d: { frozen_days: string; frozen_since: Date | null }, now: Date): number {
  return Number(d.frozen_days) + (d.frozen_since ? (now.getTime() - new Date(d.frozen_since).getTime()) / DAY : 0);
}

export function defaultView(d: any, now: Date) {
  const today = dateOf(now);
  const frozen = frozenDays(d, now);
  const overdueDays = Math.max(0, daysBetween(String(d.due_date).slice(0, 10), today));
  const effective = Math.max(0, Math.floor(overdueDays - frozen));
  return {
    overdueDays, frozenDays: Math.floor(frozen), interestDays: effective, lateInterest: lateInterest(d.principal, d.financing_rate_pct, effective),
    waitingEndsOn: addDays(String(d.waiting_ends_on).slice(0, 10), Math.ceil(frozen)),
  };
}

/** Late interest owed by the buyer as of now (used when the payment finally arrives). */
export async function accruedInterest(tx: Tx, svc: Services, invoiceId: string, asOf?: Date): Promise<string> {
  const d = await tx.elevated(() => tx.maybe<any>('select * from recovery.defaults where invoice_id = $1', [invoiceId]));
  if (!d) return '0.00';
  return defaultView(d, asOf ?? svc.clock.now()).lateInterest;
}

/** A default is resolved when the buyer pays after all. */
export async function markRecovered(tx: Tx, svc: Services, invoiceId: string) {
  await tx.elevated(() => tx.query("update recovery.defaults set status = 'Recovered', updated_at = $2 where invoice_id = $1 and status in ('Overdue','WaitingPeriod','ClaimEligible','ClaimLapsed')", [invoiceId, svc.clock.now()]));
}

export async function unfreezeDefault(tx: Tx, svc: Services, invoiceId: string) {
  const now = svc.clock.now();
  await tx.elevated(() => tx.query(
    `update recovery.defaults set frozen_days = frozen_days + extract(epoch from ($2::timestamptz - frozen_since)) / 86400, frozen_since = null, updated_at = $2 where invoice_id = $1 and frozen_since is not null`, [invoiceId, now]));
}

/** Worker: dunning notices, waiting-period expiry → ClaimEligible (invoice Defaulted), claim-deadline lapse. */
export async function processDefaults(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = svc.clock.now(); const today = dateOf(now);
  const levels = await dunningDays(tx);
  const rows = await tx.query<any>("select * from recovery.defaults where status in ('Overdue','ClaimEligible') order by created_at");
  let n = 0;
  for (const d of rows) {
    const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [d.invoice_id]);
    const frozenNow = inv.status === 'Disputed';
    const v = defaultView(d, now);
    if (d.status === 'Overdue' && !frozenNow) {
      // dunning at day 1, 7, 30 (configurable)
      for (let i = d.dunning_level; i < levels.length; i++) {
        if (v.interestDays < levels[i]!) break;
        await tx.query('insert into recovery.dunning_events (invoice_id, buyer_org_id, bank_org_id, level, days_overdue, at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [d.invoice_id, d.buyer_org_id, d.bank_org_id, i + 1, v.overdueDays, now]);
        await tx.query('update recovery.defaults set dunning_level = $2, updated_at = $3 where id = $1', [d.id, i + 1, now]);
        await emit(tx, now, 'dunning.notice', { invoiceId: d.invoice_id, humanId: d.invoice_number, level: i + 1, daysOverdue: v.overdueDays, lateInterest: v.lateInterest, currency: d.currency }, [d.buyer_org_id, d.bank_org_id, d.supplier_org_id]);
        n++;
      }
      if (inv.status === 'Overdue' && (d.insolvency || today >= v.waitingEndsOn)) {
        const terms = d.insurer_org_id ? (await resolveTerms(tx, now, 'insurer', d.insurer_org_id, {})).terms : null;
        const deadline = addDays(d.insolvency ? today : v.waitingEndsOn, terms?.claimDeadlineDays ?? 60);
        await tx.query("update recovery.defaults set status = 'ClaimEligible', claim_deadline_on = $2, updated_at = $3 where id = $1", [d.id, deadline, now]);
        await transition(tx, svc, ctx, inv, 'Defaulted', { note: d.insolvency ? 'Buyer insolvency: waiting period waived' : `Unpaid after the ${d.waiting_days}-day waiting period`, event: 'invoice.defaulted' });
        await emit(tx, now, 'claim.eligible', { invoiceId: d.invoice_id, humanId: d.invoice_number, deadline }, [d.bank_org_id, d.supplier_org_id]);
        n++;
      }
    } else if (d.status === 'ClaimEligible' && today > String(d.claim_deadline_on).slice(0, 10)) {
      await tx.query("update recovery.defaults set status = 'ClaimLapsed', updated_at = $2 where id = $1", [d.id, now]);
      await emit(tx, now, 'claim.lapsed', { invoiceId: d.invoice_id, humanId: d.invoice_number }, [d.bank_org_id, d.supplier_org_id]);
      n++;
    }
  }
  return n;
}

/** A-14: a buyer insolvency event skips the waiting period. Bank (or platform) reports it with a reference. */
export async function reportInsolvency(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string | null, invoiceId: string, reference: string) {
  const d = await tx.elevated(() => tx.maybe<any>('select * from recovery.defaults where invoice_id = $1 for update', [invoiceId]));
  if (!d || (bankOrgId && d.bank_org_id !== bankOrgId)) throw notFound('Default');
  if (!['Overdue'].includes(d.status)) throw conflict('not_waiting', `This default is ${d.status}; an insolvency event only matters while the waiting period runs.`);
  if (!reference || reference.trim().length < 3) throw invalid('Give the insolvency case reference or notice.');
  const now = svc.clock.now();
  await tx.elevated(() => tx.query('update recovery.defaults set insolvency = true, insolvency_at = $2, updated_at = $2 where id = $1', [d.id, now]));
  await audit(tx, ctx, now, { action: 'default.insolvency_reported', entityType: 'invoice', entityId: invoiceId, orgId: d.bank_org_id, after: { reference } });
  await tx.elevated(() => processDefaults(tx, svc, { ...ctx, platform: true })); // moves the invoice to Defaulted, which the bank cannot update directly
}

// ---------------------------------------------------------------- claims (XB-7)
export const CLAIM_DOC_TYPES = ['invoice', 'acceptance', 'delivery_proof', 'statement'] as const;
export interface Exclusion { code: 'dispute' | 'documentation_defect' | 'shipment_before_limit' | 'sanctions_breach'; detail: string }

/** The insurer's standard exclusions, evaluated from facts the platform holds. */
export async function evaluateExclusions(tx: Tx, invoiceId: string, documents: { docType: string; fileId: string }[], required: readonly string[]): Promise<Exclusion[]> {
  return tx.elevated(async () => {
    const out: Exclusion[] = [];
    const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [invoiceId]);
    const disputes = await tx.query<any>("select * from invoicing.disputes where invoice_id = $1 and freezes", [invoiceId]);
    const causes = await supplierCauses(tx);
    for (const d of disputes) {
      if (['Open', 'UnderReview', 'Escalated'].includes(d.status)) out.push({ code: 'dispute', detail: 'A dispute on this invoice is still open.' });
      else if (d.status === 'ResolvedForBuyer' && d.cause && causes.includes(d.cause)) out.push({ code: 'dispute', detail: `The buyer’s dispute was upheld (${String(d.cause).replace(/_/g, ' ')}).` });
    }
    const have = new Set(documents.map((d) => d.docType));
    const missing = required.filter((t) => !have.has(t));
    if (missing.length) out.push({ code: 'documentation_defect', detail: `Missing claim documents: ${missing.join(', ')}.` });
    const cover = await tx.maybe<any>('select decided_at from insurance.cover_records where invoice_id = $1', [invoiceId]);
    const shipped = inv.shipment_date ? String(inv.shipment_date).slice(0, 10) : null;
    if (shipped && cover?.decided_at && shipped < dateOf(new Date(cover.decided_at))) out.push({ code: 'shipment_before_limit', detail: `Goods shipped on ${shipped}, before the cover was granted on ${dateOf(new Date(cover.decided_at))}.` });
    if (['confirmed', 'hit', 'blocked'].includes(inv.screening_status)) out.push({ code: 'sanctions_breach', detail: 'The invoice has a sanctions screening hit.' });
    return out;
  });
}

export async function fileClaim(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, invoiceId: string, documents: { docType: string; fileId: string }[], extra?: Record<string, unknown>) {
  // Locking a row needs update visibility, which only the platform has on defaults; the bank's right to act is checked by the bank_org_id filter.
  const d = await tx.elevated(() => tx.maybe<any>('select * from recovery.defaults where invoice_id = $1 and bank_org_id = $2 for update', [invoiceId, bankOrgId]));
  if (!d) throw notFound('Default');
  if (d.status !== 'ClaimEligible') {
    const v = defaultView(d, svc.clock.now());
    throw conflict('not_claimable', d.status === 'Overdue' ? `The waiting period ends on ${v.waitingEndsOn}; a claim can be filed after that.` : `This default is ${d.status}; no claim can be filed.`);
  }
  if (!d.insurer_org_id) throw conflict('uninsured', 'This invoice has no insurance cover, so there is nothing to claim.');
  for (const x of documents) if (!(CLAIM_DOC_TYPES as readonly string[]).includes(x.docType)) throw invalid(`Unknown claim document type ${x.docType}.`);
  const cover = await tx.elevated(() => tx.one<any>('select * from insurance.cover_records where invoice_id = $1', [invoiceId]));
  const inv = await tx.elevated(() => tx.one<any>('select accepted_amount, gross_amount from invoicing.invoices where id = $1', [invoiceId]));
  const terms = (await resolveTerms(tx, svc.clock.now(), 'insurer', d.insurer_org_id, {})).terms;
  const answers = validateAnswers((terms.customFields ?? []) as any, extra, 'claim');
  for (const x of documents) await shareFile(tx, x.fileId, [d.insurer_org_id]);
  const exclusions = await evaluateExclusions(tx, invoiceId, documents, terms.claimDocuments);
  const now = svc.clock.now();
  const face = inv.accepted_amount ?? inv.gross_amount;
  const claim = await tx.one<any>(
    `insert into recovery.claims (invoice_id, invoice_number, bank_org_id, insurer_org_id, supplier_org_id, buyer_org_id, currency, face_amount, advance_amount, cover_pct, claimed_amount, status, documents, exclusions, filed_by, filed_at, extra)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,'Filed',$11,$12,$13,$14,$15) returning *`,
    [invoiceId, d.invoice_number, bankOrgId, d.insurer_org_id, d.supplier_org_id, d.buyer_org_id, d.currency, face, d.principal, cover.cover_pct, JSON.stringify(documents), JSON.stringify(exclusions), ctx.userId ?? null, now, JSON.stringify(answers)]);
  await tx.elevated(async () => {
    await tx.query("update recovery.defaults set status = 'ClaimFiled', updated_at = $2 where id = $1", [d.id, now]);
    await tx.query("update insurance.cover_records set claim_status = 'filed' where invoice_id = $1", [invoiceId]);
  });
  await audit(tx, ctx, now, { action: 'claim.filed', entityType: 'claim', entityId: claim.id, orgId: bankOrgId, after: { claimed: d.principal, exclusions: exclusions.map((e) => e.code) } });
  await audit(tx, ctx, now, { action: 'claim.filed', entityType: 'claim', entityId: claim.id, orgId: d.insurer_org_id });
  await emit(tx, now, 'claim.filed', { claimId: claim.id, invoiceId, humanId: d.invoice_number, amount: d.principal, currency: d.currency }, [d.insurer_org_id, bankOrgId, d.supplier_org_id]);
  return claim;
}

export async function reviewClaim(tx: Tx, svc: Services, ctx: Ctx, insurerOrgId: string, claimId: string) {
  const c = await tx.maybe<any>('select * from recovery.claims where id = $1 and insurer_org_id = $2 for update', [claimId, insurerOrgId]);
  if (!c) throw notFound('Claim');
  if (c.status !== 'Filed') throw conflict('wrong_state', `This claim is ${c.status}.`);
  const terms = (await resolveTerms(tx, svc.clock.now(), 'insurer', insurerOrgId, {})).terms;
  const exclusions = await evaluateExclusions(tx, c.invoice_id, c.documents, terms.claimDocuments);
  await tx.query("update recovery.claims set status = 'UnderReview', exclusions = $2 where id = $1", [claimId, JSON.stringify(exclusions)]);
  await audit(tx, ctx, svc.clock.now(), { action: 'claim.review_started', entityType: 'claim', entityId: claimId, orgId: insurerOrgId });
  return { exclusions };
}

async function closeAfterClaim(tx: Tx, svc: Services, ctx: Ctx, c: any, reason: string) {
  const now = svc.clock.now();
  await tx.elevated(async () => {
    const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [c.invoice_id]);
    if (inv.status === 'Defaulted') await transition(tx, svc, ctx, inv, 'Closed', { note: reason, event: 'invoice.closed' });
    const fr = await tx.maybe<any>("select reserved_usd from marketplace.financing_requests where invoice_id = $1 and status = 'Funded'", [c.invoice_id]);
    await tx.query("update marketplace.liens set status = 'Released', released_at = $2, release_reason = $3 where invoice_id = $1 and status = 'Active'", [c.invoice_id, now, reason]);
    await tx.query("insert into marketplace.lien_events (invoice_id, invoice_number, event, bank_org_id, detail, at) values ($1,$2,'released_claim',$3,$4,$5)", [c.invoice_id, c.invoice_number, c.bank_org_id, reason, now]);
    if (fr && D(fr.reserved_usd).gt(0)) await releaseUsed(tx, svc, { bankOrgId: c.bank_org_id, buyerOrgId: c.buyer_org_id, supplierOrgId: c.supplier_org_id, amountUsd: fr.reserved_usd });
  });
}

export async function decideClaim(tx: Tx, svc: Services, ctx: Ctx, insurerOrgId: string, claimId: string, d: { decision: 'approve' | 'partial' | 'reject'; approvedAmount?: string; reason?: string }) {
  const c = await tx.maybe<any>('select * from recovery.claims where id = $1 and insurer_org_id = $2 for update', [claimId, insurerOrgId]);
  if (!c) throw notFound('Claim');
  if (!['Filed', 'UnderReview'].includes(c.status)) throw conflict('wrong_state', `This claim is already ${c.status}.`);
  const now = svc.clock.now();
  const terms = (await resolveTerms(tx, now, 'insurer', insurerOrgId, {})).terms;
  const exclusions: Exclusion[] = await evaluateExclusions(tx, c.invoice_id, c.documents, terms.claimDocuments);
  const cap = payoutWaterfall({ face: c.face_amount, advance: c.advance_amount, coverPct: c.cover_pct });
  let status: string, approved: string | null = null;
  if (d.decision === 'reject') {
    if (!d.reason || d.reason.trim().length < 3) throw invalid('Give the reason for rejecting this claim.');
    status = 'Rejected'; approved = '0.00';
  } else if (d.decision === 'approve') {
    if (exclusions.length) throw conflict('exclusion_applies', `A policy exclusion applies (${exclusions.map((e) => e.code).join(', ')}). Reject the claim or approve a lower amount with a reason.`, { exclusions });
    status = 'Approved'; approved = cap.payout;
  } else {
    if (!d.approvedAmount || D(d.approvedAmount).lte(0) || D(d.approvedAmount).gte(cap.payout)) throw invalid(`A partial approval must be above zero and below the ${cap.payout} the cover allows.`);
    if (!d.reason || d.reason.trim().length < 3) throw invalid('Give the reason for approving less than the cover allows.');
    status = 'PartiallyApproved'; approved = D(d.approvedAmount).toFixed(2);
  }
  const wf = payoutWaterfall({ face: c.face_amount, advance: c.advance_amount, coverPct: c.cover_pct, approvedAmount: approved });
  await tx.query('update recovery.claims set status = $2, approved_amount = $3, decision_reason = $4, exclusions = $5, decided_by = $6, decided_at = $7, waterfall = $8 where id = $1',
    [claimId, status, approved, d.reason ?? null, JSON.stringify(exclusions), ctx.userId ?? null, now, JSON.stringify(wf)]);
  await audit(tx, ctx, now, { action: `claim.${status.toLowerCase()}`, entityType: 'claim', entityId: claimId, orgId: insurerOrgId, after: { approved, exclusions: exclusions.map((e) => e.code) } });
  await audit(tx, ctx, now, { action: `claim.${status.toLowerCase()}`, entityType: 'claim', entityId: claimId, orgId: c.bank_org_id });
  let recourse = null;
  if (status === 'Rejected') {
    await tx.elevated(() => tx.query("update insurance.cover_records set claim_status = 'rejected' where invoice_id = $1", [c.invoice_id]));
    // BR-11: recourse only when the loss traces to a supplier-caused, upheld dispute.
    const upheld = await tx.elevated(() => tx.maybe<any>("select cause from invoicing.disputes where invoice_id = $1 and status = 'ResolvedForBuyer' and cause is not null order by decided_at desc limit 1", [c.invoice_id]));
    const already = await tx.elevated(() => tx.maybe<any>("select 1 as x from recovery.recourse where invoice_id = $1 and cause <> 'credit_note'", [c.invoice_id]));
    if (upheld && !already && (await supplierCauses(tx)).includes(upheld.cause)) {
      recourse = await createRecourse(tx, svc, ctx, { invoiceId: c.invoice_id, invoiceNumber: c.invoice_number, supplierOrgId: c.supplier_org_id, bankOrgId: c.bank_org_id, currency: c.currency, amount: c.claimed_amount, cause: upheld.cause, note: 'Claim rejected after a supplier-caused dispute' });
    }
    await closeAfterClaim(tx, svc, ctx, c, 'Claim rejected');
  }
  await emit(tx, now, `claim.${status === 'Rejected' ? 'rejected' : 'approved'}`, { claimId, invoiceId: c.invoice_id, humanId: c.invoice_number, approved, reason: d.reason ?? null }, [c.bank_org_id, c.supplier_org_id, insurerOrgId]);
  return { status, approvedAmount: approved, waterfall: wf, exclusions, recourseId: recourse?.id ?? null };
}

/** Insurer records the payout; the waterfall pays the bank first, then the supplier's retention (BR-10). */
export async function payClaim(tx: Tx, svc: Services, ctx: Ctx, insurerOrgId: string, claimId: string) {
  const c = await tx.maybe<any>('select * from recovery.claims where id = $1 and insurer_org_id = $2 for update', [claimId, insurerOrgId]);
  if (!c) throw notFound('Claim');
  if (!['Approved', 'PartiallyApproved'].includes(c.status)) throw conflict('wrong_state', `Only an approved claim can be paid; this one is ${c.status}.`);
  const now = svc.clock.now();
  const wf = c.waterfall ?? payoutWaterfall({ face: c.face_amount, advance: c.advance_amount, coverPct: c.cover_pct, approvedAmount: c.approved_amount });
  const base = { invoice_id: c.invoice_id, invoice_number: c.invoice_number, bank_org_id: c.bank_org_id, supplier_org_id: c.supplier_org_id, buyer_org_id: c.buyer_org_id, currency: c.currency };
  const ins = (kind: string, party: string, amount: string, note: string) => tx.query(
    `insert into settlement.ledger_entries (invoice_id, invoice_number, bank_org_id, supplier_org_id, buyer_org_id, kind, party, currency, amount, note, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [base.invoice_id, base.invoice_number, base.bank_org_id, base.supplier_org_id, base.buyer_org_id, kind, party, base.currency, amount, note, now]);
  await ins('claim_payout', 'insurer', wf.payout, `Insurer paid the claim (${c.cover_pct}% cover)`);
  await ins('bank_principal', 'bank', wf.toBank, 'Claim payout applied to the bank’s principal and accrued charges first');
  if (D(wf.toSupplier).gt(0)) await ins('retention_release', 'supplier', wf.toSupplier, 'Remainder of the claim payout released to the supplier’s retention');
  if (D(wf.bankShortfall).gt(0)) await ins('shortfall', 'bank', wf.bankShortfall, 'Bank loss after the claim payout');
  await tx.query("update recovery.claims set status = 'Paid', paid_at = $2 where id = $1", [claimId, now]);
  await tx.elevated(async () => {
    await tx.query("update recovery.defaults set status = 'Paid', updated_at = $2 where invoice_id = $1", [c.invoice_id, now]);
    await tx.query("update insurance.cover_records set claim_status = 'paid' where invoice_id = $1", [c.invoice_id]);
  });
  await closeAfterClaim(tx, svc, ctx, c, 'Claim paid');
  await audit(tx, ctx, now, { action: 'claim.paid', entityType: 'claim', entityId: claimId, orgId: insurerOrgId, after: wf });
  await audit(tx, ctx, now, { action: 'claim.paid', entityType: 'claim', entityId: claimId, orgId: c.bank_org_id });
  await emit(tx, now, 'claim.paid', { claimId, invoiceId: c.invoice_id, humanId: c.invoice_number, payout: wf.payout, toBank: wf.toBank, toSupplier: wf.toSupplier, currency: c.currency }, [c.bank_org_id, c.supplier_org_id, insurerOrgId]);
  return wf;
}

/** Recoveries from the buyer or its estate, net of costs, shared pro rata to the losses each party bore. */
export async function recordRecovery(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, claimId: string, a: { gross: string; costs: string; note?: string }) {
  const c = await tx.maybe<any>('select * from recovery.claims where id = $1 and bank_org_id = $2 for update', [claimId, bankOrgId]);
  if (!c) throw notFound('Claim');
  if (!['Paid', 'Rejected'].includes(c.status) || !c.waterfall) throw conflict('wrong_state', 'Recoveries are recorded after a claim is paid or rejected.');
  if (D(a.gross).lte(0) || D(a.costs).lt(0)) throw invalid('Enter the amount recovered and the costs of recovering it.');
  const wf = c.waterfall;
  const { net, shares } = shareRecovery({ insurer: wf.insurerLoss, bank: wf.bankShortfall, supplier: wf.supplierLoss }, a.gross, a.costs);
  const now = svc.clock.now();
  const row = await tx.one<any>(
    `insert into recovery.recoveries (claim_id, invoice_id, bank_org_id, insurer_org_id, supplier_org_id, currency, gross, costs, net, shares, note, recorded_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [claimId, c.invoice_id, c.bank_org_id, c.insurer_org_id, c.supplier_org_id, c.currency, a.gross, a.costs, net, JSON.stringify(shares), a.note ?? null, ctx.userId ?? null, now]);
  for (const [party, amt] of Object.entries(shares)) {
    if (D(amt).gt(0)) await tx.query(
      `insert into settlement.ledger_entries (invoice_id, invoice_number, bank_org_id, supplier_org_id, buyer_org_id, kind, party, currency, amount, note, at) values ($1,$2,$3,$4,$5,'recovery_share',$6,$7,$8,$9,$10)`,
      [c.invoice_id, c.invoice_number, c.bank_org_id, c.supplier_org_id, c.buyer_org_id, party, c.currency, amt, `Recovery of ${a.gross} less costs ${a.costs}, shared pro rata to losses`, now]);
  }
  await audit(tx, ctx, now, { action: 'claim.recovery', entityType: 'claim', entityId: claimId, orgId: c.bank_org_id, after: { gross: a.gross, costs: a.costs, net, shares } });
  await audit(tx, ctx, now, { action: 'claim.recovery', entityType: 'claim', entityId: claimId, orgId: c.insurer_org_id });
  await emit(tx, now, 'claim.recovery', { claimId, invoiceId: c.invoice_id, humanId: c.invoice_number, net, currency: c.currency }, [c.bank_org_id, c.insurer_org_id, c.supplier_org_id]);
  return { id: row.id, net, shares };
}

export { DomainError, forbidden };
