import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '../../migrations');
const SCHEMAS = ['identity', 'audit', 'platform', 'compliance', 'invoicing', 'terms', 'insurance', 'marketplace', 'settlement', 'notify', 'recovery'];
/** Tables the application role may only read and append to. */
const APPEND_ONLY = ['audit.events', 'audit.anchors'];

export interface MigrateOptions {
  appRole?: string;
  appPassword?: string;
}

export async function migrate(adminUrl: string, opts: MigrateOptions = {}): Promise<string[]> {
  const appRole = opts.appRole ?? 'earlio_app';
  const appPassword = opts.appPassword ?? 'earlio_app';
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  const applied: string[] = [];
  try {
    const exists = await c.query('select 1 from pg_roles where rolname = $1', [appRole]);
    if (exists.rowCount === 0) await c.query(`create role ${appRole} login password '${appPassword.replace(/'/g, "''")}'`);
    await c.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select name from public.schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('begin');
      try {
        await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
        await c.query('insert into public.schema_migrations(name) values ($1)', [f]);
        await c.query('commit');
        applied.push(f);
      } catch (e) {
        await c.query('rollback');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    await c.query(`grant usage on schema app to ${appRole}`);
    await c.query(`grant execute on all functions in schema app to ${appRole}`);
    for (const s of SCHEMAS) {
      await c.query(`grant usage on schema ${s} to ${appRole}`);
      await c.query(`grant select, insert, update, delete on all tables in schema ${s} to ${appRole}`);
      await c.query(`grant usage, select on all sequences in schema ${s} to ${appRole}`);
    }
    for (const t of APPEND_ONLY) {
      await c.query(`revoke update, delete, truncate on ${t} from ${appRole}`);
    }
    await c.query(`revoke delete, truncate on audit.chain_head from ${appRole}`);
  } finally {
    await c.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set MIGRATE_DATABASE_URL');
  migrate(url).then((a) => console.log('applied:', a.join(', ') || 'none'));
}
