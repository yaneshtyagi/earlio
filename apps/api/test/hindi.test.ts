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

describe('Hindi', () => {
  it('an organisation that chooses Hindi gets Hindi notifications (INR in Indian grouping); others stay English; terms preview can be generated in Hindi', async () => {
    const adm = await login(env, 'shree', 'Admin');
    expect((await shree.req('PUT', '/api/v1/org/language', { language: 'hi' })).status).toBe(403); // finance user is not an admin
    expect((await adm.req('PUT', '/api/v1/org/language', { language: 'hi' })).status).toBe(200);
    expect((await adm.req('GET', '/api/v1/org/language')).json.language).toBe('hi');
    await funded('250000.00');
    const mine = (await shree.req('GET', '/api/v1/notifications')).json.items as any[];
    const credited = mine.find((n) => n.topic === 'disbursement.credited'); expect(credited, JSON.stringify(mine.map((m) => m.topic))).toBeTruthy();
    expect(credited.subject).toMatch(/जमा हुए/); expect(credited.subject).toMatch(/₹\d{1,2}(,\d{2})*,\d{3}\.\d{2}/);
    const buyerSide = (await nw.req('GET', '/api/v1/notifications')).json.items as any[];
    expect(buyerSide.every((n) => !/[\u0900-\u097F]/.test(n.subject))).toBe(true);
    const rows = await q("select lang from notify.notifications where recipient_org_id = $1 and topic = 'invoice.accepted' limit 1", [env.ids.shree]); expect(rows[0].lang).toBe('hi');
    const bank = await login(env, 'aurelia', 'Admin');
    const hi = await bank.req('POST', '/api/v1/terms/preview', { ownerType: 'bank', lang: 'hi', body: { advancePct: 90, fxSpreadPct: 0.5, pricing: { type: 'fixed', ratePct: 8 }, offerValidityHours: 24 } });
    expect(hi.status, JSON.stringify(hi.json)).toBe(200); expect(hi.json.supplier.join(' ')).toMatch(/अग्रिम/);
    const en = await bank.req('POST', '/api/v1/terms/preview', { ownerType: 'bank', body: { advancePct: 90 } }); expect(en.json.supplier[0]).toMatch(/up front/);
  });
});
