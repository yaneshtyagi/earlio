import { D, round2, type DecValue } from '../../kernel/money';

/** Pure domain rules for losses, recoveries, late interest and recourse (BR-10, BR-11, BR-13). No I/O: everything here is unit-tested. */

export interface PayoutInput {
  /** Face value of the invoice. */
  face: DecValue;
  /** Principal the bank advanced (A). */
  advance: DecValue;
  /** Unpaid charges the bank is owed on top of principal (e.g. late interest it has not collected). */
  accruedCharges?: DecValue;
  /** Insured percentage of face. */
  coverPct: DecValue;
  /** What the insurer approved, if it approved less than the cover allows. */
  approvedAmount?: DecValue;
}
export interface PayoutResult {
  bankClaim: string; payout: string; toBank: string; toSupplier: string;
  /** Bank's unrecovered claim after the payout. */
  bankShortfall: string;
  /** Retention the supplier loses (it keeps the advance). */
  supplierLoss: string;
  /** Insurer's loss equals the payout. */
  insurerLoss: string;
}

/** BR-10: the insurer pays up to cover × face; the bank's principal plus accrued charges come first, the remainder goes to the supplier's retention. */
export function payoutWaterfall(i: PayoutInput): PayoutResult {
  const face = D(i.face), advance = D(i.advance);
  const claim = advance.plus(D(i.accruedCharges ?? 0));
  const cap = round2(face.times(D(i.coverPct)).div(100));
  const payout = i.approvedAmount === undefined ? cap : D(i.approvedAmount).gt(cap) ? cap : D(i.approvedAmount);
  const toBank = payout.gt(claim) ? claim : payout;
  const toSupplier = payout.minus(toBank);
  const retention = face.minus(advance);
  const supplierLoss = retention.minus(toSupplier);
  return {
    bankClaim: claim.toFixed(2), payout: payout.toFixed(2), toBank: toBank.toFixed(2), toSupplier: toSupplier.toFixed(2),
    bankShortfall: claim.minus(toBank).toFixed(2), supplierLoss: (supplierLoss.lt(0) ? D(0) : supplierLoss).toFixed(2), insurerLoss: payout.toFixed(2),
  };
}

export interface Shares { insurer: string; bank: string; supplier: string }
/** Recoveries net of costs are shared pro rata to the losses each party bore; largest-remainder rounding so the shares add up to the cent. */
export function shareRecovery(losses: { insurer: DecValue; bank: DecValue; supplier: DecValue }, gross: DecValue, costs: DecValue): { net: string; shares: Shares } {
  const net0 = D(gross).minus(D(costs));
  const net = net0.lt(0) ? D(0) : net0;
  const parts = (['insurer', 'bank', 'supplier'] as const).map((k) => ({ k, loss: D(losses[k]) }));
  const total = parts.reduce((a, p) => a.plus(p.loss), D(0));
  if (total.lte(0) || net.lte(0)) return { net: net.toFixed(2), shares: { insurer: '0.00', bank: '0.00', supplier: '0.00' } };
  const cents = net.times(100).toNumber();
  const raw = parts.map((p) => ({ k: p.k, exact: p.loss.div(total).times(cents).toNumber() }));
  const floors = raw.map((r) => ({ ...r, cents: Math.floor(r.exact + 1e-9), rem: r.exact - Math.floor(r.exact + 1e-9) }));
  let left = Math.round(cents) - floors.reduce((a, f) => a + f.cents, 0);
  for (const f of [...floors].sort((a, b) => b.rem - a.rem)) { if (left <= 0) break; f.cents += 1; left -= 1; }
  const by = Object.fromEntries(floors.map((f) => [f.k, (f.cents / 100).toFixed(2)])) as unknown as Shares;
  return { net: net.toFixed(2), shares: by };
}

/** Late interest is charged to the buyer at the financing rate plus 2 points, actual/365, for the unfrozen days overdue. */
export const LATE_INTEREST_PREMIUM_PCT = 2;
export function lateInterest(principal: DecValue, financingRatePct: DecValue, daysOverdue: number): string {
  if (daysOverdue <= 0) return '0.00';
  return round2(D(principal).times(D(financingRatePct).plus(LATE_INTEREST_PREMIUM_PCT)).div(100).times(daysOverdue).div(365)).toFixed(2);
}

/** A small supplier's recourse is repaid by offsetting at most 20% of each future payout (BR-11.6, A-9). */
export const SMALL_SUPPLIER_OFFSET_PCT = 20;
export function recourseOffset(outstanding: DecValue, payout: DecValue): string {
  const cap = round2(D(payout).times(SMALL_SUPPLIER_OFFSET_PCT).div(100));
  const o = D(outstanding);
  return (o.lt(cap) ? o : cap).toFixed(2);
}

/** The alternative to offsets: a 90-day plan of three equal monthly instalments, no penalty interest. */
export function recoursePlan(owed: DecValue, start: Date): { dueOn: string; amount: string }[] {
  const each = round2(D(owed).div(3));
  const last = D(owed).minus(each.times(2));
  return [30, 60, 90].map((d, i) => ({ dueOn: new Date(start.getTime() + d * 86_400_000).toISOString().slice(0, 10), amount: (i === 2 ? last : each).toFixed(2) }));
}

/** BR-13: a credit note after funding reduces what the bank is entitled to advance; the supplier owes the difference. */
export function creditNoteEffect(face: DecValue, advance: DecValue, credit: DecValue): { newFace: string; newAdvance: string; supplierOwes: string; exposureReleasedPct: string } {
  const f = D(face), c = D(credit);
  if (c.lte(0) || c.gte(f)) throw new Error('credit must be between 0 and the invoice amount');
  const newFace = f.minus(c);
  const newAdvance = round2(D(advance).times(newFace).div(f));
  return { newFace: newFace.toFixed(2), newAdvance: newAdvance.toFixed(2), supplierOwes: D(advance).minus(newAdvance).toFixed(2), exposureReleasedPct: c.div(f).times(100).toFixed(4) };
}
