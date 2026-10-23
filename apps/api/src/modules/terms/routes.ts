import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePerm, requireUser, platformCtx } from '../../http/context';
import { DomainError, forbidden, invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { isPlatformRole } from '../identity/permissions';
import { loadInvoice } from '../invoicing/service';
import { priceEarlyPayment } from '../pricing/early-payment';
import { priceFinancing, premiumFor } from '../pricing/financing';
import { daysBetween } from '../pricing/calendar';
import { checkTermsGuardrails } from './guardrails';
import { jsonSchemaFor, validateBody } from './schema';
import { approveVersion, corridorOf, createSet, createVersion, resolveTerms, simulateBankTerms, submitVersion, retireExpired } from './service';
import { evaluateOffer } from './evaluate';

const ownerEnum = z.enum(['platform', 'bank', 'insurer']);
const scopeSchema = z.object({ buyerOrgId: z.string().uuid().optional(), supplierOrgId: z.string().uuid().optional(), corridor: z.string().optional() });
const versionOut = z.object({
  id: z.string(), version: z.number(), status: z.enum(['draft', 'pending', 'active', 'retired']), effectiveFrom: z.string().nullable(), effectiveTo: z.string().nullable(),
  body: z.record(z.string(), z.any()), createdBy: z.string().nullable(), approvedBy: z.string().nullable(), note: z.string().nullable(),
});
const setOut = z.object({ id: z.string(), ownerType: ownerEnum, ownerOrgId: z.string().nullable(), ownerName: z.string().nullable(), name: z.string(), layer: z.string(), scope: scopeSchema, priority: z.number() });
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
const toVersion = (v: any) => ({ id: v.id, version: v.version, status: v.status, effectiveFrom: iso(v.effective_from), effectiveTo: iso(v.effective_to), body: v.body, createdBy: v.created_by, approvedBy: v.approved_by, note: v.note });
const toSet = (s: any) => ({ id: s.id, ownerType: s.owner_type, ownerOrgId: s.owner_org_id, ownerName: s.owner_name ?? null, name: s.name, layer: s.layer, scope: s.scope, priority: s.priority });

export function termsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const ctxFor = (req: any) => (isPlatformRole(req.auth?.role) ? platformCtx(req) : req.ctx);

  r.get('/api/v1/terms/schema/:owner', {
    preHandler: requireUser,
    schema: { tags: ['terms'], summary: 'JSON Schema for a terms body (for editors and import/export)', params: z.object({ owner: ownerEnum }), response: { 200: z.record(z.string(), z.any()) } },
  }, async (req) => jsonSchemaFor(req.params.owner) as Record<string, any>);

  r.get('/api/v1/terms/sets', {
    preHandler: requirePerm('read'),
    schema: { tags: ['terms'], summary: 'Terms sets I own (platform staff see all); includes the active version', response: { 200: z.object({ items: z.array(setOut.extend({ activeVersion: versionOut.nullable(), latestVersion: z.number() })) }) } },
  }, async (req) => svc.db.tx(ctxFor(req), async (tx) => {
    await retireExpired(tx, svc);
    const sets = await tx.query<any>(
      `select s.*, o.legal_name as owner_name from terms.terms_sets s left join identity.organisations o on o.id = s.owner_org_id
        where ($1::boolean or s.owner_org_id = $2) order by s.owner_type, o.legal_name, s.created_at`, [isPlatformRole(req.auth!.role!), req.auth!.orgId]);
    const items = [];
    for (const s of sets) {
      const act = await tx.maybe<any>(`select * from terms.terms_versions where set_id = $1 and status = 'active' and effective_from <= $2 order by version desc limit 1`, [s.id, svc.clock.now()]);
      const latest = await tx.one<{ n: number }>('select coalesce(max(version),0) as n from terms.terms_versions where set_id = $1', [s.id]);
      items.push({ ...toSet(s), activeVersion: act ? toVersion(act) : null, latestVersion: latest.n });
    }
    return { items };
  }));

  r.get('/api/v1/terms/sets/:id', {
    preHandler: requirePerm('read'),
    schema: { tags: ['terms'], summary: 'A terms set with all visible versions', params: z.object({ id: z.string().uuid() }), response: { 200: setOut.extend({ versions: z.array(versionOut) }) } },
  }, async (req) => svc.db.tx(ctxFor(req), async (tx) => {
    const s = await tx.maybe<any>('select s.*, o.legal_name as owner_name from terms.terms_sets s left join identity.organisations o on o.id = s.owner_org_id where s.id = $1', [req.params.id]);
    if (!s) throw notFound('Terms set');
    const vs = await tx.query<any>('select * from terms.terms_versions where set_id = $1 order by version desc', [s.id]);
    return { ...toSet(s), versions: vs.map(toVersion) };
  }));

  const editor = async (req: any, reply: any) => { await requirePerm('terms:edit')(req, reply); };

  r.post('/api/v1/terms/sets', {
    preHandler: editor,
    schema: { tags: ['terms'], summary: 'Create a terms set (default or a scoped override)', body: z.object({ name: z.string().min(2).max(120), scope: scopeSchema.optional(), priority: z.number().int().min(0).max(1000).optional() }), response: { 201: setOut } },
  }, async (req, reply) => {
    const type = req.auth!.orgType;
    if (type !== 'bank' && type !== 'insurer' && type !== 'platform') throw forbidden('Only banks, insurers and platform staff manage terms.');
    const set = await svc.db.tx(ctxFor(req), (tx) => createSet(tx, svc, ctxFor(req), { ownerType: type, ownerOrgId: type === 'platform' ? null : req.auth!.orgId!, name: req.body.name, scope: req.body.scope, priority: req.body.priority }));
    return reply.code(201).send(toSet(set));
  });

  r.post('/api/v1/terms/sets/:id/versions', {
    preHandler: editor,
    schema: { tags: ['terms'], summary: 'Draft a new version (validated against the schema and the platform guardrails)', params: z.object({ id: z.string().uuid() }),
      body: z.object({ body: z.record(z.string(), z.any()), effectiveFrom: z.string().datetime().optional(), note: z.string().max(500).optional() }), response: { 201: versionOut } },
  }, async (req, reply) => {
    const v = await svc.db.tx(ctxFor(req), (tx) => createVersion(tx, svc, ctxFor(req), req.params.id, req.body.body, { effectiveFrom: req.body.effectiveFrom ? new Date(req.body.effectiveFrom) : undefined, note: req.body.note }));
    return reply.code(201).send(toVersion(v));
  });

  r.post('/api/v1/terms/versions/:id/submit', {
    preHandler: editor,
    schema: { tags: ['terms'], summary: 'Submit a draft for approval (maker)', params: z.object({ id: z.string().uuid() }), body: z.object({ effectiveFrom: z.string().datetime().optional() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(ctxFor(req), (tx) => submitVersion(tx, svc, ctxFor(req), req.params.id, req.body.effectiveFrom ? new Date(req.body.effectiveFrom) : undefined)); return reply.code(204).send(); });

  r.post('/api/v1/terms/versions/:id/approve', {
    preHandler: requirePerm('terms:publish'),
    schema: { tags: ['terms'], summary: 'Approve and publish a pending version (checker, must differ from the maker)', params: z.object({ id: z.string().uuid() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(ctxFor(req), (tx) => approveVersion(tx, svc, ctxFor(req), req.params.id)); return reply.code(204).send(); });

  r.post('/api/v1/terms/validate', {
    preHandler: requireUser,
    schema: { tags: ['terms'], summary: 'Validate a terms body without saving', body: z.object({ ownerType: ownerEnum, body: z.record(z.string(), z.any()), scoped: z.boolean().default(false) }),
      response: { 200: z.object({ valid: z.boolean(), error: z.string().nullable(), guardrailBreaches: z.array(z.object({ guardrail: z.string(), message: z.string() })) }) } },
  }, async (req) => {
    const v = validateBody(req.body.ownerType, req.body.body, req.body.scoped);
    if (!v.ok) return { valid: false, error: v.error, guardrailBreaches: [] };
    const breaches = checkTermsGuardrails(req.body.ownerType, v.body);
    return { valid: breaches.length === 0, error: null, guardrailBreaches: breaches };
  });

  r.get('/api/v1/terms/resolve', {
    preHandler: requireUser,
    schema: { tags: ['terms'], summary: 'Terms in force (and which layer supplied each parameter)',
      querystring: z.object({ ownerOrgId: z.string().uuid().optional(), buyerOrgId: z.string().uuid().optional(), supplierOrgId: z.string().uuid().optional(), corridor: z.string().optional(), at: z.string().datetime().optional() }),
      response: { 200: z.object({ terms: z.record(z.string(), z.any()), explanation: z.record(z.string(), z.any()), versionIds: z.array(z.string()) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const owner = req.query.ownerOrgId ?? (['bank', 'insurer'].includes(req.auth!.orgType!) ? req.auth!.orgId! : null);
    const res = await resolveTerms(tx, req.query.at ? new Date(req.query.at) : svc.clock.now(), 'bank', owner, { buyerOrgId: req.query.buyerOrgId, supplierOrgId: req.query.supplierOrgId, corridor: req.query.corridor });
    return res;
  }));

  r.post('/api/v1/terms/simulate', {
    preHandler: requirePerm('terms:edit'),
    schema: { tags: ['terms'], summary: 'Simulate a draft bank terms body against 20 sample invoices (CT-9)', body: z.object({ body: z.record(z.string(), z.any()) }),
      response: { 200: z.object({ rows: z.array(z.object({ sampleId: z.string(), label: z.string(), changed: z.boolean(), before: z.record(z.string(), z.any()), after: z.record(z.string(), z.any()) })) }) } },
  }, async (req) => {
    if (req.auth!.orgType !== 'bank') throw forbidden('The simulator is for bank terms.');
    const v = validateBody('bank', req.body.body, true);
    if (!v.ok) throw new DomainError('invalid_terms', `These terms are not valid: ${v.error}`, 422);
    return { rows: await svc.db.tx(req.ctx, (tx) => simulateBankTerms(tx, svc, req.auth!.orgId!, v.body)) };
  });

  // ---- Calculators ----
  r.post('/api/v1/pricing/early-payment', {
    preHandler: requireUser,
    schema: { tags: ['pricing'], summary: 'Early-payment discount maths (BR-2)', body: z.object({ faceAmount: z.string(), discountPct: z.string(), daysEarly: z.number().int().min(1).max(365), supplierBorrowingRatePct: z.string().optional() }), response: { 200: z.record(z.string(), z.any()) } },
  }, async (req) => {
    const platform = (await svc.db.tx(req.ctx, (tx) => resolveTerms(tx, svc.clock.now(), 'platform', null, {}))).terms;
    return priceEarlyPayment({ faceAmount: req.body.faceAmount, discountPct: req.body.discountPct, daysEarly: req.body.daysEarly, supplierBorrowingRatePct: req.body.supplierBorrowingRatePct ?? null,
      commissionSharePct: platform.earlyPayment.bankCommissionSharePct, buyerCashYieldPct: platform.earlyPayment.buyerCashYieldPct, guardrailCapPct: platform.maxAllInCostSmallPct }) as unknown as Record<string, unknown>;
  });

  r.post('/api/v1/pricing/financing', {
    preHandler: requireUser,
    schema: { tags: ['pricing'], summary: 'Financing maths (BR-3) for explicit inputs', body: z.object({
      faceAmount: z.string(), advancePct: z.string(), ratePct: z.string(), tenorDays: z.number().int().min(1).max(365), processingPct: z.string().default('0'), processingMin: z.string().default('0'),
      platformFeeBps: z.string().default('0'), platformFeePayer: z.enum(['bank', 'supplier']).default('bank'),
      insuredAmount: z.string().optional(), premiumRatePct: z.string().optional(), premiumPayer: z.enum(['bank', 'supplier']).default('supplier') }), response: { 200: z.record(z.string(), z.any()) } },
  }, async (req) => {
    const b = req.body;
    const premium = b.insuredAmount && b.premiumRatePct ? premiumFor(b.insuredAmount, b.premiumRatePct, b.tenorDays, 'per_period', 90) : D(0);
    return priceFinancing({ ...b, premium, premiumPayer: b.premiumPayer }) as unknown as Record<string, unknown>;
  });

  r.get('/api/v1/fx/quote', {
    preHandler: requireUser,
    schema: { tags: ['pricing'], summary: 'Simulated FX quote with validity window', querystring: z.object({ pair: z.enum(['USDINR', 'SGDINR']), spreadPct: z.string().default('0.30') }), response: { 200: z.record(z.string(), z.any()) } },
  }, async (req) => svc.adapters.fx.quote(req.query.pair, req.query.spreadPct, svc.clock.now()) as unknown as Record<string, unknown>);

  // ---- Offer evaluation (BR-1 gates 5-7) ----
  r.post('/api/v1/invoices/:id/eligibility', {
    preHandler: requireUser,
    schema: { tags: ['pricing'], summary: 'Would this bank fund this invoice, and at what cost? (gates 5 to 7 and the quote)', params: z.object({ id: z.string() }),
      body: z.object({ bankOrgId: z.string().uuid(), insurerOrgId: z.string().uuid().optional(), coverPct: z.number().min(0).max(100).optional() }),
      response: { 200: z.object({ eligible: z.boolean(), reasons: z.array(z.string()), gate: z.string().nullable(), quote: z.record(z.string(), z.any()).nullable(), explanation: z.record(z.string(), z.any()) }) } },
  }, async (req) => svc.db.tx(ctxFor(req), async (tx) => {
    const inv = await loadInvoice(tx, req.params.id);
    const now = svc.clock.now();
    const [buyer, supplier] = await tx.elevated(async () => [
      await tx.one<any>('select * from identity.organisations where id = $1', [inv.buyer_org_id]),
      await tx.one<any>('select * from identity.organisations where id = $1', [inv.supplier_org_id]),
    ]);
    if (!buyer.rating_tier) throw invalid('The buyer has no rating tier on file.');
    const bank = await tx.elevated(() => tx.maybe<any>("select id from identity.organisations where id = $1 and type = 'bank'", [req.body.bankOrgId]));
    if (!bank) throw notFound('Bank');
    const ctx = { buyerOrgId: buyer.id, supplierOrgId: supplier.id, corridor: corridorOf(supplier.country, buyer.country) };
    const bankTerms = await resolveTerms(tx, now, 'bank', bank.id, ctx);
    const platform = await resolveTerms(tx, now, 'platform', null, ctx);
    const insurerTerms = req.body.insurerOrgId ? await resolveTerms(tx, now, 'insurer', req.body.insurerOrgId, ctx) : null;
    const today = now.toISOString().slice(0, 10);
    const tenor = daysBetween(today, String(inv.due_date).slice(0, 10)) + Number(bankTerms.terms.graceDays ?? 0);
    if (tenor <= 0) throw invalid('The invoice is already due.');
    const lim = await tx.elevated(() => tx.query<any>('select subject_org_id, kind, limit_usd, reserved_usd, used_usd from identity.bank_limits where bank_org_id = $1 and subject_org_id = any($2)', [bank.id, [buyer.id, supplier.id]]));
    const avail = (id: string) => { const l = lim.find((x) => x.subject_org_id === id); return l ? D(l.limit_usd).minus(l.reserved_usd).minus(l.used_usd).toFixed(2) : '0.00'; };
    const amount = inv.accepted_amount ?? inv.gross_amount;
    const ev = evaluateOffer({
      now, invoice: { amount, currency: inv.currency as 'USD', tenorDays: tenor }, buyer: { country: buyer.country, tier: buyer.rating_tier }, supplier: { country: supplier.country, small: supplier.small, borrowingRatePct: supplier.borrowing_rate ? Number(supplier.borrowing_rate) : null },
      bank: bankTerms.terms, insurer: insurerTerms?.terms ?? null, platform: platform.terms, cover: req.body.coverPct != null ? { coverPct: req.body.coverPct } : null,
      headroom: { bankBuyerUsd: avail(buyer.id), bankSupplierUsd: avail(supplier.id) },
      mids: { USDINR: await svc.adapters.fx.mid('USDINR', now), SGDINR: await svc.adapters.fx.mid('SGDINR', now) },
      termsVersionIds: [...new Set([...bankTerms.versionIds, ...platform.versionIds, ...(insurerTerms?.versionIds ?? [])])],
    });
    return { eligible: ev.eligible, reasons: ev.reasons, gate: ev.gate ?? null, quote: (ev.quote ?? null) as Record<string, any> | null, explanation: bankTerms.explanation };
  }));

  void D;
}
