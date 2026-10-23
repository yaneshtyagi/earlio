import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireOrgType, requirePerm, requireUser, platformCtx } from '../../http/context';
import { DomainError, invalid } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { approveRelationship, proposeRelationship, suspendRelationship } from './relationships';
import { setLimit } from './limits';

const relSchema = z.object({
  id: z.string(), status: z.enum(['pending', 'active', 'suspended']),
  supplier: z.object({ id: z.string(), name: z.string() }), buyer: z.object({ id: z.string(), name: z.string() }),
  proposedByOrgId: z.string(), supplierApproved: z.boolean(), buyerApproved: z.boolean(), createdAt: z.string(),
});

export function relationshipRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;

  const listRels = (tx: any, where = "", params: unknown[] = []): Promise<any[]> => tx.elevated(async () => (await tx.query(
    `select r.*, s.legal_name as sname, b.legal_name as bname from identity.relationships r
       join identity.organisations s on s.id = r.supplier_org_id join identity.organisations b on b.id = r.buyer_org_id ${where} order by r.created_at`, params)) as any[]);
  const toRel = (x: any) => ({ id: x.id, status: x.status, supplier: { id: x.supplier_org_id, name: x.sname }, buyer: { id: x.buyer_org_id, name: x.bname },
    proposedByOrgId: x.proposed_by_org_id, supplierApproved: !!x.supplier_approved_by, buyerApproved: !!x.buyer_approved_by, createdAt: x.created_at.toISOString() });

  r.get('/api/v1/directory/organisations', {
    preHandler: requireOrgType('supplier', 'buyer', 'bank'),
    schema: { tags: ['relationships'], summary: 'KYC-approved organisations you can link with (counterparty search)',
      querystring: z.object({ q: z.string().optional(), type: z.enum(['supplier', 'buyer', 'bank']).optional() }),
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), type: z.string(), legalName: z.string(), country: z.string(), ratingTier: z.string().nullable() })) }) } },
  }, async (req) => {
    const rows = await svc.db.tx(req.ctx, (tx) => tx.query<any>(
      `select id, type, legal_name, country, rating_tier from identity.organisations
        where kyc_status = 'approved' and not blocked and id <> $1 and ($2::text is null or type = $2) and ($3::text is null or legal_name ilike '%' || $3 || '%') and type in ('supplier','buyer','bank')
        order by legal_name limit 50`, [req.auth!.orgId, req.query.type ?? null, req.query.q ?? null]));
    return { items: rows.map((o: any) => ({ id: o.id, type: o.type, legalName: o.legal_name, country: o.country, ratingTier: o.rating_tier })) };
  });

  r.get('/api/v1/relationships', {
    preHandler: requirePerm('read'),
    schema: { tags: ['relationships'], summary: 'My supplier–buyer relationships', response: { 200: z.object({ items: z.array(relSchema) }) } },
  }, async (req) => {
    const rows: any[] = await svc.db.tx(req.ctx, (tx) => listRels(tx, 'where r.supplier_org_id = $1 or r.buyer_org_id = $1', [req.auth!.orgId]));
    return { items: rows.map(toRel) };
  });

  r.post('/api/v1/relationships', {
    preHandler: requirePerm('relationship:propose'),
    schema: { tags: ['relationships'], summary: 'Propose a relationship with a counterparty',
      body: z.object({ counterpartyId: z.string().uuid() }), response: { 201: relSchema } },
  }, async (req, reply) => {
    if (!['supplier', 'buyer'].includes(req.auth!.orgType!)) throw invalid('Only suppliers and buyers have relationships.');
    const out = await svc.db.tx(req.ctx, async (tx) => {
      const rel = await proposeRelationship(tx, svc, req.ctx, req.auth!.orgId!, req.auth!.orgType!, req.body.counterpartyId);
      return (await listRels(tx, 'where r.id = $1', [rel.id]))[0];
    });
    return reply.code(201).send(toRel(out));
  });

  r.post('/api/v1/relationships/:id/approve', {
    preHandler: requirePerm('relationship:approve'),
    schema: { tags: ['relationships'], summary: 'Approve for my side', params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ status: z.string() }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => approveRelationship(tx, svc, req.ctx, req.auth!.orgId!, req.params.id)));

  r.post('/api/v1/admin/relationships/:id/suspend', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['admin'], summary: 'Suspend a relationship', params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().min(3) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    const ctx = platformCtx(req);
    await svc.db.tx(ctx, (tx) => suspendRelationship(tx, svc, ctx, req.params.id, req.body.reason));
    return reply.code(204).send();
  });

  // ---- Preferred banks ----
  r.get('/api/v1/org/preferred-banks', {
    preHandler: requireOrgType('supplier', 'buyer'),
    schema: { tags: ['relationships'], summary: 'My preferred banks', response: { 200: z.object({ banks: z.array(z.object({ id: z.string(), name: z.string() })), available: z.array(z.object({ id: z.string(), name: z.string(), isPartner: z.boolean() })) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const mine = await tx.query<any>(`select o.id, o.legal_name from identity.org_preferred_banks p join identity.organisations o on o.id = p.bank_org_id where p.org_id = $1 order by o.legal_name`, [req.auth!.orgId]);
    const avail = await tx.query<any>(`select id, legal_name, is_partner from identity.organisations where type = 'bank' and kyc_status = 'approved' and not blocked order by legal_name`);
    return { banks: mine.map((b) => ({ id: b.id, name: b.legal_name })), available: avail.map((b) => ({ id: b.id, name: b.legal_name, isPartner: b.is_partner })) };
  }));

  r.put('/api/v1/org/preferred-banks', {
    preHandler: requirePerm('org:settings'),
    schema: { tags: ['relationships'], summary: 'Replace my preferred bank list', body: z.object({ bankIds: z.array(z.string().uuid()).max(20) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    if (!['supplier', 'buyer'].includes(req.auth!.orgType!)) throw invalid('Only suppliers and buyers choose preferred banks.');
    await svc.db.tx(req.ctx, async (tx) => {
      const now = svc.clock.now();
      const ok = await tx.query<{ id: string }>(`select id from identity.organisations where type = 'bank' and id = any($1::uuid[])`, [req.body.bankIds]);
      if (ok.length !== new Set(req.body.bankIds).size) throw invalid('One or more selected organisations are not banks.');
      await tx.query('delete from identity.org_preferred_banks where org_id = $1', [req.auth!.orgId]);
      for (const id of new Set(req.body.bankIds)) await tx.query('insert into identity.org_preferred_banks (org_id, bank_org_id, created_at) values ($1,$2,$3)', [req.auth!.orgId, id, now]);
      await audit(tx, req.ctx, now, { action: 'org.preferred_banks_set', entityType: 'organisation', entityId: req.auth!.orgId!, orgId: req.auth!.orgId!, after: { bankIds: req.body.bankIds } });
    });
    return reply.code(204).send();
  });

  // ---- Bank exposure limits ----
  const limitSchema = z.object({ subjectOrgId: z.string(), subjectName: z.string(), kind: z.enum(['buyer', 'supplier']), limitUsd: z.string(), reservedUsd: z.string(), usedUsd: z.string(), availableUsd: z.string() });
  r.get('/api/v1/bank/limits', {
    preHandler: requireOrgType('bank'),
    schema: { tags: ['limits'], summary: 'My exposure limits', response: { 200: z.object({ items: z.array(limitSchema) }) } },
  }, async (req) => {
    const rows = await svc.db.tx(req.ctx, (tx) => tx.elevated(() => tx.query<any>(
      `select l.*, o.legal_name from identity.bank_limits l join identity.organisations o on o.id = l.subject_org_id where l.bank_org_id = $1 order by l.kind, o.legal_name`, [req.auth!.orgId])));
    return { items: rows.map((l: any) => ({ subjectOrgId: l.subject_org_id, subjectName: l.legal_name, kind: l.kind, limitUsd: l.limit_usd, reservedUsd: l.reserved_usd, usedUsd: l.used_usd,
      availableUsd: (Number(l.limit_usd) - Number(l.reserved_usd) - Number(l.used_usd)).toFixed(2) })) };
  });

  r.put('/api/v1/bank/limits', {
    preHandler: async (req, reply) => { await requireOrgType('bank')(req, reply); await requirePerm('limits:manage')(req, reply); },
    schema: { tags: ['limits'], summary: 'Set a buyer or supplier exposure limit (USD)',
      body: z.object({ subjectOrgId: z.string().uuid(), kind: z.enum(['buyer', 'supplier']), limitUsd: z.string().regex(/^\d+(\.\d{1,2})?$/) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    await svc.db.tx(req.ctx, (tx) => setLimit(tx, svc, req.ctx, req.auth!.orgId!, req.body.subjectOrgId, req.body.kind, req.body.limitUsd));
    return reply.code(204).send();
  });

  void DomainError; void requireUser;
}
