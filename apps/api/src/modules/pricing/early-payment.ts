import { D, round2, type Dec, type DecValue } from '../../kernel/money';

/** Annualised cost of an early-payment discount (BR-2): d / (1 - d) * 365 / n. `discountPct` is in percent (1 = 1%). */
export function annualisedDiscountCostPct(discountPct: DecValue, daysEarly: number): Dec {
  if (daysEarly <= 0) throw new Error('daysEarly must be positive');
  const d = D(discountPct).div(100);
  if (d.gte(1)) throw new Error('discount must be below 100%');
  return d.div(D(1).minus(d)).times(365).div(daysEarly).times(100);
}

/** Pro-rata mode: discount % for an annual rate r (percent) over n days: r*n/365 / (1 + r*n/365). */
export function discountPctFromAnnualRate(annualRatePct: DecValue, daysEarly: number): Dec {
  const x = D(annualRatePct).div(100).times(daysEarly).div(365);
  return x.div(D(1).plus(x)).times(100);
}

export interface EarlyPaymentInput {
  faceAmount: DecValue;
  discountPct: DecValue;
  daysEarly: number;
  /** Bank commission as a share of the discount, in percent (default 20). */
  commissionSharePct?: DecValue;
  buyerCashYieldPct?: DecValue;
  supplierBorrowingRatePct?: DecValue | null;
  /** Platform cap on annualised cost, percent. */
  guardrailCapPct?: DecValue | null;
}
export interface EarlyPaymentResult {
  buyerPays: string; discount: string; annualisedCostPct: string; commission: string; buyerNetSaving: string; buyerReturnPct: string;
  buyerBeatsCashYield: boolean | null; warnings: string[];
}

export function priceEarlyPayment(i: EarlyPaymentInput): EarlyPaymentResult {
  const face = D(i.faceAmount);
  const discount = round2(face.times(D(i.discountPct).div(100)));
  const buyerPays = face.minus(discount);
  const ann = annualisedDiscountCostPct(i.discountPct, i.daysEarly);
  const commission = round2(discount.times(D(i.commissionSharePct ?? 20).div(100)));
  const warnings: string[] = [];
  if (i.supplierBorrowingRatePct != null && ann.gt(D(i.supplierBorrowingRatePct))) {
    warnings.push(`This discount costs ${ann.toFixed(2)}% a year, more than your own borrowing rate of ${D(i.supplierBorrowingRatePct).toFixed(2)}%.`);
  }
  if (i.guardrailCapPct != null && ann.gt(D(i.guardrailCapPct))) {
    warnings.push(`This discount costs ${ann.toFixed(2)}% a year, above the platform cap of ${D(i.guardrailCapPct).toFixed(2)}% for small suppliers.`);
  }
  return {
    buyerPays: buyerPays.toFixed(2), discount: discount.toFixed(2), annualisedCostPct: ann.toFixed(2), commission: commission.toFixed(2),
    buyerNetSaving: discount.minus(commission).toFixed(2), buyerReturnPct: ann.toFixed(2),
    buyerBeatsCashYield: i.buyerCashYieldPct == null ? null : ann.gt(D(i.buyerCashYieldPct)), warnings,
  };
}
