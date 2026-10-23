import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { D, formatMoney } from '../../kernel/money';
import { loadInvoice } from '../invoicing/service';
import { transition } from '../invoicing/state';
import { activeRelationship, invitedBanks } from '../identity/relationships';
import { consumeLimits, releaseReserved, reserveLimits } from '../identity/limits';
import { transactBlockReason } from '../compliance/sanctions';
import { consumeCover, coverForInvoice, coverGate } from '../insurance/service';
import { quoteForBank, type OfferOverrides } from '../terms/quote';
import { resolveTerms } from '../terms/service';
import { usdEquivalent } from '../pricing/fx';
import { daysBetween } from '../pricing/calendar';
import { annualisedDiscountCostPct, discountPctFromAnnualRate, priceEarlyPayment } from '../pricing/early-payment';

export const LIVE_FR = ['Created', 'ConsentPending', 'BankConfirming', 'Approved', 'DisbursementInstructed', 'Funded'] as const;
const sys = (ctx: Ctx): Ctx => ({ ...ctx, platform: true });
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

async function mids(svc: Services) {
  const now = svc.clock.now();
  return { USDINR: await svc.adapters.fx.mid('USDINR', now), SGDINR: await svc.adapters.fx.mid('SGDINR', now) };
}
const amountOf = (inv: any): string => inv.accepted_amount ?? inv.gross_amount;
export async function usdEq(svc: Services, inv: any): Promise<string> { return usdEquivalent(amountOf(inv), inv.currency, await mids(svc)).toFixed(2); }
const setRoute = (tx: Tx, invoiceId: string, route: 'financing' | 'early_payment' | null) =>
  tx.elevated(() => tx.query('update invoicing.invoices set route = $2 where id = $1', [invoiceId, route]));
/** Lock an invoice row for a workflow step. Banks cannot lock invoices under RLS, so the lock is taken elevated; callers authorise first. */
const lockInvoice = (tx: Tx, id: string) => tx.elevated(() => loadInvoice(tx, id, true));
const moveInvoice = (tx: Tx, svc: Services, ctx: Ctx, inv: any, to: any, opts: any = {}) => tx.elevated(() => transition(tx, svc, sys(ctx), inv, to, opts));

// ---------------------------------------------------------------- funding gates (BR-1)
export interface Gate { n: number; name: string; ok: boolean; reason?: string }
export async function fundingGates(tx: Tx, svc: Services, inv: any, opts: { forFunding?: boolean } = {}): Promise<Gate[]> {
  const gates: Gate[] = [];
  const now = svc.clock.now();
  const blocks = [await transactBlockReason(tx, inv.supplier_org_id), await transactBlockReason(tx, inv.buyer_org_id)].filter(Boolean) as string[];
  gates.push({ n: 1, name: 'Parties verified and not sanctioned', ok: blocks.length === 0, reason: blocks[0] });
  if (inv.screening_status === 'confirmed' || inv.screening_status === 'hit') gates[0] = { n: 1, name: gates[0]!.name, ok: false, reason: gates[0]!.reason ?? 'This invoice has a sanctions screening hit awaiting review.' };
  const rel = await activeRelationship(tx, inv.supplier_org_id, inv.buyer_org_id);
  gates.push({ n: 2, name: 'Supplier–buyer relationship active', ok: !!rel, reason: rel ? undefined : 'The supplier–buyer relationship is not active.' });
  const accepted = ['Accepted', 'NotEligible', 'OpenForFunding', 'OffersReceived'].includes(inv.status) && !!inv.accepted_amount;
  gates.push({ n: 3, name: 'Invoice accepted, amount locked', ok: accepted, reason: accepted ? undefined : `The invoice is ${inv.status}; it must be accepted by the buyer first.` });
  const ends = inv.dispute_window_ends_at ? new Date(inv.dispute_window_ends_at) : null;
  const elapsed = !!ends && ends <= now;
  const open = await tx.maybe<any>("select 1 as x from invoicing.disputes where invoice_id = $1 and freezes and status in ('Open','UnderReview','Escalated')", [inv.id]);
  const g4ok = opts.forFunding ? elapsed && !open : !open;
  gates.push({ n: 4, name: 'Dispute window elapsed', ok: g4ok,
    reason: open ? 'There is an open dispute on this invoice.' : !g4ok ? `Funding can only happen after the dispute window ends (${ends?.toISOString() ?? 'unknown'}).` : undefined });
  return gates;
}

// ---------------------------------------------------------------- opening for funding + invitations
export async function openForFunding(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  let inv = await loadInvoice(tx, invoiceId, true);
  if (inv.status === 'NotEligible') { await transition(tx, svc, ctx, inv, 'Accepted', { note: 'Re-checking funding gates' }); inv = await loadInvoice(tx, inv.id, true); }
  if (inv.status === 'OpenForFunding' || inv.status === 'OffersReceived') return { opened: true, gates: await fundingGates(tx, svc, inv), invited: 0 };
  if (inv.status !== 'Accepted') throw conflict('not_accepted', `Invoice ${inv.human_id} is ${inv.status}; only an accepted invoice can open for funding.`);
  const gates = await fundingGates(tx, svc, inv);
  const failed = gates.filter((g) => !g.ok);
  if (failed.length) {
    await transition(tx, svc, ctx, inv, 'NotEligible', { note: failed.map((g) => g.reason).join(' '), event: 'invoice.not_eligible' });
    return { opened: false, gates, invited: 0 };
  }
  const now = svc.clock.now();
  const banks = await invitedBanks(tx, inv.supplier_org_id, inv.buyer_org_id);
  const info = await tx.elevated(() => tx.query<any>(
    `select b.id, b.is_partner, exists(select 1 from identity.org_preferred_banks p where p.org_id = $2 and p.bank_org_id = b.id) as sup_pref
       from identity.organisations b where b.id = any($1)`, [banks, inv.supplier_org_id]));
  let invited = 0;
  for (const b of info) {
    if (svc.config.mode === 'white-label' && !b.is_partner) continue;
    const source = b.is_partner ? 'partner' : b.sup_pref ? 'supplier_preferred' : 'buyer_preferred';
    await tx.query(
      `insert into marketplace.invitations (invoice_id, bank_org_id, supplier_org_id, buyer_org_id, source, created_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [inv.id, b.id, inv.supplier_org_id, inv.buyer_org_id, source, now]);
    invited++;
    await emit(tx, now, 'marketplace.invited', { invoiceId: inv.id, humanId: inv.human_id, bankOrgId: b.id }, [b.id]);
  }
  await transition(tx, svc, ctx, inv, 'OpenForFunding', { note: `Open for funding; ${invited} bank${invited === 1 ? '' : 's'} invited`, event: 'invoice.open_for_funding', payload: { invited } });
  return { opened: true, gates, invited };
}

export async function declineInvitation(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, invoiceId: string, reason: string) {
  const inv = await loadInvoice(tx, invoiceId);
  const r = await tx.query('update marketplace.invitations set status = \'declined\', decline_reason = $3 where invoice_id = $1 and bank_org_id = $2 and status = \'invited\' returning id', [inv.id, bankOrgId, reason]);
  if (!r.length) throw conflict('not_invited', 'You have no open invitation for this invoice.');
  await audit(tx, ctx, svc.clock.now(), { action: 'invitation.declined', entityType: 'invoice', entityId: inv.id, orgId: bankOrgId, after: { reason } });
}

// ---------------------------------------------------------------- offers
export interface OfferInput extends OfferOverrides { submit?: boolean; mode?: 'manual' | 'api'; idempotencyKey?: string }

export async function createOffer(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, invoiceId: string, input: OfferInput) {
  if (input.idempotencyKey) {
    const prior = await tx.maybe<any>('select * from marketplace.offers where bank_org_id = $1 and idempotency_key = $2', [bankOrgId, input.idempotencyKey]);
    if (prior) return prior;
  }
  const inviteRow0 = await tx.maybe<any>('select 1 as x from marketplace.invitations where invoice_id = $1 and bank_org_id = $2', [invoiceId, bankOrgId]);
  if (!inviteRow0) throw notFound('Invoice');
  const inv = await lockInvoice(tx, invoiceId);
  const inviteRow = await tx.maybe<any>('select * from marketplace.invitations where invoice_id = $1 and bank_org_id = $2', [inv.id, bankOrgId]);
  if (!inviteRow) throw notFound('Invoice');
  if (inviteRow.status === 'declined') throw conflict('declined', 'You declined this invitation.');
  if (!['OpenForFunding', 'OffersReceived'].includes(inv.status)) throw conflict('not_open', `Invoice ${inv.human_id} is ${inv.status} and not open for offers.`);
  const blocked = await transactBlockReason(tx, bankOrgId);
  if (blocked) throw new DomainError('bank_blocked', blocked, 422);
  const live = await tx.maybe<any>('select 1 as x from marketplace.financing_requests where invoice_id = $1 and status = any($2)', [inv.id, LIVE_FR]);
  if (live || inv.route) throw conflict('route_locked', 'A funding route has already been chosen for this invoice.');
  const q = await quoteForBank(tx, svc, inv, bankOrgId, { overrides: input });
  if (!q.evaluation.eligible) throw new DomainError('not_eligible', q.evaluation.reasons.join(' '), 422, q.evaluation.reasons);
  const quote = q.evaluation.quote!;
  const now = svc.clock.now();
  const submit = input.submit !== false;
  if (submit) {
    await tx.query("update marketplace.offers set status = 'Superseded', updated_at = $3 where invoice_id = $1 and bank_org_id = $2 and status in ('Drafted','Submitted')", [inv.id, bankOrgId, now]);
  }
  const row = await tx.one<any>(
    `insert into marketplace.offers (invoice_id, bank_org_id, supplier_org_id, buyer_org_id, status, mode, rate_pct, advance_pct, fx_spread_pct, net_cash, net_cash_inr, all_in_pct, currency, quote, terms_version_ids, valid_until, idempotency_key, created_by, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) returning *`,
    [inv.id, bankOrgId, inv.supplier_org_id, inv.buyer_org_id, submit ? 'Submitted' : 'Drafted', input.mode ?? 'manual', quote.ratePct, quote.advancePct, quote.fx.spreadPct, quote.breakdown.netCash,
     quote.fx.netCashInr, quote.breakdown.allInAnnualisedPct, inv.currency, JSON.stringify(quote), JSON.stringify(quote.termsVersionIds), quote.validUntil, input.idempotencyKey ?? null, ctx.userId ?? null, now]);
  if (submit) await afterSubmit(tx, svc, ctx, inv, row);
  else await audit(tx, ctx, now, { action: 'offer.drafted', entityType: 'offer', entityId: row.id, orgId: bankOrgId });
  return row;
}

async function afterSubmit(tx: Tx, svc: Services, ctx: Ctx, inv: any, offer: any) {
  const now = svc.clock.now();
  await tx.query("update marketplace.invitations set status = 'bid' where invoice_id = $1 and bank_org_id = $2", [inv.id, offer.bank_org_id]);
  if (inv.status === 'OpenForFunding') await moveInvoice(tx, svc, ctx, inv, 'OffersReceived', { note: 'First offer received', event: 'invoice.offers_received' });
  await audit(tx, ctx, now, { action: 'offer.submitted', entityType: 'offer', entityId: offer.id, orgId: offer.bank_org_id, after: { allInPct: offer.all_in_pct, netCash: offer.net_cash } });
  await audit(tx, ctx, now, { action: 'offer.submitted', entityType: 'offer', entityId: offer.id, orgId: inv.supplier_org_id });
  await emit(tx, now, 'offer.submitted', { offerId: offer.id, invoiceId: inv.id, humanId: inv.human_id, bankOrgId: offer.bank_org_id, allInPct: offer.all_in_pct }, [inv.supplier_org_id, offer.bank_org_id]);
}

export async function submitOffer(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, offerId: string) {
  const o = await tx.maybe<any>('select * from marketplace.offers where id = $1 and bank_org_id = $2 for update', [offerId, bankOrgId]);
  if (!o) throw notFound('Offer');
  if (o.status !== 'Drafted') throw conflict('not_draft', `This offer is ${o.status}.`);
  const inv = await lockInvoice(tx, o.invoice_id);
  if (!['OpenForFunding', 'OffersReceived'].includes(inv.status) || inv.route) throw conflict('not_open', 'The invoice is no longer open for offers.');
  // Re-price with current terms and cover: a stale draft must not go out at old numbers.
  const q = await quoteForBank(tx, svc, inv, bankOrgId, { overrides: { ratePct: Number(o.rate_pct), advancePct: Number(o.advance_pct), fxSpreadPct: Number(o.fx_spread_pct) } });
  if (!q.evaluation.eligible) throw new DomainError('not_eligible', q.evaluation.reasons.join(' '), 422, q.evaluation.reasons);
  const quote = q.evaluation.quote!, now = svc.clock.now();
  await tx.query("update marketplace.offers set status = 'Superseded', updated_at = $3 where invoice_id = $1 and bank_org_id = $2 and status = 'Submitted'", [inv.id, bankOrgId, now]);
  const row = await tx.one<any>(
    `update marketplace.offers set status = 'Submitted', quote = $2, net_cash = $3, net_cash_inr = $4, all_in_pct = $5, valid_until = $6, terms_version_ids = $7, updated_at = $8 where id = $1 returning *`,
    [o.id, JSON.stringify(quote), quote.breakdown.netCash, quote.fx.netCashInr, quote.breakdown.allInAnnualisedPct, quote.validUntil, JSON.stringify(quote.termsVersionIds), now]);
  await afterSubmit(tx, svc, ctx, inv, row);
  return row;
}

async function reopenIfNoOffers(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  const inv = await tx.elevated(() => tx.one<any>('select * from invoicing.invoices where id = $1', [invoiceId]));
  if (inv.status !== 'OffersReceived') return;
  const left = await tx.elevated(() => tx.maybe<any>("select 1 as x from marketplace.offers where invoice_id = $1 and status in ('Submitted','Selected')", [invoiceId]));
  if (!left) await moveInvoice(tx, svc, ctx, inv, 'OpenForFunding', { note: 'No offers remain', event: 'invoice.offers_lapsed' });
}

export async function withdrawOffer(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, offerId: string) {
  const o = await tx.maybe<any>('select * from marketplace.offers where id = $1 and bank_org_id = $2 for update', [offerId, bankOrgId]);
  if (!o) throw notFound('Offer');
  if (!['Drafted', 'Submitted'].includes(o.status)) throw conflict('cannot_withdraw', o.status === 'Selected' ? 'This offer was selected; ask the supplier to cancel, or decline at confirmation.' : `This offer is ${o.status}.`);
  await tx.query("update marketplace.offers set status = 'Withdrawn', updated_at = $2 where id = $1", [o.id, svc.clock.now()]);
  await audit(tx, ctx, svc.clock.now(), { action: 'offer.withdrawn', entityType: 'offer', entityId: o.id, orgId: bankOrgId });
  await audit(tx, ctx, svc.clock.now(), { action: 'offer.withdrawn', entityType: 'offer', entityId: o.id, orgId: o.supplier_org_id });
  await reopenIfNoOffers(tx, svc, ctx, o.invoice_id);
}

/** Worker job: offers past their validity lapse; an invoice with no live offers goes back to OpenForFunding. */
export async function expireOffers(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = svc.clock.now();
  const rows = await tx.query<any>("update marketplace.offers set status = 'Expired', updated_at = $1 where status = 'Submitted' and valid_until <= $1 returning id, invoice_id, bank_org_id, supplier_org_id", [now]);
  for (const r of rows) {
    await audit(tx, ctx, now, { action: 'offer.expired', entityType: 'offer', entityId: r.id, orgId: r.bank_org_id });
    await emit(tx, now, 'offer.expired', { offerId: r.id, invoiceId: r.invoice_id }, [r.bank_org_id, r.supplier_org_id]);
  }
  for (const id of new Set(rows.map((r) => r.invoice_id as string))) await reopenIfNoOffers(tx, svc, ctx, id);
  return rows.length;
}

// ---------------------------------------------------------------- early-payment schedule helpers
export interface ScheduleEntry { payBy: string; discountPct: number }
export function discountFor(s: { mode: string; entries?: ScheduleEntry[] | null; annual_rate_pct?: string | null }, payDate: string, dueDate: string): { discountPct: string } | null {
  const daysEarly = daysBetween(payDate, dueDate);
  if (daysEarly < 1) return null;
  if (s.mode === 'annual_rate') return { discountPct: discountPctFromAnnualRate(s.annual_rate_pct!, daysEarly).toFixed(4) };
  const ok = (s.entries ?? []).filter((e) => e.payBy >= payDate).sort((a, b) => (a.payBy < b.payBy ? -1 : 1));
  return ok[0] ? { discountPct: String(ok[0].discountPct) } : null;
}

export async function publishSchedule(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string, input: { mode: 'table' | 'annual_rate'; entries?: ScheduleEntry[]; annualRatePct?: number }) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (!['Accepted', 'OpenForFunding', 'OffersReceived'].includes(inv.status)) throw conflict('not_accepted', `Invoice ${inv.human_id} is ${inv.status}; a discount schedule needs an accepted invoice.`);
  if (inv.route) throw conflict('route_locked', 'A funding route has already been chosen for this invoice.');
  const due = String(inv.due_date).slice(0, 10), today = dateOnly(svc.clock.now());
  const supplier = await tx.elevated(() => tx.one<any>('select small, borrowing_rate from identity.organisations where id = $1', [inv.supplier_org_id]));
  const platform = (await resolveTerms(tx, svc.clock.now(), 'platform', null, {})).terms;
  const warnings: string[] = [];
  const probe: { date: string; pct: string }[] = [];
  if (input.mode === 'table') {
    if (!input.entries?.length) throw invalid('Add at least one date with a discount.');
    for (const e of input.entries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.payBy)) throw invalid(`"${e.payBy}" is not a valid date.`);
      if (e.payBy >= due) throw invalid(`The pay-by date ${e.payBy} must be before the due date ${due}.`);
      if (e.payBy < today) throw invalid(`The pay-by date ${e.payBy} is in the past.`);
      if (!(e.discountPct > 0 && e.discountPct < 20)) throw invalid('A discount must be above 0% and below 20%.');
      probe.push({ date: e.payBy, pct: String(e.discountPct) });
    }
  } else {
    if (!(input.annualRatePct && input.annualRatePct > 0 && input.annualRatePct <= 100)) throw invalid('The annual rate must be above 0% and at most 100%.');
    const d = daysBetween(today, due);
    if (d < 1) throw invalid('The invoice is already due.');
    probe.push({ date: today, pct: discountPctFromAnnualRate(input.annualRatePct, d).toFixed(4) });
  }
  for (const p of probe) {
    const n = daysBetween(p.date, due);
    const r = priceEarlyPayment({ faceAmount: amountOf(inv), discountPct: p.pct, daysEarly: n, commissionSharePct: platform.earlyPayment.bankCommissionSharePct, buyerCashYieldPct: platform.earlyPayment.buyerCashYieldPct,
      supplierBorrowingRatePct: supplier.borrowing_rate ? Number(supplier.borrowing_rate) : null, guardrailCapPct: supplier.small ? platform.maxAllInCostSmallPct : null });
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
  }
  const now = svc.clock.now();
  await tx.query(
    `insert into marketplace.discount_schedules (invoice_id, supplier_org_id, buyer_org_id, mode, entries, annual_rate_pct, status, created_at) values ($1,$2,$3,$4,$5,$6,'published',$7)
     on conflict (invoice_id) do update set mode = excluded.mode, entries = excluded.entries, annual_rate_pct = excluded.annual_rate_pct, status = 'published', created_at = excluded.created_at`,
    [inv.id, inv.supplier_org_id, inv.buyer_org_id, input.mode, input.mode === 'table' ? JSON.stringify(input.entries) : null, input.mode === 'annual_rate' ? input.annualRatePct : null, now]);
  await audit(tx, ctx, now, { action: 'discount_schedule.published', entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id, after: input as any });
  await audit(tx, ctx, now, { action: 'discount_schedule.published', entityType: 'invoice', entityId: inv.id, orgId: inv.buyer_org_id });
  await emit(tx, now, 'discount_schedule.published', { invoiceId: inv.id, humanId: inv.human_id }, [inv.buyer_org_id]);
  return { warnings };
}

export async function withdrawSchedule(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (inv.route === 'early_payment') throw conflict('route_locked', 'The invoice was already paid early.');
  const r = await tx.query("update marketplace.discount_schedules set status = 'withdrawn' where invoice_id = $1 and status = 'published' returning id", [inv.id]);
  if (!r.length) throw notFound('Discount schedule');
  await audit(tx, ctx, svc.clock.now(), { action: 'discount_schedule.withdrawn', entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id });
}

export async function earlyPaymentQuote(tx: Tx, svc: Services, inv: any, payDate: string, fundingSource: 'cash' | 'bank_loan') {
  const s = await tx.maybe<any>("select * from marketplace.discount_schedules where invoice_id = $1 and status = 'published'", [inv.id]);
  if (!s) throw conflict('no_schedule', 'The supplier has not published a discount schedule for this invoice.');
  const due = String(inv.due_date).slice(0, 10), today = dateOnly(svc.clock.now());
  if (payDate < today) throw invalid('The payment date cannot be in the past.');
  const days = daysBetween(payDate, due);
  if (days < 1) throw invalid('Pay at least one day before the due date to earn a discount.');
  const d = discountFor(s, payDate, due);
  if (!d) throw invalid('The supplier’s schedule has no discount for that date. Choose an earlier date.');
  const supplier = await tx.elevated(() => tx.one<any>('select small, borrowing_rate from identity.organisations where id = $1', [inv.supplier_org_id]));
  const platform = (await resolveTerms(tx, svc.clock.now(), 'platform', null, {})).terms;
  const r = priceEarlyPayment({ faceAmount: amountOf(inv), discountPct: d.discountPct, daysEarly: days, commissionSharePct: platform.earlyPayment.bankCommissionSharePct, buyerCashYieldPct: platform.earlyPayment.buyerCashYieldPct,
    supplierBorrowingRatePct: supplier.borrowing_rate ? Number(supplier.borrowing_rate) : null, guardrailCapPct: supplier.small ? platform.maxAllInCostSmallPct : null });
  const cash = fundingSource === 'cash';
  return { payDate, daysEarly: days, discountPct: D(d.discountPct).toFixed(2), faceAmount: D(amountOf(inv)).toFixed(2), buyerPays: r.buyerPays, discount: r.discount, annualisedCostPct: r.annualisedCostPct,
    commission: cash ? '0.00' : r.commission, buyerNetSaving: cash ? r.discount : r.buyerNetSaving, buyerReturnPct: r.buyerReturnPct, buyerBeatsCashYield: r.buyerBeatsCashYield, warnings: r.warnings, currency: inv.currency, fundingSource };
}

export async function confirmEarlyPayment(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string, input: { payDate: string; fundingSource: 'cash' | 'bank_loan'; buyerBankOrgId?: string }) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (inv.buyer_org_id !== ctx.orgId && !ctx.platform) throw notFound('Invoice');
  if (inv.route === 'early_payment') throw conflict('already_paid', 'This invoice was already paid early.');
  if (inv.route === 'financing') throw conflict('route_locked', 'A bank financing is in progress for this invoice, so early payment is no longer available.');
  if (!['OpenForFunding', 'OffersReceived'].includes(inv.status)) throw conflict('not_open', `Invoice ${inv.human_id} is ${inv.status}; the supplier must request funding first.`);
  const live = await tx.maybe<any>('select 1 as x from marketplace.financing_requests where invoice_id = $1 and status = any($2)', [inv.id, LIVE_FR]);
  if (live) throw conflict('route_locked', 'A bank financing is in progress for this invoice, so early payment is no longer available.');
  const gates = await fundingGates(tx, svc, inv, { forFunding: true });
  const bad = gates.find((g) => !g.ok);
  if (bad) throw new DomainError('gate_failed', bad.reason!, 409);
  if (input.fundingSource === 'bank_loan') {
    if (!input.buyerBankOrgId) throw invalid('Choose the bank that will fund the early payment.');
    const b = await tx.elevated(() => tx.maybe<any>("select id from identity.organisations where id = $1 and type = 'bank' and kyc_status = 'approved' and not blocked", [input.buyerBankOrgId]));
    if (!b) throw invalid('That bank is not available.');
  }
  const q = await earlyPaymentQuote(tx, svc, inv, input.payDate, input.fundingSource);
  const now = svc.clock.now();
  const ref = `SIM-EP-${inv.human_id}-${now.getTime().toString(36).toUpperCase()}`;
  const row = await tx.one<any>(
    `insert into marketplace.early_payments (invoice_id, supplier_org_id, buyer_org_id, pay_date, days_early, discount_pct, face_amount, buyer_pays, discount_amount, annualised_cost_pct, funding_source, buyer_bank_org_id, commission, buyer_net_saving, payment_ref, executed_by, executed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [inv.id, inv.supplier_org_id, inv.buyer_org_id, q.payDate, q.daysEarly, q.discountPct, q.faceAmount, q.buyerPays, q.discount, q.annualisedCostPct, q.fundingSource,
     input.fundingSource === 'bank_loan' ? input.buyerBankOrgId : null, q.commission, q.buyerNetSaving, ref, ctx.userId ?? null, now]);
  // One route per invoice (A-5): withdraw every other offer.
  const others = await tx.elevated(() => tx.query<any>("update marketplace.offers set status = 'Withdrawn', decision_note = 'Withdrawn: buyer paid early', updated_at = $2 where invoice_id = $1 and status in ('Drafted','Submitted') returning id, bank_org_id", [inv.id, now]));
  await tx.elevated(() => tx.query("update marketplace.invitations set status = 'closed' where invoice_id = $1", [inv.id]));
  await tx.elevated(() => tx.query("update marketplace.discount_schedules set status = 'used' where invoice_id = $1", [inv.id]));
  for (const o of others) await emit(tx, now, 'offer.withdrawn', { offerId: o.id, invoiceId: inv.id, reason: 'early_payment' }, [o.bank_org_id]);
  await moveInvoice(tx, svc, ctx, inv, 'Funded', { note: `Paid early on ${q.payDate} (${q.discountPct}% discount)`, event: 'invoice.paid_early', set: { route: 'early_payment' },
    payload: { route: 'early_payment', buyerPays: q.buyerPays, payDate: q.payDate } });
  await audit(tx, ctx, now, { action: 'early_payment.executed', entityType: 'invoice', entityId: inv.id, orgId: inv.buyer_org_id, after: { ref, buyerPays: q.buyerPays, discount: q.discount } });
  await audit(tx, ctx, now, { action: 'early_payment.executed', entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id });
  return { ...q, paymentRef: ref, id: row.id };
}

// ---------------------------------------------------------------- financing request + lien
export const lienConflict = (inv: any, bankOrgId?: string) => new DomainError('lien_conflict', `Invoice ${inv.human_id} already has a financing in progress or funded (lien conflict).`, 409, { invoiceId: inv.id, bankOrgId });

/** Persist a lien conflict in its own transaction so it survives the failed request's rollback. */
export async function recordLienConflict(svc: Services, ctx: Ctx, invoiceId: string, bankOrgId: string | undefined, detail: string) {
  await svc.db.tx({ ...ctx, platform: true }, async (tx) => {
    const inv = await tx.maybe<any>('select human_id, supplier_org_id from invoicing.invoices where id = $1', [invoiceId]);
    const now = svc.clock.now();
    await tx.query('insert into marketplace.lien_events (invoice_id, invoice_number, event, bank_org_id, detail, at) values ($1,$2,$3,$4,$5,$6)', [invoiceId, inv?.human_id ?? null, 'lien_conflict', bankOrgId ?? null, detail, now]);
    await audit(tx, ctx, now, { action: 'lien.conflict', entityType: 'invoice', entityId: invoiceId, orgId: inv?.supplier_org_id, after: { detail } });
  });
}

async function lienEvent(tx: Tx, svc: Services, inv: any, lienId: string | null, event: string, bankOrgId: string, detail?: string) {
  await tx.elevated(() => tx.query('insert into marketplace.lien_events (invoice_id, invoice_number, lien_id, event, bank_org_id, detail, at) values ($1,$2,$3,$4,$5,$6,$7)', [inv.id, inv.human_id, lienId, event, bankOrgId, detail ?? null, svc.clock.now()]));
}

export async function selectOffer(tx: Tx, svc: Services, ctx: Ctx, supplierOrgId: string, offerId: string) {
  const o0 = await tx.maybe<any>('select invoice_id, bank_org_id from marketplace.offers where id = $1', [offerId]);
  if (!o0) throw notFound('Offer');
  const inv = await loadInvoice(tx, o0.invoice_id, true); // serialises concurrent selects on one invoice
  if (inv.supplier_org_id !== supplierOrgId) throw notFound('Offer');
  const live = await tx.maybe<any>('select 1 as x from marketplace.financing_requests where invoice_id = $1 and status = any($2)', [inv.id, LIVE_FR]);
  if (live || inv.route === 'financing') throw lienConflict(inv, o0.bank_org_id);
  if (inv.route === 'early_payment') throw conflict('route_locked', 'This invoice was already paid early.');
  if (inv.status !== 'OffersReceived') throw conflict('not_open', `Invoice ${inv.human_id} is ${inv.status}; there are no offers to select.`);
  const o = await tx.one<any>('select * from marketplace.offers where id = $1 for update', [offerId]);
  const now = svc.clock.now();
  if (o.status !== 'Submitted') throw conflict('offer_not_available', `This offer is ${o.status}.`);
  if (new Date(o.valid_until) <= now) throw conflict('offer_expired', 'This offer has expired. Ask the bank for a new one.');
  const cover = await coverForInvoice(tx, inv.id);
  const q = o.quote as any;
  const g = coverGate(cover, Number(q.minCoverPct ?? 0));
  if (!g.ok) throw new DomainError('cover_invalid', g.reason!, 409);
  const usd = await usdEq(svc, inv);
  await reserveLimits(tx, svc, { bankOrgId: o.bank_org_id, buyerOrgId: inv.buyer_org_id, supplierOrgId: inv.supplier_org_id, amountUsd: usd });
  const fr = await tx.one<any>(
    `insert into marketplace.financing_requests (invoice_id, offer_id, bank_org_id, supplier_org_id, buyer_org_id, status, reserved_usd, created_by, created_at, updated_at)
     values ($1,$2,$3,$4,$5,'ConsentPending',$6,$7,$8,$8) returning *`, [inv.id, o.id, o.bank_org_id, inv.supplier_org_id, inv.buyer_org_id, usd, ctx.userId ?? null, now]);
  const lien = await tx.elevated(() => tx.one<any>(
    `insert into marketplace.liens (invoice_id, invoice_number, financing_request_id, bank_org_id, supplier_org_id, buyer_org_id, status, reserved_at) values ($1,$2,$3,$4,$5,$6,'Reserved',$7) returning id`,
    [inv.id, inv.human_id, fr.id, o.bank_org_id, inv.supplier_org_id, inv.buyer_org_id, now]));
  await lienEvent(tx, svc, inv, lien.id, 'reserved', o.bank_org_id);
  await tx.query("update marketplace.offers set status = 'Selected', updated_at = $2 where id = $1", [o.id, now]);
  await setRoute(tx, inv.id, 'financing');
  await audit(tx, ctx, now, { action: 'financing.selected', entityType: 'financing_request', entityId: fr.id, orgId: inv.supplier_org_id, after: { offerId: o.id, bankOrgId: o.bank_org_id } });
  await audit(tx, ctx, now, { action: 'financing.selected', entityType: 'financing_request', entityId: fr.id, orgId: o.bank_org_id });
  await emit(tx, now, 'financing.selected', { financingRequestId: fr.id, invoiceId: inv.id, humanId: inv.human_id, bankOrgId: o.bank_org_id }, [inv.supplier_org_id, o.bank_org_id]);
  return fr;
}

export const CONSENT_TEXT = (a: { supplier: string; bank: string; invoice: string; amount: string; currency: string; netCash: string; netCashInr: string; allIn: string; law: string; ref: string }) =>
  `${a.supplier} assigns its right to receive payment of invoice ${a.invoice} (${formatMoney(a.amount, a.currency as 'USD')}) to ${a.bank} and authorises ${a.bank} to collect it from the buyer. ` +
  `${a.supplier} will receive net cash of ${formatMoney(a.netCash, a.currency as 'USD')} (${formatMoney(a.netCashInr, 'INR')}) at an all-in cost of ${a.allIn}% a year. ` +
  `The financing is insured and without recourse except for disputes caused by ${a.supplier}. Governed by ${a.law}. Notice reference ${a.ref}. You can cancel until the bank instructs the payment.`;

export async function consentFinancing(tx: Tx, svc: Services, ctx: Ctx, supplierOrgId: string, frId: string) {
  const fr = await tx.maybe<any>('select * from marketplace.financing_requests where id = $1 for update', [frId]);
  if (!fr || fr.supplier_org_id !== supplierOrgId) throw notFound('Financing request');
  if (fr.status !== 'ConsentPending') throw conflict('wrong_state', `This request is ${fr.status}.`);
  const inv = await loadInvoice(tx, fr.invoice_id);
  const o = await tx.one<any>('select * from marketplace.offers where id = $1', [fr.offer_id]);
  const now = svc.clock.now();
  if (new Date(o.valid_until) <= now) throw conflict('offer_expired', 'The offer expired before you consented. Cancel and choose again.');
  const names = await tx.elevated(() => tx.query<any>('select id, legal_name, country from identity.organisations where id = any($1)', [[inv.supplier_org_id, inv.buyer_org_id, fr.bank_org_id]]));
  const nm = (id: string) => names.find((x) => x.id === id)!;
  const lawRow = await tx.elevated(() => tx.maybe<any>("select value from platform.settings where key = 'governing_law'"));
  const law = (lawRow?.value as string) ?? 'the laws of India, with the courts at Mumbai having jurisdiction';
  const ref = `AN-${inv.human_id}-${now.getTime().toString(36).toUpperCase()}`;
  const buyerCountry = nm(inv.buyer_org_id).country;
  const text = CONSENT_TEXT({ supplier: nm(inv.supplier_org_id).legal_name, bank: nm(fr.bank_org_id).legal_name, invoice: inv.human_id, amount: amountOf(inv), currency: inv.currency, netCash: o.net_cash, netCashInr: o.net_cash_inr, allIn: o.all_in_pct, law, ref });
  await tx.query(
    `insert into marketplace.assignment_notices (invoice_id, financing_request_id, bank_org_id, supplier_org_id, buyer_org_id, reference, governing_law, body, us_filing, sg_data_consent, issued_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (invoice_id) do update set financing_request_id = excluded.financing_request_id, bank_org_id = excluded.bank_org_id, reference = excluded.reference, governing_law = excluded.governing_law, body = excluded.body, us_filing = excluded.us_filing, sg_data_consent = excluded.sg_data_consent, issued_at = excluded.issued_at`,
    [inv.id, fr.id, fr.bank_org_id, inv.supplier_org_id, inv.buyer_org_id, ref, law, text,
     buyerCountry === 'US' ? JSON.stringify({ state: 'DE', filingReference: `UCC-SIM-${inv.human_id}`, status: 'simulated_pending' }) : null, buyerCountry === 'SG' ? true : null, now]);
  await tx.elevated(() => tx.query("update marketplace.liens set assignment_ref = $2 where financing_request_id = $1", [fr.id, ref]));
  await tx.query("update marketplace.financing_requests set status = 'BankConfirming', consent_text = $2, consented_by = $3, consented_at = $4, updated_at = $4 where id = $1", [fr.id, text, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'financing.consented', entityType: 'financing_request', entityId: fr.id, orgId: inv.supplier_org_id, after: { noticeRef: ref } });
  await audit(tx, ctx, now, { action: 'financing.consented', entityType: 'financing_request', entityId: fr.id, orgId: inv.buyer_org_id });
  await emit(tx, now, 'financing.consented', { financingRequestId: fr.id, invoiceId: inv.id, humanId: inv.human_id, noticeRef: ref }, [inv.supplier_org_id, inv.buyer_org_id, fr.bank_org_id]);
  return { noticeRef: ref };
}

async function releaseFinancing(tx: Tx, svc: Services, ctx: Ctx, fr: any, inv: any, newStatus: 'Cancelled' | 'Declined' | 'Failed', reason: string, offerBack: boolean) {
  const now = svc.clock.now();
  await tx.query('update marketplace.financing_requests set status = $2, decision_reason = $3, decided_by = $4, decided_at = $5, updated_at = $5 where id = $1', [fr.id, newStatus, reason, ctx.userId ?? null, now]);
  await tx.elevated(() => tx.query("update marketplace.liens set status = 'Released', released_at = $2, release_reason = $3 where financing_request_id = $1 and status in ('Reserved','Active')", [fr.id, now, reason]));
  await releaseReserved(tx, svc, { bankOrgId: fr.bank_org_id, buyerOrgId: fr.buyer_org_id, supplierOrgId: fr.supplier_org_id, amountUsd: fr.reserved_usd });
  const o = await tx.one<any>('select * from marketplace.offers where id = $1', [fr.offer_id]);
  const stillValid = new Date(o.valid_until) > now;
  await tx.elevated(() => tx.query('update marketplace.offers set status = $2, decision_note = $3, updated_at = $4 where id = $1', [o.id, offerBack && stillValid ? 'Submitted' : offerBack ? 'Expired' : 'Rejected', reason, now]));
  await setRoute(tx, inv.id, null);
  await lienEvent(tx, svc, inv, null, `released_${newStatus.toLowerCase()}`, fr.bank_org_id, reason);
  await reopenIfNoOffers(tx, svc, ctx, inv.id);
  await audit(tx, ctx, now, { action: `financing.${newStatus.toLowerCase()}`, entityType: 'financing_request', entityId: fr.id, orgId: fr.supplier_org_id, after: { reason } });
  await audit(tx, ctx, now, { action: `financing.${newStatus.toLowerCase()}`, entityType: 'financing_request', entityId: fr.id, orgId: fr.bank_org_id });
  await emit(tx, now, `financing.${newStatus.toLowerCase()}`, { financingRequestId: fr.id, invoiceId: inv.id, humanId: inv.human_id, reason }, [fr.supplier_org_id, fr.bank_org_id]);
}

/** Cooling-off: the supplier can cancel until the bank has instructed the payment. */
export async function cancelFinancing(tx: Tx, svc: Services, ctx: Ctx, supplierOrgId: string, frId: string, reason?: string) {
  const fr = await tx.maybe<any>('select * from marketplace.financing_requests where id = $1 for update', [frId]);
  if (!fr || fr.supplier_org_id !== supplierOrgId) throw notFound('Financing request');
  if (!['ConsentPending', 'BankConfirming', 'Approved'].includes(fr.status)) throw conflict('cannot_cancel', fr.status === 'Cancelled' ? 'Already cancelled.' : `The bank has already ${fr.status === 'Funded' ? 'funded' : 'instructed'} this payment; it can no longer be cancelled.`);
  const inv = await loadInvoice(tx, fr.invoice_id, true);
  await releaseFinancing(tx, svc, ctx, fr, inv, 'Cancelled', reason?.trim() || 'Cancelled by the supplier (cooling-off)', true);
}

export async function bankDecline(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, frId: string, reason: string) {
  const fr = await tx.maybe<any>('select * from marketplace.financing_requests where id = $1 and bank_org_id = $2 for update', [frId, bankOrgId]);
  if (!fr) throw notFound('Financing request');
  if (!['ConsentPending', 'BankConfirming'].includes(fr.status)) throw conflict('wrong_state', `This request is ${fr.status}.`);
  if (!reason?.trim()) throw invalid('Please give a reason for declining.');
  const inv = await lockInvoice(tx, fr.invoice_id);
  await releaseFinancing(tx, svc, ctx, fr, inv, 'Declined', reason.trim(), false);
}

/** Bank re-checks parties, limits (already reserved), cover, dispute window and the buyer's acknowledgement before it commits. */
export async function bankConfirm(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, frId: string) {
  const fr = await tx.maybe<any>('select * from marketplace.financing_requests where id = $1 and bank_org_id = $2 for update', [frId, bankOrgId]);
  if (!fr) throw notFound('Financing request');
  if (fr.status !== 'BankConfirming') throw conflict('wrong_state', fr.status === 'ConsentPending' ? 'The supplier has not given consent yet.' : `This request is ${fr.status}.`);
  const inv = await lockInvoice(tx, fr.invoice_id);
  const now = svc.clock.now();
  const blocks = (await Promise.all([inv.supplier_org_id, inv.buyer_org_id, bankOrgId].map((id) => transactBlockReason(tx, id)))).filter(Boolean) as string[];
  if (blocks.length) throw new DomainError('blocked', blocks[0]!, 422);
  const gates = await fundingGates(tx, svc, inv, { forFunding: true });
  const bad = gates.find((g) => !g.ok);
  if (bad) throw new DomainError('gate_failed', bad.reason!, 409);
  const cover = await coverForInvoice(tx, inv.id);
  const o = await tx.one<any>('select quote from marketplace.offers where id = $1', [fr.offer_id]);
  const minCover = Number((o.quote as any).minCoverPct ?? 0);
  const cg = coverGate(cover, minCover);
  if (!cg.ok) throw new DomainError('cover_invalid', cg.reason!, 409);
  const ack = await tx.maybe<any>("select assignment_ack_at from invoicing.acceptances where invoice_id = $1 and decision <> 'rejected' order by decided_at desc limit 1", [inv.id]);
  if (!ack?.assignment_ack_at) throw new DomainError('assignment_unacknowledged', 'The buyer has not yet acknowledged the assignment notice, so funding cannot start.', 409);
  await tx.query("update marketplace.financing_requests set status = 'Approved', decided_by = $2, decided_at = $3, updated_at = $3 where id = $1", [fr.id, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'financing.approved', entityType: 'financing_request', entityId: fr.id, orgId: bankOrgId });
  await audit(tx, ctx, now, { action: 'financing.approved', entityType: 'financing_request', entityId: fr.id, orgId: inv.supplier_org_id });
  // The payment is instructed through the Settlement module (event `financing.approved`); funding completes only when the
  // disbursement is credited, at which point Settlement calls `completeFunding`.
  await tx.query("update marketplace.financing_requests set status = 'DisbursementInstructed', updated_at = $2 where id = $1", [fr.id, now]);
  await emit(tx, now, 'financing.approved', { financingRequestId: fr.id, invoiceId: inv.id, humanId: inv.human_id }, [inv.supplier_org_id, bankOrgId]);
  return { status: 'DisbursementInstructed' as const };
}

/** A disbursement that could not be completed: everything is released and the supplier can choose again. */
export async function failFinancing(tx: Tx, svc: Services, ctx: Ctx, frId: string, reason: string) {
  const fr = await tx.elevated(() => tx.one<any>('select * from marketplace.financing_requests where id = $1 for update', [frId]));
  const inv = await lockInvoice(tx, fr.invoice_id);
  await releaseFinancing(tx, svc, ctx, fr, inv, 'Failed', reason, true);
}

/** The step that makes a financing real: lien Active, limits and cover consumed, invoice Funded, competing offers rejected. */
export async function completeFunding(tx: Tx, svc: Services, ctx: Ctx, frId: string) {
  const fr = await tx.one<any>('select * from marketplace.financing_requests where id = $1 for update', [frId]);
  if (fr.status !== 'DisbursementInstructed' && fr.status !== 'Approved') throw conflict('wrong_state', `This request is ${fr.status}.`);
  const inv = await tx.elevated(() => tx.one<any>('select * from invoicing.invoices where id = $1 for update', [fr.invoice_id]));
  const now = svc.clock.now();
  await tx.elevated(() => tx.query("update marketplace.liens set status = 'Active', activated_at = $2 where financing_request_id = $1 and status = 'Reserved'", [fr.id, now]));
  await consumeLimits(tx, svc, { bankOrgId: fr.bank_org_id, buyerOrgId: fr.buyer_org_id, supplierOrgId: fr.supplier_org_id, amountUsd: fr.reserved_usd });
  await consumeCover(tx, svc, inv.id);
  await tx.elevated(() => tx.query("update marketplace.financing_requests set status = 'Funded', funded_at = $2, updated_at = $2 where id = $1", [fr.id, now]));
  const rejected = await tx.elevated(() => tx.query<any>("update marketplace.offers set status = 'Rejected', decision_note = 'Another offer was funded', updated_at = $2 where invoice_id = $1 and status in ('Drafted','Submitted') returning id, bank_org_id", [inv.id, now]));
  await tx.elevated(() => tx.query("update marketplace.invitations set status = 'closed' where invoice_id = $1 and bank_org_id <> $2", [inv.id, fr.bank_org_id]));
  for (const r of rejected) await emit(tx, now, 'offer.rejected', { offerId: r.id, invoiceId: inv.id }, [r.bank_org_id]);
  await moveInvoice(tx, svc, ctx, inv, 'Funded', { note: 'Financing funded; lien active', event: 'invoice.funded', set: { route: 'financing' }, payload: { route: 'financing', bankOrgId: fr.bank_org_id } });
  await lienEvent(tx, svc, inv, null, 'activated', fr.bank_org_id);
  await audit(tx, ctx, now, { action: 'financing.funded', entityType: 'financing_request', entityId: fr.id, orgId: inv.supplier_org_id });
  await audit(tx, ctx, now, { action: 'financing.funded', entityType: 'financing_request', entityId: fr.id, orgId: fr.bank_org_id });
  await emit(tx, now, 'financing.funded', { financingRequestId: fr.id, invoiceId: inv.id, humanId: inv.human_id }, [inv.supplier_org_id, inv.buyer_org_id, fr.bank_org_id]);
}
