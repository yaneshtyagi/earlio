import type { Tx } from '../../db/pool';
import type { Services } from '../../services';
import { bankDashboard, buyerDashboard, context, insurerDashboard, scorecard, supplierDashboard } from './queries';

export type DashKind = 'supplier' | 'buyer' | 'bank' | 'insurer' | 'scorecard';
const FRESH_MS = 5 * 60_000;

async function compute(tx: Tx, svc: Services, kind: DashKind, orgId: string | null) {
  const c = await context(tx, svc);
  switch (kind) {
    case 'supplier': return supplierDashboard(c, orgId!);
    case 'buyer': return buyerDashboard(c, orgId!);
    case 'bank': return bankDashboard(c, orgId!);
    case 'insurer': return insurerDashboard(c, orgId!);
    case 'scorecard': return scorecard(c);
  }
}

/** Recompute one projection row (runs with platform visibility, filtered by the organisation inside each query). */
export async function refreshSnapshot(tx: Tx, svc: Services, kind: DashKind, orgId: string | null) {
  const data = await tx.elevated(() => compute(tx, svc, kind, orgId));
  const now = svc.clock.now();
  await tx.elevated(() => tx.query(
    `insert into analytics.snapshots (key, kind, org_id, data, computed_at) values ($1,$2,$3,$4,$5)
     on conflict (key) do update set data = excluded.data, computed_at = excluded.computed_at`, [`${kind}:${orgId ?? 'platform'}`, kind, orgId, JSON.stringify(data), now]));
  return { data, computedAt: now };
}

/** Read a dashboard from its projection; recompute when it is missing or stale (against the virtual clock). */
export async function dashboard(tx: Tx, svc: Services, kind: DashKind, orgId: string | null, fresh = false) {
  const key = `${kind}:${orgId ?? 'platform'}`;
  const row = await tx.elevated(() => tx.maybe<{ data: any; computed_at: Date }>('select data, computed_at from analytics.snapshots where key = $1', [key]));
  const now = svc.clock.now().getTime();
  if (row && !fresh && now - new Date(row.computed_at).getTime() >= 0 && now - new Date(row.computed_at).getTime() < FRESH_MS) return { ...row.data, computedAt: new Date(row.computed_at).toISOString() };
  const r = await refreshSnapshot(tx, svc, kind, orgId);
  return { ...(r.data as object), computedAt: r.computedAt.toISOString() };
}

/** Worker job: refresh every organisation's projection and the scorecard. */
export async function refreshAll(tx: Tx, svc: Services): Promise<number> {
  const orgs = await tx.elevated(() => tx.query<{ id: string; type: string }>("select id, type from identity.organisations where type in ('supplier','buyer','bank','insurer') and kyc_status = 'approved'"));
  let n = 0;
  // A savepoint per projection: one failing query must not poison the rest of the batch.
  const safely = async (kind: DashKind, orgId: string | null) => {
    await tx.query('savepoint snap');
    try { await refreshSnapshot(tx, svc, kind, orgId); await tx.query('release savepoint snap'); n++; }
    catch (e) { await tx.query('rollback to savepoint snap'); console.error(`analytics refresh failed for ${kind}:${orgId ?? 'platform'}:`, (e as Error).message); }
  };
  for (const o of orgs) await safely(o.type as DashKind, o.id);
  await safely('scorecard', null);
  return n;
}
