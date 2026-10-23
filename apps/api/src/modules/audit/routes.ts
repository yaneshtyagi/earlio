import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requirePerm } from '../../http/context';
import { anchorAuditHead, audit, SimTimestampAuthority, verifyAuditChain } from '../../platform/audit';

export function auditRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const tsa = new SimTimestampAuthority();

  r.get('/api/v1/audit/events', {
    preHandler: requirePerm('audit:read'),
    schema: {
      tags: ['audit'], summary: 'Audit log (platform staff: cross-tenant, and the read itself is audited)',
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), orgId: z.string().uuid().optional(), entityType: z.string().optional() }),
      response: { 200: z.array(z.object({ seq: z.string(), action: z.string(), entityType: z.string(), entityId: z.string().nullable(), orgId: z.string().nullable(),
        actorUserId: z.string().nullable(), occurredAt: z.string(), hash: z.string(), prevHash: z.string(), before: z.unknown(), after: z.unknown() })) },
    },
  }, async (req) => {
    const ctx = platformCtx(req);
    const rows = await svc.db.tx(ctx, async (tx) => {
      await audit(tx, req.ctx, svc.clock.now(), { action: 'platform.cross_tenant_read', entityType: 'audit_log', after: { orgId: req.query.orgId ?? null } , orgId: null });
      return tx.query<any>(
        `select * from audit.events where ($1::uuid is null or org_id = $1) and ($2::text is null or entity_type = $2) order by seq desc limit $3`,
        [req.query.orgId ?? null, req.query.entityType ?? null, req.query.limit]);
    });
    return rows.map((x) => ({ seq: x.seq, action: x.action, entityType: x.entity_type, entityId: x.entity_id, orgId: x.org_id,
      actorUserId: x.actor_user_id, occurredAt: new Date(x.occurred_at).toISOString(), hash: x.hash, prevHash: x.prev_hash, before: x.before, after: x.after }));
  });

  r.get('/api/v1/audit/verify', {
    preHandler: requirePerm('audit:read'),
    schema: { tags: ['audit'], summary: 'Recompute the hash chain and report the first broken link',
      response: { 200: z.object({ ok: z.boolean(), checked: z.number(), headHash: z.string(), firstBrokenSeq: z.string().optional(), reason: z.string().optional() }) } },
  }, async (req) => svc.db.tx(platformCtx(req), (tx) => verifyAuditChain(tx)));

  r.post('/api/v1/audit/anchor', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['audit'], summary: 'Anchor the current chain head with a (simulated) trusted timestamp',
      response: { 200: z.object({ headHash: z.string(), lastSeq: z.string(), token: z.string() }) } },
  }, async (req) => svc.db.tx(platformCtx(req), async (tx) => {
    const res = await anchorAuditHead(tx, tsa, svc.clock.now());
    await audit(tx, req.ctx, svc.clock.now(), { action: 'audit.anchored', entityType: 'audit_log', after: res, orgId: null });
    return res;
  }));
}
