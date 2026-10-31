import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestEnv, login, loginAs, makeSession, type TestEnv } from './helpers';
import { base32Encode } from '../src/kernel/totp';
import { jaroWinkler, nameScore, normaliseName } from '../src/adapters/sanctions';
import { reserveLimits } from '../src/modules/identity/limits';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.close(); });

async function register(name: string, type: 'supplier' | 'buyer', email: string, extra: object = {}) {
  const res = await env.app.inject({ method: 'POST', url: '/api/v1/onboarding/register', payload: {
    orgType: type, legalName: name, country: type === 'supplier' ? 'IN' : 'US', adminName: 'Test Admin', adminEmail: email, password: 'Str0ng!Passw0rd#1', ...extra } });
  expect(res.statusCode).toBe(201);
  // Enable MFA directly (the enrolment flow itself is covered in auth tests).
  const secret = base32Encode(Buffer.from('0123456789abcdef0123'));
  const c = new pg.Client({ connectionString: env.adminUrl }); await c.connect();
  await c.query('update identity.users set mfa_secret = $2, mfa_enabled = true where email = $1', [email, secret]); await c.end();
  const s = await loginAs(env, email, 'Str0ng!Passw0rd#1', secret);
  return { orgId: res.json().orgId as string, s };
}
async function upload(s: ReturnType<typeof makeSession>, filename: string, body: string) {
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/files?filename=${encodeURIComponent(filename)}`,
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(body) });
  return { status: res.statusCode, json: res.json() };
}
async function fullKyc(s: ReturnType<typeof makeSession>) {
  const c = (await s.req('GET', '/api/v1/onboarding/case')).json;
  for (const t of c.required) {
    const f = await upload(s, `${t}.pdf`, `doc ${t}`);
    expect(f.status).toBe(201);
    expect((await s.req('POST', '/api/v1/onboarding/documents', { docType: t, fileId: f.json.id })).status).toBe(201);
  }
  return s.req('POST', '/api/v1/onboarding/submit');
}

describe('jaro-winkler and name matching', () => {
  it('scores identical strings 1 and unrelated strings low', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.95);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(nameScore('Kumar Precision', 'Kumar Precisions Industries')).toBeGreaterThan(0.9);
  });
  it('normalises legal suffixes', () => { expect(normaliseName('Acme Trading Pvt. Ltd.')).toBe(normaliseName('ACME trading')); });
});

describe('onboarding, KYC and sanctions', () => {
  it('happy path: register -> docs -> submit -> admin approves', async () => {
    const { orgId, s } = await register('Himalaya Spices Pvt Ltd', 'supplier', 'owner@himalaya.test', { turnoverInr: '40000000' });
    const sub = await fullKyc(s);
    expect(sub.status).toBe(200);
    expect(sub.json.status).toBe('in_review');
    const admin = await login(env, 'earlio', 'PlatformAdmin');
    const q = (await admin.req('GET', '/api/v1/admin/kyc/cases?status=in_review')).json.items;
    const mine = q.find((i: any) => i.orgId === orgId);
    expect(mine).toBeTruthy();
    expect((await admin.req('POST', `/api/v1/admin/kyc/cases/${mine.id}/decision`, { decision: 'approve', reason: 'Documents verified' })).status).toBe(204);
    const me = (await s.req('GET', '/api/v1/org')).json;
    expect(me.kycStatus).toBe('approved');
    expect(me.small).toBe(true); // turnover below INR 25 crore (BR-11)
  });

  it('missing documents fail KYC', async () => {
    const { s } = await register('Docless Exports', 'supplier', 'a@docless.test');
    const sub = await s.req('POST', '/api/v1/onboarding/submit');
    expect(sub.json.status).toBe('rejected');
  });

  it('a sanctions hit blocks approval until reviewed; confirmed blocks the org', async () => {
    const { orgId, s } = await register('Orlov Maritime Holdings', 'buyer', 'a@orlov.test');
    expect((await fullKyc(s)).json.status).toBe('in_review');
    const admin = await login(env, 'earlio', 'PlatformAdmin');
    const kase = (await admin.req('GET', '/api/v1/admin/kyc/cases?status=in_review')).json.items.find((i: any) => i.orgId === orgId);
    expect(kase.sanctionsStatus).toBe('review');
    const blocked = await admin.req('POST', `/api/v1/admin/kyc/cases/${kase.id}/decision`, { decision: 'approve', reason: 'try' });
    expect(blocked.status).toBe(422);
    const hit = (await admin.req('GET', '/api/v1/admin/sanctions/screenings?outcome=hit')).json.items.find((i: any) => i.subjectOrgId === orgId);
    expect(hit.matches[0].score).toBeGreaterThanOrEqual(0.9);
    expect((await admin.req('POST', `/api/v1/admin/sanctions/screenings/${hit.id}/decision`, { decision: 'confirmed', reason: 'Exact match' })).status).toBe(204);
    expect((await s.req('GET', '/api/v1/org')).json.blocked).toBe(true);
    expect((await admin.req('POST', `/api/v1/admin/kyc/cases/${kase.id}/decision`, { decision: 'approve', reason: 'try' })).status).toBe(422);
  });

  it('a false positive is cleared, whitelisted and the org can be approved', async () => {
    const { orgId, s } = await register('Kumar Precisions Industries', 'supplier', 'a@kp.test');
    await fullKyc(s);
    const admin = await login(env, 'earlio', 'PlatformAdmin');
    const hit = (await admin.req('GET', '/api/v1/admin/sanctions/screenings?outcome=hit')).json.items.find((i: any) => i.subjectOrgId === orgId);
    expect((await admin.req('POST', `/api/v1/admin/sanctions/screenings/${hit.id}/decision`, { decision: 'false_positive', reason: 'Different entity, different country' })).status).toBe(204);
    const kase = (await admin.req('GET', '/api/v1/admin/kyc/cases?status=in_review')).json.items.find((i: any) => i.orgId === orgId);
    expect((await admin.req('POST', `/api/v1/admin/kyc/cases/${kase.id}/decision`, { decision: 'approve', reason: 'Cleared after review' })).status).toBe(204);
  });

  it('infected files are rejected and other tenants cannot read my files', async () => {
    const { s } = await register('Fileowner Ltd', 'supplier', 'a@fo.test');
    expect((await upload(s, 'virus.txt', 'X5O!P%@AP EICAR-STANDARD-ANTIVIRUS-TEST-FILE!')).status).toBe(422);
    const f = await upload(s, 'ok.pdf', 'hello');
    expect(f.status).toBe(201);
    const other = await login(env, 'northwind', 'Admin');
    expect((await other.req('GET', `/api/v1/files/${f.json.id}`)).status).toBe(404);
    expect((await s.req('GET', `/api/v1/files/${f.json.id}`)).status).toBe(200);
    expect((await other.req('GET', `/api/v1/files/${f.json.id}?disposition=inline`)).status).toBe(404);
  });

  it('files preview inline only when their bytes are an inert type; download stays the default', async () => {
    const { s } = await register('Previewer Ltd', 'supplier', 'a@pv.test');
    const get = async (id: string, q = '') => env.app.inject({ method: 'GET', url: `/api/v1/files/${id}${q}`, headers: { cookie: s.cookie } });

    const pdf = (await upload(s, 'invoice.pdf', '%PDF-1.7\n%test\n')).json.id;
    const dl = await get(pdf);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="invoice.pdf"');
    const view = await get(pdf, '?disposition=inline');
    expect(view.statusCode).toBe(200);
    expect(view.headers['content-type']).toBe('application/pdf');
    expect(view.headers['content-disposition']).toBe('inline; filename="invoice.pdf"');
    expect(view.headers['x-content-type-options']).toBe('nosniff');

    const csv = (await upload(s, 'lines.csv', 'sku,qty\nA-1,4\n')).json.id;
    expect((await get(csv, '?disposition=inline')).headers['content-type']).toBe('text/plain; charset=utf-8');

    // A PDF name does not make bytes a PDF, and markup is never rendered.
    for (const [name, body] of [['fake.pdf', 'hello'], ['page.html', '<script>alert(1)</script>'], ['logo.svg', '<svg onload="alert(1)"/>']]) {
      const id = (await upload(s, name, body)).json.id;
      const r = await get(id, '?disposition=inline');
      expect(r.statusCode).toBe(415);
      expect(r.json().message).toMatch(/cannot be previewed/);
      expect((await get(id)).statusCode).toBe(200);
    }
  });

  it('only platform staff can see the KYC queue', async () => {
    const s = await login(env, 'shree', 'Admin');
    expect((await s.req('GET', '/api/v1/admin/kyc/cases')).status).toBe(403);
    expect((await s.req('GET', '/api/v1/admin/sanctions/screenings')).status).toBe(403);
  });
});

describe('relationships', () => {
  it('needs both sides to approve, and the proposer cannot approve their own proposal', async () => {
    const proposer = await login(env, 'anand', 'Admin');
    const dir = (await proposer.req('GET', '/api/v1/directory/organisations?type=buyer&q=Lakeshore')).json.items;
    expect(dir).toHaveLength(1);
    const created = await proposer.req('POST', '/api/v1/relationships', { counterpartyId: dir[0].id });
    expect(created.status).toBe(201);
    const id = created.json.id;
    const ownApprover = await login(env, 'anand', 'Approver');
    expect((await ownApprover.req('POST', `/api/v1/relationships/${id}/approve`)).json.status).toBe('pending');
    const buyerApprover = await login(env, 'lakeshore', 'Approver');
    expect((await buyerApprover.req('POST', `/api/v1/relationships/${id}/approve`)).json.status).toBe('active');
    expect((await buyerApprover.req('POST', `/api/v1/relationships/${id}/approve`)).status).toBe(409);
  });

  it('cannot link with a blocked or sanctioned organisation', async () => {
    const s = await login(env, 'shree', 'Admin');
    const z = await env.svc.db.system((tx) => tx.one<{ id: string }>("select id from identity.organisations where legal_name = 'Zarnitsa Trading Ltd'"));
    const res = await s.req('POST', '/api/v1/relationships', { counterpartyId: z.id });
    expect(res.status).toBe(422);
    expect(res.json.detail ?? res.json.message).toMatch(/blocked/i);
  });

  it('a viewer cannot propose; strangers cannot approve', async () => {
    const v = await login(env, 'shree', 'Viewer');
    expect((await v.req('POST', '/api/v1/relationships', { counterpartyId: env.ids.merlion })).status).toBe(403);
    const rel = (await (await login(env, 'shree', 'Admin')).req('GET', '/api/v1/relationships')).json.items[0];
    const stranger = await login(env, 'kallang', 'Approver');
    expect((await stranger.req('POST', `/api/v1/relationships/${rel.id}/approve`)).status).toBe(404);
  });
});

describe('bank limits', () => {
  it('rejects a limit below current exposure and enforces who can set limits', async () => {
    const rm = await login(env, 'kestrel', 'RelationshipManager');
    expect((await rm.req('PUT', '/api/v1/bank/limits', { subjectOrgId: env.ids.northwind, kind: 'buyer', limitUsd: '1000000' })).status).toBe(204);
    const co = await login(env, 'kestrel', 'CreditOfficer');
    expect((await co.req('PUT', '/api/v1/bank/limits', { subjectOrgId: env.ids.northwind, kind: 'buyer', limitUsd: '1' })).status).toBe(403);
    await env.svc.db.tx({ platform: true, correlationId: 't' }, (tx) => reserveLimits(tx, env.svc, { bankOrgId: env.ids.kestrel!, buyerOrgId: env.ids.northwind!, supplierOrgId: env.ids.shree!, amountUsd: '600000' }));
    const low = await rm.req('PUT', '/api/v1/bank/limits', { subjectOrgId: env.ids.northwind, kind: 'buyer', limitUsd: '500000' });
    expect(low.status).toBe(422);
  });

  it('parallel reservations never exceed the limit', async () => {
    const rm = await login(env, 'harbour', 'RelationshipManager');
    await rm.req('PUT', '/api/v1/bank/limits', { subjectOrgId: env.ids.merlion, kind: 'buyer', limitUsd: '1000000' });
    await rm.req('PUT', '/api/v1/bank/limits', { subjectOrgId: env.ids.kumar, kind: 'supplier', limitUsd: '1000000' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () =>
      env.svc.db.tx({ platform: true, correlationId: 'race' }, (tx) =>
        reserveLimits(tx, env.svc, { bankOrgId: env.ids.harbour!, buyerOrgId: env.ids.merlion!, supplierOrgId: env.ids.kumar!, amountUsd: '100000' }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const l = (await rm.req('GET', '/api/v1/bank/limits')).json.items.find((i: any) => i.subjectName.startsWith('Merlion'));
    expect(Number(l.reservedUsd)).toBe(1_000_000);
    expect(Number(l.availableUsd)).toBe(0);
  });
});
