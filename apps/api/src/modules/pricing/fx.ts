import { D, type Dec, type DecValue } from '../../kernel/money';

/** Bank payout rate = mid x (1 - spread), 4 dp (BR-5). spreadPct in percent. */
export const bankRate = (mid: DecValue, spreadPct: DecValue): Dec => D(mid).times(D(1).minus(D(spreadPct).div(100))).toDecimalPlaces(4);

export const inrAmount = (foreign: DecValue, rate: DecValue): Dec => D(foreign).times(D(rate)).toDecimalPlaces(2);

export interface FxQuote { pair: string; mid: string; spreadPct: string; rate: string; quotedAt: string; validUntil: string; quoteId: string }

/** Convert an amount in USD/SGD to a USD equivalent using INR crosses (for size limits and exposure limits). */
export function usdEquivalent(amount: DecValue, currency: string, mids: { USDINR: DecValue; SGDINR: DecValue }): Dec {
  if (currency === 'USD') return D(amount);
  if (currency === 'SGD') return D(amount).times(D(mids.SGDINR)).div(D(mids.USDINR)).toDecimalPlaces(2);
  throw new Error(`unsupported currency ${currency}`);
}
