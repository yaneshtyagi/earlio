import type { Tx } from '../db/pool';

/** Write a domain event in the same transaction as the state change (ADR-003). */
export async function emit(tx: Tx, now: Date, topic: string, payload: Record<string, unknown>, orgIds: string[] = []) {
  await tx.query('insert into platform.outbox (topic, payload, org_ids, created_at) values ($1,$2,$3,$4)', [
    topic, JSON.stringify(payload), orgIds, now,
  ]);
}

export type OutboxHandler = (tx: Tx, evt: { id: string; topic: string; payload: any; orgIds: string[]; createdAt: Date }) => Promise<void>;

/** Dispatch unprocessed events to subscribers. Called by the worker loop (and directly in tests). */
export const MAX_OUTBOX_ATTEMPTS = 5;

/**
 * Dispatch unprocessed events to subscribers. Each event runs in its own savepoint: a failing handler is retried on
 * the next pass and parked (processed with an error) after MAX_OUTBOX_ATTEMPTS, so one poison event cannot block the queue.
 */
export async function drainOutbox(
  runTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  handlers: Record<string, OutboxHandler[]>,
  now: Date,
  limit = 200,
): Promise<number> {
  return runTx(async (tx) => {
    const rows = await tx.query<any>(
      'select * from platform.outbox where processed_at is null order by id asc limit $1 for update skip locked', [limit]);
    for (const r of rows) {
      await tx.query('savepoint evt');
      try {
        for (const h of [...(handlers[r.topic] ?? []), ...(handlers['*'] ?? [])]) {
          await h(tx, { id: r.id, topic: r.topic, payload: r.payload, orgIds: r.org_ids, createdAt: r.created_at });
        }
        await tx.query('release savepoint evt');
        await tx.query('update platform.outbox set processed_at = $2, attempts = attempts + 1 where id = $1', [r.id, now]);
      } catch (e) {
        await tx.query('rollback to savepoint evt');
        const dead = r.attempts + 1 >= MAX_OUTBOX_ATTEMPTS;
        await tx.query('update platform.outbox set attempts = attempts + 1, last_error = $2, processed_at = case when $3 then $4::timestamptz else null end where id = $1',
          [r.id, String((e as Error).message ?? e).slice(0, 500), dead, now]);
      }
    }
    return rows.length;
  });
}
