/** Layer resolution (CT-4, BR-9, A-18). Pure. */
export interface Scope { buyerOrgId?: string | null; supplierOrgId?: string | null; corridor?: string | null }

export const LAYER_ORDER = [
  'buyer+supplier+corridor', 'buyer+supplier', 'buyer+corridor', 'supplier+corridor', 'buyer', 'supplier', 'corridor', 'owner_default', 'platform_default',
] as const;
export type Layer = (typeof LAYER_ORDER)[number];

export function layerOf(ownerType: string, scope: Scope): Layer {
  const parts = [scope.buyerOrgId ? 'buyer' : '', scope.supplierOrgId ? 'supplier' : '', scope.corridor ? 'corridor' : ''].filter(Boolean).join('+');
  if (!parts) return ownerType === 'platform' ? 'platform_default' : 'owner_default';
  return parts as Layer;
}
export const specificity = (l: Layer) => LAYER_ORDER.length - LAYER_ORDER.indexOf(l); // higher = more specific

export interface Candidate {
  setId: string; setName: string; versionId: string; version: number; ownerType: string; scope: Scope; priority: number;
  effectiveFrom: Date; body: Record<string, unknown>;
}
export interface Context { buyerOrgId?: string; supplierOrgId?: string; corridor?: string }

export const matches = (scope: Scope, ctx: Context): boolean =>
  (!scope.buyerOrgId || scope.buyerOrgId === ctx.buyerOrgId) && (!scope.supplierOrgId || scope.supplierOrgId === ctx.supplierOrgId) && (!scope.corridor || scope.corridor === ctx.corridor);

/** Order for the same parameter: more specific layer first, then later effective date, then higher priority, then higher version. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const sa = specificity(layerOf(a.ownerType, a.scope)), sb = specificity(layerOf(b.ownerType, b.scope));
  if (sa !== sb) return sb - sa;
  if (a.effectiveFrom.getTime() !== b.effectiveFrom.getTime()) return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  if (a.priority !== b.priority) return b.priority - a.priority;
  return b.version - a.version;
}

export interface Resolved {
  terms: Record<string, any>;
  explanation: Record<string, { layer: Layer; setId: string; setName: string; versionId: string; version: number }>;
  versionIds: string[];
}

/** Candidates are the ACTIVE versions already filtered to the effective date. */
export function resolve(candidates: Candidate[], ctx: Context): Resolved {
  const applicable = candidates.filter((c) => matches(c.scope, ctx)).sort(compareCandidates);
  const terms: Record<string, any> = {};
  const explanation: Resolved['explanation'] = {};
  const used = new Set<string>();
  for (const c of applicable) {
    for (const [k, v] of Object.entries(c.body)) {
      if (k in terms) continue;
      terms[k] = v;
      explanation[k] = { layer: layerOf(c.ownerType, c.scope), setId: c.setId, setName: c.setName, versionId: c.versionId, version: c.version };
      used.add(c.versionId);
    }
  }
  return { terms, explanation, versionIds: [...used] };
}
