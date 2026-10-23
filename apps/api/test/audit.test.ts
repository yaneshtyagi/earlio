import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestEnv, login, type TestEnv } from './helpers';
import { audit, verifyAuditChain } from '../src/platform/audit';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.close(); });

describe('audit hash chain', () => {
  it('verifies a clean chain through the API (platform auditor)', async () => {
    const aud = await login(env, 'earlio', 'Auditor');
    const res = await aud.req('GET', '/api/v1/audit/verify');
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.checked).toBeGreaterThan(50);
  });

  it('records platform cross-tenant reads in the audit log itself', async () => {
    const aud = await login(env, 'earlio', 'Auditor');
    const list = await aud.req('GET', '/api/v1/audit/events?limit=5');
    expect(list.status).toBe(200);
    const again = await aud.req('GET', `/api/v1/audit/events?entityType=audit_log`);
    expect(again.json.some((e: any) => e.action === 'platform.cross_tenant_read')).toBe(true);
  });

  it('detects a tampered row (superuser edits one event)', async () => {
    const aud = await login(env, 'earlio', 'Auditor');
    const admin = new pg.Client({ connectionString: env.adminUrl });
    await admin.connect();
    const target = (await admin.query("select seq from audit.events where action = 'organisation.created' order by seq limit 1 offset 3")).rows[0];
    await admin.query("update audit.events set after = '{\"tampered\":true}'::jsonb where seq = $1", [target.seq]);
    const res = await aud.req('GET', '/api/v1/audit/verify');
    expect(res.json.ok).toBe(false);
    expect(res.json.firstBrokenSeq).toBe(target.seq);
    expect(res.json.reason).toContain('does not match its hash');
    await admin.end();
  });

  it('detects a deleted event', async () => {
    const e2 = await createTestEnv();
    try {
      const admin = new pg.Client({ connectionString: e2.adminUrl });
      await admin.connect();
      await admin.query("delete from audit.events where seq = (select seq from audit.events order by seq limit 1 offset 10)");
      await admin.end();
      const aud = await login(e2, 'earlio', 'Auditor');
      const res = await aud.req('GET', '/api/v1/audit/verify');
      expect(res.json.ok).toBe(false);
      expect(res.json.reason).toContain('previous-hash link');
    } finally { await e2.close(); }
  });
});

describe('append-only enforcement', () => {
  it('the application role cannot update or delete audit events', async () => {
    const c = new pg.Client({ connectionString: env.appUrl });
    await c.connect();
    await expect(c.query("update audit.events set action = 'x'")).rejects.toThrow(/permission denied/);
    await expect(c.query('delete from audit.events')).rejects.toThrow(/permission denied/);
    await c.end();
  });
});

describe('concurrency', () => {
  it('parallel writers cannot fork the chain', async () => {
    const e = await createTestEnv({ seed: false });
    try {
      await Promise.all(Array.from({ length: 40 }, (_, i) =>
        e.svc.db.tx({ correlationId: 'c' + i, orgId: undefined }, (tx) =>
          audit(tx, { correlationId: 'c' + i }, e.clock.now(), { action: 'test.parallel', entityType: 'test', entityId: String(i), orgId: null }))));
      const res = await e.svc.db.system((tx) => verifyAuditChain(tx));
      expect(res.ok).toBe(true);
      expect(res.checked).toBe(40);
    } finally { await e.close(); }
  });
});
