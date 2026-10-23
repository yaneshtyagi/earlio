import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireOrgType, requirePerm, requireUser } from '../../http/context';
import { invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { decideCover, exportRequestsCsv, importDecisionsCsv, setBuyerLimit, availableLimit } from './service';

const coverOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), status: z.enum(['requested', 'approved', 'partial', 'declined', 'expired', 'uninsured']),
  gateway: z.string(), currency: z.string(), invoiceAmount: z.string(), buyer: z.object({ id: z.string(), name: z.string(), tier: z.string().nullable() }),
  supplierName: z.string(), insurerName: z.string().nullable(),
  requestedCoverPct: z.number().nullable(), coverPct: z.number().nullable(), insuredAmount: z.string().nullable(), reason: z.string().nullable(),
  requestedAt: z.string(), slaDueAt: z.string().nullable(), slaBreached: z.boolean(), decidedAt: z.string().nullable(), validUntil: z.string().nullable(), policyNumber: z.string().nullable(),
});
const limitOut = z.object({
  buyer: z.object({ id: z.string(), name: z.string(), tier: z.string().nullable() }), policyNumber: z.string(), limitUsd: z.string(), reservedUsd: z.string(), usedUsd: z.string(), availableUsd: z.string(),
  expiresAt: z.string(), expired: z.boolean(),
});

export function insuranceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));
  const num = (v: any) => (v == null ? null : Number(v));

  const SELECT = `select c.*, c.invoice_number as human_id, b.legal_name as buyer_name, b.rating_tier as buyer_tier2, s.legal_name as supplier_name, n.legal_name as insurer_name
      from insurance.cover_records c join identity.organisations b on b.id = c.buyer_org_id
      join identity.organisations s on s.id = c.supplier_org_id left join identity.organisations n on n.id = c.insurer_org_id`;
  const toCover = (c: any, now: Date) => ({
    id: c.id, invoiceId: c.invoice_id, invoiceNumber: c.human_id, status: c.status, gateway: c.gateway, currency: c.currency, invoiceAmount: c.invoice_amount,
    buyer: { id: c.buyer_org_id, name: c.buyer_name, tier: c.buyer_tier ?? c.buyer_tier2 ?? null }, supplierName: c.supplier_name, insurerName: c.insurer_name ?? null,
    requestedCoverPct: num(c.requested_cover_pct), coverPct: num(c.cover_pct), insuredAmount: c.insured_amount, reason: c.decision_reason,
    requestedAt: iso(c.requested_at)!, slaDueAt: iso(c.sla_due_at), slaBreached: c.status === 'requested' && !!c.sla_due_at && new Date(c.sla_due_at) < now,
    decidedAt: iso(c.decided_at), validUntil: iso(c.valid_until), policyNumber: c.policy_number,
  });

  r.get('/api/v1/insurance/requests', {
    preHandler: requireOrgType('insurer'),
    schema: { tags: ['insurance'], summary: 'Cover requests addressed to me (INS-02)', querystring: z.object({ status: z.string().optional() }), response: { 200: z.object({ items: z.array(coverOut) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const rows = await tx.query<any>(`${SELECT} where c.insurer_org_id = $1 and ($2::text is null or c.status = $2) order by (c.status = 'requested') desc, c.requested_at desc`, [req.auth!.orgId, req.query.status ?? null]);
    return { items: rows.map((c) => toCover(c, svc.clock.now())) };
  }));

  r.post('/api/v1/insurance/requests/:id/decision', {
    preHandler: requirePerm('cover:decide'),
    schema: { tags: ['insurance'], summary: 'Approve (optionally with lower cover) or decline a cover request',
      params: z.object({ id: z.string().uuid() }),
      body: z.object({ decision: z.enum(['approve', 'decline']), coverPct: z.number().gt(0).max(100).optional(), reason: z.string().max(500).optional() }),
      response: { 200: z.object({ status: z.string(), coverPct: z.number().nullable(), insuredAmount: z.string().nullable() }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => decideCover(tx, svc, req.ctx, req.params.id, req.auth!.orgId!, req.body)));

  r.get('/api/v1/invoices/:id/cover', {
    preHandler: requireUser,
    schema: { tags: ['insurance'], summary: 'Cover record for an invoice (404 until the invoice is accepted, or if you are not a party)', params: z.object({ id: z.string() }), response: { 200: coverOut } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const c = await tx.maybe<any>(`${SELECT} where ${/^INV-/.test(req.params.id) ? 'c.invoice_number' : 'c.invoice_id'} = $1`, [req.params.id]);
    if (!c) throw notFound('Cover record');
    return toCover(c, svc.clock.now());
  }));

  // ---- buyer limits (INS-03) ----
  r.get('/api/v1/insurance/limits', {
    preHandler: requireOrgType('insurer'),
    schema: { tags: ['insurance'], summary: 'My per-buyer insured limits', response: { 200: z.object({ items: z.array(limitOut) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const rows = await tx.query<any>(`select l.*, b.legal_name, b.rating_tier from insurance.buyer_limits l join identity.organisations b on b.id = l.buyer_org_id where l.insurer_org_id = $1 order by b.legal_name`, [req.auth!.orgId]);
    const now = svc.clock.now();
    return { items: rows.map((l) => {
      const expired = new Date(l.expires_at) <= now;
      return { buyer: { id: l.buyer_org_id, name: l.legal_name, tier: l.rating_tier }, policyNumber: l.policy_number, limitUsd: l.limit_usd, reservedUsd: l.reserved_usd, usedUsd: l.used_usd,
        availableUsd: expired ? '0.00' : D(l.limit_usd).minus(l.reserved_usd).minus(l.used_usd).toFixed(2), expiresAt: l.expires_at.toISOString(), expired };
    }) };
  }));

  r.put('/api/v1/insurance/limits', {
    preHandler: requirePerm('limits:manage'),
    schema: { tags: ['insurance'], summary: 'Set or change a buyer limit (cannot go below current exposure or above my policy caps)',
      body: z.object({ buyerOrgId: z.string().uuid(), limitUsd: z.string().regex(/^\d+(\.\d{1,2})?$/), expiresAt: z.string().datetime(), policyNumber: z.string().min(3).max(60) }),
      response: { 204: z.undefined() } },
  }, async (req, reply) => {
    if (req.auth!.orgType !== 'insurer') throw invalid('Only insurers set buyer limits.');
    await svc.db.tx(req.ctx, (tx) => setBuyerLimit(tx, svc, req.ctx, req.auth!.orgId!, { ...req.body, expiresAt: new Date(req.body.expiresAt) }));
    return reply.code(204).send();
  });

  // ---- file exchange stub (XB-5) ----
  r.get('/api/v1/insurance/requests.csv', {
    preHandler: requireOrgType('insurer'),
    schema: { tags: ['insurance'], summary: 'Export open cover requests as CSV', response: { 200: z.string() } },
  }, async (req, reply) => {
    const csv = await svc.db.tx(req.ctx, (tx) => exportRequestsCsv(tx, req.auth!.orgId!));
    return reply.header('content-type', 'text/csv').send(csv);
  });

  r.post('/api/v1/insurance/decisions/import', {
    preHandler: requirePerm('cover:decide'),
    schema: { tags: ['insurance'], summary: 'Import decisions from CSV (requestId,decision,coverPct,reason)', body: z.object({ csv: z.string().min(1).max(500_000) }),
      response: { 200: z.object({ applied: z.number(), errors: z.array(z.object({ row: z.number(), message: z.string() })) }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => importDecisionsCsv(tx, svc, req.ctx, req.auth!.orgId!, req.body.csv)));

  void availableLimit;
}
