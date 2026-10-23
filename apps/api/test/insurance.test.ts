import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv, type Session } from './helpers';
import { coverGate, availableRoutes } from '../src/modules/insurance/service';
import { emit } from '../src/platform/outbox';

let env: TestEnv;
let shree: Session; let nwApprover: Session; let lsApprover: Session; let uwES: Session; let kumar: Session; let mlApprover: Session; let uwSN: Session;
beforeAll(async () => {
  env = await createTestEnv();
  shree = await login(env, 'shree', 'FinanceUser'); nwApprover = await login(env, 'northwind', 'Approver'); lsApprover = await login(env, 'lakeshore', 'Approver');
  uwES = await login(env, 'exportshield', 'Underwriter');
  kumar = await login(env, 'kumar', 'FinanceUser'); mlApprover = await login(env, 'merlion', 'Approver'); uwSN = await login(env, 'sentinel', 'Underwriter');
});
afterAll(async () => { await env.close(); });

let n = 0;
async function upload(s: Session, name: string) {
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/files?filename=${name}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(name + Math.random()) });
  return res.json().id as string;
}
/** Create, document, submit and accept an invoice, then let the worker raise the cover request. */
async function accepted(supplier: Session, buyer: Session, buyerOrgId: string, amount = '48000.00', currency = 'USD') {
  const c = await supplier.req('POST', '/api/v1/invoices', { buyerOrgId, number: `INS/${++n}`, currency, amount, issueDate: '2026-11-01', dueDate: '2026-12-31' });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  for (const t of ['commercial_invoice', 'delivery_proof']) await supplier.req('POST', `/api/v1/invoices/${c.json.id}/documents`, { docType: t, fileId: await upload(supplier, t + '.pdf') });
  expect((await supplier.req('POST', `/api/v1/invoices/${c.json.id}/submit`)).status).toBe(200);
  expect((await buyer.req('POST', `/api/v1/invoices/${c.json.id}/decision`, { decision: 'accept', undertakingAccepted: true })).status).toBe(200);
  await env.work();
  return c.json as { id: string; humanId: string };
}
const coverOf = async (s: Session, id: string) => (await s.req('GET', `/api/v1/invoices/${id}/cover`)).json;


describe('requesting cover', () => {
  it('accepting an invoice raises a cover request to the relationship insurer with a 24h SLA', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!);
    const c = await coverOf(shree, inv.id);
    expect(c.status).toBe('requested'); expect(c.insurerName).toBe('ExportShield'); expect(c.gateway).toBe('manual');
    expect(c.requestedCoverPct).toBe(90);
    expect(new Date(c.slaDueAt).getTime() - new Date(c.requestedAt).getTime()).toBe(24 * 3_600_000);
    expect((await shree.req('GET', `/api/v1/invoices/${inv.id}`)).json.coverStatus).toBe('requested');
  });
  it('is visible to the buyer and the insurer, hidden from other tenants', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!);
    expect((await coverOf(nwApprover, inv.id)).status).toBe('requested');
    expect((await uwES.req('GET', '/api/v1/insurance/requests')).json.items.some((i: any) => i.invoiceId === inv.id)).toBe(true);
    expect((await uwSN.req('GET', '/api/v1/insurance/requests')).json.items.some((i: any) => i.invoiceId === inv.id)).toBe(false);
    expect((await mlApprover.req('GET', `/api/v1/invoices/${inv.id}/cover`)).status).toBe(404);
  });
  it('is idempotent: re-processing the same event does not create a second record', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!);
    await env.svc.db.system((tx) => emit(tx, env.clock.now(), 'invoice.accepted', { invoiceId: inv.id }, []));
    await env.work();
    const rows = await env.svc.db.system((tx) => tx.query('select 1 from insurance.cover_records where invoice_id = $1', [inv.id]));
    expect(rows).toHaveLength(1);
  });
  it('a relationship with no insurer is recorded as uninsured and leaves only early payment', async () => {
    await env.svc.db.system((tx) => tx.query('update identity.relationships set insurer_org_id = null where supplier_org_id = $1 and buyer_org_id = $2', [env.ids.deccan, env.ids.northwind]));
    const dec = await login(env, 'deccan', 'FinanceUser');
    const inv = await accepted(dec, nwApprover, env.ids.northwind!);
    const c = await coverOf(dec, inv.id);
    expect(c.status).toBe('uninsured');
    expect(availableRoutes(c.status)).toEqual(['early_payment']);
    expect(coverGate({ status: c.status, coverPct: null }, 80).ok).toBe(false);
  });
});

describe('underwriter decisions (J-I1)', () => {
  it('only an underwriter can decide, and only on their own requests', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!);
    const c = await coverOf(shree, inv.id);
    expect((await shree.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await uwSN.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' })).status).toBe(404);
  });
  it('full approval uses the term-set cover, reserves limit and syncs the invoice', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!, '10000.00');
    const c = await coverOf(shree, inv.id);
    const d = await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ status: 'approved', coverPct: 90, insuredAmount: '9000.00' });
    expect((await shree.req('GET', `/api/v1/invoices/${inv.id}`)).json.coverStatus).toBe('approved');
    expect((await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' })).status).toBe(409);
  });
  it('a lower percentage is a partial approval; above the terms is refused', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!, '20000.00');
    const c = await coverOf(shree, inv.id);
    expect((await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve', coverPct: 95 })).status).toBe(400);
    const d = await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve', coverPct: 60 });
    expect(d.json).toMatchObject({ status: 'partial', coverPct: 60, insuredAmount: '12000.00' });
    expect(coverGate({ status: 'partial', coverPct: 60 }, 80)).toMatchObject({ ok: false });
    expect(coverGate({ status: 'partial', coverPct: 60 }, 50).ok).toBe(true);
  });
  it('a declined cover needs a reason, keeps early payment available and removes financing', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!);
    const c = await coverOf(shree, inv.id);
    expect((await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'decline' })).status).toBe(400);
    const d = await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'decline', reason: 'Buyer under review' });
    expect(d.json.status).toBe('declined');
    const after = await coverOf(shree, inv.id);
    expect(after.reason).toBe('Buyer under review');
    expect(availableRoutes('declined')).toEqual(['early_payment']);
    expect(availableRoutes('approved')).toEqual(['financing', 'early_payment']);
  });
  it('eligibility uses the real cover record: a small supplier’s advance is capped at the insured cover', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!, '30000.00');
    const c = await coverOf(shree, inv.id);
    await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve', coverPct: 70 });
    const e = await shree.req('POST', `/api/v1/invoices/${inv.id}/eligibility`, { bankOrgId: env.ids.kestrel, insurerOrgId: env.ids.exportshield });
    expect(e.status, JSON.stringify(e.json)).toBe(200);
    // Kestrel's minimum cover may be above 70%: either way the answer must come from the actual 70%.
    if (e.json.eligible) expect(e.json.quote.coverPct).toBe(70); else expect(e.json.reasons.join(' ')).toMatch(/70%/);
  });
});

describe('buyer limits', () => {
  it('rejects limits above the policy caps or below current exposure', async () => {
    const put = (limitUsd: string) => uwES.req('PUT', '/api/v1/insurance/limits', { buyerOrgId: env.ids.lakeshore, limitUsd, expiresAt: '2027-12-31T00:00:00.000Z', policyNumber: 'ES-POL-LS-002' });
    expect((await put('9000000')).status).toBe(422);
    expect((await put('100000')).status).toBe(204);
    const inv = await accepted(shree, lsApprover, env.ids.lakeshore!, '50000.00');
    const c = await coverOf(shree, inv.id);
    expect((await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' })).status).toBe(200);
    const low = await put('10000');
    expect(low.status).toBe(422); expect(JSON.stringify(low.json)).toMatch(/below current exposure/);
  });
  it('parallel approvals can never over-consume the limit', async () => {
    expect((await uwES.req('PUT', '/api/v1/insurance/limits', { buyerOrgId: env.ids.lakeshore, limitUsd: '200000', expiresAt: '2027-12-31T00:00:00.000Z', policyNumber: 'ES-POL-LS-002' })).status).toBe(204);
    const before = (await uwES.req('GET', '/api/v1/insurance/limits')).json.items.find((l: any) => l.buyer.id === env.ids.lakeshore);
    const invs = [];
    for (let i = 0; i < 5; i++) invs.push(await accepted(shree, lsApprover, env.ids.lakeshore!, '60000.00'));
    const covers = await Promise.all(invs.map((i) => coverOf(shree, i.id)));
    const res = await Promise.all(covers.map((c) => uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' })));
    const after = (await uwES.req('GET', '/api/v1/insurance/limits')).json.items.find((l: any) => l.buyer.id === env.ids.lakeshore);
    expect(Number(after.reservedUsd) + Number(after.usedUsd)).toBeLessThanOrEqual(200000);
    expect(Number(after.availableUsd)).toBeGreaterThanOrEqual(0);
    expect(res.every((r) => [200, 409, 422].includes(r.status)), JSON.stringify(res.map((r) => r.status))).toBe(true);
    expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(3);
    expect(Number(before.reservedUsd)).toBeLessThan(Number(after.reservedUsd));
  });
  it('is invisible to other insurers and to suppliers', async () => {
    expect((await uwSN.req('GET', '/api/v1/insurance/limits')).json.items.every((l: any) => l.policyNumber.startsWith('SN-'))).toBe(true);
    expect((await shree.req('GET', '/api/v1/insurance/limits')).status).toBe(403);
  });
});

describe('worker and gateways', () => {
  it('the simulated insurer API decides on its own after its delay; the clock is virtual', async () => {
    const inv = await accepted(kumar, mlApprover, env.ids.merlion!, '40000.00');
    expect((await coverOf(kumar, inv.id)).status).toBe('requested');
    expect((await coverOf(kumar, inv.id)).gateway).toBe('api');
    try {
      env.clock.advanceHours(4);
      const out = await env.work();
      expect(out.insurerApi).toBeGreaterThanOrEqual(1);
      const row = await env.svc.db.system((tx) => tx.one<any>('select status, cover_pct, decision_reason from insurance.cover_records where invoice_id = $1', [inv.id]));
      expect(row.status).toMatch(/approved|partial/); expect(Number(row.cover_pct)).toBeGreaterThan(0);
      const msgs = await env.svc.db.system((tx) => tx.query("select direction from platform.integration_messages where adapter = 'insurer'"));
      expect(msgs.some((m: any) => m.direction === 'response')).toBe(true);
    } finally { env.clock.setTo(new Date('2026-11-02T04:00:00.000Z')); }
  });
  it('file exchange: export open requests as CSV and import decisions, reporting bad rows', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!, '15000.00');
    const c = await coverOf(shree, inv.id);
    const csv = await env.app.inject({ method: 'GET', url: '/api/v1/insurance/requests.csv', headers: { cookie: uwES.cookie } });
    expect(csv.statusCode).toBe(200); expect(csv.body).toContain(c.id);
    const imp = await uwES.req('POST', '/api/v1/insurance/decisions/import', { csv: `requestId,decision,coverPct,reason\n${c.id},approve,80,\nnot-an-id,approve,,\n${c.id},maybe,,\n` });
    expect(imp.status, JSON.stringify(imp.json)).toBe(200);
    expect(imp.json.applied).toBe(1); expect(imp.json.errors).toHaveLength(2);
    expect((await coverOf(shree, inv.id)).status).toBe('partial');
  });
  it('unused approved cover expires and frees its limit', async () => {
    const inv = await accepted(shree, nwApprover, env.ids.northwind!, '8000.00');
    const c = await coverOf(shree, inv.id);
    await uwES.req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' });
    const lim = async () => (await env.svc.db.system((tx) => tx.one<any>('select reserved_usd from insurance.buyer_limits where insurer_org_id = $1 and buyer_org_id = $2', [env.ids.exportshield, env.ids.northwind]))).reserved_usd;
    const reserved = Number(await lim());
    try {
      env.clock.advanceDays(31);
      expect((await env.work()).coversExpired).toBeGreaterThanOrEqual(1);
      expect(Number(await lim())).toBeLessThan(reserved);
      expect((await env.svc.db.system((tx) => tx.one<any>('select status from insurance.cover_records where id = $1', [c.id]))).status).toBe('expired');
    } finally { env.clock.setTo(new Date('2026-11-02T04:00:00.000Z')); }
  });
  it('a poison event is retried, then parked, without blocking later events', async () => {
    await env.svc.db.system(async (tx) => {
      await emit(tx, env.clock.now(), 'invoice.accepted', { invoiceId: '00000000-0000-0000-0000-000000000000' }, []);
    });
    const inv = await accepted(shree, nwApprover, env.ids.northwind!, '5000.00');
    for (let i = 0; i < 6; i++) await env.work();
    const poison = await env.svc.db.system((tx) => tx.one<any>("select processed_at, attempts, last_error from platform.outbox where payload->>'invoiceId' = '00000000-0000-0000-0000-000000000000'"));
    expect(poison.attempts).toBe(5); expect(poison.processed_at).not.toBeNull(); expect(poison.last_error).toMatch(/Invoice/i);
    expect((await coverOf(shree, inv.id)).status).toBe('requested');
  });
});
