import { createHash } from 'node:crypto';
import { D } from '../kernel/money';
import { bankRate, type FxQuote } from '../modules/pricing/fx';

export type FxPair = 'USDINR' | 'SGDINR';
/** Simulated FX desk: seeded base rates (illustrative, fictional). Optional deterministic daily movement in basis points. */
export interface FxRateProvider {
  mid(pair: FxPair, on: Date): Promise<string>;
  quote(pair: FxPair, spreadPct: string, now: Date, validityMinutes?: number): Promise<FxQuote>;
}
export const SEED_MIDS: Record<FxPair, string> = { USDINR: '88.40', SGDINR: '68.10' };

export class SimFxRateProvider implements FxRateProvider {
  constructor(private readonly movementBps = 0) {}
  async mid(pair: FxPair, on: Date): Promise<string> {
    const base = D(SEED_MIDS[pair]);
    if (this.movementBps === 0) return base.toFixed(2);
    const day = on.toISOString().slice(0, 10);
    const h = createHash('sha256').update(pair + day).digest().readUInt16BE(0) / 65535; // 0..1, deterministic per pair/day
    return base.times(D(1).plus(D(h * 2 - 1).times(this.movementBps).div(10000))).toDecimalPlaces(2).toFixed(2);
  }
  async quote(pair: FxPair, spreadPct: string, now: Date, validityMinutes = 10): Promise<FxQuote> {
    const mid = await this.mid(pair, now);
    const id = createHash('sha256').update(`${pair}|${mid}|${spreadPct}|${now.toISOString()}`).digest('hex').slice(0, 16);
    return { pair, mid, spreadPct, rate: bankRate(mid, spreadPct).toFixed(4), quotedAt: now.toISOString(), validUntil: new Date(now.getTime() + validityMinutes * 60_000).toISOString(), quoteId: `FXQ-${id}` };
  }
}
