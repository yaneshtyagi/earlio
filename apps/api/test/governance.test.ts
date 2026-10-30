import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, loginAs, type TestEnv, type Session } from './helpers';
import { diffJson, describeTerms, templatesFor } from '../src/modules/governance/diff';
import { contrast } from '../src/modules/governance/service';
import { checkTermsGuardrails } from '../src/modules/terms/guardrails';
import { validateBody } from '../src/modules/terms/schema';

let env: TestEnv;
let admin: Session; let admin2: Session; let rm: Session; let bankApprover: Session; let bankAdmin: Session; let uw: Session; let esApprover: Session;
let shree: Session; let shreeApprover: Session; let nw: Session; let aurelia: Session; let kestrelAdmin: Session;
const T0 = new Date('2026-11-02T04:00:00.000Z');
async function logins() {
  admin = await login(env, 'earlio', 'PlatformAdmin'); admin2 = await loginAs(env, 'admin2@earlio.demo');
  rm = await login(env, 'aurelia', 'RelationshipManager'); bankApprover = await login(env, 'aurelia', 'Approver'); bankAdmin = await login(env, 'aurelia', 'Admin'); aurelia = await login(env, 'aurelia', 'CreditOfficer');
  uw = await login(env, 'exportshield', 'Underwriter'); esApprover = await login(env, 'exportshield', 'Approver');
  shree = await login(env, 'shree', 'FinanceUser'); shreeApprover = await login(env, 'shree', 'Approver'); nw = await login(env, 'northwind', 'Approver'); kestrelAdmin = await login(env, 'kestrel', 'Admin');
}
beforeAll(async () => { env = await createTestEnv(); await logins(); });
afterAll(async () => { await env.close(); });
const q = <T = any>(sql: string, p: unknown[] = []) => env.svc.db.system((tx) => tx.query<T>(sql, p));
const host = (h: string) => env.app.inject({ method: 'GET', url: '/api/v1/branding', headers: { host: h } });

describe('pure helpers', () => {
  it('diffJson lists added, removed and changed leaves with their paths', () => {
    const d = diffJson({ a: 1, b: { c: 2, d: [1] }, e: 'x' }, { a: 1, b: { c: 3, d: [1, 2] }, f: true });
    expect(d).toEqual([
      { path: 'b.c', before: 2, after: 3, kind: 'changed' }, { path: 'b.d', before: [1], after: [1, 2], kind: 'changed' },
      { path: 'e', before: 'x', after: undefined, kind: 'removed' }, { path: 'f', before: undefined, after: true, kind: 'added' },
    ]);
    expect(diffJson({ x: 1 }, { x: 1 })).toEqual([]);
  });
  it('every template is valid and respects the guardrails', () => {
    for (const owner of ['platform', 'bank', 'insurer'] as const) {
      const ts = templatesFor(owner);
      expect(ts.length).toBeGreaterThan(0);
      for (const t of ts) {
        const v = validateBody(owner, t.body, false);
        expect(v.ok, `${owner}/${t.id}: ${(v as any).error}`).toBe(true);
        expect(checkTermsGuardrails(owner, t.body), `${owner}/${t.id}`).toEqual([]);
      }
    }
  });
  it('the plain-language preview says what the supplier gets and that buyers never see the price', () => {
    const p = describeTerms('bank', templatesFor('bank')[0]!.body, 4.1);
    expect(p.supplier.join(' ')).toContain('up to 90% of the invoice');
    expect(p.supplier.join(' ')).toContain('benchmark rate (4.1% today)');
    expect(p.buyer.join(' ')).toContain('never see the rate');
    expect(describeTerms('insurer', templatesFor('insurer')[0]!.body).supplier.join(' ')).toContain('insured for 90%');
  });
  it('contrast follows WCAG', () => { expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0); expect(contrast('#0b5d3b', '#ffffff')).toBeGreaterThan(4.5); expect(contrast('#ffff00', '#ffffff')).toBeLessThan(2); });
});

describe('maker-checker for terms (CT-6)', () => {
  it('the maker cannot approve; the inbox shows a diff and who may approve; the other administrator publishes; the audit trail keeps before and after', async () => {
    const sets = (await admin.req('GET', '/api/v1/terms/sets')).json.items;
    const plat = sets.find((s: any) => s.ownerType === 'platform');
    const body = { ...plat.activeVersion.body, freeTierInvoicesPerMonth: 7 };
    const v = await admin.req('POST', `/api/v1/terms/sets/${plat.id}/versions`, { body, note: 'More free invoices for small suppliers' });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    expect((await admin.req('POST', `/api/v1/terms/versions/${v.json.id}/submit`, {})).status).toBe(204);
    expect((await admin.req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(403); // self-approval blocked server-side
    const mine = (await admin.req('GET', '/api/v1/approvals')).json.items.find((i: any) => i.id === v.json.id);
    expect(mine).toMatchObject({ kind: 'terms', canApprove: false, against: 1 });
    expect(mine.changes).toEqual([{ path: 'freeTierInvoicesPerMonth', before: 5, after: 7, kind: 'changed' }]);
    const theirs = (await admin2.req('GET', '/api/v1/approvals')).json.items.find((i: any) => i.id === v.json.id);
    expect(theirs.canApprove).toBe(true);
    expect((await admin2.req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(204);
    const ev = (await q("select before, after from audit.events where action = 'terms.version_published' and entity_id = $1", [v.json.id]))[0];
    expect(ev.before.body.freeTierInvoicesPerMonth).toBe(5); expect(ev.after.body.freeTierInvoicesPerMonth).toBe(7);
    const d = (await admin.req('GET', `/api/v1/terms/versions/${v.json.id}/diff`)).json;
    expect(d).toMatchObject({ version: 2, against: 1 }); expect(d.changes).toHaveLength(1);
  });

  it('a term save that breaks a guardrail is rejected, naming it', async () => {
    const plat = (await admin.req('GET', '/api/v1/terms/sets')).json.items.find((s: any) => s.ownerType === 'platform');
    const r = await admin.req('POST', `/api/v1/terms/sets/${plat.id}/versions`, { body: { ...plat.activeVersion.body, disputeWindowHours: 12 } });
    expect(r.status).toBe(422); expect(r.json.message).toContain('Minimum dispute window'); expect(r.json.details?.guardrails ?? r.json.guardrails).toContain('min_dispute_window');
    const bank = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0];
    const r2 = await rm.req('POST', `/api/v1/terms/sets/${bank.id}/versions`, { body: { ...bank.activeVersion.body, fxSpreadPct: 2 } });
    expect(r2.status).toBe(422); expect(r2.json.message).toContain('Maximum FX spread');
  });

  it('a checker can send a version back with a reason, and the maker can then redraft', async () => {
    const set = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0];
    const v = await rm.req('POST', `/api/v1/terms/sets/${set.id}/versions`, { body: { ...set.activeVersion.body, offerValidityHours: 36 } });
    await rm.req('POST', `/api/v1/terms/versions/${v.json.id}/submit`, {});
    const items = (await bankApprover.req('GET', '/api/v1/approvals')).json.items;
    expect(items.find((i: any) => i.id === v.json.id)).toMatchObject({ canApprove: true, ownerType: 'bank' });
    expect((await bankApprover.req('POST', `/api/v1/terms/versions/${v.json.id}/reject`, { reason: 'Keep 24 hours until the pilot ends' })).status).toBe(204);
    const after = (await rm.req('GET', `/api/v1/terms/sets/${set.id}`)).json.versions.find((x: any) => x.id === v.json.id);
    expect(after.status).toBe('draft'); expect(after.note).toContain('Keep 24 hours');
    expect((await bankApprover.req('GET', '/api/v1/approvals')).json.items.some((i: any) => i.id === v.json.id)).toBe(false);
  });

  it('platform staff cannot publish a bank\'s terms, and a bank cannot see another bank\'s inbox', async () => {
    const set = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0];
    const v = await rm.req('POST', `/api/v1/terms/sets/${set.id}/versions`, { body: { ...set.activeVersion.body, offerValidityHours: 30 } });
    await rm.req('POST', `/api/v1/terms/versions/${v.json.id}/submit`, {});
    expect((await admin.req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(403);
    expect((await kestrelAdmin.req('GET', '/api/v1/approvals')).json.items.some((i: any) => i.id === v.json.id)).toBe(false);
    await bankApprover.req('POST', `/api/v1/terms/versions/${v.json.id}/reject`, { reason: 'test cleanup' });
  });
});

describe('studio helpers: export/import, simulator (CT-9, CT-11)', () => {
  it('export → import round-trips into a draft, and a foreign or newer file is refused', async () => {
    const set = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0];
    const doc = (await rm.req('GET', `/api/v1/terms/sets/${set.id}/export`)).json;
    expect(doc).toMatchObject({ format: 'earlio-terms', ownerType: 'bank', schemaVersion: 1 });
    const imp = await rm.req('POST', `/api/v1/terms/sets/${set.id}/import`, { ...doc, body: { ...doc.body, advancePct: 85 } });
    expect(imp.status, JSON.stringify(imp.json)).toBe(201); expect(imp.json.status).toBe('draft');
    expect((await rm.req('POST', `/api/v1/terms/sets/${set.id}/import`, { ...doc, format: 'other' })).status).toBe(400);
    expect((await rm.req('POST', `/api/v1/terms/sets/${set.id}/import`, { ...doc, ownerType: 'insurer' })).status).toBe(400);
    expect((await rm.req('POST', `/api/v1/terms/sets/${set.id}/import`, { ...doc, schemaVersion: 99 })).status).toBe(400);
    expect((await rm.req('POST', `/api/v1/terms/sets/${set.id}/import`, { ...doc, body: { ...doc.body, advancePct: 150 } })).status).toBe(422); // validated like any draft
  });

  it('the simulator runs 20 samples for a bank draft and for an insurer draft', async () => {
    const bank = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0].activeVersion.body;
    const b = await rm.req('POST', '/api/v1/terms/simulate', { body: { maxTenorDays: 60 } });
    expect(b.status, JSON.stringify(b.json)).toBe(200); expect(b.json.rows).toHaveLength(20);
    expect(b.json.rows.some((r: any) => r.changed && r.before.eligible && !r.after.eligible)).toBe(true);
    expect(bank.maxTenorDays).toBe(120);
    const i = await uw.req('POST', '/api/v1/terms/simulate', { body: { coverPct: 60 } });
    expect(i.status, JSON.stringify(i.json)).toBe(200); expect(i.json.rows).toHaveLength(20);
    expect(i.json.rows.some((r: any) => r.changed)).toBe(true);
    expect((await shree.req('POST', '/api/v1/terms/simulate', { body: {} })).status).toBe(403);
  });

  it('templates and preview are served; the preview needs no write permission', async () => {
    const t = await rm.req('GET', '/api/v1/terms/templates/bank');
    expect(t.json.items.map((x: any) => x.id)).toEqual(['standard', 'conservative', 'growth']);
    const p = await shree.req('POST', '/api/v1/terms/preview', { ownerType: 'bank', body: t.json.items[1].body });
    expect(p.status).toBe(200); expect(p.json.supplier.length).toBeGreaterThan(3);
  });
});

describe('platform settings and the guardrail console (ADM-07)', () => {
  it('a change needs a second administrator; the value applies only then; the audit log keeps before and after', async () => {
    const list = (await admin.req('GET', '/api/v1/admin/settings')).json.items;
    expect(list.map((x: any) => x.key)).toContain('dispute_timers');
    expect((await shree.req('PUT', '/api/v1/admin/settings/dunning_days', { value: [2, 8, 31] })).status).toBe(403);
    expect((await admin.req('PUT', '/api/v1/admin/settings/nope', { value: 1 })).status).toBe(400);
    expect((await admin.req('PUT', '/api/v1/admin/settings/dunning_days', { value: [7, 3] })).status).toBe(422);
    expect((await admin.req('PUT', '/api/v1/admin/settings/dispute_window_hours', { value: 6 })).status).toBe(422); // below the 24-hour guardrail
    const p = await admin.req('PUT', '/api/v1/admin/settings/dunning_days', { value: [2, 8, 31], note: 'Gentler reminders' });
    expect(p.status).toBe(202);
    expect((await admin.req('GET', '/api/v1/admin/settings')).json.items.find((x: any) => x.key === 'dunning_days')).toMatchObject({ value: [1, 7, 30], pending: { value: [2, 8, 31] } });
    expect((await admin.req('POST', `/api/v1/approvals/settings/${p.json.changeId}/decision`, { approve: true })).status).toBe(403);
    expect((await admin2.req('POST', `/api/v1/approvals/settings/${p.json.changeId}/decision`, { approve: true })).status).toBe(204);
    expect((await admin.req('GET', '/api/v1/admin/settings')).json.items.find((x: any) => x.key === 'dunning_days')).toMatchObject({ value: [2, 8, 31], pending: null });
    const ev = (await q("select before, after from audit.events where action = 'settings.applied' and entity_id = 'dunning_days'"))[0];
    expect(ev.before).toEqual([1, 7, 30]); expect(ev.after).toEqual([2, 8, 31]);
    // put it back via a rejected-then-accepted pair
    const r = await admin2.req('PUT', '/api/v1/admin/settings/dunning_days', { value: [1, 7, 30] });
    expect((await admin.req('POST', `/api/v1/approvals/settings/${r.json.changeId}/decision`, { approve: false, note: 'Not yet' })).status).toBe(204);
    expect((await admin.req('GET', '/api/v1/admin/settings')).json.items.find((x: any) => x.key === 'dunning_days').value).toEqual([2, 8, 31]);
    const r2 = await admin2.req('PUT', '/api/v1/admin/settings/dunning_days', { value: [1, 7, 30] });
    await admin.req('POST', `/api/v1/approvals/settings/${r2.json.changeId}/decision`, { approve: true });
  });

  it('pending setting changes appear in the administrators\' inbox and the console lists the hard guardrails', async () => {
    const p = await admin.req('PUT', '/api/v1/admin/settings/export_realisation_months', { value: 12 });
    const inbox = (await admin2.req('GET', '/api/v1/approvals')).json.items.find((i: any) => i.kind === 'setting' && i.id === p.json.changeId);
    expect(inbox).toMatchObject({ canApprove: true, title: expect.stringContaining('realisation') });
    expect(inbox.changes).toEqual([{ path: 'export_realisation_months', before: 9, after: 12, kind: 'changed' }]);
    expect((await admin.req('GET', '/api/v1/approvals')).json.items.find((i: any) => i.id === p.json.changeId).canApprove).toBe(false);
    await admin2.req('POST', `/api/v1/approvals/settings/${p.json.changeId}/decision`, { approve: false });
    const g = (await admin.req('GET', '/api/v1/admin/guardrails')).json;
    expect(g.guardrails.map((x: any) => x.key)).toEqual(expect.arrayContaining(['minDisputeWindowHours', 'maxFxSpreadPct', 'maxAllInCostSmallPct']));
    expect(g.guardrails.every((x: any) => x.editable === false)).toBe(true);
    expect((await bankAdmin.req('GET', '/api/v1/admin/guardrails')).status).toBe(403);
  });
});

describe('white-label branding (WL-1)', () => {
  it('the tenant name (first label of the host) decides whose branding the SPA gets; unknown hosts get Earlio', async () => {
    const a = (await host('aurelia.localhost')).json(); const k = (await host('Kestrel.localhost:5173')).json(); const u = (await host('portal.example.com')).json();
    expect(a).toMatchObject({ matched: true, displayName: 'Aurelia Bank', primary: '#0b5d3b', whiteLabel: true, tenant: 'aurelia' });
    expect(k).toMatchObject({ matched: true, displayName: 'Kestrel Capital', primary: '#1d4ed8', tenant: 'kestrel' });
    expect((await host('kestrel.earlio.example.com')).json()).toMatchObject({ matched: true, orgId: env.ids.kestrel });
    expect(u).toMatchObject({ matched: false, displayName: 'Earlio', whiteLabel: false });
    expect((await host('localhost:5173')).json()).toMatchObject({ matched: false, displayName: 'Earlio' });
    expect(a.orgId).toBe(env.ids.aurelia);
  });

  it('a bank administrator edits its own branding; low contrast and bad logos are refused; another bank is untouched', async () => {
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { primary: '#ffff00' })).json.code).toBe('low_contrast');
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { logo: 'javascript:alert(1)' })).status).toBe(400);
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { primary: 'green' })).status).toBe(400);
    expect((await shree.req('PUT', '/api/v1/bank/branding', { displayName: 'Hack' })).status).toBe(403);
    const ok = await bankAdmin.req('PUT', '/api/v1/bank/branding', { displayName: 'Aurelia Trade Finance', primary: '#14532d', welcome: 'Welcome to Aurelia.' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await host('aurelia.localhost')).json()).toMatchObject({ displayName: 'Aurelia Trade Finance', primary: '#14532d', welcome: 'Welcome to Aurelia.' });
    expect((await host('kestrel.localhost')).json().displayName).toBe('Kestrel Capital');
    expect((await bankAdmin.req('GET', '/api/v1/bank/branding')).json).toMatchObject({ displayName: 'Aurelia Trade Finance', tenant: 'aurelia', hostname: null });
    expect((await q("select 1 from audit.events where action = 'branding.updated'")).length).toBeGreaterThan(0);
  });

  it('only the platform can point a custom domain at a bank, and a domain belongs to one bank', async () => {
    expect((await bankAdmin.req('PUT', `/api/v1/admin/banks/${env.ids.aurelia}/hostname`, { hostname: 'evil.example.com' })).status).toBe(403);
    expect((await admin.req('PUT', `/api/v1/admin/banks/${env.ids.kestrel}/hostname`, { hostname: 'finance.kestrel.example.com' })).status).toBe(204);
    expect((await admin.req('PUT', `/api/v1/admin/banks/${env.ids.aurelia}/hostname`, { hostname: 'finance.kestrel.example.com' })).status).toBe(409);
    expect((await admin.req('PUT', `/api/v1/admin/banks/${env.ids.aurelia}/hostname`, { hostname: 'not a host' })).status).toBe(400);
    // the custom domain wins over the tenant label (its first label, "finance", is no tenant anyway)
    expect((await host('finance.kestrel.example.com')).json()).toMatchObject({ matched: true, orgId: env.ids.kestrel });
    expect((await admin.req('PUT', `/api/v1/admin/banks/${env.ids.kestrel}/hostname`, { hostname: null })).status).toBe(204);
    expect((await host('finance.kestrel.example.com')).json().matched).toBe(false);
    expect((await admin.req('GET', '/api/v1/admin/banks')).json.items.find((b: any) => b.id === env.ids.aurelia)).toMatchObject({ tenant: 'aurelia', hostname: null });
  });

  it('a bank chooses its own tenant name; names are validated, unique and reserved words are refused', async () => {
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'kestrel' })).json.code).toBe('tenant_taken');
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'www' })).status).toBe(400);
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'Bad Name!' })).status).toBe(400);
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: '' })).status).toBe(400); // a bank cannot drop its name
    expect((await bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'Aurelia-Trade' })).status).toBe(200);
    expect((await host('aurelia-trade.localhost:5173')).json()).toMatchObject({ matched: true, orgId: env.ids.aurelia, tenant: 'aurelia-trade' });
    expect((await host('aurelia.localhost')).json().matched).toBe(false);
    expect((await kestrelAdmin.req('PUT', `/api/v1/admin/banks/${env.ids.aurelia}/tenant`, { tenant: 'stolen' })).status).toBe(403);
    expect((await admin.req('PUT', `/api/v1/admin/banks/${env.ids.aurelia}/tenant`, { tenant: 'aurelia' })).status).toBe(204);
    expect((await host('aurelia.localhost')).json().matched).toBe(true);
    expect((await q("select after from audit.events where action = 'branding.tenant_set' order by seq"))).toHaveLength(2);
  });

  it('two banks racing for the same tenant name: exactly one gets it (unique in the database)', async () => {
    const r = await Promise.all([
      bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'contested' }),
      kestrelAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'contested' }),
    ]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await q("select id from identity.organisations where tenant = 'contested'")).toHaveLength(1);
    await bankAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'aurelia' }); await kestrelAdmin.req('PUT', '/api/v1/bank/branding', { tenant: 'kestrel' });
  });

  it('switching to white-label mode (maker-checker) shows the partner bank everywhere and invites only it', async () => {
    const p = await admin.req('PUT', '/api/v1/admin/settings/mode', { value: 'white-label' });
    expect(p.status).toBe(202);
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/system/config' })).json().mode).toBe('network'); // not yet
    await admin2.req('POST', `/api/v1/approvals/settings/${p.json.changeId}/decision`, { approve: true });
    expect((await env.app.inject({ method: 'GET', url: '/api/v1/system/config' })).json().mode).toBe('white-label');
    const unknown = (await host('anything.example.org')).json();
    expect(unknown).toMatchObject({ mode: 'white-label', displayName: 'Aurelia Trade Finance', whiteLabel: true, matched: false });
    const back = await admin.req('PUT', '/api/v1/admin/settings/mode', { value: 'network' });
    await admin2.req('POST', `/api/v1/approvals/settings/${back.json.changeId}/decision`, { approve: true });
    expect((await host('anything.example.org')).json().displayName).toBe('Earlio');
  });
});

// ---------------------------------------------------------------------------------------------- funded invoices keep their terms; custom fields
let n = 0;
async function upload(s: Session, name: string) {
  const res = await env.app.inject({ method: 'POST', url: `/api/v1/files?filename=${name}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(name + Math.random()) });
  return res.json().id as string;
}
async function accepted(amount = '100000.00') {
  const c = await shree.req('POST', '/api/v1/invoices', { buyerOrgId: env.ids.northwind, number: `GV/${++n}`, currency: 'USD', amount, issueDate: '2026-11-01', dueDate: '2027-01-01', poNumber: 'PO-NW-2201' });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  for (const t of ['commercial_invoice', 'delivery_proof']) await shree.req('POST', `/api/v1/invoices/${c.json.id}/documents`, { docType: t, fileId: await upload(shree, t + '.pdf') });
  await shree.req('POST', `/api/v1/invoices/${c.json.id}/submit`);
  await nw.req('POST', `/api/v1/invoices/${c.json.id}/decision`, { decision: 'accept', undertakingAccepted: true });
  await env.work();
  const cover = (await shree.req('GET', `/api/v1/invoices/${c.json.id}/cover`)).json;
  await uw.req('POST', `/api/v1/insurance/requests/${cover.id}/decision`, { decision: 'approve' });
  return c.json as { id: string; humanId: string };
}
async function toConsent(inv: { id: string }) {
  expect((await shree.req('POST', `/api/v1/invoices/${inv.id}/open-funding`)).json.opened).toBe(true);
  const o = await aurelia.req('POST', `/api/v1/invoices/${inv.id}/offers`, {});
  expect(o.status, JSON.stringify(o.json)).toBe(201);
  const fr = await shree.req('POST', `/api/v1/offers/${o.json.id}/select`);
  expect(fr.status, JSON.stringify(fr.json)).toBe(201);
  return { offerId: o.json.id as string, frId: fr.json.id as string };
}
async function publishBank(patch: Record<string, unknown>) {
  const set = (await rm.req('GET', '/api/v1/terms/sets')).json.items.find((s: any) => Object.keys(s.scope).length === 0);
  const v = await rm.req('POST', `/api/v1/terms/sets/${set.id}/versions`, { body: { ...set.activeVersion.body, ...patch } });
  expect(v.status, JSON.stringify(v.json)).toBe(201);
  expect((await rm.req('POST', `/api/v1/terms/versions/${v.json.id}/submit`, { effectiveFrom: env.clock.now().toISOString() })).status).toBe(204);
  expect((await bankApprover.req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(204);
  return { setId: set.id as string, versionId: v.json.id as string, version: v.json.version as number };
}

describe('terms versions on live invoices, and custom requirements (CT-5, CT-10)', () => {
  it('a funded invoice keeps the terms version it was priced on while a new invoice uses the new one', async () => {
    env.clock.setTo(T0); await logins();
    const inv1 = await accepted();
    const c1 = await toConsent(inv1);
    const before = (await q('select terms_version_ids, advance_pct from marketplace.offers where id = $1', [c1.offerId]))[0];
    await shreeApprover.req('POST', `/api/v1/financing-requests/${c1.frId}/consent`);
    await nw.req('POST', `/api/v1/invoices/${inv1.id}/assignment-ack`);
    env.clock.advanceHours(25); await logins();
    expect((await aurelia.req('POST', `/api/v1/financing-requests/${c1.frId}/confirm`)).status).toBe(200);
    for (let i = 0; i < 20; i++) { await env.work(); if ((await shree.req('GET', `/api/v1/invoices/${inv1.id}`)).json.status === 'Funded') break; env.clock.advanceHours(i % 2 ? 24 : 2); await logins(); }
    expect((await shree.req('GET', `/api/v1/invoices/${inv1.id}`)).json.status).toBe('Funded');

    const pub = await publishBank({ advancePct: 85 });
    expect(pub.version).toBeGreaterThan(1);
    const after1 = (await q('select terms_version_ids, advance_pct from marketplace.offers where id = $1', [c1.offerId]))[0];
    expect(after1.terms_version_ids).toEqual(before.terms_version_ids); expect(Number(after1.advance_pct)).toBe(Number(before.advance_pct));

    const inv2 = await accepted();
    const c2 = await toConsent(inv2);
    const o2 = (await q('select terms_version_ids, advance_pct from marketplace.offers where id = $1', [c2.offerId]))[0];
    expect(o2.terms_version_ids).toContain(pub.versionId); expect(o2.terms_version_ids).not.toContain(before.terms_version_ids.find((x: string) => !o2.terms_version_ids.includes(x)) ?? 'none');
    expect(Number(o2.advance_pct)).toBe(85); expect(Number(before.advance_pct)).toBe(90);
    // the old invoice's financing request still points at the same offer
    expect((await q('select offer_id from marketplace.financing_requests where id = $1', [c1.frId]))[0].offer_id).toBe(c1.offerId);
    await shree.req('POST', `/api/v1/financing-requests/${c2.frId}/cancel`);
  });

  it('a bank can require extra documents and information (CT-10); consent names what is missing; answers reach the bank', async () => {
    env.clock.advanceHours(1); await logins();
    await publishBank({
      requiredDocuments: ['packing_list'],
      customFields: [
        { key: 'purposeOfGoods', label: 'Purpose of the goods', type: 'select', options: ['resale', 'manufacturing'], required: true, appliesTo: 'financing_request' },
        { key: 'poValue', label: 'Purchase order value', type: 'number', required: false, appliesTo: 'financing_request' },
      ],
    });
    const inv = await accepted();
    const c = await toConsent(inv);
    const req = (await shree.req('GET', `/api/v1/financing-requests/${c.frId}/requirements`)).json;
    expect(req.requiredDocuments).toEqual(['packing_list']); expect(req.missingDocuments).toEqual(['packing_list']); expect(req.customFields.map((f: any) => f.key)).toEqual(['purposeOfGoods', 'poValue']);
    const noDoc = await shreeApprover.req('POST', `/api/v1/financing-requests/${c.frId}/consent`, { extra: { purposeOfGoods: 'resale' } });
    expect(noDoc.status).toBe(422); expect(noDoc.json.code).toBe('missing_documents'); expect(noDoc.json.message).toContain('packing list');
    await shree.req('POST', `/api/v1/invoices/${inv.id}/documents`, { docType: 'packing_list', fileId: await upload(shree, 'packing.pdf') });
    const noAns = await shreeApprover.req('POST', `/api/v1/financing-requests/${c.frId}/consent`, { extra: {} });
    expect(noAns.status).toBe(422); expect(noAns.json.code).toBe('missing_information'); expect(noAns.json.message).toContain('Purpose of the goods');
    expect((await shreeApprover.req('POST', `/api/v1/financing-requests/${c.frId}/consent`, { extra: { purposeOfGoods: 'smuggling' } })).status).toBe(422);
    const ok = await shreeApprover.req('POST', `/api/v1/financing-requests/${c.frId}/consent`, { extra: { purposeOfGoods: 'resale', poValue: '120000' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200); expect(ok.json.extra).toEqual({ purposeOfGoods: 'resale', poValue: 120000 });
    expect((await aurelia.req('GET', `/api/v1/financing-requests/${c.frId}`)).json.extra.purposeOfGoods).toBe('resale'); // the bank sees the answers
  });

  it('terms with a malformed custom field are rejected at draft time', async () => {
    const set = (await rm.req('GET', '/api/v1/terms/sets')).json.items.find((s: any) => Object.keys(s.scope).length === 0);
    const bad = (cf: unknown[]) => rm.req('POST', `/api/v1/terms/sets/${set.id}/versions`, { body: { ...set.activeVersion.body, customFields: cf } });
    expect((await bad([{ key: 'Bad Key', label: 'x1', type: 'text', required: true, appliesTo: 'claim' }])).status).toBe(422);
    expect((await bad([{ key: 'pick', label: 'Pick one', type: 'select', required: true, appliesTo: 'claim' }])).status).toBe(422); // select needs options
    expect((await bad([{ key: 'a1', label: 'First', type: 'text', required: false, appliesTo: 'claim' }, { key: 'a1', label: 'Second', type: 'text', required: false, appliesTo: 'claim' }])).status).toBe(422);
  });

  it('an insurer defines claim fields; they are served for the claim form', async () => {
    const set = (await uw.req('GET', '/api/v1/terms/sets')).json.items.find((s: any) => Object.keys(s.scope).length === 0);
    const v = await uw.req('POST', `/api/v1/terms/sets/${set.id}/versions`, { body: { ...set.activeVersion.body, customFields: [{ key: 'insolvencyCourt', label: 'Insolvency court', type: 'text', required: false, appliesTo: 'claim' }] } });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    await uw.req('POST', `/api/v1/terms/versions/${v.json.id}/submit`, { effectiveFrom: env.clock.now().toISOString() });
    expect((await uw.req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(403); // the underwriter prepared it
    expect((await esApprover.req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(204);
    const preview = (await uw.req('POST', '/api/v1/terms/preview', { ownerType: 'insurer', body: { ...set.activeVersion.body } })).json;
    expect(preview.notes.join(' ')).toContain('Claim file must contain');
  });
});
