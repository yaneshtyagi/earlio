export type Currency = 'USD' | 'SGD' | 'INR';

/** Indian digit grouping for INR (₹87,25,345.00); western grouping for USD/SGD. Mirrors the API helper. */
export function formatMoney(amount: string | number, currency: Currency): string {
  const n = Number(amount);
  const neg = n < 0;
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  let grouped: string;
  if (currency === 'INR') {
    const last3 = int!.slice(-3);
    const rest = int!.slice(0, -3);
    grouped = rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3 : last3;
  } else {
    grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return `${neg ? '-' : ''}${sym}${grouped}.${frac}`;
}

export const formatPct = (v: string | number, dp = 2) => `${Number(v).toFixed(dp)}%`;
