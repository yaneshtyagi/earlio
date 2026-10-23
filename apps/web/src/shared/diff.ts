export interface Change { path: string; before: unknown; after: unknown; kind: 'added' | 'removed' | 'changed' }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Structural diff of two JSON values (same rules as the server's). */
export function diffJson(before: unknown, after: unknown, path = ''): Change[] {
  if (isObj(before) && isObj(after)) {
    const out: Change[] = [];
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) out.push(...diffJson(before[k], after[k], path ? `${path}.${k}` : k));
    return out;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [{ path, before, after, kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed' }];
}
export const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));
