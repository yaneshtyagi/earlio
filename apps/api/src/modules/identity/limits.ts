import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, invalid } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { D } from '../../kernel/money';

export async function setLimit(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, subjectOrgId: string, kind: 'buyer' | 'supplier', limitUsd: string) {
  const subj = await tx.elevated(() => tx.maybe<any>('select type from identity.organisations where id = $1', [subjectOrgId]));
  if (!subj || subj.type !== kind) throw invalid(`That organisation is not a ${kind}.`);
  const now = svc.clock.now();
  const before = await tx.maybe<any>('select limit_usd, reserved_usd, used_usd from identity.bank_limits where bank_org_id = $1 and subject_org_id = $2 and kind = $3', [bankOrgId, subjectOrgId, kind]);
  if (before && D(limitUsd).lt(D(before.reserved_usd).plus(before.used_usd))) {
    throw new DomainError('limit_below_usage', `The limit cannot be set below current exposure (reserved + used = USD ${D(before.reserved_usd).plus(before.used_usd).toFixed(2)}).`, 422);
  }
  await tx.query(
    `insert into identity.bank_limits (bank_org_id, subject_org_id, kind, limit_usd, updated_at) values ($1,$2,$3,$4,$5)
     on conflict (bank_org_id, subject_org_id, kind) do update set limit_usd = excluded.limit_usd, updated_at = excluded.updated_at`,
    [bankOrgId, subjectOrgId, kind, limitUsd, now]);
  await audit(tx, ctx, now, { action: 'limit.set', entityType: 'bank_limit', entityId: `${bankOrgId}:${subjectOrgId}:${kind}`, orgId: bankOrgId, before, after: { limitUsd } });
}

type Bucket = 'reserve' | 'consume' | 'release_reserved' | 'release_used';

const SQL: Record<Bucket, string> = {
  reserve: 'reserved_usd = reserved_usd + $4',
  consume: 'reserved_usd = reserved_usd - $4, used_usd = used_usd + $4',
  release_reserved: 'reserved_usd = reserved_usd - $4',
  release_used: 'used_usd = used_usd - $4',
};
const GUARD: Record<Bucket, string> = {
  reserve: 'limit_usd - reserved_usd - used_usd >= $4',
  consume: 'reserved_usd >= $4',
  release_reserved: 'reserved_usd >= $4',
  release_used: 'used_usd >= $4',
};

async function move(tx: Tx, svc: Services, op: Bucket, bankOrgId: string, subjectOrgId: string, kind: 'buyer' | 'supplier', amountUsd: string, names?: { subject?: string; bank?: string }) {
  const now = svc.clock.now();
  const rows = await tx.elevated(() => tx.query(
    `update identity.bank_limits set ${SQL[op]}, updated_at = $5
      where bank_org_id = $1 and subject_org_id = $2 and kind = $3 and ${GUARD[op]} returning id`,
    [bankOrgId, subjectOrgId, kind, amountUsd, now]));
  if (rows.length) return;
  const cur = await tx.elevated(() => tx.maybe<any>('select limit_usd, reserved_usd, used_usd from identity.bank_limits where bank_org_id = $1 and subject_org_id = $2 and kind = $3', [bankOrgId, subjectOrgId, kind]));
  const who = names?.subject ?? `this ${kind}`;
  if (!cur) throw new DomainError('no_limit', `The bank has no exposure limit set for ${who}.`, 422);
  if (op === 'reserve') {
    const avail = D(cur.limit_usd).minus(cur.reserved_usd).minus(cur.used_usd);
    throw new DomainError('limit_exceeded', `The bank's ${kind} limit for ${who} would be exceeded: USD ${avail.toFixed(2)} available, USD ${D(amountUsd).toFixed(2)} needed.`, 422);
  }
  throw new DomainError('limit_state', `Limit bookkeeping error for ${who} (${op}).`, 500);
}

/** Atomic against concurrent requests: the guard and update are one SQL statement; check constraints back it up. */
export const reserveLimits = async (tx: Tx, svc: Services, a: { bankOrgId: string; buyerOrgId: string; supplierOrgId: string; amountUsd: string; names?: { buyer?: string; supplier?: string } }) => {
  await move(tx, svc, 'reserve', a.bankOrgId, a.buyerOrgId, 'buyer', a.amountUsd, { subject: a.names?.buyer });
  await move(tx, svc, 'reserve', a.bankOrgId, a.supplierOrgId, 'supplier', a.amountUsd, { subject: a.names?.supplier });
};
export const consumeLimits = async (tx: Tx, svc: Services, a: { bankOrgId: string; buyerOrgId: string; supplierOrgId: string; amountUsd: string }) => {
  await move(tx, svc, 'consume', a.bankOrgId, a.buyerOrgId, 'buyer', a.amountUsd);
  await move(tx, svc, 'consume', a.bankOrgId, a.supplierOrgId, 'supplier', a.amountUsd);
};
export const releaseReserved = async (tx: Tx, svc: Services, a: { bankOrgId: string; buyerOrgId: string; supplierOrgId: string; amountUsd: string }) => {
  await move(tx, svc, 'release_reserved', a.bankOrgId, a.buyerOrgId, 'buyer', a.amountUsd);
  await move(tx, svc, 'release_reserved', a.bankOrgId, a.supplierOrgId, 'supplier', a.amountUsd);
};
export const releaseUsed = async (tx: Tx, svc: Services, a: { bankOrgId: string; buyerOrgId: string; supplierOrgId: string; amountUsd: string }) => {
  await move(tx, svc, 'release_used', a.bankOrgId, a.buyerOrgId, 'buyer', a.amountUsd);
  await move(tx, svc, 'release_used', a.bankOrgId, a.supplierOrgId, 'supplier', a.amountUsd);
};
