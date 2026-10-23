import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestEnv, login, type TestEnv } from './helpers';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.close(); });

/** Run raw SQL as the application role with a tenancy context, exactly as the API does. */
async function asApp<T>(orgId: string | '', platform: boolean, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: env.appUrl });
  await c.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.org_id',$1,true), set_config('app.is_platform',$2,true)", [orgId, platform ? 'on' : '']);
    const out = await fn(c);
    await c.query('rollback');
    return out;
  } finally { await c.end(); }
}

describe('row-level security (direct SQL under the application role)', () => {
  it('a supplier context sees only its own memberships', async () => {
    const rows = await asApp(env.ids.shree!, false, async (c) => (await c.query('select distinct org_id from identity.memberships')).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].org_id).toBe(env.ids.shree);
  });

  it('without any tenancy context nothing tenant-scoped is visible', async () => {
    const rows = await asApp('', false, async (c) => (await c.query('select 1 from identity.memberships')).rows);
    expect(rows).toHaveLength(0);
  });

  it('cannot update another organisation, nor read another tenant audit trail', async () => {
    await asApp(env.ids.shree!, false, async (c) => {
      const upd = await c.query("update identity.organisations set legal_name = 'Hacked' where id = $1", [env.ids.kumar]);
      expect(upd.rowCount).toBe(0);
      const aud = await c.query('select distinct org_id from audit.events where org_id is not null');
      expect(aud.rows.every((r: any) => r.org_id === env.ids.shree)).toBe(true);
    });
  });

  it('cannot insert a membership into another organisation', async () => {
    await asApp(env.ids.shree!, false, async (c) => {
      const u = (await c.query('select id from identity.users limit 1')).rows[0];
      await expect(c.query("insert into identity.memberships (user_id, org_id, role, created_at) values ($1,$2,'Viewer',now())", [u.id, env.ids.kumar]))
        .rejects.toThrow(/row-level security/);
    });
  });

  it('platform context sees all tenants', async () => {
    const rows = await asApp('', true, async (c) => (await c.query('select distinct org_id from identity.memberships')).rows);
    expect(rows.length).toBe(14);
  });
});

describe('tenancy through the API', () => {
  it('each organisation lists only its own users', async () => {
    const a = await login(env, 'shree', 'Admin');
    const b = await login(env, 'kumar', 'Admin');
    const ua = (await a.req('GET', '/api/v1/org/users')).json as any[];
    const ub = (await b.req('GET', '/api/v1/org/users')).json as any[];
    expect(ua.every((u) => u.email.endsWith('@shree.demo'))).toBe(true);
    expect(ub.every((u) => u.email.endsWith('@kumar.demo'))).toBe(true);
  });

  it('platform-only endpoints are closed to tenant users', async () => {
    const a = await login(env, 'shree', 'Admin');
    expect((await a.req('GET', '/api/v1/audit/events')).status).toBe(403);
    expect((await a.req('GET', '/api/v1/audit/verify')).status).toBe(403);
  });
});
