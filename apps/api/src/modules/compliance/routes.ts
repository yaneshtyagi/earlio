import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireOrgType, requirePerm, requireUser, platformCtx } from '../../http/context';
import { DomainError, forbidden } from '../../kernel/errors';
import { storeFile, readFile, previewType } from '../../platform/files';
import { createOrganisation, addMember } from '../identity/service';
import { attachDocument, caseView, decideCase, getOrCreateOpenCase, submitCase } from './kyc';
import { decideScreening } from './sanctions';

const caseSchema = z.object({
  status: z.string(), org: z.object({ type: z.string(), kycStatus: z.string(), sanctionsStatus: z.string(), blocked: z.boolean() }),
  required: z.array(z.string()),
  documents: z.array(z.object({ id: z.string(), docType: z.string(), fileId: z.string(), filename: z.string(), sha256: z.string() })),
  decisionReason: z.string().nullable(),
  providerResult: z.unknown().nullable(),
});

async function view(tx: any, orgId: string) {
  const v = await caseView(tx, orgId);
  return {
    status: v.kase?.status ?? 'not_started',
    org: { type: v.org.type, kycStatus: v.org.kyc_status, sanctionsStatus: v.org.sanctions_status, blocked: v.org.blocked },
    required: v.required,
    documents: v.docs.map((d: any) => ({ id: d.id, docType: d.doc_type, fileId: d.file_id, filename: d.filename, sha256: d.sha256 })),
    decisionReason: v.kase?.decision_reason ?? null,
    providerResult: v.kase?.provider_result ?? null,
  };
}

export function complianceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;

  // Raw upload bodies (files). Limit enforced again in the service.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 11 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  // ---- Files ----
  r.post('/api/v1/files', {
    preHandler: requireUser,
    schema: {
      tags: ['files'], summary: 'Upload a file (raw body, application/octet-stream)',
      querystring: z.object({ filename: z.string().min(1).max(200) }),
      response: { 201: z.object({ id: z.string(), filename: z.string(), sha256: z.string(), size: z.number() }) },
    },
  }, async (req, reply) => {
    const data = req.body as unknown as Buffer;
    if (!Buffer.isBuffer(data)) throw new DomainError('bad_upload', 'Send the file as application/octet-stream.', 415);
    const out = await svc.db.tx(req.ctx, (tx) => storeFile(tx, svc, req.ctx, { filename: req.query.filename, contentType: 'application/octet-stream', data }));
    return reply.code(201).send(out);
  });

  r.get('/api/v1/files/:id', {
    preHandler: requireUser,
    schema: {
      tags: ['files'], summary: 'Download or preview a file you own or that was shared with you',
      description: 'disposition=inline returns the file with its real type for in-app preview (PDF, PNG, JPEG, GIF, WebP, plain text only); other types are refused with 415.',
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({ disposition: z.enum(['attachment', 'inline']).default('attachment') }),
    },
  }, async (req, reply) => {
    const { meta, data } = await svc.db.tx(req.ctx, (tx) => readFile(tx, svc, req.params.id));
    if (req.query.disposition === 'inline') {
      const type = previewType(meta.filename, data);
      if (!type) throw new DomainError('not_previewable', 'This file type cannot be previewed. Download it to open it on your device.', 415);
      return reply.header('content-type', type)
        .header('content-disposition', `inline; filename="${meta.filename}"`).header('x-content-type-options', 'nosniff').send(data);
    }
    return reply.header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${meta.filename}"`).header('x-content-type-options', 'nosniff').send(data);
  });

  // ---- Self-service onboarding ----
  r.post('/api/v1/onboarding/register', {
    config: { rateLimit: { max: svc.config.env === 'test' ? 10_000 : 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['onboarding'], summary: 'Register an organisation and its first administrator',
      body: z.object({
        orgType: z.enum(['supplier', 'buyer', 'bank', 'insurer']),
        legalName: z.string().min(2).max(200), country: z.string().length(2),
        turnoverInr: z.string().regex(/^\d+(\.\d+)?$/).optional(), msme: z.boolean().optional(),
        adminName: z.string().min(2).max(120), adminEmail: z.string().email(), password: z.string().min(1),
      }),
      response: { 201: z.object({ orgId: z.string(), next: z.string() }) },
    },
  }, async (req, reply) => {
    const b = req.body;
    const ctx = { platform: true, correlationId: req.id };
    const orgId = await svc.db.tx(ctx, async (tx) => {
      const id = await createOrganisation(tx, svc, ctx, { type: b.orgType, legalName: b.legalName.trim(), country: b.country.toUpperCase(), turnoverInr: b.turnoverInr ?? null, msme: b.msme });
      await addMember(tx, svc, ctx, { orgId: id, orgType: b.orgType, email: b.adminEmail, name: b.adminName, role: 'Admin', password: b.password });
      await tx.query('insert into compliance.kyc_cases (org_id, status, created_at) values ($1,$2,$3)', [id, 'draft', svc.clock.now()]);
      return id;
    });
    return reply.code(201).send({ orgId, next: 'Sign in, set up multi-factor authentication, then upload your KYC documents.' });
  });

  r.get('/api/v1/onboarding/case', {
    preHandler: requireOrgType('supplier', 'buyer', 'bank', 'insurer'),
    schema: { tags: ['onboarding'], summary: 'My KYC application', response: { 200: caseSchema } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => view(tx, req.auth!.orgId!)));

  r.post('/api/v1/onboarding/documents', {
    preHandler: requirePerm('kyc:submit'),
    schema: {
      tags: ['onboarding'], summary: 'Attach an uploaded file as a KYC document',
      body: z.object({ docType: z.string(), fileId: z.string().uuid() }), response: { 201: z.object({ id: z.string() }) },
    },
  }, async (req, reply) => {
    const id = await svc.db.tx(req.ctx, (tx) => attachDocument(tx, svc, req.ctx, req.auth!.orgId!, req.body.docType, req.body.fileId));
    return reply.code(201).send({ id });
  });

  r.post('/api/v1/onboarding/submit', {
    preHandler: requirePerm('kyc:submit'),
    schema: {
      tags: ['onboarding'], summary: 'Submit the KYC application (runs KYC check and sanctions screening)',
      response: { 200: z.object({ status: z.string(), reasons: z.array(z.string()) }) },
    },
  }, async (req) => {
    const out = await svc.db.tx(req.ctx, async (tx) => { await getOrCreateOpenCase(tx, svc, req.ctx, req.auth!.orgId!); return submitCase(tx, svc, req.ctx, req.auth!.orgId!); });
    return { status: out.status, reasons: out.result.reasons };
  });

  // ---- Platform admin: KYC queue ----
  const queueItem = z.object({
    id: z.string(), orgId: z.string(), orgName: z.string(), orgType: z.string(), country: z.string(), status: z.string(),
    sanctionsStatus: z.string(), submittedAt: z.string().nullable(), providerResult: z.unknown().nullable(),
  });
  r.get('/api/v1/admin/kyc/cases', {
    preHandler: requirePerm('kyc:review'),
    schema: { tags: ['admin'], summary: 'KYC cases', querystring: z.object({ status: z.string().optional() }), response: { 200: z.object({ items: z.array(queueItem) }) } },
  }, async (req) => {
    const ctx = platformCtx(req);
    const rows = await svc.db.tx(ctx, (tx) => tx.query<any>(
      `select k.*, o.legal_name, o.type, o.country, o.sanctions_status from compliance.kyc_cases k join identity.organisations o on o.id = k.org_id
        where ($1::text is null or k.status = $1) and k.status <> 'draft' order by k.submitted_at desc nulls last`, [req.query.status ?? null]));
    return { items: rows.map((k: any) => ({ id: k.id, orgId: k.org_id, orgName: k.legal_name, orgType: k.type, country: k.country, status: k.status, sanctionsStatus: k.sanctions_status, submittedAt: k.submitted_at?.toISOString() ?? null, providerResult: k.provider_result })) };
  });

  r.get('/api/v1/admin/kyc/cases/:id', {
    preHandler: requirePerm('kyc:review'),
    schema: { tags: ['admin'], summary: 'KYC case detail', params: z.object({ id: z.string().uuid() }), response: { 200: caseSchema.extend({ orgName: z.string() }) } },
  }, async (req) => {
    const ctx = platformCtx(req);
    return svc.db.tx(ctx, async (tx) => {
      const k = await tx.maybe<any>('select org_id from compliance.kyc_cases where id = $1', [req.params.id]);
      if (!k) throw new DomainError('not_found', 'KYC case was not found.', 404);
      const org = await tx.one<any>('select legal_name from identity.organisations where id = $1', [k.org_id]);
      return { ...(await view(tx, k.org_id)), orgName: org.legal_name };
    });
  });

  r.post('/api/v1/admin/kyc/cases/:id/decision', {
    preHandler: requirePerm('kyc:review'),
    schema: { tags: ['admin'], summary: 'Approve or reject a KYC case', params: z.object({ id: z.string().uuid() }),
      body: z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().min(3) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    const ctx = platformCtx(req);
    await svc.db.tx(ctx, (tx) => decideCase(tx, svc, ctx, req.params.id, req.body.decision, req.body.reason));
    return reply.code(204).send();
  });

  // ---- Platform admin: sanctions review ----
  r.get('/api/v1/admin/sanctions/screenings', {
    preHandler: requirePerm('sanctions:review'),
    schema: { tags: ['admin'], summary: 'Sanctions screening results', querystring: z.object({ outcome: z.string().optional() }),
      response: { 200: z.object({ items: z.array(z.object({
        id: z.string(), subjectName: z.string(), subjectOrgId: z.string().nullable(), invoiceId: z.string().nullable(), outcome: z.string(),
        topScore: z.string(), matches: z.array(z.object({ entry: z.string(), list: z.string(), score: z.number() })), listVersion: z.string(),
        reviewReason: z.string().nullable(), createdAt: z.string() })) }) } },
  }, async (req) => {
    const ctx = platformCtx(req);
    const rows = await svc.db.tx(ctx, (tx) => tx.query<any>(
      `select * from compliance.screening_results where ($1::text is null or outcome = $1) order by created_at desc limit 200`, [req.query.outcome ?? null]));
    return { items: rows.map((s: any) => ({ id: s.id, subjectName: s.subject_name, subjectOrgId: s.subject_org_id, invoiceId: s.invoice_id, outcome: s.outcome, topScore: String(s.top_score), matches: s.matches, listVersion: s.list_version, reviewReason: s.review_reason, createdAt: s.created_at.toISOString() })) };
  });

  r.post('/api/v1/admin/sanctions/screenings/:id/decision', {
    preHandler: requirePerm('sanctions:review'),
    schema: { tags: ['admin'], summary: 'Resolve a sanctions hit', params: z.object({ id: z.string().uuid() }),
      body: z.object({ decision: z.enum(['false_positive', 'confirmed']), reason: z.string().min(3) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    const ctx = platformCtx(req);
    await svc.db.tx(ctx, (tx) => decideScreening(tx, svc, ctx, req.params.id, req.body.decision, req.body.reason));
    return reply.code(204).send();
  });

  void forbidden;
}
