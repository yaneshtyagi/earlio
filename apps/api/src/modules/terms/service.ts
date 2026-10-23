import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { layerOf, resolve, type Candidate, type Context, type Resolved, type Scope } from './layers';
import { TERMS_SCHEMA_VERSION, validateBody, type OwnerType } from './schema';
import { assertGuardrails } from './guardrails';
import { BANK_TERMS, INSURER_TERMS, PLATFORM_DEFAULT } from './defaults';
import { PLATFORM_DEFAULT as PD } from './defaults';

export interface SetRow { id: string; owner_type: OwnerType; owner_org_id: string | null; name: string; scope: Scope; layer: string; priority: number }
export interface VersionRow {
  id: string; set_id: string; version: number; status: 'draft' | 'pending' | 'active' | 'retired'; effective_from: Date | null; effective_to: Date | null;
  body: Record<string, unknown>; schema_version: number; created_by: string | null; submitted_by: string | null; approved_by: string | null;
}

const normScope = (s: Scope): Scope => ({
  ...(s.buyerOrgId ? { buyerOrgId: s.buyerOrgId } : {}), ...(s.supplierOrgId ? { supplierOrgId: s.supplierOrgId } : {}), ...(s.corridor ? { corridor: s.corridor } : {}),
});

export async function createSet(tx: Tx, svc: Services, ctx: Ctx, a: { ownerType: OwnerType; ownerOrgId: string | null; name: string; scope?: Scope; priority?: number }) {
  const scope = normScope(a.scope ?? {});
  if (a.scope?.corridor && !/^[A-Z]{2}-[A-Z]{2}$/.test(a.scope.corridor)) throw invalid('A corridor looks like IN-US (supplier country - buyer country).');
  if (a.ownerType === 'platform' && Object.keys(scope).length) throw invalid('Platform terms apply to everyone and cannot be scoped.');
  const layer = layerOf(a.ownerType, scope);
  const now = svc.clock.now();
  const row = await tx.one<SetRow>(
    `insert into terms.terms_sets (owner_type, owner_org_id, name, scope, layer, priority, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [a.ownerType, a.ownerOrgId, a.name, JSON.stringify(scope), layer, a.priority ?? 0, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'terms.set_created', entityType: 'terms_set', entityId: row.id, orgId: a.ownerOrgId, after: { name: a.name, layer, scope } });
  return row;
}

async function benchmark(tx: Tx, svc: Services): Promise<number> {
  const r = await resolveTerms(tx, svc.clock.now(), 'platform', null, {});
  return Number(r.terms.benchmarkRatePct ?? PD.benchmarkRatePct);
}

function assertOwns(set: { owner_org_id: string | null }, ctx: Ctx) {
  if (!ctx.platform && set.owner_org_id !== ctx.orgId) throw notFound('Terms set');
}

export async function createVersion(tx: Tx, svc: Services, ctx: Ctx, setId: string, body: unknown, opts: { effectiveFrom?: Date; note?: string } = {}) {
  const set = await tx.maybe<SetRow>('select * from terms.terms_sets where id = $1', [setId]);
  if (!set) throw notFound('Terms set');
  assertOwns(set, ctx);
  const partial = Object.keys(set.scope).length > 0;
  const v = validateBody(set.owner_type, body, partial);
  if (!v.ok) throw new DomainError('invalid_terms', `These terms are not valid: ${v.error}`, 422);
  assertGuardrails(set.owner_type, v.body, await benchmark(tx, svc));
  const now = svc.clock.now();
  const n = await tx.one<{ n: number }>('select coalesce(max(version),0)+1 as n from terms.terms_versions where set_id = $1', [setId]);
  const row = await tx.one<VersionRow>(
    `insert into terms.terms_versions (set_id, version, status, effective_from, body, schema_version, note, created_by, created_at) values ($1,$2,'draft',$3,$4,$5,$6,$7,$8) returning *`,
    [setId, n.n, opts.effectiveFrom ?? null, JSON.stringify(v.body), TERMS_SCHEMA_VERSION, opts.note ?? null, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'terms.version_drafted', entityType: 'terms_version', entityId: row.id, orgId: set.owner_org_id, after: { setId, version: row.version } });
  return row;
}

export async function submitVersion(tx: Tx, svc: Services, ctx: Ctx, versionId: string, effectiveFrom?: Date) {
  const v = await tx.maybe<VersionRow>('select * from terms.terms_versions where id = $1 for update', [versionId]);
  if (!v) throw notFound('Terms version');
  if (v.status !== 'draft') throw conflict('not_draft', `Only a draft can be submitted for approval (this one is ${v.status}).`);
  const eff = effectiveFrom ?? v.effective_from ?? svc.clock.now();
  const set = await tx.one<SetRow>('select * from terms.terms_sets where id = $1', [v.set_id]);
  assertOwns(set, ctx);
  assertGuardrails(set.owner_type, v.body, await benchmark(tx, svc));
  const now = svc.clock.now();
  await tx.query("update terms.terms_versions set status = 'pending', submitted_by = $2, submitted_at = $3, effective_from = $4 where id = $1", [versionId, ctx.userId ?? null, now, eff]);
  await audit(tx, ctx, now, { action: 'terms.version_submitted', entityType: 'terms_version', entityId: versionId, orgId: set.owner_org_id, after: { effectiveFrom: eff } });
  await emit(tx, now, 'terms.version_pending', { versionId, setId: set.id }, set.owner_org_id ? [set.owner_org_id] : []);
}

/** Maker-checker (CT-6): the approver must be a different user from the maker. Effective dates may be in the future. */
export async function approveVersion(tx: Tx, svc: Services, ctx: Ctx, versionId: string) {
  const v = await tx.maybe<VersionRow>('select * from terms.terms_versions where id = $1 for update', [versionId]);
  if (!v) throw notFound('Terms version');
  if (v.status !== 'pending') throw conflict('not_pending', `Only a version awaiting approval can be approved (this one is ${v.status}).`);
  if (v.created_by === ctx.userId || v.submitted_by === ctx.userId) throw forbidden('You prepared these terms, so a different approver must publish them.');
  const set = await tx.one<SetRow>('select * from terms.terms_sets where id = $1', [v.set_id]);
  assertOwns(set, ctx);
  const now = svc.clock.now();
  const from = v.effective_from ?? now;
  const prev = await tx.maybe<VersionRow>("select * from terms.terms_versions where set_id = $1 and status = 'active' and effective_to is null order by version desc limit 1 for update", [v.set_id]);
  if (prev) {
    if (prev.effective_from && from <= prev.effective_from) throw invalid('The new version must take effect after the version it replaces.');
    await tx.query("update terms.terms_versions set effective_to = $2::timestamptz, status = case when $2::timestamptz <= $3::timestamptz then 'retired' else status end where id = $1", [prev.id, from, now]);
  }
  await tx.query("update terms.terms_versions set status = 'active', approved_by = $2, approved_at = $3 where id = $1", [versionId, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'terms.version_published', entityType: 'terms_version', entityId: versionId, orgId: set.owner_org_id, after: { version: v.version, effectiveFrom: from } });
  await emit(tx, now, 'terms.version_published', { versionId, setId: set.id, effectiveFrom: from }, set.owner_org_id ? [set.owner_org_id] : []);
}

/** Retire versions whose effective_to has passed. Called lazily by resolution paths and the worker. */
export async function retireExpired(tx: Tx, svc: Services) {
  await tx.query("update terms.terms_versions set status = 'retired' where status = 'active' and effective_to is not null and effective_to <= $1", [svc.clock.now()]);
}

/** Terms in force at `at` for an owner (bank/insurer) layered over platform defaults. */
export async function resolveTerms(tx: Tx, at: Date, ownerType: OwnerType, ownerOrgId: string | null, ctx: Context): Promise<Resolved> {
  const rows = await tx.elevated(() => tx.query<any>(
    `select s.id as set_id, s.name, s.owner_type, s.scope, s.priority, v.id as version_id, v.version, v.effective_from, v.body
       from terms.terms_sets s join terms.terms_versions v on v.set_id = s.id
      where v.status in ('active','retired') and v.effective_from <= $1 and (v.effective_to is null or v.effective_to > $1)
        and (s.owner_type = 'platform' or ($2::uuid is not null and s.owner_org_id = $2))`, [at, ownerOrgId]));
  const cands: Candidate[] = rows.map((r) => ({
    setId: r.set_id, setName: r.name, versionId: r.version_id, version: r.version, ownerType: r.owner_type, scope: r.scope, priority: r.priority, effectiveFrom: new Date(r.effective_from), body: r.body,
  }));
  void ownerType;
  return resolve(cands, ctx);
}

export const corridorOf = (supplierCountry: string, buyerCountry: string) => `${supplierCountry}-${buyerCountry}`;

/** Seed the platform defaults and the BR-6 / BR-7 term sets (active from 2026-01-01). Idempotent. */
export async function seedTerms(tx: Tx, svc: Services, ids: Record<string, string>) {
  const have = await tx.maybe('select 1 from terms.terms_sets limit 1');
  if (have) return;
  const now = svc.clock.now();
  const eff = new Date('2026-01-01T00:00:00Z');
  const put = async (ownerType: OwnerType, ownerOrgId: string | null, name: string, body: object) => {
    const set = await tx.one<{ id: string }>(
      `insert into terms.terms_sets (owner_type, owner_org_id, name, scope, layer, created_at) values ($1,$2,$3,'{}',$4,$5) returning id`,
      [ownerType, ownerOrgId, name, layerOf(ownerType, {}), now]);
    await tx.query(
      `insert into terms.terms_versions (set_id, version, status, effective_from, body, schema_version, created_at, approved_at) values ($1,1,'active',$2,$3,$4,$5,$5)`,
      [set.id, eff, JSON.stringify(body), TERMS_SCHEMA_VERSION, now]);
  };
  await put('platform', null, 'Earlio platform defaults', PLATFORM_DEFAULT);
  for (const [slug, body] of Object.entries(BANK_TERMS)) if (ids[slug]) await put('bank', ids[slug]!, `${slug[0]!.toUpperCase()}${slug.slice(1)} default terms`, body);
  for (const [slug, body] of Object.entries(INSURER_TERMS)) if (ids[slug]) await put('insurer', ids[slug]!, `${slug[0]!.toUpperCase()}${slug.slice(1)} default terms`, body);
}

void validateBody;

import { evaluateOffer, type OfferEvaluation } from './evaluate';
import { SAMPLE_INVOICES } from './samples';

export interface SimulationRow {
  sampleId: string; label: string; before: { eligible: boolean; reasons: string[]; netCash?: string; allInPct?: string };
  after: { eligible: boolean; reasons: string[]; netCash?: string; allInPct?: string }; changed: boolean;
}
const brief = (e: OfferEvaluation) => ({ eligible: e.eligible, reasons: e.reasons, netCash: e.quote?.breakdown.netCash, allInPct: e.quote?.breakdown.allInAnnualisedPct });

/** Run a draft bank terms body against the 20 samples and compare with what is active now (CT-9). */
export async function simulateBankTerms(tx: Tx, svc: Services, bankOrgId: string, draftBody: Record<string, unknown>): Promise<SimulationRow[]> {
  const now = svc.clock.now();
  const platform = await resolveTerms(tx, now, 'platform', null, {});
  const active = await resolveTerms(tx, now, 'bank', bankOrgId, {});
  const insurerOrg = await tx.elevated(() => tx.maybe<{ id: string }>("select id from identity.organisations where type = 'insurer' order by created_at limit 1"));
  const insurer = insurerOrg ? (await resolveTerms(tx, now, 'insurer', insurerOrg.id, {})).terms : null;
  const mids = { USDINR: await svc.adapters.fx.mid('USDINR', now), SGDINR: await svc.adapters.fx.mid('SGDINR', now) };
  const draft = { ...active.terms, ...draftBody };
  return SAMPLE_INVOICES.map((s) => {
    const mk = (bank: Record<string, any>) => evaluateOffer({
      now, invoice: { amount: s.amount, currency: s.currency, tenorDays: s.tenorDays, goods: s.goods }, buyer: { country: s.buyerCountry, tier: s.buyerTier },
      supplier: { country: 'IN', small: s.supplierSmall }, bank, insurer, platform: platform.terms, mids, termsVersionIds: active.versionIds,
    });
    const before = brief(mk(active.terms)), after = brief(mk(draft));
    return { sampleId: s.id, label: s.label, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
  });
}
