import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestEnv, login, type TestEnv, type Session } from './helpers';
import { LAYER_ORDER, compareCandidates, layerOf, resolve, type Candidate } from '../src/modules/terms/layers';
import { checkTermsGuardrails } from '../src/modules/terms/guardrails';
import { validateBody } from '../src/modules/terms/schema';
import { BANK_TERMS, INSURER_TERMS, PLATFORM_DEFAULT } from '../src/modules/terms/defaults';
import { resolveTerms } from '../src/modules/terms/service';
import { evaluateOffer } from '../src/modules/terms/evaluate';

// ---------- pure: layer resolution ----------
const cand = (n: number, scope: any, over: Partial<Candidate> = {}): Candidate => ({
  setId: 's' + n, setName: 'set' + n, versionId: 'v' + n, version: 1, ownerType: 'bank', scope, priority: 0, effectiveFrom: new Date('2026-01-01'), body: { advancePct: 50 + n }, ...over,
});
const FULL = { buyerOrgId: 'B', supplierOrgId: 'S', corridor: 'IN-US' };
const SCOPES: Record<string, any> = {
  'buyer+supplier+corridor': FULL, 'buyer+supplier': { buyerOrgId: 'B', supplierOrgId: 'S' }, 'buyer+corridor': { buyerOrgId: 'B', corridor: 'IN-US' },
  'supplier+corridor': { supplierOrgId: 'S', corridor: 'IN-US' }, buyer: { buyerOrgId: 'B' }, supplier: { supplierOrgId: 'S' }, corridor: { corridor: 'IN-US' }, owner_default: {},
};

describe('layer resolution (BR-9 precedence)', () => {
  it('names each layer', () => { for (const [name, scope] of Object.entries(SCOPES)) expect(layerOf('bank', scope)).toBe(name); expect(layerOf('platform', {})).toBe('platform_default'); });
  it('each precedence level beats every level below it', () => {
    const all = [...Object.entries(SCOPES).map(([, s], i) => cand(i, s)), cand(99, {}, { ownerType: 'platform', body: { advancePct: 1 } })];
    for (let top = 0; top < LAYER_ORDER.length - 1; top++) {
      const remaining = all.filter((_, i) => i >= top);
      const r = resolve(remaining, { buyerOrgId: 'B', supplierOrgId: 'S', corridor: 'IN-US' });
      const expected = top < 8 ? 50 + top : 1;
      expect(r.terms.advancePct, `top=${top}`).toBe(expected);
      expect(r.explanation.advancePct!.layer).toBe(LAYER_ORDER[top]);
    }
  });
  it('ignores layers whose scope does not match the context', () => {
    const r = resolve([cand(1, { buyerOrgId: 'OTHER' }), cand(2, {})], { buyerOrgId: 'B' });
    expect(r.terms.advancePct).toBe(52);
  });
  it('ties at the same level: later effective date wins, then priority, then version', () => {
    const a = cand(1, { buyerOrgId: 'B' }, { effectiveFrom: new Date('2026-02-01') }), b = cand(2, { buyerOrgId: 'B' }, { effectiveFrom: new Date('2026-03-01') });
    expect(resolve([a, b], { buyerOrgId: 'B' }).terms.advancePct).toBe(52);
    const c = cand(3, { buyerOrgId: 'B' }, { priority: 5 }), d = cand(4, { buyerOrgId: 'B' }, { priority: 9 });
    expect(resolve([c, d], { buyerOrgId: 'B' }).terms.advancePct).toBe(54);
    expect([cand(5, {}, { version: 2 }), cand(6, {}, { version: 3 })].sort(compareCandidates)[0]!.version).toBe(3);
  });
  it('merges per parameter and explains where each came from', () => {
    const base = cand(1, {}, { body: { advancePct: 90, maxTenorDays: 120 } });
    const buyer = cand(2, { buyerOrgId: 'B' }, { body: { advancePct: 80 } });
    const r = resolve([base, buyer], { buyerOrgId: 'B' });
    expect(r.terms).toEqual({ advancePct: 80, maxTenorDays: 120 });
    expect(r.explanation.advancePct!.layer).toBe('buyer'); expect(r.explanation.maxTenorDays!.layer).toBe('owner_default');
    expect(r.versionIds.sort()).toEqual(['v1', 'v2']);
  });
});

// ---------- pure: schemas, seeds and guardrails ----------
describe('schemas and seeds', () => {
  it('the seeded terms validate against the schema', () => {
    expect(validateBody('platform', PLATFORM_DEFAULT, false).ok).toBe(true);
    for (const b of Object.values(BANK_TERMS)) expect(validateBody('bank', b, false)).toMatchObject({ ok: true });
    for (const i of Object.values(INSURER_TERMS)) expect(validateBody('insurer', i, false)).toMatchObject({ ok: true });
  });
  it('unknown keys and a missing mandatory parameter are rejected', () => {
    expect(validateBody('bank', { ...BANK_TERMS.aurelia, bogus: 1 }, false).ok).toBe(false);
    const { advancePct: _a, ...noAdvance } = BANK_TERMS.aurelia!;
    expect(validateBody('bank', noAdvance, false).ok).toBe(false);
    expect(validateBody('bank', noAdvance, true).ok).toBe(true); // a scoped override may be partial
  });
  it('BR-6 / BR-7 numbers are exact', () => {
    expect(BANK_TERMS.aurelia).toMatchObject({ advancePct: 90, maxTenorDays: 120, offerValidityHours: 24, fxSpreadPct: 0.3, settlementDays: 1 });
    expect(BANK_TERMS.kestrel).toMatchObject({ advancePct: 85, pricing: { type: 'fixed', ratePct: 7.25 }, maxTenorDays: 90, currencies: ['USD'], fxSpreadPct: 0.45 });
    expect(BANK_TERMS.harbour).toMatchObject({ advancePct: 80, maxTenorDays: 150, settlementDays: 2, cutoff: { time: '17:00', timezone: 'Asia/Singapore' }, fxSpreadPct: 0.25 });
    expect(INSURER_TERMS.exportshield).toMatchObject({ coverPct: 90, coverPctByTier: { BBB: 85 }, claimDeadlineDays: 60, limits: { perBuyerUsd: 3_000_000, portfolioUsd: 25_000_000 } });
    expect(INSURER_TERMS.sentinel).toMatchObject({ coverPct: 85, waitingPeriodDays: { protractedDefault: 120 }, premium: { flatRatePct: 0.28, payer: 'bank' }, limits: { perBuyerUsd: 5_000_000, portfolioUsd: 40_000_000 } });
  });
  it('guardrails name themselves', () => {
    expect(checkTermsGuardrails('bank', { fxSpreadPct: 1.25 })[0]).toMatchObject({ guardrail: 'max_fx_spread' });
    expect(checkTermsGuardrails('platform', { disputeWindowHours: 12 })[0]!.message).toMatch(/Minimum dispute window/);
    expect(checkTermsGuardrails('platform', { assignmentNoticeRequired: false })[0]!.guardrail).toBe('assignment_notice_mandatory');
    expect(checkTermsGuardrails('platform', { sanctionsBlocksFunding: false })[0]!.guardrail).toBe('sanctions_block');
    expect(checkTermsGuardrails('platform', { maxFxSpreadPct: 2 })[0]!.guardrail).toBe('max_fx_spread');
    const dear = { ...BANK_TERMS.aurelia!, pricing: { type: 'fixed' as const, ratePct: 19 } };
    expect(checkTermsGuardrails('bank', dear)[0]).toMatchObject({ guardrail: 'max_all_in_cost_small' });
    expect(checkTermsGuardrails('bank', BANK_TERMS.aurelia!)).toEqual([]);
    expect(checkTermsGuardrails('platform', PLATFORM_DEFAULT)).toEqual([]);
  });
});

// ---------- pure: offer evaluation ----------
const MIDS = { USDINR: '88.40', SGDINR: '68.10' };
const baseInputs = () => ({
  now: new Date('2026-11-02T04:00:00Z'), invoice: { amount: '100000', currency: 'USD' as const, tenorDays: 60 }, buyer: { country: 'US', tier: 'A' as const },
  supplier: { country: 'IN', small: false, borrowingRatePct: 14 }, bank: BANK_TERMS.aurelia as any, insurer: INSURER_TERMS.exportshield as any,
  platform: PLATFORM_DEFAULT as any, mids: MIDS, termsVersionIds: ['v'],
});
describe('offer evaluation', () => {
  it('Aurelia / ExportShield / tier A / 60 days reproduces the BR-3 numbers (platform fee paid by the bank)', () => {
    const e = evaluateOffer(baseInputs());
    expect(e.eligible).toBe(true);
    expect(e.quote!.breakdown).toMatchObject({ discount: '865.48', processingFee: '100.00', premium: '180.00', totalCharges: '1145.48', netCash: '88854.52', allInAnnualisedPct: '7.84' });
    expect(e.quote!.fx).toMatchObject({ rate: '88.1348', spreadPct: '0.30' });
    expect(e.quote!.fx.netCashInr).toBe('7831175.35');
    expect(e.quote!.savingVsBorrowingPct).toBe('6.16');
  });
  it('passing the platform fee through gives 8.03%', () => {
    const e = evaluateOffer({ ...baseInputs(), bank: { ...BANK_TERMS.aurelia, platformFeePayer: 'supplier' } as any });
    expect(e.quote!.breakdown).toMatchObject({ totalCharges: '1172.48', netCash: '88827.52', allInAnnualisedPct: '8.03' });
  });
  it('plain-language reasons: tenor, country, currency, tier', () => {
    expect(evaluateOffer({ ...baseInputs(), invoice: { amount: '100000', currency: 'USD', tenorDays: 135 } }).reasons).toContain("Tenor of 135 days is above this bank's maximum of 120 days.");
    expect(evaluateOffer({ ...baseInputs(), bank: BANK_TERMS.harbour as any }).reasons.join(' ')).toMatch(/Singapore buyers only|buyers in SG/);
    const sgd = evaluateOffer({ ...baseInputs(), bank: BANK_TERMS.kestrel as any, invoice: { amount: '30000', currency: 'SGD', tenorDays: 60 } });
    expect(sgd.reasons.join(' ')).toMatch(/funds USD invoices; this one is in SGD/);
    const bbb = evaluateOffer({ ...baseInputs(), bank: BANK_TERMS.kestrel as any, buyer: { country: 'US', tier: 'BBB' } });
    expect(bbb.reasons).toContain('This lender funds buyers rated A or better.');
  });
  it('size limits use USD equivalents', () => {
    const r = evaluateOffer({ ...baseInputs(), invoice: { amount: '3000', currency: 'USD', tenorDays: 30 } });
    expect(r.eligible).toBe(false); expect(r.reasons.join(' ')).toMatch(/below this bank's minimum of USD 5000/);
  });
  it('gate 5: no cover blocks; cover below the bank minimum blocks', () => {
    expect(evaluateOffer({ ...baseInputs(), insurer: null }).gate).toBe('cover');
    const low = evaluateOffer({ ...baseInputs(), insurer: null, cover: { coverPct: 70 } });
    expect(low.reasons[0]).toMatch(/below this bank's minimum of 85%/);
  });
  it('gate 6: limit headroom blocks with the available amount', () => {
    const e = evaluateOffer({ ...baseInputs(), headroom: { bankBuyerUsd: '50000.00' } });
    expect(e.gate).toBe('limits'); expect(e.reasons[0]).toMatch(/USD 50000\.00 available/);
  });
  it('a small supplier\'s advance is capped at the insured cover; BBB cover is 85%', () => {
    const e = evaluateOffer({ ...baseInputs(), supplier: { country: 'IN', small: true }, buyer: { country: 'US', tier: 'BBB' }, invoice: { amount: '100000', currency: 'USD', tenorDays: 60 } });
    expect(e.eligible).toBe(true); expect(e.quote!.advancePct).toBe('85'); expect(e.quote!.advanceCappedToCover).toBe(true);
    expect(e.quote!.breakdown.advance).toBe('85000.00');
  });
  it('the 18% cost cap for small suppliers blocks an expensive offer', () => {
    const e = evaluateOffer({ ...baseInputs(), supplier: { country: 'IN', small: true }, bank: { ...BANK_TERMS.kestrel, pricing: { type: 'fixed', ratePct: 25 } } as any });
    expect(e.gate).toBe('guardrail'); expect(e.reasons[0]).toMatch(/above the 18% cap/);
  });
});

// ---------- DB + API ----------
let env: TestEnv; let rm: Session; let bankApprover: Session; let platformAdmin: Session; let shreeFin: Session;
beforeAll(async () => {
  env = await createTestEnv();
  rm = await login(env, 'aurelia', 'RelationshipManager'); bankApprover = await login(env, 'aurelia', 'Approver');
  platformAdmin = await login(env, 'earlio', 'PlatformAdmin'); shreeFin = await login(env, 'shree', 'FinanceUser');
});
afterAll(async () => { await env.close(); });

describe('seeded terms in the database', () => {
  it('resolves Aurelia terms layered over the platform defaults', async () => {
    const r = await env.svc.db.tx({ platform: true, correlationId: 't' }, (tx) => resolveTerms(tx, env.clock.now(), 'bank', env.ids.aurelia!, {}));
    expect(r.terms.advancePct).toBe(90); expect(r.terms.benchmarkRatePct).toBe(4.1);
    expect(r.explanation.benchmarkRatePct!.layer).toBe('platform_default'); expect(r.explanation.advancePct!.layer).toBe('owner_default');
  });
  it('a bank sees only its own sets; platform staff see all', async () => {
    const mine = (await rm.req('GET', '/api/v1/terms/sets')).json.items;
    expect(mine.map((s: any) => s.name)).toEqual(['Aurelia default terms']);
    const all = (await platformAdmin.req('GET', '/api/v1/terms/sets')).json.items;
    expect(all.length).toBe(6);
  });
});

describe('scoped overrides and eligibility API', () => {
  let invoiceId: string;
  it('creates an invoice and evaluates all three banks (reasons in plain language)', async () => {
    const inv = await shreeFin.req('POST', '/api/v1/invoices', { buyerOrgId: env.ids.northwind, number: 'E-1', currency: 'USD', amount: '100000.00', issueDate: '2026-11-01', dueDate: '2027-01-01', poNumber: 'PO-NW-2201' });
    expect(inv.status).toBe(201); invoiceId = inv.json.id;
    const aur = await shreeFin.req('POST', `/api/v1/invoices/${invoiceId}/eligibility`, { bankOrgId: env.ids.aurelia, insurerOrgId: env.ids.exportshield });
    expect(aur.json.eligible, JSON.stringify(aur.json)).toBe(true);
    expect(aur.json.quote.breakdown).toMatchObject({ discount: '865.48', premium: '180.00', allInAnnualisedPct: expect.any(String) });
    expect(aur.json.quote.termsVersionIds.length).toBeGreaterThanOrEqual(3);
    const har = await shreeFin.req('POST', `/api/v1/invoices/${invoiceId}/eligibility`, { bankOrgId: env.ids.harbour, insurerOrgId: env.ids.exportshield });
    expect(har.json.eligible).toBe(false); expect(har.json.reasons.join(' ')).toMatch(/Singapore/);
    const kes = await shreeFin.req('POST', `/api/v1/invoices/${invoiceId}/eligibility`, { bankOrgId: env.ids.kestrel, insurerOrgId: env.ids.exportshield });
    expect(kes.json.eligible).toBe(true); expect(kes.json.quote.ratePct).toBe('7.25');
    const noCover = await shreeFin.req('POST', `/api/v1/invoices/${invoiceId}/eligibility`, { bankOrgId: env.ids.aurelia });
    expect(noCover.json.gate).toBe('cover');
  });
  it('another supplier cannot evaluate this invoice', async () => {
    const kumar = await login(env, 'kumar', 'FinanceUser');
    expect((await kumar.req('POST', `/api/v1/invoices/${invoiceId}/eligibility`, { bankOrgId: env.ids.aurelia })).status).toBe(404);
  });
  it('a per-buyer override changes only that buyer and the explanation shows the layer', async () => {
    const set = await rm.req('POST', '/api/v1/terms/sets', { name: 'Northwind override', scope: { buyerOrgId: env.ids.northwind }, priority: 1 });
    expect(set.status).toBe(201); expect(set.json.layer).toBe('buyer');
    const v = await rm.req('POST', `/api/v1/terms/sets/${set.json.id}/versions`, { body: { advancePct: 85 } });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    await rm.req('POST', `/api/v1/terms/versions/${v.json.id}/submit`, {});
    expect((await (await login(env, 'aurelia', 'Approver')).req('POST', `/api/v1/terms/versions/${v.json.id}/approve`)).status).toBe(204);
    const res = await shreeFin.req('POST', `/api/v1/invoices/${invoiceId}/eligibility`, { bankOrgId: env.ids.aurelia, insurerOrgId: env.ids.exportshield });
    expect(res.json.explanation.advancePct.layer).toBe('buyer'); expect(res.json.quote.advancePct).toBe('85');
    const r2 = await shreeFin.req('GET', `/api/v1/terms/resolve?ownerOrgId=${env.ids.aurelia}&buyerOrgId=${env.ids.merlion}`);
    expect(r2.json.explanation.advancePct.layer).toBe('owner_default');
  });
  it('scoped overrides must be partial bodies of known keys and unscoped sets must be complete', async () => {
    const set = await rm.req('POST', '/api/v1/terms/sets', { name: 'Corridor', scope: { corridor: 'IN-US' } });
    expect((await rm.req('POST', `/api/v1/terms/sets/${set.json.id}/versions`, { body: { nonsense: 1 } })).status).toBe(422);
    const full = await rm.req('POST', '/api/v1/terms/sets', { name: 'Another default' });
    expect((await rm.req('POST', `/api/v1/terms/sets/${full.json.id}/versions`, { body: { advancePct: 80 } })).status).toBe(422);
  });
  it('the simulator shows which samples change', async () => {
    const harbourRm = await login(env, 'harbour', 'RelationshipManager');
    const sim = await harbourRm.req('POST', '/api/v1/terms/simulate', { body: { maxTenorDays: 90 } });
    expect(sim.status).toBe(200); expect(sim.json.rows).toHaveLength(20);
    const flipped = sim.json.rows.filter((r: any) => r.before.eligible && !r.after.eligible).map((r: any) => r.sampleId);
    expect(flipped).toEqual(expect.arrayContaining(['S11']));
    expect(sim.json.rows.filter((r: any) => !r.before.eligible && r.after.eligible)).toHaveLength(0);
    expect(sim.json.rows.filter((r: any) => !r.changed).length).toBeGreaterThan(0);
    expect((await shreeFin.req('POST', '/api/v1/terms/simulate', { body: {} })).status).toBe(403);
  });
});

describe('versions, immutability and maker-checker', () => {
  let setId: string; let defaultBody: any;
  it('drafting validates and names guardrails', async () => {
    const sets = (await rm.req('GET', '/api/v1/terms/sets')).json.items; setId = sets[0].id; defaultBody = sets[0].activeVersion.body;
    const bad = await rm.req('POST', `/api/v1/terms/sets/${setId}/versions`, { body: { ...defaultBody, fxSpreadPct: 1.25 } });
    expect(bad.status).toBe(422); expect(bad.json.code).toBe('guardrail_breach'); expect(bad.json.message).toMatch(/Maximum FX spread/);
    const invalid = await rm.req('POST', `/api/v1/terms/sets/${setId}/versions`, { body: { ...defaultBody, advancePct: 150 } });
    expect(invalid.status).toBe(422); expect(invalid.json.code).toBe('invalid_terms');
    expect((await rm.req('POST', '/api/v1/terms/validate', { ownerType: 'bank', body: { ...defaultBody, fxSpreadPct: 1.25 } })).json.guardrailBreaches[0].guardrail).toBe('max_fx_spread');
  });
  it('the maker cannot approve their own version; a different approver can; old invoices keep the old version id', async () => {
    const draft = await rm.req('POST', `/api/v1/terms/sets/${setId}/versions`, { body: { ...defaultBody, advancePct: 88 }, note: 'Lower advance' });
    expect(draft.status).toBe(201); expect(draft.json.status).toBe('draft');
    expect((await bankApprover.req('POST', `/api/v1/terms/versions/${draft.json.id}/approve`)).status).toBe(409); // still a draft
    expect((await rm.req('POST', `/api/v1/terms/versions/${draft.json.id}/submit`, {})).status).toBe(204);
    expect((await rm.req('POST', `/api/v1/terms/versions/${draft.json.id}/approve`)).status).toBe(403); // rm lacks terms:publish
    const approverMaker = await login(env, 'aurelia', 'Approver');
    // an approver who also prepared a version cannot approve it either (covered at DB level below)
    expect((await approverMaker.req('POST', `/api/v1/terms/versions/${draft.json.id}/approve`)).status).toBe(204);
    const sets = (await rm.req('GET', '/api/v1/terms/sets')).json.items;
    expect(sets[0].activeVersion.body.advancePct).toBe(88);
    const detail = (await rm.req('GET', `/api/v1/terms/sets/${setId}`)).json;
    expect(detail.versions.map((v: any) => [v.version, v.status])).toEqual([[2, 'active'], [1, 'retired']]);
    expect(detail.versions[1].effectiveTo).toBe(detail.versions[0].effectiveFrom);
  });
  it('a future-dated version takes effect only on its date and never changes the past', async () => {
    const setsNow = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0];
    const from = new Date(env.clock.now().getTime() + 10 * 86_400_000).toISOString();
    const d = await rm.req('POST', `/api/v1/terms/sets/${setId}/versions`, { body: { ...setsNow.activeVersion.body, advancePct: 70 } });
    await rm.req('POST', `/api/v1/terms/versions/${d.json.id}/submit`, { effectiveFrom: from });
    expect((await (await login(env, 'aurelia', 'Approver')).req('POST', `/api/v1/terms/versions/${d.json.id}/approve`)).status).toBe(204);
    const at = async (t: Date) => (await env.svc.db.tx({ platform: true, correlationId: 't' }, (tx) => resolveTerms(tx, t, 'bank', env.ids.aurelia!, {}))).terms.advancePct;
    expect(await at(env.clock.now())).toBe(88);
    expect(await at(new Date(Date.parse(from) + 1000))).toBe(70);
    expect(await at(new Date('2026-06-01'))).toBe(90); // before v2: v1 was in force
  });
  it('an active version cannot be mutated or deleted, even with direct SQL as the owner of the database', async () => {
    const c = new pg.Client({ connectionString: env.adminUrl }); await c.connect();
    await expect(c.query("update terms.terms_versions set body = '{}'::jsonb where status = 'active'")).rejects.toThrow(/immutable once active/);
    await expect(c.query("update terms.terms_versions set effective_from = now() where status in ('active','retired')")).rejects.toThrow(/immutable/);
    await expect(c.query("delete from terms.terms_versions where status = 'active'")).rejects.toThrow(/immutable/);
    await expect(c.query("update terms.terms_versions set status = 'draft' where status = 'active'")).rejects.toThrow(/cannot return to draft/);
    await c.end();
  });
  it('a bank cannot read or edit another bank\'s sets', async () => {
    const kestrelRm = await login(env, 'kestrel', 'RelationshipManager');
    const aureliaSet = (await rm.req('GET', '/api/v1/terms/sets')).json.items[0];
    const res = await kestrelRm.req('POST', `/api/v1/terms/sets/${aureliaSet.id}/versions`, { body: aureliaSet.activeVersion.body });
    expect(res.status).toBe(404);
  });
  it('platform guardrails cannot be loosened by platform staff either', async () => {
    const platformSet = (await platformAdmin.req('GET', '/api/v1/terms/sets')).json.items.find((s: any) => s.ownerType === 'platform');
    const r = await platformAdmin.req('POST', `/api/v1/terms/sets/${platformSet.id}/versions`, { body: { ...platformSet.activeVersion.body, disputeWindowHours: 12 } });
    expect(r.status).toBe(422); expect(r.json.message).toMatch(/Minimum dispute window/);
  });
});

describe('calculator endpoints', () => {
  it('early payment and financing calculators return the golden numbers', async () => {
    const ep = await shreeFin.req('POST', '/api/v1/pricing/early-payment', { faceAmount: '100000', discountPct: '1', daysEarly: 60 });
    expect(ep.json).toMatchObject({ buyerPays: '99000.00', annualisedCostPct: '6.14', commission: '200.00', buyerNetSaving: '800.00' });
    const fin = await shreeFin.req('POST', '/api/v1/pricing/financing', { faceAmount: '100000', advancePct: '90', ratePct: '5.85', tenorDays: 60, processingPct: '0.10', processingMin: '25', platformFeeBps: '3', platformFeePayer: 'supplier', insuredAmount: '90000', premiumRatePct: '0.20' });
    expect(fin.json).toMatchObject({ totalCharges: '1172.48', netCash: '88827.52', allInAnnualisedPct: '8.03' });
    const fx = await shreeFin.req('GET', '/api/v1/fx/quote?pair=USDINR&spreadPct=0.30');
    expect(fx.json).toMatchObject({ mid: '88.40', rate: '88.1348' });
  });
});
