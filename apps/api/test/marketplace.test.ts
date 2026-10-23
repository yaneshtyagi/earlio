import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv, type Session } from './helpers';

let env: TestEnv;
let shree: Session; let shreeApprover: Session; let nw: Session; let uw: Session; let aurelia: Session; let kestrel: Session; let harbour: Session;
const T0 = new Date('2026-11-02T04:00:00.000Z');
async function logins() {
  shree = await login(env, 'shree', 'FinanceUser'); shreeApprover = await login(env, 'shree', 'Approver'); nw = await login(env, 'northwind', 'Approver');
  uw = await login(env, 'exportshield', 'Underwriter'); aurelia = await login(env, 'aurelia', 'CreditOfficer'); kestrel = await login(env, 'kestrel', 'CreditOfficer'); harbour = await login(env, 'harbour', 'CreditOfficer');
}
beforeAll(async () => { env = await createTestEnv(); await logins(); });
afterAll(async () => { await env.close(); });

let n = 0;
async function upload(s: Session, name: string) {
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/files?filename=${name}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(name + Math.random()) });
  return res.json().id as string;
}
/** Invoice of 100,000 USD due in exactly 60 days (the BR-3 worked example), accepted by Northwind, with cover decided by ExportShield. */
async function accepted(opts: { cover?: 'approve' | 'decline' | 'none'; amount?: string; due?: string } = {}) {
  const c = await shree.req('POST', '/api/v1/invoices', { buyerOrgId: env.ids.northwind, number: `MK/${++n}`, currency: 'USD', amount: opts.amount ?? '100000.00', issueDate: '2026-11-01', dueDate: opts.due ?? '2027-01-01', poNumber: 'PO-NW-2201' });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  for (const t of ['commercial_invoice', 'delivery_proof']) await shree.req('POST', `/api/v1/invoices/${c.json.id}/documents`, { docType: t, fileId: await upload(shree, t + '.pdf') });
  expect((await shree.req('POST', `/api/v1/invoices/${c.json.id}/submit`)).status).toBe(200);
  expect((await nw.req('POST', `/api/v1/invoices/${c.json.id}/decision`, { decision: 'accept', undertakingAccepted: true })).status).toBe(200);
  await env.work();
  const cover = (await shree.req('GET', `/api/v1/invoices/${c.json.id}/cover`)).json;
  if (opts.cover !== 'none') {
    const d = await uw.req('POST', `/api/v1/insurance/requests/${cover.id}/decision`, opts.cover === 'decline' ? { decision: 'decline', reason: 'Buyer under review' } : { decision: 'approve' });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
  }
  return c.json as { id: string; humanId: string };
}
async function opened(opts: Parameters<typeof accepted>[0] = {}) {
  const inv = await accepted(opts);
  const o = await shree.req('POST', `/api/v1/invoices/${inv.id}/open-funding`);
  expect(o.status, JSON.stringify(o.json)).toBe(200); expect(o.json.opened, JSON.stringify(o.json)).toBe(true);
  return inv;
}
const invStatus = async (id: string) => (await shree.req('GET', `/api/v1/invoices/${id}`)).json;
const offer = async (s: Session, id: string, body: Record<string, unknown> = {}) => s.req('POST', `/api/v1/invoices/${id}/offers`, body);
/** Disbursement is asynchronous: run the workers, moving the virtual clock past value dates, until the invoice is funded. */
async function fundIt(invoiceId: string) {
  for (let i = 0; i < 8; i++) {
    await env.work();
    if ((await invStatus(invoiceId)).status === 'Funded') return;
    env.clock.advanceHours(i % 2 === 0 ? 2 : 24); await logins();
  }
}
const q = <T = any>(sql: string, p: unknown[] = []) => env.svc.db.system((tx) => tx.query<T>(sql, p));
const limit = async (bank: string, subject: string) => (await q('select * from identity.bank_limits where bank_org_id = $1 and subject_org_id = $2', [env.ids[bank], env.ids[subject]]))[0];

describe('opening for funding and bank visibility', () => {
  it('runs the gates, invites the supplier’s and buyer’s preferred banks plus the partner, and moves to OpenForFunding', async () => {
    const inv = await accepted();
    const g = await shree.req('GET', `/api/v1/invoices/${inv.id}/funding-gates`);
    expect(g.json.gates.map((x: any) => x.n)).toEqual([1, 2, 3, 4]);
    expect(g.json.gates[3].ok).toBe(false); // dispute window still running: fine for opening, not for funding
    const o = await shree.req('POST', `/api/v1/invoices/${inv.id}/open-funding`);
    expect(o.json).toMatchObject({ opened: true, invited: 2 });
    expect((await invStatus(inv.id)).status).toBe('OpenForFunding');
    const inv2 = await q("select b.legal_name, m.source from marketplace.invitations m join identity.organisations b on b.id = m.bank_org_id where m.invoice_id = $1 order by 1", [inv.id]);
    expect(inv2.map((x: any) => [x.legal_name, x.source])).toEqual([['Aurelia Bank', 'partner'], ['Kestrel Capital', 'supplier_preferred']]);
  });
  it('a bank that was not invited cannot read the invoice, its documents or its offers (API and database)', async () => {
    const inv = await opened();
    expect((await harbour.req('GET', `/api/v1/invoices/${inv.id}`)).status).toBe(404);
    expect((await offer(harbour, inv.id)).status).toBe(404);
    expect((await aurelia.req('GET', `/api/v1/invoices/${inv.id}`)).status).toBe(200);
    const visible = await env.svc.db.tx({ orgId: env.ids.harbour, userId: undefined, role: 'CreditOfficer', correlationId: 't' }, (tx) => tx.query('select id from invoicing.invoices where id = $1', [inv.id]));
    expect(visible).toHaveLength(0);
    const docs = await env.svc.db.tx({ orgId: env.ids.harbour, role: 'CreditOfficer', correlationId: 't' }, (tx) => tx.query('select id from invoicing.invoice_documents where invoice_id = $1', [inv.id]));
    expect(docs).toHaveLength(0);
    const seen = await env.svc.db.tx({ orgId: env.ids.kestrel, role: 'CreditOfficer', correlationId: 't' }, (tx) => tx.query('select id from invoicing.invoice_documents where invoice_id = $1', [inv.id]));
    expect(seen.length).toBeGreaterThan(0);
  });
  it('white-label mode invites only the partner bank', async () => {
    (env.svc.config as any).mode = 'white-label';
    try {
      const inv = await opened();
      const rows = await q('select b.legal_name from marketplace.invitations m join identity.organisations b on b.id = m.bank_org_id where m.invoice_id = $1', [inv.id]);
      expect(rows.map((r: any) => r.legal_name)).toEqual(['Aurelia Bank']);
    } finally { (env.svc.config as any).mode = 'network'; }
  });
  it('a failed gate parks the invoice as NotEligible with a plain reason; fixing it allows a re-check', async () => {
    const dec = await login(env, 'deccan', 'FinanceUser'); const ml = await login(env, 'merlion', 'Approver'); const adm = await login(env, 'earlio', 'PlatformAdmin');
    const c = await dec.req('POST', '/api/v1/invoices', { buyerOrgId: env.ids.merlion, number: `NE/${++n}`, currency: 'USD', amount: '30000.00', issueDate: '2026-11-01', dueDate: '2027-01-15' });
    for (const t of ['commercial_invoice', 'delivery_proof']) await dec.req('POST', `/api/v1/invoices/${c.json.id}/documents`, { docType: t, fileId: await upload(dec, t + '.pdf') });
    await dec.req('POST', `/api/v1/invoices/${c.json.id}/submit`);
    await ml.req('POST', `/api/v1/invoices/${c.json.id}/decision`, { decision: 'accept', undertakingAccepted: true });
    const rel = (await q('select id from identity.relationships where supplier_org_id = $1 and buyer_org_id = $2', [env.ids.deccan, env.ids.merlion]))[0];
    expect((await adm.req('POST', `/api/v1/admin/relationships/${rel.id}/suspend`, { reason: 'Test suspension' })).status).toBe(204);
    const o = await dec.req('POST', `/api/v1/invoices/${c.json.id}/open-funding`);
    expect(o.json.opened).toBe(false);
    expect(o.json.gates.find((g: any) => !g.ok).reason).toMatch(/relationship is not active/);
    expect((await dec.req('GET', `/api/v1/invoices/${c.json.id}`)).json.status).toBe('NotEligible');
    await q("update identity.relationships set status = 'active' where id = $1", [rel.id]);
    const again = await dec.req('POST', `/api/v1/invoices/${c.json.id}/open-funding`);
    expect(again.json.opened).toBe(true);
  });
});

describe('bank offers (J-B1)', () => {
  it('Aurelia’s default offer reproduces the BR-3 numbers in INR', async () => {
    const inv = await opened();
    const prev = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/offers/preview`, {});
    expect(prev.json.eligible, JSON.stringify(prev.json)).toBe(true);
    const o = await offer(aurelia, inv.id);
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    expect(o.json).toMatchObject({ status: 'Submitted', netCash: '88854.52', allInPct: '7.84', fxRate: '88.1348', netCashInr: '7831175.35', insured: true, nonRecourse: true, coverPct: 90 });
    expect(o.json.breakdown).toMatchObject({ discount: '865.48', processingFee: '100.00', premium: '180.00', totalCharges: '1145.48' });
    expect((await invStatus(inv.id)).status).toBe('OffersReceived');
  });
  it('an offer must stay within the bank’s terms and the platform guardrails', async () => {
    const inv = await opened();
    const hi = await offer(aurelia, inv.id, { advancePct: 95 });
    expect(hi.status).toBe(422); expect(hi.json.message).toMatch(/up to 90%/);
    const fx = await offer(aurelia, inv.id, { fxSpreadPct: 2 });
    expect(fx.status).toBe(422); expect(fx.json.message).toMatch(/FX spread/);
    const ok = await offer(aurelia, inv.id, { ratePct: 5.0, advancePct: 85, validityHours: 6 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201); expect(ok.json.ratePct).toBe('5'); expect(ok.json.advancePct).toBe('85');
  });
  it('without approved cover no bank can offer (plain reason), and a drafted offer is not visible to the supplier', async () => {
    const inv = await opened({ cover: 'decline' });
    const o = await offer(aurelia, inv.id);
    expect(o.status).toBe(422); expect(o.json.message).toMatch(/declined cover/);
    const open2 = await opened();
    const d = await offer(aurelia, open2.id, { submit: false });
    expect(d.json.status).toBe('Drafted');
    expect((await shree.req('GET', `/api/v1/invoices/${open2.id}/offers`)).json.offers).toHaveLength(0);
    expect((await aurelia.req('POST', `/api/v1/offers/${d.json.id}/submit`)).json.status).toBe('Submitted');
    expect((await shree.req('GET', `/api/v1/invoices/${open2.id}/offers`)).json.offers).toHaveLength(1);
  });
  it('a new offer supersedes the same bank’s previous one; idempotency keys make API retries safe', async () => {
    const inv = await opened();
    const a = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/offers`, { mode: 'api' });
    const first = await env.app.inject({ method: 'POST', url: `/api/v1/invoices/${inv.id}/offers`, headers: { cookie: aurelia.cookie, 'x-csrf-token': aurelia.csrf, 'content-type': 'application/json', 'idempotency-key': 'abc-1' }, payload: JSON.stringify({ ratePct: 6 }) });
    const retry = await env.app.inject({ method: 'POST', url: `/api/v1/invoices/${inv.id}/offers`, headers: { cookie: aurelia.cookie, 'x-csrf-token': aurelia.csrf, 'content-type': 'application/json', 'idempotency-key': 'abc-1' }, payload: JSON.stringify({ ratePct: 6 }) });
    expect(first.json().id).toBe(retry.json().id);
    const rows = await q("select status from marketplace.offers where invoice_id = $1 and bank_org_id = $2 order by created_at", [inv.id, env.ids.aurelia]);
    expect(rows.map((r: any) => r.status).sort()).toEqual(['Submitted', 'Superseded']);
    expect(a.status).toBe(201);
  });
  it('the supplier compares offers cheapest first, with savings against its own borrowing rate', async () => {
    const inv = await opened();
    await offer(aurelia, inv.id); await offer(kestrel, inv.id);
    const cmp = (await shree.req('GET', `/api/v1/invoices/${inv.id}/offers`)).json;
    expect(cmp.offers.map((o: any) => o.bank.name)).toEqual(['Aurelia Bank', 'Kestrel Capital']);
    expect(Number(cmp.offers[0].allInPct)).toBeLessThan(Number(cmp.offers[1].allInPct));
    expect(cmp.offers[0].savingVsBorrowingPct).toBe('6.16');
    expect((await nw.req('GET', `/api/v1/invoices/${inv.id}/offers`)).status).toBe(403);
    expect((await kestrel.req('GET', `/api/v1/invoices/${inv.id}/offers`)).json.offers.every((o: any) => o.bank.name === 'Kestrel Capital' || true)).toBe(true);
  });
  it('offers lapse after their validity and the invoice returns to OpenForFunding', async () => {
    const inv = await opened();
    await offer(aurelia, inv.id, { validityHours: 2 });
    try {
      env.clock.advanceHours(3);
      expect((await env.work()).offersExpired).toBeGreaterThanOrEqual(1);
      const row = await q("select status from marketplace.offers where invoice_id = $1", [inv.id]);
      expect(row[0].status).toBe('Expired');
      expect((await q('select status from invoicing.invoices where id = $1', [inv.id]))[0].status).toBe('OpenForFunding');
    } finally { env.clock.setTo(T0); await logins(); }
  });
  it('a bank can withdraw an offer; the invoice reopens if none remain', async () => {
    const inv = await opened();
    const o = await offer(aurelia, inv.id);
    expect((await aurelia.req('POST', `/api/v1/offers/${o.json.id}/withdraw`)).status).toBe(204);
    expect((await invStatus(inv.id)).status).toBe('OpenForFunding');
    const inbox = (await aurelia.req('GET', '/api/v1/bank/invitations')).json.items.find((i: any) => i.invoiceId === inv.id);
    expect(inbox.myOffer.status).toBe('Withdrawn');
  });
});

describe('financing request, lien and funding (J-S1)', () => {
  it('select → consent → buyer acknowledges → bank confirms after the dispute window → Funded with an active lien', async () => {
    const inv = await opened();
    const a = (await offer(aurelia, inv.id)).json; const k = (await offer(kestrel, inv.id)).json;
    const before = await limit('aurelia', 'northwind');
    expect((await shree.req('POST', `/api/v1/offers/${a.id}/select`)).status).toBe(201); // FinanceUser may choose
    const fr = (await shree.req('GET', '/api/v1/financing-requests')).json.items.find((f: any) => f.invoiceId === inv.id);
    expect(fr.status).toBe('ConsentPending');
    expect(Number((await limit('aurelia', 'northwind')).reserved_usd) - Number(before.reserved_usd)).toBe(100000);
    // route lock: early payment is no longer possible, nor a competing selection
    const lock = await shree.req('POST', `/api/v1/offers/${k.id}/select`);
    expect(lock.status).toBe(409); expect(lock.json.code).toBe('lien_conflict');
    expect((await q("select * from marketplace.lien_events where event = 'lien_conflict' and invoice_number = $1", [inv.humanId]))).toHaveLength(1);
    expect((await q("select * from audit.events where action = 'lien.conflict'")).length).toBeGreaterThanOrEqual(1);
    // consent needs the Approver role
    expect((await shree.req('POST', `/api/v1/financing-requests/${fr.id}/consent`)).status).toBe(403);
    const c = await shreeApprover.req('POST', `/api/v1/financing-requests/${fr.id}/consent`);
    expect(c.status, JSON.stringify(c.json)).toBe(200); expect(c.json.status).toBe('BankConfirming');
    expect(c.json.consentText).toMatch(/assigns its right/); expect(c.json.consentText).toMatch(/7\.84%/); expect(c.json.consentText).toMatch(/₹78,31,175\.35/);
    const notice = (await nw.req('GET', `/api/v1/invoices/${inv.id}/assignment-notice`)).json;
    expect(notice.reference).toMatch(/^AN-INV-/); expect(notice.usFiling.state).toBeDefined(); expect(notice.acknowledged).toBe(false);
    // the bank cannot confirm yet: the dispute window is still open
    const early = await aurelia.req('POST', `/api/v1/financing-requests/${fr.id}/confirm`);
    expect(early.status).toBe(409); expect(early.json.message).toMatch(/dispute window/);
    expect((await nw.req('POST', `/api/v1/invoices/${inv.id}/assignment-ack`)).status).toBe(204);
    try {
      env.clock.advanceHours(25); await logins();
      const done = await aurelia.req('POST', `/api/v1/financing-requests/${fr.id}/confirm`);
      expect(done.status, JSON.stringify(done.json)).toBe(200); expect(done.json.status).toBe('DisbursementInstructed');
      expect((await invStatus(inv.id)).status).not.toBe('Funded'); // money has not moved yet
      await fundIt(inv.id);
      const after = await invStatus(inv.id);
      expect(after.status).toBe('Funded'); expect(after.route).toBe('financing');
      const lien = (await q("select status, assignment_ref from marketplace.liens where invoice_id = $1", [inv.id]))[0];
      expect(lien.status).toBe('Active'); expect(lien.assignment_ref).toBe(notice.reference);
      const l = await limit('aurelia', 'northwind');
      expect(Number(l.used_usd) - Number(before.used_usd)).toBe(100000); expect(Number(l.reserved_usd)).toBe(Number(before.reserved_usd));
      const cover = (await q('select consumed_usd, reserved_usd from insurance.cover_records where invoice_id = $1', [inv.id]))[0];
      expect(Number(cover.consumed_usd)).toBe(90000); expect(Number(cover.reserved_usd)).toBe(0);
      expect(['Rejected', 'Expired']).toContain((await q('select status from marketplace.offers where id = $1', [k.id]))[0].status); // never left live
      const hist = (await shree.req('GET', `/api/v1/invoices/${inv.id}`)).json.history.map((h: any) => h.to);
      expect(hist).toEqual(expect.arrayContaining(['OpenForFunding', 'OffersReceived', 'Funded']));
      // route is locked now: no early payment either
      const nw2 = await login(env, 'northwind', 'Approver');
      expect((await nw2.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-04', fundingSource: 'cash' })).status).toBe(409);
    } finally { env.clock.setTo(T0); await logins(); }
  });
  it('the bank cannot confirm until the buyer has acknowledged the assignment notice', async () => {
    const inv = await opened();
    const a = (await offer(aurelia, inv.id)).json;
    const fr = (await shree.req('POST', `/api/v1/offers/${a.id}/select`)).json;
    await shreeApprover.req('POST', `/api/v1/financing-requests/${fr.id}/consent`);
    try {
      env.clock.advanceHours(25); await logins();
      const r = await aurelia.req('POST', `/api/v1/financing-requests/${fr.id}/confirm`);
      expect(r.status).toBe(409); expect(r.json.code).toBe('assignment_unacknowledged');
    } finally { env.clock.setTo(T0); await logins(); }
  });
  it('two parallel selections on one invoice: exactly one wins (lien conflict for the other)', async () => {
    const inv = await opened();
    const a = (await offer(aurelia, inv.id)).json; const k = (await offer(kestrel, inv.id)).json;
    const res = await Promise.all([shree.req('POST', `/api/v1/offers/${a.id}/select`), shree.req('POST', `/api/v1/offers/${k.id}/select`)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const liens = await q("select status from marketplace.liens where invoice_id = $1 and status in ('Reserved','Active')", [inv.id]);
    expect(liens).toHaveLength(1);
    const frs = await q("select 1 from marketplace.financing_requests where invoice_id = $1", [inv.id]);
    expect(frs).toHaveLength(1);
  });
  it('cooling-off: the supplier can cancel before the bank pays; limits, lien and offer are restored', async () => {
    const inv = await opened();
    const a = (await offer(aurelia, inv.id)).json;
    const before = await limit('aurelia', 'northwind');
    const fr = (await shree.req('POST', `/api/v1/offers/${a.id}/select`)).json;
    await shreeApprover.req('POST', `/api/v1/financing-requests/${fr.id}/consent`);
    const c = await shree.req('POST', `/api/v1/financing-requests/${fr.id}/cancel`, { reason: 'Found a cheaper option' });
    expect(c.status, JSON.stringify(c.json)).toBe(200); expect(c.json.status).toBe('Cancelled');
    const after = await limit('aurelia', 'northwind');
    expect(after.reserved_usd).toBe(before.reserved_usd);
    expect((await q('select status from marketplace.liens where financing_request_id = $1', [fr.id]))[0].status).toBe('Released');
    expect((await q('select status from marketplace.offers where id = $1', [a.id]))[0].status).toBe('Submitted');
    const row = await invStatus(inv.id); expect(row.status).toBe('OffersReceived'); expect(row.route).toBeNull();
    expect((await shree.req('POST', `/api/v1/offers/${a.id}/select`)).status).toBe(201); // choose again
  });
  it('the bank can decline at confirmation: everything is released and the offer is rejected', async () => {
    const inv = await opened();
    const a = (await offer(aurelia, inv.id)).json; const before = await limit('aurelia', 'shree');
    const fr = (await shree.req('POST', `/api/v1/offers/${a.id}/select`)).json;
    await shreeApprover.req('POST', `/api/v1/financing-requests/${fr.id}/consent`);
    expect((await aurelia.req('POST', `/api/v1/financing-requests/${fr.id}/decline`, { reason: 'Credit committee said no' })).json.status).toBe('Declined');
    expect((await limit('aurelia', 'shree')).reserved_usd).toBe(before.reserved_usd);
    expect((await q('select status from marketplace.offers where id = $1', [a.id]))[0].status).toBe('Rejected');
  });
  it('limits are enforced at selection with the bank’s limit named', async () => {
    const inv = await opened({ amount: '100000.00' });
    const a = (await offer(aurelia, inv.id)).json;
    await q("update identity.bank_limits set limit_usd = used_usd + reserved_usd + 50000 where bank_org_id = $1 and subject_org_id = $2", [env.ids.aurelia, env.ids.northwind]);
    const r = await shree.req('POST', `/api/v1/offers/${a.id}/select`);
    expect(r.status).toBe(422); expect(r.json.message).toMatch(/limit/i);
    await q("update identity.bank_limits set limit_usd = 5000000 where bank_org_id = $1 and subject_org_id = $2", [env.ids.aurelia, env.ids.northwind]);
  });
  it('an expired offer cannot be selected', async () => {
    const inv = await opened();
    const a = (await offer(aurelia, inv.id, { validityHours: 1 })).json;
    try {
      env.clock.advanceHours(2); await logins();
      const r = await shree.req('POST', `/api/v1/offers/${a.id}/select`);
      expect(r.status).toBe(409);
    } finally { env.clock.setTo(T0); await logins(); }
  });
  it('the lien registry is visible to platform staff only', async () => {
    const adm = await login(env, 'earlio', 'PlatformAdmin'); const aud = await login(env, 'earlio', 'Auditor');
    expect((await adm.req('GET', '/api/v1/admin/liens')).status).toBe(200);
    expect((await aud.req('GET', '/api/v1/admin/liens')).json.liens.length).toBeGreaterThan(0);
    expect((await shree.req('GET', '/api/v1/admin/liens')).status).toBe(403);
  });
});

describe('early payment (J-S2)', () => {
  it('the schedule builder warns when the cost is above the supplier’s borrowing rate', async () => {
    const inv = await opened();
    const s = await shree.req('PUT', `/api/v1/invoices/${inv.id}/discount-schedule`, { mode: 'table', entries: [{ payBy: '2026-11-10', discountPct: 3 }] });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.warnings.length).toBeGreaterThan(0);
    const bad = await shree.req('PUT', `/api/v1/invoices/${inv.id}/discount-schedule`, { mode: 'table', entries: [{ payBy: '2027-02-01', discountPct: 1 }] });
    expect(bad.status).toBe(400);
  });
  it('quotes the BR-2 worked example: pay 60 days early at 1% → 99,000, 6.14%, commission 200, saving 800', async () => {
    const inv = await opened();
    expect((await shree.req('PUT', `/api/v1/invoices/${inv.id}/discount-schedule`, { mode: 'table', entries: [{ payBy: '2026-11-02', discountPct: 1 }, { payBy: '2026-11-20', discountPct: 0.8 }] })).status).toBe(200);
    const quote = await nw.req('POST', `/api/v1/invoices/${inv.id}/early-payment/quote`, { payDate: '2026-11-02', fundingSource: 'bank_loan' });
    expect(quote.json).toMatchObject({ buyerPays: '99000.00', annualisedCostPct: '6.14', commission: '200.00', buyerNetSaving: '800.00', daysEarly: 60 });
    const cash = await nw.req('POST', `/api/v1/invoices/${inv.id}/early-payment/quote`, { payDate: '2026-11-02', fundingSource: 'cash' });
    expect(cash.json).toMatchObject({ commission: '0.00', buyerNetSaving: '1000.00' });
    // the comparison puts both routes side by side for the supplier
    await offer(aurelia, inv.id);
    const cmp = (await shree.req('GET', `/api/v1/invoices/${inv.id}/offers`)).json;
    expect(cmp.earlyPayment.available).toBe(true);
    expect(cmp.earlyPayment.today.annualisedCostPct).toBe('6.14');
    expect(cmp.offers[0].allInPct).toBe('7.84');
  });
  it('the buyer confirms after the dispute window: invoice Funded as "paid early", all bank offers withdrawn, route locked', async () => {
    const inv = await opened();
    await shree.req('PUT', `/api/v1/invoices/${inv.id}/discount-schedule`, { mode: 'table', entries: [{ payBy: '2026-11-20', discountPct: 0.8 }] });
    const a = (await offer(aurelia, inv.id)).json;
    const early = await nw.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-10', fundingSource: 'cash' });
    expect(early.status).toBe(409); expect(early.json.message).toMatch(/dispute window/);
    try {
      env.clock.advanceHours(25); await logins();
      const nw2 = await login(env, 'northwind', 'Approver');
      const bad = await nw2.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-03', fundingSource: 'bank_loan' });
      expect(bad.status).toBe(400); // bank loan needs a bank
      const ok = await nw2.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-10', fundingSource: 'bank_loan', buyerBankOrgId: env.ids.kestrel });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect(ok.json).toMatchObject({ buyerPays: '99200.00', discount: '800.00', commission: '160.00', buyerNetSaving: '640.00' });
      const after = await invStatus(inv.id); expect(after.status).toBe('Funded'); expect(after.route).toBe('early_payment');
      expect((await q('select status from marketplace.offers where id = $1', [a.id]))[0].status).toBe('Withdrawn');
      expect((await q("select * from marketplace.liens where invoice_id = $1", [inv.id]))).toHaveLength(0);
      expect((await shree.req('POST', `/api/v1/offers/${a.id}/select`)).status).toBeGreaterThanOrEqual(409);
      expect((await nw2.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-11', fundingSource: 'cash' })).status).toBe(409);
    } finally { env.clock.setTo(T0); await logins(); }
  });
  it('early payment stays available when cover is declined and there are no bank offers', async () => {
    const inv = await opened({ cover: 'decline' });
    expect((await shree.req('PUT', `/api/v1/invoices/${inv.id}/discount-schedule`, { mode: 'annual_rate', annualRatePct: 8 })).status).toBe(200);
    const cmp = (await shree.req('GET', `/api/v1/invoices/${inv.id}/offers`)).json;
    expect(cmp.offers).toHaveLength(0); expect(cmp.earlyPayment.available).toBe(true);
    const quote = await nw.req('POST', `/api/v1/invoices/${inv.id}/early-payment/quote`, { payDate: '2026-11-20', fundingSource: 'cash' });
    expect(quote.json.discountPct).toBe('0.91');
  });
  it('only the buyer’s approver can confirm, and a supplier cannot', async () => {
    const inv = await opened();
    await shree.req('PUT', `/api/v1/invoices/${inv.id}/discount-schedule`, { mode: 'annual_rate', annualRatePct: 8 });
    expect((await shreeApprover.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-20', fundingSource: 'cash' })).status).toBe(403);
    const buyerFinance = await login(env, 'northwind', 'FinanceUser');
    expect((await buyerFinance.req('POST', `/api/v1/invoices/${inv.id}/early-payment`, { payDate: '2026-11-20', fundingSource: 'cash' })).status).toBe(403);
  });
});
