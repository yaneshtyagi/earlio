import { randomUUID } from 'node:crypto';
import type { Ctx, Tx } from '../db/pool';
import { canonicalJson, sha256 } from '../kernel/canonical';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Organisation the event belongs to (visibility); defaults to the actor's org. */
  orgId?: string | null;
  actorLabel?: string;
}

/**
 * Append an audit event. Serialised through the chain-head row lock, so concurrent writers
 * cannot fork the chain (verified by a concurrency test).
 */
export async function audit(tx: Tx, ctx: Ctx, now: Date, e: AuditInput): Promise<void> {
  const head = await tx.one<{ head_hash: string }>('select head_hash from audit.chain_head where id = 1 for update');
  const body = {
    id: randomUUID(),
    org_id: e.orgId === undefined ? (ctx.orgId ?? null) : e.orgId,
    actor_user_id: ctx.userId ?? null,
    actor_label: e.actorLabel ?? (ctx.userId ? null : 'system'),
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    correlation_id: ctx.correlationId,
    occurred_at: now.toISOString(),
  };
  const hash = sha256(head.head_hash + canonicalJson(body));
  // RETURNING would need SELECT visibility on the new row (RLS), which system events do not grant: take the seq first.
  const { seq } = await tx.one<{ seq: string }>("select nextval(pg_get_serial_sequence('audit.events','seq')) as seq");
  await tx.query(
    `insert into audit.events (seq, id, org_id, actor_user_id, actor_label, action, entity_type, entity_id, before, after, correlation_id, occurred_at, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [seq, body.id, body.org_id, body.actor_user_id, body.actor_label, body.action, body.entity_type, body.entity_id,
     JSON.stringify(body.before), JSON.stringify(body.after), body.correlation_id, body.occurred_at, head.head_hash, hash],
  );
  await tx.query('update audit.chain_head set head_hash = $1, last_seq = $2 where id = 1', [hash, seq]);
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  headHash: string;
  firstBrokenSeq?: string;
  reason?: string;
}

/** Recompute the entire chain. Must run with platform visibility. */
export async function verifyAuditChain(tx: Tx): Promise<VerifyResult> {
  const rows = await tx.query<any>('select * from audit.events order by seq asc');
  let prev = '0'.repeat(64);
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, checked: 0, headHash: prev, firstBrokenSeq: r.seq, reason: 'previous-hash link is broken' };
    const body = {
      id: r.id, org_id: r.org_id, actor_user_id: r.actor_user_id, actor_label: r.actor_label, action: r.action,
      entity_type: r.entity_type, entity_id: r.entity_id, before: r.before, after: r.after,
      correlation_id: r.correlation_id, occurred_at: new Date(r.occurred_at).toISOString(),
    };
    const expected = sha256(prev + canonicalJson(body));
    if (expected !== r.hash) return { ok: false, checked: 0, headHash: prev, firstBrokenSeq: r.seq, reason: 'entry content does not match its hash' };
    prev = r.hash;
  }
  const head = await tx.one<{ head_hash: string; last_seq: string }>('select head_hash, last_seq from audit.chain_head where id = 1');
  const lastSeq = rows.length ? rows[rows.length - 1].seq : '0';
  if (head.head_hash !== prev || head.last_seq !== lastSeq) {
    return { ok: false, checked: rows.length, headHash: prev, reason: 'chain head does not match the last event (events removed or appended outside the writer)' };
  }
  return { ok: true, checked: rows.length, headHash: prev };
}

export interface TimestampAuthority {
  stamp(hash: string, at: Date): Promise<string>;
}

/** Simulated trusted timestamp (PRD section 7: periodic anchoring by a third party). */
export class SimTimestampAuthority implements TimestampAuthority {
  async stamp(hash: string, at: Date) {
    return `SIMTSA.${at.toISOString()}.${sha256('demo-tsa-key' + hash + at.toISOString()).slice(0, 32)}`;
  }
}

export async function anchorAuditHead(tx: Tx, tsa: TimestampAuthority, now: Date) {
  const head = await tx.one<{ head_hash: string; last_seq: string }>('select head_hash, last_seq from audit.chain_head where id = 1');
  const token = await tsa.stamp(head.head_hash, now);
  await tx.query('insert into audit.anchors (anchored_at, head_hash, last_seq, token) values ($1,$2,$3,$4)', [now, head.head_hash, head.last_seq, token]);
  return { headHash: head.head_hash, lastSeq: head.last_seq, token };
}
