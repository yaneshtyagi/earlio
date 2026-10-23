import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv, type Session } from './helpers';
import { lateInterest } from '../src/modules/recovery/waterfall';

let env: TestEnv;
let shree: Session; let shreeApprover: Session; let nw: Session; let nwFinance: Session; let uw: Session; let aurelia: Session; let aureliaOps: Session; let admin: Session; let claims: Session; let esUnderwriter: Session;
const T0 = new Date('2026-11-02T04:00:00.000Z');
async function logins() {
  shree = await login(env, 'shree', 'FinanceUser'); shreeApprover = await login(env, 'shree', 'Approver'); nw = await login(env, 'northwind', 'Approver'); nwFinance = await login(env, 'northwind', 'FinanceUser');
  uw = await login(env, 'exportshield', 'Underwriter'); esUnderwriter = uw; claims = await login(env, 'exportshield', 'ClaimsHandler');
  aurelia = await login(env, 'aurelia', 'CreditOfficer'); aureliaOps = await login(env, 'aurelia', 'Operations'); admin = await login(env, 'earlio', 'PlatformAdmin');
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
const defaults = async (id: string) => (await aurelia.req('GET', `/api/v1/recovery/defaults/${id}`)).json;
const ledger = async (id: string) => (await admin.req('GET', `/api/v1/settlement/ledger/${id}`)).json.items as any[];
const sumKind = (l: any[], k: string) => l.filter((x) => x.kind === k).reduce((a, x) => a + Number(x.amount), 0);
const usedUsd = async () => Number((await q('select used_usd from identity.bank_limits where bank_org_id = $1 and subject_org_id = $2', [env.ids.aurelia, env.ids.northwind]))[0].used_usd);

describe('disputes (J-S3, J-B3, ADM-04)', () => {
  it('a window dispute freezes the invoice; both sides use the thread and evidence; the platform reviews and decides for the supplier', async () => {
    const inv = await accepted();
    const d = await nw.req('POST', `/api/v1/invoices/${inv.id}/disputes`, { reason: 'Quantity differs from the purchase order', amount: '5000.00' });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect((await invStatus(inv.id)).status).toBe('Disputed');
    const evidence = await upload(shree, 'packing-list.pdf');
    expect((await shree.req('POST', `/api/v1/disputes/${d.json.id}/messages`, { body: 'Signed delivery note attached', kind: 'evidence', fileId: evidence })).status).toBe(204);
    expect((await nw.req('POST', `/api/v1/disputes/${d.json.id}/messages`, { body: 'We will check our warehouse record.' })).status).toBe(204);
    const dl = await env.app.inject({ method: 'GET', url: `/api/v1/files/${evidence}`, headers: { cookie: nw.cookie } });
    expect(dl.statusCode).toBe(200); // the evidence was shared with the other party
    const detail = (await shree.req('GET', `/api/v1/disputes/${d.json.id}`)).json;
    expect(detail.messages.map((m: any) => m.kind)).toEqual(['system', 'evidence', 'message']);
    expect((await admin.req('GET', '/api/v1/disputes?status=open')).json.items.some((x: any) => x.id === d.json.id)).toBe(true);
    // roles: neither party can decide
    expect((await shreeApprover.req('POST', `/api/v1/disputes/${d.json.id}/decision`, { outcome: 'supplier', note: 'mine' })).status).toBe(403);
    expect((await admin.req('POST', `/api/v1/disputes/${d.json.id}/review`)).status).toBe(204);
    expect((await admin.req('POST', `/api/v1/disputes/${d.json.id}/decision`, { outcome: 'supplier', note: 'Delivery note matches the order.' })).status).toBe(200);
    const after = await invStatus(inv.id);
    expect(after.status).toBe('Accepted'); expect(after.disputeFlag).toBe(false);
    expect((await nw.req('POST', `/api/v1/disputes/${d.json.id}/messages`, { body: 'too late' })).status).toBe(409); // thread is read-only once resolved
  });

  it('timers: silence escalates to the platform queue, then the dispute times out and the freeze lifts; admin can change the timers', async () => {
    try {
      expect((await shree.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 1, escalateAfterHours: 2, timeoutAfterHours: 3 })).status).toBe(403);
      expect((await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 10, escalateAfterHours: 5, timeoutAfterHours: 20 })).status).toBe(400); // must be ordered
      const set = await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 12, escalateAfterHours: 24, timeoutAfterHours: 72 });
      expect(set.json).toMatchObject({ escalateAfterHours: 24, timeoutAfterHours: 72 });
      const inv = await accepted();
      const d = await nw.req('POST', `/api/v1/invoices/${inv.id}/disputes`, { reason: 'Wrong price on the invoice' });
      env.clock.advanceHours(25); await logins(); await env.work();
      expect((await nw.req('GET', `/api/v1/disputes/${d.json.id}`)).json.dispute.status).toBe('Escalated');
      expect((await invStatus(inv.id)).status).toBe('Disputed');
      env.clock.advanceHours(60); await logins(); await env.work();
      expect((await nw.req('GET', `/api/v1/disputes/${d.json.id}`)).json.dispute.status).toBe('TimedOut');
      expect((await invStatus(inv.id)).status).toBe('Accepted');
    } finally { await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 48, escalateAfterHours: 72, timeoutAfterHours: 240 }); await reset(); }
  });

  it('the party that raised a dispute can withdraw it', async () => {
    const inv = await accepted();
    const d = await shree.req('POST', `/api/v1/invoices/${inv.id}/disputes`, { reason: 'Price list was outdated' });
    expect((await nw.req('POST', `/api/v1/disputes/${d.json.id}/withdraw`)).status).toBe(403);
    expect((await shree.req('POST', `/api/v1/disputes/${d.json.id}/withdraw`)).status).toBe(204);
    expect((await invStatus(inv.id)).status).toBe('Accepted');
  });
});

describe('credit notes (BR-13)', () => {
  it('before funding: the invoice is reduced, live offers are superseded and the invoice returns to OpenForFunding', async () => {
    const inv = await accepted();
    await shree.req('POST', `/api/v1/invoices/${inv.id}/open-funding`);
    const o = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/offers`, {});
    expect((await invStatus(inv.id)).status).toBe('OffersReceived');
    expect((await shree.req('POST', `/api/v1/invoices/${inv.id}/credit-notes`, { amount: '1000.00', reason: 'mine' })).status).toBe(403); // only the buyer
    expect((await nw.req('POST', `/api/v1/invoices/${inv.id}/credit-notes`, { amount: '100000.00', reason: 'whole invoice' })).status).toBe(400);
    const cn = await nw.req('POST', `/api/v1/invoices/${inv.id}/credit-notes`, { amount: '10000.00', reason: 'Damaged cartons' });
    expect(cn.status, JSON.stringify(cn.json)).toBe(201);
    expect(cn.json).toMatchObject({ stage: 'pre_funding', priorAmount: '100000.00', newAmount: '90000.00', supplierOwes: '0.00' });
    expect((await q('select status from marketplace.offers where id = $1', [o.json.id]))[0].status).toBe('Superseded');
    const after = await invStatus(inv.id);
    expect(after.status).toBe('OpenForFunding'); expect(after.acceptedAmount).toBe('90000.00');
  });

  it('after funding: exposure and the expected payment shrink, the advance is cut pro rata, the supplier owes the difference and settlement uses the new numbers', async () => {
    try {
      const inv = await funded();
      const usedBefore = await usedUsd();
      const cn = await nw.req('POST', `/api/v1/invoices/${inv.id}/credit-notes`, { amount: '10000.00', reason: 'Late delivery rebate' });
      expect(cn.status, JSON.stringify(cn.json)).toBe(201);
      expect(cn.json).toMatchObject({ stage: 'post_funding', newAmount: '90000.00', supplierOwes: '9000.00' });
      expect(usedBefore - (await usedUsd())).toBe(10000); // the bank's exposure fell by the credited share
      const exp = (await q('select expected_amount, advance_amount, retention_amount from settlement.expectations where invoice_id = $1', [inv.id]))[0];
      expect(exp).toMatchObject({ expected_amount: '90000.00', advance_amount: '81000.00', retention_amount: '9000.00' });
      const rec = (await shree.req('GET', '/api/v1/recovery/recourse')).json.items.find((x: any) => x.invoiceId === inv.id);
      expect(rec).toMatchObject({ cause: 'credit_note', amountOwed: '9000.00', outstanding: '9000.00', smallSupplier: true, mode: 'offset_20pct' });
      // the buyer now pays the reduced amount and the invoice settles and closes
      expect((await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: inv.humanId })).json.amount).toBe('90000.00');
      await env.work();
      expect((await invStatus(inv.id)).status).toBe('Closed');
      const l = await ledger(inv.id);
      expect(sumKind(l, 'bank_principal')).toBe(81000); expect(sumKind(l, 'retention_release') + sumKind(l, 'recourse_offset')).toBeCloseTo(9000, 2);
    } finally { await reset(); }
  });
});

describe('recourse for small suppliers (BR-11, SUP-09)', () => {
  it('offsets at most 20% of each future payout; a 90-day plan is the alternative; the bank records repayments; no penalty interest', async () => {
    try {
      // start clean: clear whatever earlier scenarios left owing
      for (const x of (await aurelia.req('GET', '/api/v1/recovery/recourse')).json.items.filter((i: any) => i.status === 'open')) await aurelia.req('POST', `/api/v1/recovery/recourse/${x.id}/payments`, { amount: x.outstanding });
      const a = await funded();
      await nw.req('POST', `/api/v1/invoices/${a.id}/credit-notes`, { amount: '10000.00', reason: 'Rebate' }); // supplier now owes 9,000 (small supplier, offset mode)
      const rec = (await shree.req('GET', '/api/v1/recovery/recourse')).json.items.find((x: any) => x.invoiceId === a.id);
      // A second invoice settles: retention is 10,000, so at most 2,000 can be withheld
      const b = await funded();
      expect((await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: b.humanId })).status).toBe(200);
      await env.work();
      const lb = await ledger(b.id);
      expect(sumKind(lb, 'recourse_offset')).toBe(2000); expect(sumKind(lb, 'retention_release')).toBe(8000);
      const after = (await shree.req('GET', '/api/v1/recovery/recourse')).json.items.find((x: any) => x.id === rec.id);
      expect(after.outstanding).toBe('7000.00'); expect(after.payments).toHaveLength(1); expect(after.payments[0].source).toBe('offset');
      // only the supplier's approver chooses the plan; bank terms apply to non-small suppliers
      expect((await shree.req('POST', `/api/v1/recovery/recourse/${rec.id}/mode`, { mode: 'plan_90d' })).status).toBe(403);
      const plan = await shreeApprover.req('POST', `/api/v1/recovery/recourse/${rec.id}/mode`, { mode: 'plan_90d' });
      expect(plan.status, JSON.stringify(plan.json)).toBe(200);
      expect(plan.json.plan.map((p: any) => p.amount)).toEqual(['2333.33', '2333.33', '2333.34']);
      // on a plan nothing is offset any more
      const c = await funded();
      await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: c.humanId }); await env.work();
      expect(sumKind(await ledger(c.id), 'recourse_offset')).toBe(0);
      // the bank records the first instalment; overpaying is refused
      expect((await aurelia.req('POST', `/api/v1/recovery/recourse/${rec.id}/payments`, { amount: '99999.00' })).status).toBe(400);
      expect((await aurelia.req('POST', `/api/v1/recovery/recourse/${rec.id}/payments`, { amount: '2333.33', note: 'Instalment 1' })).status).toBe(204);
      const paid = (await aurelia.req('GET', '/api/v1/recovery/recourse')).json.items.find((x: any) => x.id === rec.id);
      expect(paid.outstanding).toBe('4666.67'); expect(paid.plan[0].paid).toBe(true);
      expect((await shree.req('POST', `/api/v1/recovery/recourse/${rec.id}/payments`, { amount: '1.00' })).status).toBe(403);
    } finally { await reset(); }
  });
});

describe('overdue, default, claim, payout, recovery (J-I3, BR-10 case A)', () => {
  it('runs the whole path: dunning at 1/7/30 days with late interest, waiting period, claim, payout waterfall and shared recovery', async () => {
    try {
      const inv = await funded();
      const l0 = await usedUsd();
      await at('2027-01-02T06:00:00.000Z'); // 1 day late
      expect((await invStatus(inv.id)).status).toBe('Overdue');
      let d = await defaults(inv.id);
      expect(d).toMatchObject({ status: 'Overdue', overdueDays: 1, waitingDays: 90, waitingEndsOn: '2027-04-01', insured: true, dunningLevel: 1 });
      await at('2027-01-09T06:00:00.000Z'); expect((await defaults(inv.id)).dunningLevel).toBe(2);
      await at('2027-02-01T06:00:00.000Z');
      d = await defaults(inv.id);
      expect(d.dunningLevel).toBe(3); expect(d.overdueDays).toBe(31);
      expect(d.lateInterest).toBe(lateInterest(d.principal, d.financingRatePct, 31)); // rate + 2 points, on the bank's principal, charged to the buyer
      expect((await q('select level from recovery.dunning_events where invoice_id = $1 order by level', [inv.id])).map((x: any) => x.level)).toEqual([1, 2, 3]);
      // no claim during the waiting period
      const early = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/claims`, { documents: [] });
      expect(early.status).toBe(409); expect(early.json.message).toMatch(/waiting period ends on 2027-04-01/);
      await at('2027-04-02T06:00:00.000Z');
      expect((await invStatus(inv.id)).status).toBe('Defaulted');
      d = await defaults(inv.id); expect(d.status).toBe('ClaimEligible'); expect(d.claimDeadlineOn).toBe('2027-05-31'); // 60 days
      // the bank files with all four documents
      const documents = await Promise.all((['invoice', 'acceptance', 'delivery_proof', 'statement'] as const).map(async (t) => ({ docType: t, fileId: await upload(aurelia, `${t}.pdf`) })));
      expect((await shree.req('POST', `/api/v1/invoices/${inv.id}/claims`, { documents })).status).toBe(403);
      const filed = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/claims`, { documents });
      expect(filed.status, JSON.stringify(filed.json)).toBe(201);
      expect(filed.json).toMatchObject({ status: 'Filed', claimedAmount: '90000.00', coverPct: '90', exclusions: [] });
      // the insurer's claims desk reviews, approves and pays
      expect((await aurelia.req('POST', `/api/v1/claims/${filed.json.id}/decision`, { decision: 'approve' })).status).toBe(403); // the bank cannot decide
      expect((await claims.req('POST', `/api/v1/claims/${filed.json.id}/review`)).json.exclusions).toEqual([]);
      const dec = await claims.req('POST', `/api/v1/claims/${filed.json.id}/decision`, { decision: 'approve' });
      expect(dec.status, JSON.stringify(dec.json)).toBe(200);
      expect(dec.json.waterfall).toMatchObject({ payout: '90000.00', toBank: '90000.00', toSupplier: '0.00', bankShortfall: '0.00', supplierLoss: '10000.00' }); // case A
      expect((await claims.req('POST', `/api/v1/claims/${filed.json.id}/pay`)).status).toBe(200);
      expect((await claims.req('POST', `/api/v1/claims/${filed.json.id}/pay`)).status).toBe(409); // never paid twice
      expect((await invStatus(inv.id)).status).toBe('Closed');
      expect((await q("select status from marketplace.liens where invoice_id = $1", [inv.id]))[0].status).toBe('Released');
      expect(l0 - (await usedUsd())).toBe(100000); // the bank's limit usage for this invoice is freed
      const led = await ledger(inv.id);
      expect(sumKind(led, 'claim_payout')).toBe(90000); expect(sumKind(led, 'bank_principal')).toBe(90000 + 0);
      // recovery: 12,000 recovered at a cost of 2,000 → net 10,000 shared pro rata to losses (insurer 90,000 : supplier 10,000)
      expect((await aurelia.req('POST', `/api/v1/claims/${filed.json.id}/recoveries`, { gross: '12000.00', costs: '2000.00', note: 'Liquidator dividend' })).json)
        .toMatchObject({ net: '10000.00', shares: { insurer: '9000.00', bank: '0.00', supplier: '1000.00' } });
      const view = (await nw.req('GET', `/api/v1/claims/${filed.json.id}`));
      expect(view.status).toBe(404); // the buyer is not a party to the claim
      expect((await claims.req('GET', `/api/v1/claims/${filed.json.id}`)).json.recoveries).toHaveLength(1);
    } finally { await reset(); }
  });

  it('case B: the insurer approves less than the cover; the bank carries a 20,000 shortfall and the recovery is shared 70 : 20 : 10', async () => {
    try {
      const inv = await funded();
      await at('2027-04-02T06:00:00.000Z');
      expect((await defaults(inv.id)).status).toBe('ClaimEligible');
      const documents = await Promise.all((['invoice', 'acceptance', 'delivery_proof', 'statement'] as const).map(async (t) => ({ docType: t, fileId: await upload(aurelia, `${t}.pdf`) })));
      const c = (await aurelia.req('POST', `/api/v1/invoices/${inv.id}/claims`, { documents })).json;
      expect((await claims.req('POST', `/api/v1/claims/${c.id}/decision`, { decision: 'partial', approvedAmount: '70000.00' })).status).toBe(400); // a reason is required
      expect((await claims.req('POST', `/api/v1/claims/${c.id}/decision`, { decision: 'partial', approvedAmount: '95000.00', reason: 'x' })).status).toBe(400); // above the cover
      const dec = await claims.req('POST', `/api/v1/claims/${c.id}/decision`, { decision: 'partial', approvedAmount: '70000.00', reason: 'Policy limit per buyer reduced mid-term' });
      expect(dec.json.waterfall).toMatchObject({ payout: '70000.00', toBank: '70000.00', bankShortfall: '20000.00', supplierLoss: '10000.00' });
      await claims.req('POST', `/api/v1/claims/${c.id}/pay`);
      const rec = await aurelia.req('POST', `/api/v1/claims/${c.id}/recoveries`, { gross: '1000.00' });
      expect(rec.json.shares).toMatchObject({ insurer: '700.00', bank: '200.00', supplier: '100.00' });
    } finally { await reset(); }
  });

  it('case C: a supplier-caused dispute upheld by the platform blocks the claim; the insurer rejects; nothing is paid and recourse (not duplicated) is triggered', async () => {
    try {
      await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 1000, escalateAfterHours: 2000, timeoutAfterHours: 5000 });
      const inv = await funded();
      await at('2027-01-05T06:00:00.000Z');
      const d = await nw.req('POST', `/api/v1/invoices/${inv.id}/disputes`, { reason: 'The goods never arrived' });
      expect(d.status, JSON.stringify(d.json)).toBe(201);
      expect((await invStatus(inv.id)).status).toBe('Disputed');
      const frozenView = await defaults(inv.id);
      // only the platform can attribute a cause, and it must be a known one
      expect((await admin.req('POST', `/api/v1/disputes/${d.json.id}/decision`, { outcome: 'buyer', cause: 'bad_vibes', note: 'x1' })).status).toBe(400);
      const dec = await admin.req('POST', `/api/v1/disputes/${d.json.id}/decision`, { outcome: 'buyer', cause: 'non_delivery', note: 'Carrier confirms the container never left port.' });
      expect(dec.status, JSON.stringify(dec.json)).toBe(200); expect(dec.json.recourseId).toBeTruthy();
      expect((await invStatus(inv.id)).status).toBe('Overdue'); // back to where it was
      const rec = (await aurelia.req('GET', '/api/v1/recovery/recourse')).json.items.filter((x: any) => x.invoiceId === inv.id);
      expect(rec).toHaveLength(1); expect(rec[0]).toMatchObject({ cause: 'non_delivery', amountOwed: '90000.00' });
      void frozenView;
      await at('2027-05-10T06:00:00.000Z');
      expect((await defaults(inv.id)).status).toBe('ClaimEligible');
      const documents = await Promise.all((['invoice', 'acceptance', 'delivery_proof'] as const).map(async (t) => ({ docType: t, fileId: await upload(aurelia, `${t}.pdf`) })));
      const c = (await aurelia.req('POST', `/api/v1/invoices/${inv.id}/claims`, { documents })).json;
      expect(c.exclusions.map((e: any) => e.code).sort()).toEqual(['dispute', 'documentation_defect']);
      const blocked = await claims.req('POST', `/api/v1/claims/${c.id}/decision`, { decision: 'approve' });
      expect(blocked.status).toBe(409); expect(blocked.json.code).toBe('exclusion_applies');
      expect((await claims.req('POST', `/api/v1/claims/${c.id}/decision`, { decision: 'reject' })).status).toBe(400); // a reason is required
      const rej = await claims.req('POST', `/api/v1/claims/${c.id}/decision`, { decision: 'reject', reason: 'Excluded: the buyer’s dispute was upheld and a claim document is missing.' });
      expect(rej.json.waterfall).toMatchObject({ payout: '0.00', toBank: '0.00', bankShortfall: '90000.00' });
      expect(rej.json.recourseId).toBeNull(); // already raised when the dispute was decided
      expect((await aurelia.req('GET', '/api/v1/recovery/recourse')).json.items.filter((x: any) => x.invoiceId === inv.id)).toHaveLength(1);
      expect((await claims.req('POST', `/api/v1/claims/${c.id}/pay`)).status).toBe(409);
      expect((await invStatus(inv.id)).status).toBe('Closed');
    } finally { await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 48, escalateAfterHours: 72, timeoutAfterHours: 240 }); await reset(); }
  });

  it('a dispute freezes late interest and the waiting period; resolving it starts them again', async () => {
    try {
      await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 1000, escalateAfterHours: 2000, timeoutAfterHours: 5000 });
      const inv = await funded();
      await at('2027-01-11T06:00:00.000Z'); // 10 days late
      const before = await defaults(inv.id);
      expect(before.overdueDays).toBe(10);
      const d = await shree.req('POST', `/api/v1/invoices/${inv.id}/disputes`, { reason: 'Buyer claims a short shipment; we dispute that' });
      expect(d.status, JSON.stringify(d.json)).toBe(201);
      await at('2027-01-31T06:00:00.000Z'); // 20 more days pass
      const frozen = await defaults(inv.id);
      expect(frozen.lateInterest).toBe(lateInterest(before.principal, before.financingRatePct, 10));
      expect(frozen.frozenDays).toBe(20);
      expect(frozen.dunningLevel).toBe(before.dunningLevel); // no further dunning while disputed
      expect(frozen.waitingEndsOn).toBe('2027-04-21'); // 2027-04-01 + 20 frozen days
      expect((await admin.req('POST', `/api/v1/disputes/${d.json.id}/decision`, { outcome: 'supplier', note: 'Delivery proof is signed.' })).status).toBe(200);
      await at('2027-02-10T06:00:00.000Z');
      const resumed = await defaults(inv.id);
      expect(resumed.frozenDays).toBe(20); expect(resumed.lateInterest).toBe(lateInterest(before.principal, before.financingRatePct, 20)); // 40 days late − 20 frozen
    } finally { await admin.req('PUT', '/api/v1/admin/dispute-timers', { responseHours: 48, escalateAfterHours: 72, timeoutAfterHours: 240 }); await reset(); }
  });

  it('A-14: a reported insolvency waives the waiting period and the claim window starts at once', async () => {
    try {
      const inv = await funded();
      await at('2027-01-20T06:00:00.000Z');
      expect((await defaults(inv.id)).status).toBe('Overdue');
      expect((await shree.req('POST', `/api/v1/recovery/defaults/${inv.id}/insolvency`, { reference: 'Ch. 11 case 26-10042' })).status).toBe(403);
      expect((await aurelia.req('POST', `/api/v1/recovery/defaults/${inv.id}/insolvency`, { reference: 'x' })).status).toBe(400);
      expect((await aurelia.req('POST', `/api/v1/recovery/defaults/${inv.id}/insolvency`, { reference: 'Ch. 11 case 26-10042' })).status).toBe(204);
      const d = await defaults(inv.id);
      expect(d).toMatchObject({ status: 'ClaimEligible', insolvency: true, claimDeadlineOn: '2027-03-21' });
      expect((await invStatus(inv.id)).status).toBe('Defaulted');
    } finally { await reset(); }
  });

  it('a buyer who pays after the due date but before any claim clears the default, the interest owed is booked and the invoice settles', async () => {
    try {
      const inv = await funded();
      await at('2027-01-31T06:00:00.000Z'); // 30 days late
      const d = await defaults(inv.id);
      const pay = await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: inv.humanId, amount: (100000 + Number(d.lateInterest)).toFixed(2) });
      expect(pay.json.callbackOutcome).toBe('late');
      await env.work();
      expect(['Settled', 'Closed']).toContain((await invStatus(inv.id)).status);
      expect(sumKind(await ledger(inv.id), 'late_interest')).toBeCloseTo(Number(d.lateInterest), 2);
      expect((await defaults(inv.id)).status).toBe('Recovered');
      const open = (await admin.req('GET', '/api/v1/settlement/exceptions?status=open')).json.items.filter((e: any) => e.invoiceNumber === inv.humanId);
      expect(open.map((e: any) => e.type)).toEqual(['Late']); // interest is not an overpayment
    } finally { await reset(); }
  });
});

describe('export proceeds (XB-6, SUP-08)', () => {
  it('starts the realisation clock at acceptance, flags the financing chain, realises on settlement and lets the authorised dealer bank report it', async () => {
    try {
      const inv = await funded();
      let p = (await shree.req('GET', '/api/v1/export-proceeds')).json.items.find((x: any) => x.invoiceId === inv.id);
      expect(p).toMatchObject({ status: 'Pending', shipmentDate: '2026-11-01', realisationDeadline: '2027-08-01', chainBroken: true });
      expect(p.chainNote).toMatch(/authorised dealer bank/);
      await admin.req('POST', '/api/v1/sim/pay', { invoiceNumber: inv.humanId });
      await env.work();
      p = (await shree.req('GET', '/api/v1/export-proceeds')).json.items.find((x: any) => x.invoiceId === inv.id);
      expect(p.status).toBe('Realised'); expect(Number(p.realisedInr)).toBeGreaterThan(7_800_000); // payout plus retention, in rupees
      expect((await shree.req('POST', `/api/v1/export-proceeds/${p.id}/report`, { reference: 'EDPMS-1' })).status).toBe(403);
      expect((await aureliaOps.req('POST', `/api/v1/export-proceeds/${p.id}/report`, { reference: 'EDPMS-1' })).status).toBe(204);
      expect((await aureliaOps.req('GET', '/api/v1/export-proceeds')).json.items.find((x: any) => x.id === p.id).status).toBe('Reported');
    } finally { await reset(); }
  });

  it('proceeds still outstanding after the deadline are flagged Overdue', async () => {
    try {
      const inv = await accepted();
      await at('2027-08-05T06:00:00.000Z');
      const p = (await shree.req('GET', '/api/v1/export-proceeds')).json.items.find((x: any) => x.invoiceId === inv.id);
      expect(p.status).toBe('Overdue'); expect(p.daysLeft).toBeLessThan(0);
      expect((await q("select 1 from platform.outbox where topic = 'export_proceeds.overdue'")).length).toBeGreaterThan(0);
    } finally { await reset(); }
  });
});
