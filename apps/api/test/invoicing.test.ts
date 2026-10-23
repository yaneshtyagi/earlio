import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv, type Session } from './helpers';
import { INVOICE_STATES, TRANSITIONS, canTransition, transition } from '../src/modules/invoicing/state';
import { csvToRows, dueForReminder, parseCsv, sendAcceptanceReminders } from '../src/modules/invoicing/service';

let env: TestEnv;
let fin: Session; let approverB: Session; let lakeshoreApprover: Session; let shreeAdmin: Session;
beforeAll(async () => {
  env = await createTestEnv();
  fin = await login(env, 'shree', 'FinanceUser');
  approverB = await login(env, 'northwind', 'Approver');
  lakeshoreApprover = await login(env, 'lakeshore', 'Approver');
  shreeAdmin = await login(env, 'shree', 'Admin');
});
afterAll(async () => { await env.close(); });

let counter = 0;
const body = (over: Record<string, unknown> = {}) => ({
  buyerOrgId: env.ids.northwind, number: `SH/2026/${++counter}`, currency: 'USD', amount: '48000.00', issueDate: '2026-11-01', dueDate: '2026-12-31', poNumber: 'PO-NW-2201', ...over,
});
async function upload(s: Session, name: string) {
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/files?filename=${name}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from('content ' + name + Math.random()) });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}
async function draft(over: Record<string, unknown> = {}) {
  const r = await fin.req('POST', '/api/v1/invoices', body(over));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; humanId: string; warnings: string[] };
}
async function withDocs(id: string) {
  for (const t of ['commercial_invoice', 'delivery_proof']) {
    expect((await fin.req('POST', `/api/v1/invoices/${id}/documents`, { docType: t, fileId: await upload(fin, t + '.pdf') })).status).toBe(201);
  }
}
async function submitted(over: Record<string, unknown> = {}) {
  const d = await draft(over); await withDocs(d.id);
  const s = await fin.req('POST', `/api/v1/invoices/${d.id}/submit`);
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  return d;
}

describe('state machine table', () => {
  it('allows exactly the transitions in the table and rejects every other pair', () => {
    let allowed = 0, denied = 0;
    for (const a of INVOICE_STATES) for (const b of INVOICE_STATES) {
      if (TRANSITIONS[a].includes(b)) { expect(canTransition(a, b)).toBe(true); allowed++; } else { expect(canTransition(a, b)).toBe(false); denied++; }
    }
    expect(allowed).toBe(Object.values(TRANSITIONS).flat().length);
    expect(denied).toBe(INVOICE_STATES.length ** 2 - allowed);
  });
  it('terminal states have no exits', () => { expect(TRANSITIONS.Closed).toHaveLength(0); expect(TRANSITIONS.Cancelled).toHaveLength(0); });
  it('an illegal transition throws a domain error and changes nothing', async () => {
    const d = await draft();
    await expect(env.svc.db.tx({ platform: true, correlationId: 't' }, async (tx) => {
      const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [d.id]);
      await transition(tx, env.svc, { platform: true, correlationId: 't' }, inv, 'Funded');
    })).rejects.toThrow(/cannot move from Draft to Funded/);
    expect((await fin.req('GET', `/api/v1/invoices/${d.id}`)).json.status).toBe('Draft');
  });
});

describe('create and validate', () => {
  it('creates a draft with a human id, an IRN and no warnings when a PO is given', async () => {
    const d = await draft();
    expect(d.humanId).toMatch(/^INV-\d+$/);
    expect(d.warnings).toEqual([]);
    const got = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json;
    expect(got.irn).toMatch(/^[0-9a-f]{64}$/);
    expect(got.status).toBe('Draft');
  });
  it('flags a missing purchase order but allows it (A-15)', async () => {
    const d = await draft({ poNumber: undefined });
    expect(d.warnings).toContain('no_purchase_order');
  });
  it('rejects bad currency, dates and amounts with plain-language reasons', async () => {
    expect((await fin.req('POST', '/api/v1/invoices', body({ currency: 'EUR' }))).status).toBe(400);
    const due = await fin.req('POST', '/api/v1/invoices', body({ dueDate: '2026-10-01' }));
    expect(due.status).toBe(400); expect(due.json.message).toMatch(/due date must be after/i);
    const amt = await fin.req('POST', '/api/v1/invoices', body({ amount: '-5' }));
    expect(amt.status).toBe(400);
  });
  it('rejects a duplicate (same number, amount, issue date)', async () => {
    const b = body();
    expect((await fin.req('POST', '/api/v1/invoices', b)).status).toBe(201);
    const dup = await fin.req('POST', '/api/v1/invoices', b);
    expect(dup.status).toBe(409); expect(dup.json.message).toMatch(/duplicate of INV-/);
  });
  it('needs an active relationship with the buyer', async () => {
    const r = await fin.req('POST', '/api/v1/invoices', body({ buyerOrgId: env.ids.kallang }));
    expect(r.status).toBe(422); expect(r.json.message).toMatch(/active relationship/);
  });
  it('only a supplier finance user can create', async () => {
    expect((await shreeAdmin.req('POST', '/api/v1/invoices', body())).status).toBe(403); // Admin lacks invoice:create
    expect((await approverB.req('POST', '/api/v1/invoices', body())).status).toBe(403);
  });
});

describe('submission', () => {
  it('needs commercial invoice and delivery proof', async () => {
    const d = await draft();
    const r = await fin.req('POST', `/api/v1/invoices/${d.id}/submit`);
    expect(r.status).toBe(422); expect(r.json.message).toMatch(/commercial invoice and delivery proof/);
    expect((await fin.req('POST', `/api/v1/invoices/${d.id}/documents`, { docType: 'commercial_invoice', fileId: await upload(fin, 'ci.pdf') })).status).toBe(201);
    expect((await fin.req('POST', `/api/v1/invoices/${d.id}/submit`)).json.message).toMatch(/delivery proof/);
  });
  it('versions documents and stores hashes', async () => {
    const d = await draft();
    const a = await fin.req('POST', `/api/v1/invoices/${d.id}/documents`, { docType: 'packing_list', fileId: await upload(fin, 'pl1.pdf') });
    const b = await fin.req('POST', `/api/v1/invoices/${d.id}/documents`, { docType: 'packing_list', fileId: await upload(fin, 'pl2.pdf') });
    expect([a.json.version, b.json.version]).toEqual([1, 2]);
    const docs = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json.documents;
    expect(docs.every((x: any) => /^[0-9a-f]{64}$/.test(x.sha256))).toBe(true);
  });
  it('submits, records screening, and shares documents with the buyer only after submission', async () => {
    const d = await draft(); await withDocs(d.id);
    const docId = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json.documents[0].fileId;
    expect((await approverB.req('GET', `/api/v1/files/${docId}`)).status).toBe(404);
    expect((await approverB.req('GET', `/api/v1/invoices/${d.id}`)).status).toBe(404); // the buyer never sees a supplier's drafts
    expect((await approverB.req('GET', '/api/v1/invoices')).json.items.find((i: any) => i.id === d.id)).toBeUndefined();
    expect((await fin.req('POST', `/api/v1/invoices/${d.id}/submit`)).status).toBe(200);
    expect((await approverB.req('GET', `/api/v1/invoices/${d.id}`)).status).toBe(200);
    expect((await approverB.req('GET', `/api/v1/files/${docId}`)).status).toBe(200);
  });
});

describe('visibility', () => {
  it('buyer sees invoices addressed to it; other buyers and suppliers do not', async () => {
    const d = await submitted();
    expect((await approverB.req('GET', `/api/v1/invoices/${d.id}`)).status).toBe(200);
    expect((await lakeshoreApprover.req('GET', `/api/v1/invoices/${d.id}`)).status).toBe(404);
    const kumar = await login(env, 'kumar', 'FinanceUser');
    expect((await kumar.req('GET', `/api/v1/invoices/${d.id}`)).status).toBe(404);
    const list = (await lakeshoreApprover.req('GET', '/api/v1/invoices')).json.items;
    expect(list.find((i: any) => i.id === d.id)).toBeUndefined();
    const docs = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json.documents;
    expect((await approverB.req('GET', `/api/v1/files/${docs[0].fileId}`)).status).toBe(200);
    expect((await lakeshoreApprover.req('GET', `/api/v1/files/${docs[0].fileId}`)).status).toBe(404);
  });
  it('raw SQL under the application role shows only own-party rows', async () => {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: env.appUrl }); await c.connect();
    await c.query('begin'); await c.query("select set_config('app.org_id', $1, true)", [env.ids.kumar]);
    const rows = (await c.query('select supplier_org_id, buyer_org_id from invoicing.invoices')).rows;
    await c.query('rollback'); await c.end();
    expect(rows.every((r) => r.supplier_org_id === env.ids.kumar || r.buyer_org_id === env.ids.kumar)).toBe(true);
  });
});

describe('acceptance', () => {
  it('only a buyer Approver can decide', async () => {
    const d = await submitted();
    const fin2 = await login(env, 'northwind', 'FinanceUser');
    expect((await fin2.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true })).status).toBe(403);
    expect((await fin.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true })).status).toBe(403);
    expect((await lakeshoreApprover.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true })).status).toBe(404);
  });
  it('accepting requires the signed undertaking, locks the amount and opens a 24h dispute window', async () => {
    const d = await submitted();
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept' })).status).toBe(400);
    const ok = await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true });
    expect(ok.json.status).toBe('Accepted'); expect(ok.json.acceptedAmount).toBe('48000.00');
    const got = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json;
    expect(got.acceptance.undertakingText).toMatch(/irrevocably undertake to pay/);
    expect(got.acceptance.undertakingSignedAt).toBeTruthy();
    expect(new Date(got.disputeWindowEndsAt).getTime() - new Date(got.acceptedAt).getTime()).toBe(24 * 3600_000);
    expect(got.history.map((h: any) => h.to)).toEqual(['Draft', 'Submitted', 'Accepted']);
    // a second decision is not allowed
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'reject', reason: 'changed my mind' })).status).toBe(409);
  });
  it('rejection needs a reason', async () => {
    const d = await submitted();
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'reject' })).status).toBe(400);
    const r = await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'reject', reason: 'Goods not received' });
    expect(r.json.status).toBe('Rejected');
  });
  it('part-accept makes the accepted amount the invoice amount and records the remainder', async () => {
    const d = await submitted({ amount: '100000.00' });
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'partial', acceptedAmount: '100000.00', reason: 'x', undertakingAccepted: true })).status).toBe(400);
    const r = await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'partial', acceptedAmount: '82500.00', reason: 'One line short-shipped', undertakingAccepted: true });
    expect(r.json.acceptedAmount).toBe('82500.00');
    const got = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json;
    expect(got.grossAmount).toBe('100000.00'); expect(got.acceptedAmount).toBe('82500.00');
    expect(got.disputes[0]).toMatchObject({ kind: 'partial_remainder', amount: '17500.00' });
    expect(got.acceptance.undertakingText).toMatch(/82,500\.00/);
  });
  it('silence is never acceptance: reminders at 1 and 3 days, status stays Submitted', async () => {
    const d = await submitted();
    try {
    expect(dueForReminder(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T12:00:00Z'), 0)).toBe(false);
    env.clock.advanceDays(1.5);
    expect(await env.svc.db.tx({ platform: true, correlationId: 'r' }, (tx) => sendAcceptanceReminders(tx, env.svc, { platform: true, correlationId: 'r' }))).toBeGreaterThanOrEqual(1);
    env.clock.advanceDays(2);
    await env.svc.db.tx({ platform: true, correlationId: 'r' }, (tx) => sendAcceptanceReminders(tx, env.svc, { platform: true, correlationId: 'r' }));
    env.clock.advanceDays(30);
    await env.svc.db.tx({ platform: true, correlationId: 'r' }, (tx) => sendAcceptanceReminders(tx, env.svc, { platform: true, correlationId: 'r' }));
    } finally { env.clock.reset(); }
    const got = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json;
    expect(got.status).toBe('Submitted'); expect(got.reminderCount).toBe(2);
  });
  it('buyer can acknowledge the assignment notice once', async () => {
    const d = await submitted();
    await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true });
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/assignment-ack`)).status).toBe(204);
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/assignment-ack`)).status).toBe(409);
  });
});

describe('disputes', () => {
  it('either party can dispute within the window; it freezes the invoice', async () => {
    const d = await submitted();
    await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true });
    const r = await approverB.req('POST', `/api/v1/invoices/${d.id}/disputes`, { reason: 'Quantity on delivery proof does not match' });
    expect(r.status).toBe(201);
    const got = (await fin.req('GET', `/api/v1/invoices/${d.id}`)).json;
    expect(got.status).toBe('Disputed'); expect(got.disputeFlag).toBe(true);
    // a disputed invoice cannot be accepted again or cancelled
    expect((await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true })).status).toBe(409);
    expect((await fin.req('POST', `/api/v1/invoices/${d.id}/cancel`)).status).toBe(409);
  });
  it('the window closes after 24 hours', async () => {
    const d = await submitted();
    await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true });
    env.clock.advanceHours(25);
    try {
      const late = await login(env, 'shree', 'FinanceUser'); // sessions are time-bound, so sign in again at the new time
      const r = await late.req('POST', `/api/v1/invoices/${d.id}/disputes`, { reason: 'Too late?' });
      expect(r.status).toBe(409); expect(r.json.message).toMatch(/window.*closed/i);
    } finally { env.clock.reset(); }
  });
  it('an outsider cannot dispute', async () => {
    const d = await submitted();
    await approverB.req('POST', `/api/v1/invoices/${d.id}/decision`, { decision: 'accept', undertakingAccepted: true });
    const lake = await login(env, 'lakeshore', 'FinanceUser');
    expect((await lake.req('POST', `/api/v1/invoices/${d.id}/disputes`, { reason: 'not mine to dispute' })).status).toBe(404);
  });
});

describe('import', () => {
  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\n"x, y",2\n')).toEqual([['a', 'b'], ['x, y', '2']]);
    expect(csvToRows('buyer,number\nA,1').error).toMatch(/Missing column/);
  });
  it('CSV import creates valid rows and reports each bad row', async () => {
    const csv = [
      'buyer,number,currency,amount,issueDate,dueDate,poNumber',
      'Northwind Retail Inc.,CSV-1,USD,"12,000.50",2026-11-02,2027-01-02,PO-NW-2201',
      'Northwind Retail Inc.,CSV-2,EUR,1000,2026-11-02,2027-01-02,',
      'Nobody Ltd,CSV-3,USD,1000,2026-11-02,2027-01-02,',
      'Northwind Retail Inc.,CSV-1,USD,12000.50,2026-11-02,2027-01-02,PO-NW-2201',
      'Northwind Retail Inc.,CSV-5,USD,500,2027-01-02,2026-11-02,',
    ].join('\n');
    const r = await fin.req('POST', '/api/v1/invoices/import/csv', { csv });
    expect(r.status).toBe(200);
    expect(r.json.created).toHaveLength(1);
    expect(r.json.errors.map((e: any) => e.row)).toEqual([3, 4, 5, 6]);
    expect(r.json.errors[2].message).toMatch(/duplicate/);
  });
  it('ERP import loads the seeded batch, skipping the unknown buyer', async () => {
    const r = await fin.req('POST', '/api/v1/invoices/import/erp');
    expect(r.json.created).toHaveLength(2);
    expect(r.json.errors).toHaveLength(1);
    const again = await fin.req('POST', '/api/v1/invoices/import/erp');
    expect(again.json.created).toHaveLength(0); // duplicates are detected
  });
});

describe('purchase orders and cancel', () => {
  it('lists seeded POs for the supplier only', async () => {
    const mine = (await fin.req('GET', '/api/v1/purchase-orders')).json.items;
    expect(mine.map((p: any) => p.number)).toContain('PO-NW-2201');
    expect(mine.map((p: any) => p.number)).not.toContain('PO-ML-0815');
  });
  it('a draft can be cancelled and then frees its fingerprint', async () => {
    const b = body();
    const d = (await fin.req('POST', '/api/v1/invoices', b)).json;
    expect((await fin.req('POST', `/api/v1/invoices/${d.id}/cancel`)).status).toBe(204);
    expect((await fin.req('POST', '/api/v1/invoices', b)).status).toBe(201);
  });
});
