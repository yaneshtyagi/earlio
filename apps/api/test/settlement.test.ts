import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv, type Session } from './helpers';
import { signWebhook, webhookSecret } from '../src/adapters/payments';

let env: TestEnv;
let shree: Session; let shreeApprover: Session; let nw: Session; let uw: Session; let aurelia: Session; let aureliaOps: Session; let admin: Session;
const T0 = new Date('2026-11-02T04:00:00.000Z');
async function logins() {
  shree = await login(env, 'shree', 'FinanceUser'); shreeApprover = await login(env, 'shree', 'Approver'); nw = await login(env, 'northwind', 'Approver');
  uw = await login(env, 'exportshield', 'Underwriter'); aurelia = await login(env, 'aurelia', 'CreditOfficer'); aureliaOps = await login(env, 'aurelia', 'Operations'); admin = await login(env, 'earlio', 'PlatformAdmin');
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

/** An accepted, insured 100,000 USD invoice due in 60 days with an Aurelia offer selected and consented, ready for the bank to confirm. */
async function readyToConfirm() {
  const c = await shree.req('POST', '/api/v1/invoices', { buyerOrgId: env.ids.northwind, number: `ST/${++n}`, currency: 'USD', amount: '100000.00', issueDate: '2026-11-01', dueDate: '2027-01-01', poNumber: 'PO-NW-2201' });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  for (const t of ['commercial_invoice', 'delivery_proof']) await shree.req('POST', `/api/v1/invoices/${c.json.id}/documents`, { docType: t, fileId: await upload(shree, t + '.pdf') });
  await shree.req('POST', `/api/v1/invoices/${c.json.id}/submit`);
  await nw.req('POST', `/api/v1/invoices/${c.json.id}/decision`, { decision: 'accept', undertakingAccepted: true });
  await env.work();
  const cover = (await shree.req('GET', `/api/v1/invoices/${c.json.id}/cover`)).json;
  await uw.req('POST', `/api/v1/insurance/requests/${cover.id}/decision`, { decision: 'approve' });
  expect((await shree.req('POST', `/api/v1/invoices/${c.json.id}/open-funding`)).json.opened).toBe(true);
  const o = await aurelia.req('POST', `/api/v1/invoices/${c.json.id}/offers`, {});
  const fr = (await shree.req('POST', `/api/v1/offers/${o.json.id}/select`)).json;
  await shreeApprover.req('POST', `/api/v1/financing-requests/${fr.id}/consent`);
  await nw.req('POST', `/api/v1/invoices/${c.json.id}/assignment-ack`);
  return { id: c.json.id as string, humanId: c.json.humanId as string, frId: fr.id as string };
}
async function confirmAt(frId: string, at?: string) {
  if (at) env.clock.setTo(new Date(at)); else env.clock.advanceHours(25);
  await logins();
  const r = await aurelia.req('POST', `/api/v1/financing-requests/${frId}/confirm`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
/** Run workers, stepping the clock, until the predicate holds. */
async function until(pred: () => Promise<boolean>, step = 6, max = 14) {
  for (let i = 0; i < max; i++) {
    await env.work();
    if (await pred()) return;
    env.clock.advanceHours(step); await logins();
  }
  throw new Error('condition not reached');
}
async function funded() {
  const x = await readyToConfirm(); await confirmAt(x.frId);
  await until(async () => (await invStatus(x.id)).status === 'Funded');
  return x;
}
const disb = async (invoiceId: string) => (await admin.req('GET', `/api/v1/settlement/disbursements?invoiceId=${invoiceId}`)).json.items[0];
const exceptions = async (status?: string) => (await admin.req('GET', `/api/v1/settlement/exceptions${status ? `?status=${status}` : ''}`)).json.items as any[];
const reset = async () => { await admin.req('PUT', '/api/v1/admin/sim-settings', { disbursement: 'none' }); env.clock.setTo(T0); await logins(); };

describe('disbursement (ST-1)', () => {
  it('pays the supplier the golden net cash in INR at the bank FX rate, then funds the invoice and issues a payment reference', async () => {
    try {
      const x = await funded();
      const d = await disb(x.id);
      expect(d).toMatchObject({ status: 'Credited', currency: 'USD', fxRate: '88.1348', amountInr: '7831175.35', cutoffMissed: false });
      expect(d.events.map((e: any) => e.status)).toEqual(expect.arrayContaining(['FXBooked', 'Sent', 'Credited']));
      const due = (await login(env, 'northwind', 'Approver')).req;
      const pd = (await due('GET', '/api/v1/settlement/payments-due')).json.items.find((i: any) => i.invoiceNumber === x.humanId);
      expect(pd.reference).toMatch(/^EARL-/); expect(pd.expectedAmount).toBe('100000.00'); expect(pd.collectionAccount.bankName).toMatch(/Aurelia/);
    } finally { await reset(); }
  });

  it('a request confirmed after the bank cut-off is queued to a later business day and never pays on a weekend or holiday', async () => {
    try {
      const x = await readyToConfirm();
      await confirmAt(x.frId, '2026-11-04T12:30:00.000Z'); // 18:00 IST, after the 15:00 cut-off
      await env.work();
      let d = await disb(x.id);
      expect(d.cutoffMissed).toBe(true); expect(d.status).toBe('QueuedForValueDate');
      expect(d.valueDate > '2026-11-05').toBe(true);
      expect([0, 6]).not.toContain(new Date(d.valueDate + 'T00:00:00Z').getUTCDay());
      await env.work(); expect((await invStatus(x.id)).status).not.toBe('Funded'); // not before the value date
      await until(async () => (await invStatus(x.id)).status === 'Funded', 12, 20);
      d = await disb(x.id); expect(d.status).toBe('Credited');
    } finally { await reset(); }
  });

  it('a rejecting bank is retried three times, then the payment is reversed, the financing fails and operations see an exception', async () => {
    try {
      expect((await admin.req('PUT', '/api/v1/admin/sim-settings', { disbursement: 'reject' })).status).toBe(200);
      const x = await readyToConfirm(); await confirmAt(x.frId);
      await until(async () => (await disb(x.id))?.status === 'Reversed', 12, 20);
      const d = await disb(x.id);
      expect(d.attempts).toBe(3);
      expect((await invStatus(x.id)).status).not.toBe('Funded');
      const fr = (await q('select status from marketplace.financing_requests where id = $1', [x.frId]))[0];
      expect(fr.status).toBe('Failed');
      expect((await exceptions('open')).some((e) => e.type === 'DisbursementFailed' && e.invoiceNumber === x.humanId)).toBe(true);
      expect((await q("select status from marketplace.liens where invoice_id = $1 and status in ('Reserved','Active')", [x.id]))).toHaveLength(0);
    } finally { await reset(); }
  });

  it('a short credit raises an AmountMismatch that operations can accept, after which funding completes', async () => {
    try {
      await admin.req('PUT', '/api/v1/admin/sim-settings', { disbursement: 'mismatch' });
      const x = await readyToConfirm(); await confirmAt(x.frId);
      await until(async () => (await exceptions('open')).some((e) => e.type === 'AmountMismatch' && e.invoiceNumber === x.humanId), 6, 20);
      expect((await invStatus(x.id)).status).not.toBe('Funded');
      const ex = (await exceptions('open')).find((e) => e.type === 'AmountMismatch' && e.invoiceNumber === x.humanId);
      expect(ex.allowedActions).toContain('accept_credit');
      const r = await aureliaOps.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'accept_credit', note: 'Bank charges confirmed' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      await until(async () => (await invStatus(x.id)).status === 'Funded');
    } finally { await reset(); }
  });
});

describe('collection and reconciliation (ST-2 to ST-4)', () => {
  it('J-K3 happy path: the buyer pays by reference, the payment is matched, distributed, the statement reconciles it and the invoice closes with no manual step', async () => {
    try {
      const x = await funded();
      const usedSql = "select used_usd from identity.bank_limits where bank_org_id = $1 and subject_org_id = $2";
      const usedBefore = Number((await q(usedSql, [env.ids.aurelia, env.ids.northwind]))[0].used_usd);
      const pay = await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: x.humanId });
      expect(pay.status, JSON.stringify(pay.json)).toBe(200); expect(pay.json.callbackOutcome).toBe('matched');
      await env.work();
      const inv = await invStatus(x.id);
      expect(inv.status).toBe('Closed');
      const ledger = (await admin.req('GET', `/api/v1/settlement/ledger/${x.id}`)).json.items;
      const sum = (k: string) => ledger.filter((l: any) => l.kind === k).reduce((a: number, l: any) => a + Number(l.amount), 0);
      expect(sum('payment_received')).toBe(100000);
      expect(sum('bank_principal') + sum('retention_release')).toBeCloseTo(100000, 2);
      expect(ledger.find((l: any) => l.kind === 'retention_release').amountInr).toBeTruthy();
      expect((await exceptions('open')).filter((e) => e.invoiceNumber === x.humanId)).toHaveLength(0);
      expect((await q("select status from marketplace.liens where invoice_id = $1", [x.id]))[0].status).toBe('Released');
      expect((await q('select status from settlement.expectations where invoice_id = $1', [x.id]))[0].status).toBe('Reconciled');
      expect(usedBefore - Number((await q(usedSql, [env.ids.aurelia, env.ids.northwind]))[0].used_usd)).toBe(100000); // the bank's limit is freed
      expect(Number((await q('select consumed_usd from insurance.cover_records where invoice_id = $1', [x.id]))[0].consumed_usd)).toBe(0);
    } finally { await reset(); }
  });

  it('a statement line alone (lost callback) still matches and closes the invoice', async () => {
    try {
      const x = await funded();
      await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: x.humanId, via: 'statement' });
      await env.work();
      expect((await invStatus(x.id)).status).toBe('Closed');
    } finally { await reset(); }
  });

  it('a short payment is held as an exception; operations accept it and the invoice settles with the shortfall flagged', async () => {
    try {
      const x = await funded();
      const pay = await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: x.humanId, amount: '95000.00' });
      expect(pay.json.callbackOutcome).toBe('short_paid');
      await env.work();
      expect((await invStatus(x.id)).status).toBe('Funded');
      const ex = (await exceptions('open')).find((e) => e.type === 'ShortPaid' && e.invoiceNumber === x.humanId);
      expect(ex.amount).toBe('5000.00'); expect(ex.allowedActions).toEqual(expect.arrayContaining(['wait', 'accept_short']));
      expect((await shree.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'accept_short' })).status).toBe(403); // suppliers cannot resolve
      expect((await aurelia.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'accept_short' })).status).toBe(403); // credit officers cannot either
      expect((await aureliaOps.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'refund' })).status).toBe(400); // wrong action for this type
      const ok = await aureliaOps.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'accept_short', note: 'Buyer short-paid bank charges' });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      expect((await aureliaOps.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'accept_short' })).status).toBe(409);
      await env.work();
      expect(['Settled', 'Closed']).toContain((await invStatus(x.id)).status);
    } finally { await reset(); }
  });

  it('an unknown reference becomes an Unmatched exception that operations assign to the right invoice', async () => {
    try {
      const x = await funded();
      const pay = await admin.req('POST', '/api/v1/sim/pay', { reference: 'EARL-WRONG-0000', amount: '100000.00' });
      expect(pay.json.callbackOutcome).toBe('unmatched');
      const ex = (await exceptions('open')).find((e) => e.type === 'Unmatched');
      expect(ex).toBeTruthy();
      expect((await aureliaOps.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'assign' })).status).toBe(400); // needs an invoice
      const ok = await aureliaOps.req('POST', `/api/v1/settlement/exceptions/${ex.id}/resolve`, { action: 'assign', invoiceNumber: x.humanId });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      await env.work();
      expect(['Settled', 'Closed']).toContain((await invStatus(x.id)).status);
    } finally { await reset(); }
  });

  it('a payment after the due date is accepted but flagged Late and the invoice passes through Overdue', async () => {
    try {
      const x = await funded();
      env.clock.setTo(new Date('2027-01-05T06:00:00.000Z')); await logins();
      await env.work();
      expect((await invStatus(x.id)).status).toBe('Overdue');
      await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: x.humanId });
      await env.work();
      expect((await exceptions('open')).some((e) => e.type === 'Late' && e.invoiceNumber === x.humanId)).toBe(true);
      expect(['Settled', 'Closed']).toContain((await invStatus(x.id)).status);
    } finally { await reset(); }
  });
});

describe('signed bank webhook', () => {
  const post = async (bankId: string, body: object, over: { ts?: number; nonce?: string; secretFrom?: string; sig?: string } = {}) => {
    const raw = JSON.stringify(body);
    const ts = over.ts ?? env.clock.now().getTime(); const nonce = over.nonce ?? randomUUID();
    const sig = over.sig ?? signWebhook(webhookSecret(env.svc.config.webhookKey, over.secretFrom ?? bankId), ts, nonce, raw);
    return env.app.inject({ method: 'POST', url: `/api/v1/webhooks/bank/${bankId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-earlio-timestamp': String(ts), 'x-earlio-nonce': nonce, 'x-earlio-signature': sig } });
  };
  const line = (ref: string | null, id = `W-${randomUUID().slice(0, 8)}`) => ({ bankTxnId: id, reference: ref, currency: 'USD', amount: '100000.00', valueDate: '2026-11-02', payer: 'Northwind Retail' });

  it('accepts a correctly signed callback once; a replay of the same nonce is rejected; the same bank transaction is never booked twice', async () => {
    const x = await funded();
    const ref = (await q('select reference from settlement.expectations where invoice_id = $1', [x.id]))[0].reference;
    const body = line(ref);
    const nonce = randomUUID();
    const ok = await post(env.ids.aurelia!, body, { nonce });
    expect(ok.statusCode, ok.body).toBe(200); expect(ok.json().outcome).toBe('matched');
    const replay = await post(env.ids.aurelia!, body, { nonce });
    expect(replay.statusCode).toBe(409);
    const dupe = await post(env.ids.aurelia!, body); // fresh nonce, same bank transaction id
    expect(dupe.statusCode).toBe(200); expect(dupe.json().outcome).toBe('duplicate');
    expect((await q("select count(*)::int as n from settlement.bank_transactions where source = 'callback' and bank_txn_id = $1", [body.bankTxnId]))[0].n).toBe(1);
    await reset();
  });

  it('rejects a bad signature, a signature made with another bank’s secret, a stale timestamp and missing headers', async () => {
    const b = line('EARL-ANY-0001');
    expect((await post(env.ids.aurelia!, b, { sig: 'ab'.repeat(32) })).statusCode).toBe(401);
    expect((await post(env.ids.aurelia!, b, { secretFrom: env.ids.kestrel! })).statusCode).toBe(401);
    expect((await post(env.ids.aurelia!, b, { ts: env.clock.now().getTime() - 10 * 60_000 })).statusCode).toBe(401);
    const bare = await env.app.inject({ method: 'POST', url: `/api/v1/webhooks/bank/${env.ids.aurelia}`, payload: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
    expect(bare.statusCode).toBe(401);
    expect((await post(randomUUID(), b)).statusCode).toBe(404);
    // nothing was stored for the rejected calls
    expect((await q("select count(*)::int as n from settlement.bank_transactions where bank_txn_id = $1", [b.bankTxnId]))[0].n).toBe(0);
  });
});

describe('notifications and control room', () => {
  it('every party gets in-app notifications for the events that concern them, and only them; SMS goes to suppliers for key events', async () => {
    try {
      const x = await funded();
      const mine = (await shree.req('GET', '/api/v1/notifications')).json;
      const topics = mine.items.map((i: any) => i.topic);
      expect(topics).toEqual(expect.arrayContaining(['disbursement.credited', 'financing.funded']));
      expect(mine.unread).toBeGreaterThan(0);
      const credited = mine.items.find((i: any) => i.topic === 'disbursement.credited' && i.payload.humanId === x.humanId);
      expect(credited.subject).toMatch(/7831175\.35/);
      expect((await shree.req('POST', `/api/v1/notifications/${credited.id}/read`)).status).toBe(200);
      expect((await shree.req('GET', '/api/v1/notifications')).json.unread).toBe(mine.unread - 1);
      // tenant isolation: Northwind cannot read or mark Shree's notification
      expect((await nw.req('POST', `/api/v1/notifications/${credited.id}/read`)).status).toBe(404);
      expect((await nw.req('GET', '/api/v1/notifications')).json.items.some((i: any) => i.topic === 'disbursement.credited')).toBe(false);
      // the buyer is told what to pay
      expect((await nw.req('GET', '/api/v1/notifications')).json.items.some((i: any) => i.topic === 'settlement.payment_due' && i.body.includes('EARL-'))).toBe(true);
      const ch = await q("select channel, status from notify.notifications where topic = 'disbursement.credited' and recipient_org_id = $1 and payload->>'humanId' = $2 order by channel", [env.ids.shree, x.humanId]);
      expect(ch.map((c: any) => c.channel)).toEqual(['email', 'in_app', 'sms', 'whatsapp']);
      expect(ch.every((c: any) => c.status === 'delivered')).toBe(true);
      expect((await shree.req('POST', '/api/v1/notifications/read-all')).status).toBe(200);
      expect((await shree.req('GET', '/api/v1/notifications')).json.unread).toBe(0);
    } finally { await reset(); }
  });

  it('the control room: only platform admins move the clock and set faults; calendars and integration messages are readable', async () => {
    try {
      expect((await shree.req('POST', '/api/v1/admin/clock', { advanceDays: 1 })).status).toBe(403);
      expect((await shree.req('PUT', '/api/v1/admin/sim-settings', { disbursement: 'reject' })).status).toBe(403);
      const before = (await admin.req('GET', '/api/v1/admin/clock')).json;
      const moved = (await admin.req('POST', '/api/v1/admin/clock', { advanceHours: 3 })).json;
      expect(new Date(moved.now).getTime() - new Date(before.now).getTime()).toBe(3 * 3_600_000);
      const cal = (await admin.req('GET', '/api/v1/admin/calendars')).json;
      expect(cal.verifyBeforeProduction).toBe(true); expect(Object.keys(cal.calendars).sort()).toEqual(['IN', 'SG', 'US']);
      const msgs = (await admin.req('GET', '/api/v1/admin/integration-messages?adapter=payments')).json.items;
      expect(msgs.length).toBeGreaterThan(0);
      expect(createHmac).toBeDefined();
    } finally { await reset(); }
  });
});
