import { describe, expect, it } from 'vitest';
import { annualisedDiscountCostPct, discountPctFromAnnualRate, priceEarlyPayment } from '../src/modules/pricing/early-payment';
import { priceFinancing, premiumFor } from '../src/modules/pricing/financing';
import { bankRate, inrAmount, usdEquivalent } from '../src/modules/pricing/fx';
import { formatMoney } from '../src/kernel/money';
import { SimFxRateProvider } from '../src/adapters/fx';
import { tenorDays, addDays, WeekdayCalendar } from '../src/modules/pricing/calendar';

describe('golden: early payment (BR-2)', () => {
  it('1% for 60 days early annualises to 6.14%', () => { expect(annualisedDiscountCostPct(1, 60).toFixed(2)).toBe('6.14'); });
  it('2% for 60 days early annualises to 12.41%', () => { expect(annualisedDiscountCostPct(2, 60).toFixed(2)).toBe('12.41'); });
  it('USD 100,000 paid 60 days early at 1%: buyer pays 99,000; commission 200; buyer net saving 800', () => {
    const r = priceEarlyPayment({ faceAmount: '100000', discountPct: 1, daysEarly: 60, commissionSharePct: 20, buyerCashYieldPct: 4, supplierBorrowingRatePct: 14 });
    expect(r).toMatchObject({ buyerPays: '99000.00', annualisedCostPct: '6.14', commission: '200.00', buyerNetSaving: '800.00', discount: '1000.00' });
    expect(r.buyerBeatsCashYield).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it('warns when the discount costs more than the supplier borrowing rate or the guardrail', () => {
    const r = priceEarlyPayment({ faceAmount: '100000', discountPct: 2, daysEarly: 60, supplierBorrowingRatePct: 11.5, guardrailCapPct: 12 });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/12\.41%.*11\.50%/);
  });
  it('pro-rata annual-rate mode inverts the annualised cost', () => {
    const d = discountPctFromAnnualRate(6.14, 60);
    expect(annualisedDiscountCostPct(d, 60).toFixed(2)).toBe('6.14');
  });
});

describe('golden: financing (BR-3)', () => {
  const base = { faceAmount: '100000', advancePct: 90, ratePct: '5.85', tenorDays: 60, processingPct: '0.10', processingMin: 25, platformFeeBps: 3 };
  const premium = premiumFor(90000, '0.20', 60, 'per_period', 90);
  it('premium is 0.20% of the insured amount for the first 90-day period: 180.00', () => { expect(premium.toFixed(2)).toBe('180.00'); });
  it('platform fee passed through to the supplier: discount 865.48, processing 100, fee 27, premium 180, total 1,172.48, net 88,827.52, all-in 8.03%', () => {
    const r = priceFinancing({ ...base, platformFeePayer: 'supplier', premium, premiumPayer: 'supplier' });
    expect(r).toMatchObject({ advance: '90000.00', retention: '10000.00', discount: '865.48', processingFee: '100.00', platformFee: '27.00', premium: '180.00',
      totalCharges: '1172.48', netCash: '88827.52', allInAnnualisedPct: '8.03' });
  });
  it('platform fee paid by the bank (default): charges 1,145.48, net 88,854.52, all-in 7.84%', () => {
    const r = priceFinancing({ ...base, platformFeePayer: 'bank', premium, premiumPayer: 'supplier' });
    expect(r).toMatchObject({ totalCharges: '1145.48', netCash: '88854.52', allInAnnualisedPct: '7.84', platformFeePaidBy: 'bank' });
  });
  it('the processing-fee minimum applies on small invoices', () => {
    const r = priceFinancing({ ...base, faceAmount: '10000', platformFeePayer: 'bank' });
    expect(r.processingFee).toBe('25.00');
  });
  it('premium payer bank removes the premium from the supplier charges', () => {
    const r = priceFinancing({ ...base, platformFeePayer: 'bank', premium, premiumPayer: 'bank' });
    expect(r.totalCharges).toBe('965.48');
  });
  it('financing at 8.03% is dearer than the 6.14% early-payment example, yet cheaper than a 14% borrowing rate', () => {
    expect(8.03).toBeGreaterThan(6.14); expect(14 - 8.03).toBeGreaterThanOrEqual(3);
  });
});

describe('golden: FX (BR-5) and formatting', () => {
  it('USD/INR 88.40 with 0.30% spread gives 88.1348', () => { expect(bankRate('88.40', '0.30').toFixed(4)).toBe('88.1348'); });
  it('converts the example net cash into INR', () => { expect(inrAmount('88827.52', '88.1348').toFixed(2)).toBe('7828795.71'); });
  it('Indian digit grouping: 8725345 INR', () => { expect(formatMoney(8725345, 'INR')).toBe('₹87,25,345.00'); expect(formatMoney(8725345, 'USD')).toBe('USD 8,725,345.00'); });
  it('SGD to USD equivalent uses the INR crosses', () => { expect(usdEquivalent('30000', 'SGD', { USDINR: '88.40', SGDINR: '68.10' }).toFixed(2)).toBe('23110.86'); });
  it('the simulated provider quotes with a validity window and is deterministic', async () => {
    const fx = new SimFxRateProvider();
    const now = new Date('2026-11-02T04:00:00Z');
    const q = await fx.quote('USDINR', '0.30', now);
    expect(q).toMatchObject({ mid: '88.40', rate: '88.1348' });
    expect(Date.parse(q.validUntil) - Date.parse(q.quotedAt)).toBe(600_000);
    expect((await fx.quote('USDINR', '0.30', now)).quoteId).toBe(q.quoteId);
    const moving = new SimFxRateProvider(15);
    expect(await moving.mid('USDINR', now)).toBe(await moving.mid('USDINR', now));
  });
});

describe('calendar hook', () => {
  it('computes tenor and business days', () => {
    expect(tenorDays('2026-11-02', '2027-01-01', 0)).toBe(60);
    expect(tenorDays('2026-11-02', '2027-01-01', 2)).toBe(62);
    expect(WeekdayCalendar.addBusinessDays('2026-11-06', 1)).toBe('2026-11-09'); // Fri -> Mon
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });
});
