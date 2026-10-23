import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requirePerm, requireUser } from '../../http/context';
import { forbidden, invalid } from '../../kernel/errors';
import { can, isPlatformRole } from '../identity/permissions';
import { GUARDRAILS, checkTermsGuardrails } from '../terms/guardrails';
import { validateBody } from '../terms/schema';
import { resolveTerms } from '../terms/service';
import { describeTerms, templatesFor } from './diff';
import { SETTINGS, SETTING_KEYS, currentSetting, decideSetting, proposeSetting, settingChanges } from './settings';
import { approvalsInbox, brandingForHost, exportSet, financingRequirements, importIntoSet, rejectVersion, saveBranding, setHostname, versionDiff } from './service';

const ownerEnum = z.enum(['platform', 'bank', 'insurer']);
const change = z.object({ path: z.string(), before: z.any().optional(), after: z.any().optional(), kind: z.enum(['added', 'removed', 'changed']) });
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
const fieldOut = z.object({ key: z.string(), label: z.string(), type: z.enum(['text', 'number', 'date', 'select']), required: z.boolean(), options: z.array(z.string()).optional(), appliesTo: z.enum(['financing_request', 'claim']) });
const brandingOut = z.object({ displayName: z.string(), primary: z.string(), accent: z.string(), logo: z.string().nullable(), welcome: z.string().nullable() });

export function governanceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const ctxFor = (req: any) => (isPlatformRole(req.auth?.role) ? platformCtx(req) : req.ctx);
  const isAdmin = (req: any) => can(req.auth?.role, 'platform:admin');

  // ------------------------------------------------------------------------------------------ approvals inbox
  r.get('/api/v1/approvals', {
    preHandler: requireUser,
    schema: { tags: ['governance'], summary: 'Changes waiting for a second pair of eyes (maker-checker), with a diff against what is in force',
      response: { 200: z.object({ items: z.array(z.object({ kind: z.enum(['terms', 'setting']), id: z.string(), title: z.string(), ownerName: z.string().nullable(), ownerType: ownerEnum, maker: z.string().nullable(), submittedAt: z.string(), effectiveFrom: z.string().nullable(), note: z.string().nullable(), changes: z.array(change), against: z.number().nullable(), version: z.number().nullable(), canApprove: z.boolean(), reason: z.string().nullable() })) }) } },
  }, async (req) => ({
    items: await svc.db.tx(ctxFor(req), (tx) => approvalsInbox(tx, svc, ctxFor(req), { orgId: req.auth!.orgId!, orgType: req.auth!.orgType!, role: req.auth!.role!, userId: req.auth!.userId }, can(req.auth!.role!, 'terms:publish'), isAdmin(req))),
  }));

  r.post('/api/v1/approvals/settings/:id/decision', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['governance'], summary: 'Approve or reject a proposed platform setting (a different administrator from the proposer)', params: z.object({ id: z.string().uuid() }), body: z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(platformCtx(req), (tx) => decideSetting(tx, svc, platformCtx(req), req.params.id, req.body.approve, req.body.note)); return reply.code(204).send(); });

  r.post('/api/v1/terms/versions/:id/reject', {
    preHandler: requireUser,
    schema: { tags: ['terms'], summary: 'Send a pending version back to draft (checker declines, or maker withdraws)', params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().min(3).max(500) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    if (!can(req.auth!.role!, 'terms:publish') && !can(req.auth!.role!, 'terms:edit')) throw forbidden('Your role cannot change terms.');
    await svc.db.tx(ctxFor(req), (tx) => rejectVersion(tx, svc, ctxFor(req), req.params.id, req.body.reason));
    return reply.code(204).send();
  });

  r.get('/api/v1/terms/versions/:id/diff', {
    preHandler: requirePerm('read'),
    schema: { tags: ['terms'], summary: 'What changed in a version compared with the previous in-force one (or a chosen version)', params: z.object({ id: z.string().uuid() }), querystring: z.object({ against: z.string().uuid().optional() }),
      response: { 200: z.object({ version: z.number(), against: z.number().nullable(), changes: z.array(change) }) } },
  }, async (req) => svc.db.tx(ctxFor(req), (tx) => versionDiff(tx, req.params.id, req.query.against)));

  // ------------------------------------------------------------------------------------------ studio helpers
  r.get('/api/v1/terms/templates/:owner', {
    preHandler: requirePerm('read'),
    schema: { tags: ['terms'], summary: 'Starting templates', params: z.object({ owner: ownerEnum }), response: { 200: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), body: z.record(z.string(), z.any()) })) }) } },
  }, async (req) => ({ items: templatesFor(req.params.owner) }));

  r.post('/api/v1/terms/preview', {
    preHandler: requirePerm('read'),
    schema: { tags: ['terms'], summary: 'Plain-language preview of what suppliers and buyers will see (CT-8)', body: z.object({ ownerType: ownerEnum, body: z.record(z.string(), z.any()) }),
      response: { 200: z.object({ supplier: z.array(z.string()), buyer: z.array(z.string()), notes: z.array(z.string()) }) } },
  }, async (req) => {
    const bench = await svc.db.tx(ctxFor(req), async (tx) => Number((await resolveTerms(tx, svc.clock.now(), 'platform', null, {})).terms.benchmarkRatePct ?? 4.1));
    return describeTerms(req.body.ownerType, req.body.body, bench);
  });

  r.get('/api/v1/terms/sets/:id/export', {
    preHandler: requirePerm('read'),
    schema: { tags: ['terms'], summary: 'Export a terms version as a portable JSON document (CT-11)', params: z.object({ id: z.string().uuid() }), querystring: z.object({ version: z.string().uuid().optional() }),
      response: { 200: z.object({ format: z.string(), schemaVersion: z.number(), ownerType: ownerEnum, name: z.string(), scope: z.record(z.string(), z.any()), version: z.number(), exportedAt: z.string(), body: z.record(z.string(), z.any()) }) } },
  }, async (req) => svc.db.tx(ctxFor(req), (tx) => exportSet(tx, svc, req.params.id, req.query.version)));

  r.post('/api/v1/terms/sets/:id/import', {
    preHandler: requirePerm('terms:edit'),
    schema: { tags: ['terms'], summary: 'Import an exported document as a new draft version (validated like any other draft)', params: z.object({ id: z.string().uuid() }),
      body: z.object({ format: z.string(), schemaVersion: z.number().int(), ownerType: z.string(), body: z.record(z.string(), z.any()) }).passthrough(),
      response: { 201: z.object({ id: z.string(), version: z.number(), status: z.string() }) } },
  }, async (req, reply) => {
    const v = await svc.db.tx(ctxFor(req), (tx) => importIntoSet(tx, svc, ctxFor(req), req.params.id, req.body));
    return reply.code(201).send({ id: v.id, version: v.version, status: v.status });
  });

  // ------------------------------------------------------------------------------------------ platform settings and guardrails (ADM-07)
  r.get('/api/v1/admin/settings', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['governance'], summary: 'Governed platform settings with any pending change and recent history',
      response: { 200: z.object({ items: z.array(z.object({ key: z.string(), label: z.string(), help: z.string(), value: z.any(), pending: z.object({ id: z.string(), value: z.any(), proposer: z.string().nullable(), at: z.string(), note: z.string().nullable() }).nullable(),
        history: z.array(z.object({ id: z.string(), status: z.string(), before: z.any(), after: z.any(), proposer: z.string().nullable(), decider: z.string().nullable(), at: z.string(), decidedAt: z.string().nullable() })) })) }) } },
  }, async (req) => svc.db.tx(platformCtx(req), async (tx) => {
    const all = await settingChanges(tx);
    const items = [];
    for (const key of SETTING_KEYS) {
      const mine = all.filter((c) => c.key === key);
      const p = mine.find((c) => c.status === 'pending');
      items.push({
        key, label: SETTINGS[key].label, help: SETTINGS[key].help, value: await currentSetting(tx, svc, key),
        pending: p ? { id: p.id, value: p.after, proposer: p.proposer, at: iso(p.proposed_at)!, note: p.note } : null,
        history: mine.filter((c) => c.status !== 'pending').slice(0, 5).map((c) => ({ id: c.id, status: c.status, before: c.before, after: c.after, proposer: c.proposer, decider: c.decider, at: iso(c.proposed_at)!, decidedAt: iso(c.decided_at) })),
      });
    }
    return { items };
  }));

  r.put('/api/v1/admin/settings/:key', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['governance'], summary: 'Propose a new value; it takes effect when a different administrator approves it', params: z.object({ key: z.string() }), body: z.object({ value: z.any(), note: z.string().max(500).optional() }),
      response: { 202: z.object({ changeId: z.string(), status: z.literal('pending') }) } },
  }, async (req, reply) => {
    const c = await svc.db.tx(platformCtx(req), (tx) => proposeSetting(tx, svc, platformCtx(req), req.params.key, req.body.value, req.body.note));
    return reply.code(202).send({ changeId: c.id, status: 'pending' as const });
  });

  r.get('/api/v1/admin/guardrails', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['governance'], summary: 'Hard platform guardrails (code, not data) and the platform terms set that carries fees and defaults',
      response: { 200: z.object({ guardrails: z.array(z.object({ key: z.string(), label: z.string(), value: z.string(), editable: z.literal(false) })), platformSetId: z.string().nullable() }) } },
  }, async (req) => {
    const set = await svc.db.tx(platformCtx(req), (tx) => tx.maybe<{ id: string }>("select id from terms.terms_sets where owner_type = 'platform' order by created_at limit 1"));
    return {
      guardrails: [
        { key: 'minDisputeWindowHours', label: 'Minimum dispute window (hours)', value: String(GUARDRAILS.minDisputeWindowHours), editable: false as const },
        { key: 'maxFxSpreadPct', label: 'Maximum FX spread (%)', value: String(GUARDRAILS.maxFxSpreadPct), editable: false as const },
        { key: 'maxAllInCostSmallPct', label: 'Cost cap for small suppliers (% a year)', value: String(GUARDRAILS.maxAllInCostSmallPct), editable: false as const },
        { key: 'assignmentNotice', label: 'Assignment notice is mandatory', value: 'always', editable: false as const },
        { key: 'sanctionsBlock', label: 'A sanctions hit blocks funding', value: 'always', editable: false as const },
      ],
      platformSetId: set?.id ?? null,
    };
  });

  // ------------------------------------------------------------------------------------------ white-label branding (WL-1)
  r.get('/api/v1/branding', {
    schema: { tags: ['system'], summary: 'Branding for the hostname the SPA is served from (public)', querystring: z.object({ host: z.string().max(200).optional() }),
      response: { 200: brandingOut.extend({ mode: z.enum(['network', 'white-label']), matched: z.boolean(), orgId: z.string().nullable(), hostname: z.string().nullable(), whiteLabel: z.boolean() }) } },
  }, async (req, reply) => {
    reply.header('cache-control', 'no-store').header('vary', 'host, x-forwarded-host');
    return brandingForHost(svc, req.query.host ?? (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host);
  });

  r.get('/api/v1/bank/branding', {
    preHandler: requirePerm('read'),
    schema: { tags: ['governance'], summary: 'My bank\'s branding and hostname', response: { 200: brandingOut.extend({ hostname: z.string().nullable() }) } },
  }, async (req) => {
    if (req.auth!.orgType !== 'bank') throw forbidden('Only banks have branding.');
    const b = await brandingForHost(svc, undefined);
    void b;
    const o = await svc.db.tx(req.ctx, (tx) => tx.one<any>('select branding, hostname, legal_name from identity.organisations where id = $1', [req.auth!.orgId]));
    const x = o.branding ?? {};
    return { displayName: x.displayName ?? o.legal_name, primary: x.primary ?? '#0b5d3b', accent: x.accent ?? '#c9a227', logo: x.logo ?? null, welcome: x.welcome ?? null, hostname: o.hostname ?? null };
  });

  r.put('/api/v1/bank/branding', {
    preHandler: requirePerm('org:settings'),
    schema: { tags: ['governance'], summary: 'Update my bank\'s branding (display name, colours, logo, welcome text)',
      body: z.object({ displayName: z.string().optional(), primary: z.string().optional(), accent: z.string().optional(), logo: z.string().nullable().optional(), welcome: z.string().nullable().optional() }), response: { 200: brandingOut } },
  }, async (req) => {
    if (req.auth!.orgType !== 'bank') throw forbidden('Only banks have branding.');
    return svc.db.tx(req.ctx, (tx) => saveBranding(tx, svc, req.ctx, req.auth!.orgId!, req.body as any));
  });

  r.get('/api/v1/admin/banks', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['governance'], summary: 'Banks with their hostname and branding', response: { 200: z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), isPartner: z.boolean(), hostname: z.string().nullable(), displayName: z.string(), primary: z.string() })) }) } },
  }, async (req) => ({
    items: (await svc.db.tx(platformCtx(req), (tx) => tx.query<any>("select id, legal_name, is_partner, hostname, branding from identity.organisations where type = 'bank' order by is_partner desc, legal_name")))
      .map((o) => ({ id: o.id, name: o.legal_name, isPartner: !!o.is_partner, hostname: o.hostname ?? null, displayName: o.branding?.displayName ?? o.legal_name, primary: o.branding?.primary ?? '#0b5d3b' })),
  }));

  r.put('/api/v1/admin/banks/:id/hostname', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['governance'], summary: 'Point a hostname at a bank (platform only: a hostname decides whose branding a visitor sees)', params: z.object({ id: z.string().uuid() }), body: z.object({ hostname: z.string().nullable() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(platformCtx(req), (tx) => setHostname(tx, svc, platformCtx(req), req.params.id, req.body.hostname?.toLowerCase() ?? null)); return reply.code(204).send(); });

  // ------------------------------------------------------------------------------------------ requirements (CT-10)
  r.get('/api/v1/financing-requests/:id/requirements', {
    preHandler: requireUser,
    schema: { tags: ['governance'], summary: 'Extra information and documents the bank asks for before consent', params: z.object({ id: z.string().uuid() }),
      response: { 200: z.object({ bankOrgId: z.string(), customFields: z.array(fieldOut), requiredDocuments: z.array(z.string()), missingDocuments: z.array(z.string()), answers: z.record(z.string(), z.any()) }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => financingRequirements(tx, svc, req.params.id)));

  r.get('/api/v1/requirements/claim/:invoiceId', {
    preHandler: requireUser,
    schema: { tags: ['governance'], summary: 'Documents and extra information the insurer requires for a claim on this invoice', params: z.object({ invoiceId: z.string().uuid() }),
      response: { 200: z.object({ documents: z.array(z.string()), customFields: z.array(fieldOut) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const d = await tx.elevated(() => tx.maybe<any>('select insurer_org_id, bank_org_id from recovery.defaults where invoice_id = $1', [req.params.invoiceId]));
    if (!d?.insurer_org_id || (d.bank_org_id !== req.auth!.orgId && !isPlatformRole(req.auth!.role ?? undefined))) return { documents: ['invoice', 'acceptance', 'delivery_proof', 'statement'], customFields: [] };
    const terms = (await resolveTerms(tx, svc.clock.now(), 'insurer', d.insurer_org_id, {})).terms;
    return { documents: (terms.claimDocuments ?? []) as string[], customFields: ((terms.customFields ?? []) as any[]).filter((f) => f.appliesTo === 'claim') };
  }));

  void invalid; void validateBody; void checkTermsGuardrails;
}
