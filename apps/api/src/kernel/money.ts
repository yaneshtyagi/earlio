import Decimal from 'decimal.js';

// Round half away from zero, applied only at defined points (per charge line, 2 dp).
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type Dec = Decimal;
export type Currency = 'USD' | 'SGD' | 'INR';

export const D = (v: Decimal.Value): Decimal => new Decimal(v);
export const round2 = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const round4 = (v: Decimal.Value): Decimal => new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
export const sum = (vals: Decimal.Value[]): Decimal => vals.reduce<Decimal>((a, b) => a.plus(b), new Decimal(0));

export interface Money {
  amount: string;
  currency: Currency;
}
export const money = (amount: Decimal.Value, currency: Currency): Money => ({
  amount: round2(amount).toFixed(2),
  currency,
});

/** Indian digit grouping (₹87,25,345.00) for INR; western grouping otherwise. */
export function formatMoney(amount: Decimal.Value, currency: Currency): string {
  const d = round2(amount);
  const neg = d.isNegative();
  const [int, frac] = d.abs().toFixed(2).split('.');
  let grouped: string;
  if (currency === 'INR') {
    const last3 = int!.slice(-3);
    const rest = int!.slice(0, -3);
    grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  } else {
    grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  const sym = currency === 'INR' ? '₹' : currency === 'USD' ? 'USD ' : 'SGD ';
  return `${neg ? '-' : ''}${sym}${grouped}.${frac}`;
}

/** Split an amount into parts proportional to weights so the parts always sum exactly. */
export function allocate(total: Decimal.Value, weights: Decimal.Value[]): Decimal[] {
  const t = round2(total);
  const w = weights.map((x) => new Decimal(x));
  const wsum = sum(w);
  if (wsum.isZero()) return w.map(() => new Decimal(0));
  const parts = w.map((x) => round2(t.times(x).div(wsum)).toDecimalPlaces(2, Decimal.ROUND_DOWN));
  let rem = t.minus(sum(parts));
  let i = 0;
  while (rem.greaterThan(0) && parts.length) {
    parts[i % parts.length] = parts[i % parts.length]!.plus('0.01');
    rem = rem.minus('0.01');
    i++;
  }
  return parts;
}
