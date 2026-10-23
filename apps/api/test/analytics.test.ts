import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, loginAs, type TestEnv, type Session } from './helpers';
import { lateInterest } from '../src/modules/recovery/waterfall';

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

describe('dashboards and scorecard', () => {
  it('shows each organisation type its own numbers and the platform the six pilot metrics', async () => {
    const a = await funded('50000.00'); await accepted('20000.00'); expect(a.id).toBeTruthy();
    await env.work();
    const sup = await shree.req('GET', '/api/v1/dashboard?fresh=true'); expect(sup.status, JSON.stringify(sup.json)).toBe(200);
    const buy = await nw.req('GET', '/api/v1/dashboard?fresh=true'); expect(buy.status).toBe(200);
    const bank = await aurelia.req('GET', '/api/v1/dashboard?fresh=true'); expect(bank.status, JSON.stringify(bank.json)).toBe(200);
    const ins = await uw.req('GET', '/api/v1/dashboard?fresh=true'); expect(ins.status, JSON.stringify(ins.json)).toBe(200);
    expect(JSON.stringify(sup.json)).not.toEqual(JSON.stringify(buy.json));
    expect((await admin.req('GET', '/api/v1/dashboard')).status).toBe(403);
    const sc = await admin.req('GET', '/api/v1/admin/scorecard?fresh=true'); expect(sc.status, JSON.stringify(sc.json)).toBe(200);
    expect(sc.json.metrics.monthlyFinancedVolumeUsd.latest).toBe('45000.00');
    expect(sc.json.metrics.costVsBorrowing.met).toBe(true);
    expect(sup.json.financed.count).toBe(1); expect(sup.json.financed.volumeUsd).toBe('50000.00');
    expect(sup.json.aging.reduce((a: number, b: any) => a + b.count, 0)).toBe(2);
    expect(bank.json.funded.count).toBe(1); expect(bank.json.funded.outstandingUsd).toBe('45000.00');
    expect((await shree.req('GET', '/api/v1/admin/scorecard')).status).toBe(403);
  });
});
