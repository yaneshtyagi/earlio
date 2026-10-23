import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { creditNoteEffect, lateInterest, payoutWaterfall, recourseOffset, recoursePlan, shareRecovery } from '../src/modules/recovery/waterfall';

describe('payout waterfall (BR-10 loss-sharing cases)', () => {
  it('case A: F 100,000, A 90%, cover 90% pays 90,000; the bank is whole; the supplier keeps the advance and loses the 10,000 retention', () => {
    const r = payoutWaterfall({ face: '100000', advance: '90000', coverPct: 90 });
    expect(r).toMatchObject({ payout: '90000.00', toBank: '90000.00', toSupplier: '0.00', bankShortfall: '0.00', supplierLoss: '10000.00' });
  });
  it('case B: cover 70% pays 70,000; the bank is short by 20,000', () => {
    const r = payoutWaterfall({ face: '100000', advance: '90000', coverPct: 70 });
    expect(r).toMatchObject({ payout: '70000.00', toBank: '70000.00', bankShortfall: '20000.00', supplierLoss: '10000.00' });
  });
  it('case C: a rejected claim pays nothing, so the whole claim is a shortfall for recourse', () => {
    const r = payoutWaterfall({ face: '100000', advance: '90000', coverPct: 90, approvedAmount: '0' });
    expect(r).toMatchObject({ payout: '0.00', toBank: '0.00', bankShortfall: '90000.00' });
  });
  it('bank principal and accrued charges come first, any remainder goes to the supplier retention', () => {
    const r = payoutWaterfall({ face: '100000', advance: '80000', accruedCharges: '500', coverPct: 90 });
    expect(r).toMatchObject({ bankClaim: '80500.00', toBank: '80500.00', toSupplier: '9500.00', bankShortfall: '0.00', supplierLoss: '10500.00' });
  });
  it('an approved amount below the cover limit is respected, and above it is capped', () => {
    expect(payoutWaterfall({ face: '100000', advance: '90000', coverPct: 90, approvedAmount: '60000' }).payout).toBe('60000.00');
    expect(payoutWaterfall({ face: '100000', advance: '90000', coverPct: 90, approvedAmount: '95000' }).payout).toBe('90000.00');
  });
  it('property: the bank never receives more than its claim and the payout is fully distributed', () => {
    fc.assert(fc.property(fc.integer({ min: 1000, max: 5_000_000 }), fc.integer({ min: 10, max: 95 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 1000 }), (face, advPct, cover, charges) => {
      const adv = Math.floor((face * advPct) / 100);
      const r = payoutWaterfall({ face, advance: adv, accruedCharges: charges, coverPct: cover });
      expect(Number(r.toBank) + Number(r.toSupplier)).toBeCloseTo(Number(r.payout), 2);
      expect(Number(r.toBank)).toBeLessThanOrEqual(Number(r.bankClaim) + 0.001);
      expect(Number(r.bankShortfall)).toBeGreaterThanOrEqual(0);
    }));
  });
});

describe('recoveries shared pro rata to losses', () => {
  it('case A: insurer bore 90,000 and the supplier 10,000, so a net recovery of 10,000 splits 9,000 / 1,000', () => {
    const r = shareRecovery({ insurer: '90000', bank: '0', supplier: '10000' }, '12000', '2000');
    expect(r).toEqual({ net: '10000.00', shares: { insurer: '9000.00', bank: '0.00', supplier: '1000.00' } });
  });
  it('case B: insurer 70,000, bank 20,000, supplier 10,000; net 1,000 gives 700 / 200 / 100', () => {
    expect(shareRecovery({ insurer: '70000', bank: '20000', supplier: '10000' }, '1000', '0').shares).toEqual({ insurer: '700.00', bank: '200.00', supplier: '100.00' });
  });
  it('costs above the recovery leave nothing to share', () => {
    expect(shareRecovery({ insurer: '70000', bank: '20000', supplier: '10000' }, '500', '800')).toEqual({ net: '0.00', shares: { insurer: '0.00', bank: '0.00', supplier: '0.00' } });
  });
  it('property: shares always add up to the net recovery to the cent', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 900000 }), fc.integer({ min: 0, max: 900000 }), fc.integer({ min: 0, max: 900000 }), fc.integer({ min: 1, max: 500000 }), (a, b, c, g) => {
      const r = shareRecovery({ insurer: a, bank: b, supplier: c }, g, 0);
      const total = Number(r.shares.insurer) + Number(r.shares.bank) + Number(r.shares.supplier);
      if (a + b + c > 0) expect(total).toBeCloseTo(g, 2);
    }));
  });
});

describe('late interest, recourse and credit notes', () => {
  it('late interest is financing rate + 2 points, actual/365: 90,000 at 5.85% + 2% for 30 days = 580.68', () => {
    expect(lateInterest('90000', '5.85', 30)).toBe('580.68');
    expect(lateInterest('90000', '5.85', 0)).toBe('0.00');
  });
  it('a small supplier’s offset is capped at 20% of the payout and never exceeds what is owed', () => {
    expect(recourseOffset('9000', '10000')).toBe('2000.00');
    expect(recourseOffset('500', '10000')).toBe('500.00');
    fc.assert(fc.property(fc.integer({ min: 1, max: 1e7 }), fc.integer({ min: 1, max: 1e7 }), (owed, payout) => {
      const o = Number(recourseOffset(owed, payout));
      expect(o).toBeLessThanOrEqual(payout * 0.2 + 0.005); expect(o).toBeLessThanOrEqual(owed);
    }));
  });
  it('the 90-day plan is three instalments that add up exactly', () => {
    const p = recoursePlan('10000.00', new Date('2026-11-02T00:00:00Z'));
    expect(p.map((x) => x.dueOn)).toEqual(['2026-12-02', '2027-01-01', '2027-01-31']);
    expect(p.map((x) => x.amount)).toEqual(['3333.33', '3333.33', '3333.34']);
  });
  it('BR-13: a 10,000 credit on a 100,000 invoice advanced at 90,000 reduces the advance to 81,000; the supplier owes 9,000', () => {
    expect(creditNoteEffect('100000', '90000', '10000')).toEqual({ newFace: '90000.00', newAdvance: '81000.00', supplierOwes: '9000.00', exposureReleasedPct: '10.0000' });
    expect(() => creditNoteEffect('100000', '90000', '100000')).toThrow();
  });
});
