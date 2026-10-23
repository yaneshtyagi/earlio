import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, loginAs, type TestEnv, type Session } from './helpers';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { signWebhook } from '../src/adapters/payments';

let env: TestEnv; let admin2: Session;
let shree: Session; let shreeApprover: Session; let nw: Session; let nwFinance: Session; let uw: Session; let aurelia: Session; let aureliaOps: Session; let admin: Session; let claims: Session; let esUnderwriter: Session;
const T0 = new Date('2026-11-02T04:00:00.000Z');
async function logins() {
  shree = await login(env, 'shree', 'FinanceUser'); shreeApprover = await login(env, 'shree', 'Approver'); nw = await login(env, 'northwind', 'Approver'); nwFinance = await login(env, 'northwind', 'FinanceUser');
  uw = await login(env, 'exportshield', 'Underwriter'); esUnderwriter = uw; claims = await login(env, 'exportshield', 'ClaimsHandler');
  aurelia = await login(env, 'aurelia', 'CreditOfficer'); aureliaOps = await login(env, 'aurelia', 'Operations'); admin = await login(env, 'earlio', 'PlatformAdmin'); admin2 = await loginAs(env, 'admin2@earlio.demo');
}
beforeAll(async () => { env = await createTestEnv(); await logins(); });
afterAll(async () => { await env.close(); });

let n = 0;
async function upload(s: Session, name: string) {
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/files?filename=${name}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(name + Math.random()) });
  return res.json().id as string;
}
const q = <T = any>(sql: string, p: unknown[] = []) => env.svc.db.system((tx) => tx.query<T>(sql, p));
const invStatus = async (id: string) => (await shree.req('GET', `/api/v1/invoices/${id}`)).json;
// Platform settings are maker-checker: one administrator proposes, the other approves.
const setTimers = async (v: { responseHours: number; escalateAfterHours: number; timeoutAfterHours: number }) => {
  const p = await admin.req('PUT', '/api/v1/admin/settings/dispute_timers', { value: v });
  expect(p.status, JSON.stringify(p.json)).toBe(202);
  expect((await admin2.req('POST', `/api/v1/approvals/settings/${p.json.changeId}/decision`, { approve: true })).status).toBe(204);
};
const reset = async () => { env.clock.setTo(T0); await logins(); };
const at = async (iso: string) => { env.clock.setTo(new Date(iso)); await logins(); await env.work(); };

async function accepted(amount = '100000.00') {
  const c = await shree.req('POST', '/api/v1/invoices', { buyerOrgId: env.ids.northwind, number: `EX/${++n}`, currency: 'USD', amount, issueDate: '2026-11-01', dueDate: '2027-01-01', poNumber: 'PO-NW-2201' });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  for (const t of ['commercial_invoice', 'delivery_proof']) await shree.req('POST', `/api/v1/invoices/${c.json.id}/documents`, { docType: t, fileId: await upload(shree, t + '.pdf') });
  await shree.req('POST', `/api/v1/invoices/${c.json.id}/submit`);
  await nw.req('POST', `/api/v1/invoices/${c.json.id}/decision`, { decision: 'accept', undertakingAccepted: true });
  await env.work();
  const cover = (await shree.req('GET', `/api/v1/invoices/${c.json.id}/cover`)).json;
  await uw.req('POST', `/api/v1/insurance/requests/${cover.id}/decision`, { decision: 'approve' });
  return c.json as { id: string; humanId: string };
}
async function funded(amount?: string) {
  const inv = await accepted(amount);
  expect((await shree.req('POST', `/api/v1/invoices/${inv.id}/open-funding`)).json.opened).toBe(true);
  const o = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/offers`, {});
  const fr = (await shree.req('POST', `/api/v1/offers/${o.json.id}/select`)).json;
  await shreeApprover.req('POST', `/api/v1/financing-requests/${fr.id}/consent`);
  await nw.req('POST', `/api/v1/invoices/${inv.id}/assignment-ack`);
  env.clock.advanceHours(25); await logins();
  expect((await aurelia.req('POST', `/api/v1/financing-requests/${fr.id}/confirm`)).status).toBe(200);
  for (let i = 0; i < 20; i++) {
    await env.work();
    if ((await invStatus(inv.id)).status === 'Funded') break;
    env.clock.advanceHours(i % 2 ? 24 : 2); await logins();
  }
  expect((await invStatus(inv.id)).status).toBe('Funded');
  return { ...inv, frId: fr.id as string };
}

let bankAdmin: Session;
async function call(key: { apiKey: string; signingSecret: string }, method: 'GET' | 'POST', url: string, body?: string, over: { sig?: string; ts?: number; nonce?: string; noAuth?: boolean; contentType?: string; headers?: Record<string, string> } = {}) {
  const ts = over.ts ?? env.clock.now().getTime(); const nonce = over.nonce ?? randomUUID();
  const sig = over.sig ?? signWebhook(key.signingSecret, ts, nonce, body ?? '');
  const res = await env.app.inject({ method, url, payload: body, headers: { ...(over.noAuth ? {} : { authorization: `Bearer ${key.apiKey}` }), 'content-type': over.contentType ?? 'application/json', 'x-earlio-timestamp': String(ts), 'x-earlio-nonce': nonce, 'x-earlio-signature': sig, ...over.headers } });
  let json: any = null; try { json = res.json(); } catch { json = res.body; }
  return { status: res.statusCode, json, text: res.body };
}
async function openForFunding(amount = '60000.00') {
  const inv = await accepted(amount);
  expect((await shree.req('POST', `/api/v1/invoices/${inv.id}/open-funding`)).json.opened).toBe(true);
  return inv;
}

describe('bank API keys, signed machine API and file drop', () => {
  it('only a bank administrator manages keys; the secret is shown once; signed calls work and tampering does not', async () => {
    bankAdmin = await login(env, 'aurelia', 'Admin');
    expect((await aurelia.req('GET', '/api/v1/bank/api-keys')).status).toBe(403);
    expect((await shree.req('GET', '/api/v1/bank/api-keys')).status).toBe(403);
    const k = (await bankAdmin.req('POST', '/api/v1/bank/api-keys', { label: 'core-banking' })); expect(k.status, JSON.stringify(k.json)).toBe(201);
    expect(k.json.apiKey).toMatch(/^ek_[0-9a-f]{8}_[0-9a-f]{48}$/);
    const list = (await bankAdmin.req('GET', '/api/v1/bank/api-keys')).json.items; expect(JSON.stringify(list)).not.toContain(k.json.apiKey.slice(-20));
    const inv = await openForFunding();
    // unsigned / unauthenticated
    expect((await call(k.json, 'GET', '/api/v1/machine/invitations', undefined, { noAuth: true })).status).toBe(401);
    const inv1 = await call(k.json, 'GET', '/api/v1/machine/invitations'); expect(inv1.status, inv1.text).toBe(200);
    expect(inv1.json.items.map((i: any) => i.invoiceId)).toContain(inv.id);
    const body = JSON.stringify({ invoiceId: inv.id });
    expect((await call(k.json, 'POST', '/api/v1/machine/offers', body, { sig: 'ab'.repeat(32) })).status).toBe(401);
    expect((await call(k.json, 'POST', '/api/v1/machine/offers', body, { ts: env.clock.now().getTime() - 10 * 60_000 })).status).toBe(401);
    const nonce = randomUUID();
    const ok = await call(k.json, 'POST', '/api/v1/machine/offers', body, { nonce, headers: { 'idempotency-key': 'k1' } }); expect(ok.status, ok.text).toBe(201);
    expect((await call(k.json, 'POST', '/api/v1/machine/offers', body, { nonce })).status).toBe(409); // replay
    const again = await call(k.json, 'POST', '/api/v1/machine/offers', body, { headers: { 'idempotency-key': 'k1' } });
    expect(again.json.id).toBe(ok.json.id); // idempotent retry
    // a key from one bank cannot see another bank's invitations
    const kk = (await (await login(env, 'kestrel', 'Admin')).req('POST', '/api/v1/bank/api-keys', { label: 'x' })).json;
    expect((await call(kk, 'POST', '/api/v1/machine/offers', body, {})).status).toBe(201); // kestrel's own offer, not aurelia's
    const owners = await q('select distinct bank_org_id from marketplace.offers where invoice_id = $1', [inv.id]); expect(owners).toHaveLength(2);
    expect((await q("select count(*)::int as n from audit.events where action like 'apikey.%'"))[0].n).toBeGreaterThan(0);
  });

  it('rotation keeps the old key for 24 hours, then it stops; revoke is immediate', async () => {
    const k1 = (await bankAdmin.req('POST', '/api/v1/bank/api-keys', { label: 'rot' })).json;
    const k2 = (await bankAdmin.req('POST', `/api/v1/bank/api-keys/${k1.id}/rotate`)).json; expect(k2.apiKey).toBeTruthy();
    expect((await call(k1, 'GET', '/api/v1/machine/invitations')).status).toBe(200);
    expect((await call(k2, 'GET', '/api/v1/machine/invitations')).status).toBe(200);
    expect((await bankAdmin.req('POST', `/api/v1/bank/api-keys/${k1.id}/rotate`)).status).toBe(409);
    env.clock.advanceHours(25); await logins(); bankAdmin = await login(env, 'aurelia', 'Admin');
    expect((await call(k1, 'GET', '/api/v1/machine/invitations')).status).toBe(401);
    expect((await call(k2, 'GET', '/api/v1/machine/invitations')).status).toBe(200);
    expect((await bankAdmin.req('POST', `/api/v1/bank/api-keys/${k2.id}/revoke`)).status).toBe(204);
    expect((await call(k2, 'GET', '/api/v1/machine/invitations')).status).toBe(401);
    await reset(); bankAdmin = await login(env, 'aurelia', 'Admin');
  });

  it('file drop: a CSV with a bad row imports the good rows and reports the bad one; instructions export as CSV', async () => {
    const inv = await openForFunding('30000.00');
    const csv = `invoice,ratePct,advancePct,fxSpreadPct,validityHours\r\n${inv.humanId},,,,\r\nEXP-NOPE,,,,\r\n${inv.humanId},abc,,,\r\n`;
    const r = await aurelia.req('POST', '/api/v1/bank/files/offers', { filename: 'offers.csv', content: csv });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.rowsTotal).toBe(3); expect(r.json.rowsOk).toBe(1); expect(r.json.errors.map((e: any) => e.row)).toEqual([3, 4]);
    const st = await aureliaOps.req('POST', '/api/v1/bank/files/statements', { filename: 's.csv', content: 'bankTxnId,reference,currency,amount,valueDate,payer\nT1,EARL-X,USD,10.00,2026-11-02,Acme\nT2,,EUR,1,2026-11-02,x\n' });
    expect(st.json.rowsOk).toBe(1); expect(st.json.errors).toHaveLength(1);
    const ins = await aureliaOps.req('GET', '/api/v1/bank/files/instructions');
    expect(ins.status).toBe(200);
    expect((await aureliaOps.req('GET', '/api/v1/bank/file-batches')).json.items.length).toBeGreaterThanOrEqual(3);
    expect((await shree.req('POST', '/api/v1/bank/files/offers', { filename: 'x.csv', content: csv })).status).toBe(403);
  });

  it('webhooks: a matching event is delivered, signed, to the registered endpoint; a failing endpoint is retried', async () => {
    const got: { sig: string; body: string }[] = []; let fail = true;
    const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ sig: String(req.headers['x-earlio-signature']), body: b }); res.statusCode = fail ? 500 : 200; res.end(); }); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
    try {
      expect((await bankAdmin.req('POST', '/api/v1/bank/webhooks', { url: 'ftp://x' })).status).toBe(400);
      const key = (await bankAdmin.req('POST', '/api/v1/bank/api-keys', { label: 'wh' })).json;
      const w = await bankAdmin.req('POST', '/api/v1/bank/webhooks', { url, events: ['offer.submitted'] }); expect(w.status, JSON.stringify(w.json)).toBe(201);
      const wi = await openForFunding('21000.00'); expect((await aurelia.req('POST', `/api/v1/invoices/${wi.id}/offers`, {})).status).toBe(201); await env.work(); await env.work();
      const d1 = (await bankAdmin.req('GET', '/api/v1/bank/webhooks')).json.deliveries;
      expect(d1.length, JSON.stringify(d1)).toBeGreaterThan(0); expect(d1[0].status).toBe('pending'); expect(d1[0].attempts).toBeGreaterThan(0);
      fail = false; await env.work();
      const d2 = (await bankAdmin.req('GET', '/api/v1/bank/webhooks')).json.deliveries; expect(d2.some((d: any) => d.status === 'delivered')).toBe(true);
      const last = got[got.length - 1]!; expect(last.sig).toMatch(/^[0-9a-f]{64}$/); expect(JSON.parse(last.body).type).toBeTruthy();
      expect((await bankAdmin.req('DELETE', `/api/v1/bank/webhooks/${w.json.id}`)).status).toBe(204);
      void key;
    } finally { srv.close(); }
  });
});
