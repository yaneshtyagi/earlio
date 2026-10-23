/** Jaro-Winkler similarity in [0,1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(b.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) { if (a[i] === b[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const SUFFIXES = new Set(['ltd', 'limited', 'llc', 'inc', 'incorporated', 'pte', 'pvt', 'private', 'co', 'company', 'corp', 'corporation', 'plc', 'gmbh', 'sa', 'llp']);

export function normaliseName(n: string): string {
  return n.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter((w) => w && !SUFFIXES.has(w)).join(' ');
}

/** Name similarity robust to word order and legal-form suffixes. */
export function nameScore(a: string, b: string): number {
  const na = normaliseName(a), nb = normaliseName(b);
  const sortWords = (s: string) => s.split(' ').sort().join(' ');
  return Math.max(jaroWinkler(na, nb), jaroWinkler(sortWords(na), sortWords(nb)));
}

export interface ScreenMatch { entry: string; list: string; score: number }
export interface ScreenResult { listVersion: string; matches: ScreenMatch[]; topScore: number }
export interface SanctionsProvider {
  screen(name: string, country?: string | null): Promise<ScreenResult>;
}

/** Fictional watch list. Real lists come from a commercial provider via this same interface. */
export const SIM_WATCH_LIST: { entry: string; list: string }[] = [
  { entry: 'Zarnitsa Trading Ltd', list: 'SIM-OFAC-FICTIONAL' },
  { entry: 'Orlov Maritime Holdings', list: 'SIM-OFAC-FICTIONAL' },
  { entry: 'Kumar Precisions Industries', list: 'SIM-UN-FICTIONAL' }, // near-miss for a real demo supplier: a false-positive demo
  { entry: 'Black Harbour Metals FZE', list: 'SIM-EU-FICTIONAL' },
];

export class SimSanctionsProvider implements SanctionsProvider {
  readonly version = 'sim-2026-10';
  constructor(private threshold = 0.9) {}
  async screen(name: string): Promise<ScreenResult> {
    const matches = SIM_WATCH_LIST
      .map((w) => ({ entry: w.entry, list: w.list, score: Math.round(nameScore(name, w.entry) * 10000) / 10000 }))
      .filter((m) => m.score >= this.threshold)
      .sort((a, b) => b.score - a.score);
    return { listVersion: this.version, matches, topScore: matches[0]?.score ?? 0 };
  }
}
