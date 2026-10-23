import pg from 'pg';
import type { Role } from '../modules/identity/permissions';

// numeric -> string (never float); int8 -> string.
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(20, (v) => v);
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD'

export interface Ctx {
  userId?: string;
  orgId?: string;
  role?: Role;
  /** Cross-tenant access; only granted to platform roles and always audited by callers. */
  platform?: boolean;
  correlationId: string;
}

export class Tx {
  constructor(readonly client: pg.PoolClient) {}
  async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.client.query(text, params as any[]);
    return r.rows as T[];
  }
  async one<T = any>(text: string, params: unknown[] = []): Promise<T> {
    const rows = await this.query<T>(text, params);
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}: ${text.slice(0, 80)}`);
    return rows[0]!;
  }
  async maybe<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }

  /**
   * Run `fn` with cross-tenant visibility, then restore the previous scope. Service-layer only:
   * used where a workflow legitimately touches another party's rows (limits, liens, settlement).
   * Routes never call this directly.
   */
  async elevated<T>(fn: () => Promise<T>): Promise<T> {
    const prev = (await this.query<{ v: string }>("select coalesce(current_setting('app.is_platform', true), '') as v"))[0]!.v;
    await this.query("select set_config('app.is_platform', 'on', true)");
    try {
      return await fn();
    } finally {
      await this.query("select set_config('app.is_platform', $1, true)", [prev]);
    }
  }
}

export class Db {
  readonly pool: pg.Pool;
  constructor(url: string, max = 10) {
    this.pool = new pg.Pool({ connectionString: url, max });
    // An idle client can be terminated by the server (restart, forced drop); the pool replaces it, so this must not crash the process.
    this.pool.on('error', () => {});
  }

  /** Run `fn` in a transaction with the tenancy context applied (RLS). */
  async tx<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.is_platform', $3, true)`,
        [ctx.orgId ?? '', ctx.userId ?? '', ctx.platform ? 'on' : ''],
      );
      const out = await fn(new Tx(client));
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Background/system work (schedulers, workers, seeds): cross-tenant, no user. */
  system<T>(fn: (tx: Tx) => Promise<T>, correlationId = 'system'): Promise<T> {
    return this.tx({ platform: true, correlationId }, fn);
  }

  async close() {
    await this.pool.end();
  }
}
