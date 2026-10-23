import { D } from '../../kernel/money';
import { evaluateRule } from './rules';
import { GUARDRAILS } from './guardrails';
import { priceFinancing, premiumFor, type FinancingBreakdown } from '../pricing/financing';
import { bankRate, inrAmount, usdEquivalent } from '../pricing/fx';
import { addDays } from '../pricing/calendar';

export interface OfferInputs {
  now: Date;
  invoice: { amount: string; currency: 'USD' | 'SGD'; tenorDays: number; goods?: string | null };
  buyer: { country: string; tier: 'AA' | 'A' | 'BBB' };
  supplier: { country: string; small: boolean; borrowingRatePct?: number | null };
  bank: Record<string, any>;
  insurer: Record<string, any> | null;
  platform: Record<string, any>;
  /** Approved cover record (M5). When absent and an insurer is given, the insurer's tier default is assumed and flagged. */
  cover?: { coverPct: number } | null;
  /** Remaining exposure headroom in USD equivalent at the bank (and insurer), if known. */
  headroom?: { bankBuyerUsd?: string; bankSupplierUsd?: string; insurerBuyerUsd?: string };
  mids: { USDINR: string; SGDINR: string };
  termsVersionIds: string[];
}

export interface OfferQuote {
  breakdown: FinancingBreakdown;
  ratePct: string; advancePct: string; advanceCappedToCover: boolean;
  coverPct: number; coverAssumed: boolean; insuredAmount: string;
  fx: { pair: string; mid: string; spreadPct: string; rate: string; netCashInr: string; advanceInr: string };
  validUntil: string; insured: true; nonRecourse: true; termsVersionIds: string[];
  supplierBorrowingRatePct: number | null; savingVsBorrowingPct: string | null;
}
export interface OfferEvaluation { eligible: boolean; reasons: string[]; gate?: 'cover' | 'limits' | 'terms' | 'guardrail'; quote?: OfferQuote }

const fail = (gate: OfferEvaluation['gate'], reasons: string[]): OfferEvaluation => ({ eligible: false, gate, reasons });

/** BR-1 gates 5 to 7 plus pricing. Pure: all inputs are passed in. */
export function evaluateOffer(i: OfferInputs): OfferEvaluation {
  const b = i.bank;
  const amountUsdEq = usdEquivalent(i.invoice.amount, i.invoice.currency, i.mids);

  // Gate 7: bank terms eligibility (checked first so the supplier sees the most actionable reason).
  const reasons: string[] = [];
  if (!b.currencies?.includes(i.invoice.currency)) reasons.push(`This bank funds ${b.currencies?.join(' and ')} invoices; this one is in ${i.invoice.currency}.`);
  if (!b.buyerCountries?.includes(i.buyer.country)) reasons.push(`This bank funds buyers in ${b.buyerCountries?.join(', ')}; this buyer is in ${i.buyer.country}.`);
  if (i.invoice.tenorDays > b.maxTenorDays) reasons.push(`Tenor of ${i.invoice.tenorDays} days is above this bank's maximum of ${b.maxTenorDays} days.`);
  if (amountUsdEq.lt(b.invoiceSizeUsd.min)) reasons.push(`The invoice (about USD ${amountUsdEq.toFixed(0)}) is below this bank's minimum of USD ${b.invoiceSizeUsd.min}.`);
  if (amountUsdEq.gt(b.invoiceSizeUsd.max)) reasons.push(`The invoice (about USD ${amountUsdEq.toFixed(0)}) is above this bank's maximum of USD ${b.invoiceSizeUsd.max}.`);
  if (b.goods?.allowed && i.invoice.goods && !b.goods.allowed.includes(i.invoice.goods)) reasons.push(`This bank does not fund ${i.invoice.goods}.`);
  if (b.goods?.excluded && i.invoice.goods && b.goods.excluded.includes(i.invoice.goods)) reasons.push(`This bank does not fund ${i.invoice.goods}.`);
  const facts = {
    buyer: { country: i.buyer.country, tier: i.buyer.tier }, supplier: { country: i.supplier.country, small: i.supplier.small },
    invoice: { currency: i.invoice.currency, tenorDays: i.invoice.tenorDays, amountUsdEq: amountUsdEq.toNumber(), goods: i.invoice.goods ?? null },
    corridor: `${i.supplier.country}-${i.buyer.country}`,
  };
  if (b.eligibility) {
    const r = evaluateRule(b.eligibility, facts);
    if (!r.pass) for (const x of r.reasons) if (!reasons.includes(x)) reasons.push(x);
  }
  // Pricing for this tier
  let ratePct: number | undefined;
  if (b.pricing.type === 'fixed') ratePct = b.pricing.ratePct;
  else {
    const spread = b.pricing.spreadPctByTier?.[i.buyer.tier];
    if (spread === undefined) reasons.push(`This bank does not price buyers rated ${i.buyer.tier}.`);
    else ratePct = Number(i.platform.benchmarkRatePct) + spread;
  }
  if (reasons.length) return fail('terms', reasons);

  // Gate 5: cover
  if (!i.insurer && !i.cover) return fail('cover', ['Insurance cover has not been approved for this invoice yet.']);
  let coverPct: number, coverAssumed = false;
  if (i.cover) coverPct = i.cover.coverPct;
  else { coverPct = i.insurer!.coverPctByTier?.[i.buyer.tier] ?? i.insurer!.coverPct; coverAssumed = true; }
  if (coverPct < b.minCoverPct) return fail('cover', [`Insurance cover of ${coverPct}% is below this bank's minimum of ${b.minCoverPct}%.`]);

  // Gate 6: limits headroom
  const limitReasons: string[] = [];
  if (i.headroom?.bankBuyerUsd !== undefined && amountUsdEq.gt(i.headroom.bankBuyerUsd)) limitReasons.push(`This bank's limit for this buyer has only USD ${D(i.headroom.bankBuyerUsd).toFixed(2)} available.`);
  if (i.headroom?.bankSupplierUsd !== undefined && amountUsdEq.gt(i.headroom.bankSupplierUsd)) limitReasons.push(`This bank's limit for this supplier has only USD ${D(i.headroom.bankSupplierUsd).toFixed(2)} available.`);
  if (i.headroom?.insurerBuyerUsd !== undefined && amountUsdEq.gt(i.headroom.insurerBuyerUsd)) limitReasons.push(`The insurer's buyer limit has only USD ${D(i.headroom.insurerBuyerUsd).toFixed(2)} available.`);
  if (limitReasons.length) return fail('limits', limitReasons);

  // Advance: for small suppliers the advance cannot exceed the insured cover (BR-11.6)
  let advancePct = b.advancePct as number, capped = false;
  if (i.supplier.small && advancePct > coverPct) { advancePct = coverPct; capped = true; }

  // Price
  const insuredAmount = D(i.invoice.amount).times(D(coverPct).div(100));
  let premium = D(0), premiumPayer: 'bank' | 'supplier' = 'supplier';
  if (i.insurer) {
    const p = i.insurer.premium;
    const rate = p.mode === 'flat' ? p.flatRatePct : p.ratePctByTier?.[i.buyer.tier];
    if (rate === undefined) return fail('cover', [`The insurer does not price buyers rated ${i.buyer.tier}.`]);
    premium = premiumFor(insuredAmount, rate, i.invoice.tenorDays, p.mode, p.periodDays ?? 90);
    premiumPayer = p.payer;
  }
  const platformFee = i.platform.platformFee;
  const breakdown = priceFinancing({
    faceAmount: i.invoice.amount, advancePct, ratePct: ratePct!, tenorDays: i.invoice.tenorDays, processingPct: b.processingFee.pct, processingMin: b.processingFee.minUsd,
    platformFeeBps: platformFee.bps, platformFeePayer: b.platformFeePayer ?? platformFee.payer, premium, premiumPayer,
  });

  // Guardrails on the quote
  const g: string[] = [];
  if (b.fxSpreadPct > Math.min(GUARDRAILS.maxFxSpreadPct, Number(i.platform.maxFxSpreadPct ?? GUARDRAILS.maxFxSpreadPct))) g.push(`The FX spread of ${b.fxSpreadPct}% is above the platform maximum.`);
  const cap = Math.min(GUARDRAILS.maxAllInCostSmallPct, Number(i.platform.maxAllInCostSmallPct ?? GUARDRAILS.maxAllInCostSmallPct));
  if (i.supplier.small && D(breakdown.allInAnnualisedPct).gt(cap)) g.push(`This offer would cost ${breakdown.allInAnnualisedPct}% a year all-in, above the ${cap}% cap for small suppliers.`);
  if (g.length) return fail('guardrail', g);

  const pair = i.invoice.currency === 'USD' ? 'USDINR' : 'SGDINR';
  const mid = i.mids[pair];
  const rate = bankRate(mid, b.fxSpreadPct);
  const borrowing = i.supplier.borrowingRatePct ?? null;
  return {
    eligible: true, reasons: [],
    quote: {
      breakdown, ratePct: D(ratePct!).toFixed(2), advancePct: String(advancePct), advanceCappedToCover: capped, coverPct, coverAssumed, insuredAmount: insuredAmount.toFixed(2),
      fx: { pair, mid, spreadPct: D(b.fxSpreadPct).toFixed(2), rate: rate.toFixed(4), netCashInr: inrAmount(breakdown.netCash, rate).toFixed(2), advanceInr: inrAmount(breakdown.advance, rate).toFixed(2) },
      validUntil: new Date(i.now.getTime() + b.offerValidityHours * 3_600_000).toISOString(), insured: true, nonRecourse: true, termsVersionIds: i.termsVersionIds,
      supplierBorrowingRatePct: borrowing, savingVsBorrowingPct: borrowing == null ? null : D(borrowing).minus(breakdown.allInAnnualisedPct).toFixed(2),
    },
  };
}

export const fundingDateFor = (today: string, settlementDays: number) => addDays(today, settlementDays);
