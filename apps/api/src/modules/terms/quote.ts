import type { Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { daysBetween } from '../pricing/calendar';
import { coverForInvoice, coverGate } from '../insurance/service';
import { corridorOf, resolveTerms } from './service';
import { evaluateOffer, type OfferEvaluation } from './evaluate';

export interface OfferOverrides { ratePct?: number; advancePct?: number; fxSpreadPct?: number; validityHours?: number }
export interface QuoteResult { evaluation: OfferEvaluation; tenorDays: number; amount: string; currency: string; explanation: Record<string, any>; cover: { status: string; coverPct: number | null } | null }

/**
 * Would this bank fund this invoice, and at what cost? Gates 5 to 7 plus pricing, using the real cover record when there is one.
 * A bank may compose an offer that differs from its terms only within them: the advance cannot exceed the terms, the rate must be sane,
 * and platform guardrails (FX spread, small-supplier cost cap) still apply inside `evaluateOffer`.
 */
export async function quoteForBank(
  tx: Tx, svc: Services, inv: any, bankOrgId: string,
  opts: { insurerOrgId?: string; coverPct?: number; overrides?: OfferOverrides } = {},
): Promise<QuoteResult> {
  const now = svc.clock.now();
  const [buyer, supplier] = await tx.elevated(async () => [
    await tx.one<any>('select * from identity.organisations where id = $1', [inv.buyer_org_id]),
    await tx.one<any>('select * from identity.organisations where id = $1', [inv.supplier_org_id]),
  ]);
  if (!buyer.rating_tier) throw invalid('The buyer has no rating tier on file.');
  const bank = await tx.elevated(() => tx.maybe<any>("select id from identity.organisations where id = $1 and type = 'bank'", [bankOrgId]));
  if (!bank) throw notFound('Bank');
  const ctx = { buyerOrgId: buyer.id, supplierOrgId: supplier.id, corridor: corridorOf(supplier.country, buyer.country) };
  const bankTerms = await resolveTerms(tx, now, 'bank', bank.id, ctx);
  const platform = await resolveTerms(tx, now, 'platform', null, ctx);
  const real = await coverForInvoice(tx, inv.id);
  const insurerId = opts.insurerOrgId ?? real?.insurerOrgId ?? undefined;
  const insurerTerms = insurerId ? await resolveTerms(tx, now, 'insurer', insurerId, ctx) : null;
  const today = now.toISOString().slice(0, 10);
  const tenor = daysBetween(today, String(inv.due_date).slice(0, 10)) + Number(bankTerms.terms.graceDays ?? 0);
  if (tenor <= 0) throw invalid('The invoice is already due.');
  const amount = inv.accepted_amount ?? inv.gross_amount;
  const base = { tenorDays: tenor, amount, currency: inv.currency as string, explanation: bankTerms.explanation, cover: real ? { status: real.status, coverPct: real.coverPct } : null };
  if (real && opts.coverPct == null && !['approved', 'partial'].includes(real.status)) {
    const g = coverGate(real, 0);
    return { ...base, evaluation: { eligible: false, reasons: [g.reason!], gate: 'cover' } };
  }
  // Compose within terms.
  const terms: Record<string, any> = { ...bankTerms.terms };
  const o = opts.overrides ?? {};
  if (o.advancePct !== undefined) {
    if (o.advancePct <= 0 || o.advancePct > terms.advancePct) throw new DomainError('outside_terms', `Your terms allow an advance of up to ${terms.advancePct}%; ${o.advancePct}% is not allowed.`, 422);
    terms.advancePct = o.advancePct;
  }
  if (o.ratePct !== undefined) {
    if (o.ratePct < 0 || o.ratePct > 60) throw new DomainError('outside_terms', 'The rate must be between 0% and 60% a year.', 422);
    terms.pricing = { type: 'fixed', ratePct: o.ratePct };
  }
  if (o.fxSpreadPct !== undefined) {
    if (o.fxSpreadPct < 0) throw new DomainError('outside_terms', 'The FX spread cannot be negative.', 422);
    terms.fxSpreadPct = o.fxSpreadPct;
  }
  if (o.validityHours !== undefined) {
    if (o.validityHours < 1 || o.validityHours > 168) throw new DomainError('outside_terms', 'Offers can be valid for 1 to 168 hours.', 422);
    terms.offerValidityHours = o.validityHours;
  }
  const lim = await tx.elevated(() => tx.query<any>('select subject_org_id, limit_usd, reserved_usd, used_usd from identity.bank_limits where bank_org_id = $1 and subject_org_id = any($2)', [bank.id, [buyer.id, supplier.id]]));
  const avail = (id: string) => { const l = lim.find((x) => x.subject_org_id === id); return l ? D(l.limit_usd).minus(l.reserved_usd).minus(l.used_usd).toFixed(2) : '0.00'; };
  const coverPct = opts.coverPct ?? real?.coverPct ?? null;
  const evaluation = evaluateOffer({
    now, invoice: { amount, currency: inv.currency as 'USD', tenorDays: tenor }, buyer: { country: buyer.country, tier: buyer.rating_tier },
    supplier: { country: supplier.country, small: supplier.small, borrowingRatePct: supplier.borrowing_rate ? Number(supplier.borrowing_rate) : null },
    bank: terms, insurer: insurerTerms?.terms ?? null, platform: platform.terms, cover: coverPct != null ? { coverPct } : null,
    headroom: { bankBuyerUsd: avail(buyer.id), bankSupplierUsd: avail(supplier.id) },
    mids: { USDINR: await svc.adapters.fx.mid('USDINR', now), SGDINR: await svc.adapters.fx.mid('SGDINR', now) },
    termsVersionIds: [...new Set([...bankTerms.versionIds, ...platform.versionIds, ...(insurerTerms?.versionIds ?? [])])],
  });
  return { ...base, evaluation };
}
