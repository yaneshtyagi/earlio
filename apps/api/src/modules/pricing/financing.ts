import { D, round2, sum, type Dec, type DecValue } from '../../kernel/money';

export interface FinancingInput {
  faceAmount: DecValue;
  /** Advance as percent of face (90 = 90%). */
  advancePct: DecValue;
  /** Annual discount rate in percent (5.85 = 5.85%). */
  ratePct: DecValue;
  /** Days from funding to due date plus grace days. */
  tenorDays: number;
  processingPct: DecValue;
  processingMin?: DecValue;
  /** Platform fee in basis points on the advance. */
  platformFeeBps: DecValue;
  platformFeePayer: 'bank' | 'supplier';
  /** Insurance premium amount and who pays it (computed by premiumFor). */
  premium?: DecValue;
  premiumPayer?: 'bank' | 'supplier';
}
export interface FinancingBreakdown {
  advance: string; retention: string; discount: string; processingFee: string; platformFee: string; premium: string;
  /** Lines charged to the supplier (sum of the rounded lines). */
  totalCharges: string; netCash: string; allInAnnualisedPct: string; tenorDays: number;
  platformFeePaidBy: 'bank' | 'supplier'; premiumPaidBy: 'bank' | 'supplier';
}

/** Discount-to-yield, deducted upfront, actual/365 (BR-3). Each charge is rounded to 2 dp and the rounded lines are summed. */
export function priceFinancing(i: FinancingInput): FinancingBreakdown {
  if (i.tenorDays <= 0) throw new Error('tenorDays must be positive');
  const face = D(i.faceAmount);
  const advance = round2(face.times(D(i.advancePct).div(100)));
  const retention = face.minus(advance);
  const discount = round2(advance.times(D(i.ratePct).div(100)).times(i.tenorDays).div(365));
  let processing = round2(face.times(D(i.processingPct).div(100)));
  if (i.processingMin != null && processing.lt(D(i.processingMin))) processing = round2(i.processingMin);
  const platformFee = round2(advance.times(D(i.platformFeeBps).div(10000)));
  const premium = round2(i.premium ?? 0);
  const premiumPayer = i.premiumPayer ?? 'supplier';
  const supplierLines = [discount, processing, i.platformFeePayer === 'supplier' ? platformFee : D(0), premiumPayer === 'supplier' ? premium : D(0)];
  const totalCharges = sum(supplierLines);
  const netCash = advance.minus(totalCharges);
  const allIn = totalCharges.div(netCash).times(365).div(i.tenorDays).times(100);
  return {
    advance: advance.toFixed(2), retention: retention.toFixed(2), discount: discount.toFixed(2), processingFee: processing.toFixed(2),
    platformFee: platformFee.toFixed(2), premium: premium.toFixed(2), totalCharges: totalCharges.toFixed(2), netCash: netCash.toFixed(2),
    allInAnnualisedPct: allIn.toFixed(2), tenorDays: i.tenorDays, platformFeePaidBy: i.platformFeePayer, premiumPaidBy: premiumPayer,
  };
}

/** Insurance premium (CT-2): per-period rate on the insured amount (one period per started `periodDays`), or a flat rate. */
export function premiumFor(insuredAmount: DecValue, ratePct: DecValue, tenorDays: number, mode: 'per_period' | 'flat', periodDays = 90): Dec {
  const periods = mode === 'flat' ? 1 : Math.max(1, Math.ceil(tenorDays / periodDays));
  return round2(D(insuredAmount).times(D(ratePct).div(100)).times(periods));
}
