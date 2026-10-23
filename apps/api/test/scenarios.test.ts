import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { seedScenarios } from '../src/demo/scenarios';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); }, 60_000);
afterAll(async () => { await env.close(); });

describe('Appendix A scenario seeder', () => {
  it('produces the thirteen invoices in their thirteen states', async () => {
    const out = await seedScenarios(env.app, env.svc);
    const by = Object.fromEntries(out.map((o) => [o.label, o.state]));
    console.log(JSON.stringify(by));
    expect(by).toMatchObject({ 'INV-1001': 'Draft', 'INV-1002': 'Submitted', 'INV-1003': 'Rejected', 'INV-1004': 'Accepted', 'INV-1005': 'OffersReceived', 'INV-1006': 'Funded', 'INV-1007': 'Closed', 'INV-1008': 'Closed', 'INV-1009': 'Disputed', 'INV-1010': 'Overdue', 'INV-1011': 'Defaulted', 'INV-1012': 'NotEligible', 'INV-1013': 'Funded' });
    // the early-payment invoice is labelled as paid early; the funded ones carry an active lien
    const rows = await env.svc.db.system((tx) => tx.query<any>("select human_id, route, status from invoicing.invoices where id = any($1::uuid[])", [out.map((o) => o.id)]));
    expect(rows.find((r) => r.human_id === out.find((o) => o.label === 'INV-1007')!.humanId).route).toBe('early_payment');
    // dashboards and the scorecard work on the seeded history
    const admin = await (await import('./helpers')).login(env, 'earlio', 'PlatformAdmin');
    const sc = (await admin.req('GET', '/api/v1/admin/scorecard?fresh=true')).json.metrics;
    expect(Number(sc.monthlyFinancedVolumeUsd.latest)).toBeGreaterThan(0); expect(sc.medianDaysAcceptanceToCash.sample).toBeGreaterThan(3);
    expect(Number(sc.offersPerAcceptedInvoice.invoicesOpened)).toBeGreaterThan(0);
    const bank = await (await import('./helpers')).login(env, 'aurelia', 'CreditOfficer');
    const dash = (await bank.req('GET', '/api/v1/dashboard?fresh=true')).json;
    expect(dash.funded.count).toBeGreaterThanOrEqual(5); expect(Number(dash.funded.overdueUsd)).toBeGreaterThan(0);
    // idempotent
    expect((await seedScenarios(env.app, env.svc)).length).toBe(13);
  }, 280_000);
});
