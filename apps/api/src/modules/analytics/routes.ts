import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requirePerm, requireUser } from '../../http/context';
import { forbidden } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { isPlatformRole } from '../identity/permissions';
import { context, network } from './queries';
import { dashboard, type DashKind } from './service';

const any = z.record(z.string(), z.any());
const usd = z.string().nullable();
const networkOut = z.object({
  asOf: z.string(),
  nodes: z.array(z.object({ id: z.string(), type: z.enum(['supplier', 'buyer', 'bank', 'insurer']), name: z.string(), country: z.string(), kycStatus: z.string(),
    sanctionsStatus: z.string(), blocked: z.boolean(), ratingTier: z.string().nullable(), msme: z.boolean(), partner: z.boolean() })),
  edges: z.array(z.object({ id: z.string(), kind: z.enum(['trade', 'bank_limit', 'cover_limit', 'preferred_bank', 'financed']), from: z.string(), to: z.string(),
    status: z.string().nullable(), detail: z.string().nullable(), limitUsd: usd, reservedUsd: usd, usedUsd: usd, count: z.number().int().nullable(), volumeUsd: usd, expiresAt: z.string().nullable() })),
});

export function analyticsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;

  r.get('/api/v1/dashboard', {
    preHandler: requireUser,
    schema: { tags: ['analytics'], summary: 'Dashboard for my organisation type (supplier, buyer, bank, insurer); refreshed by the worker', querystring: z.object({ fresh: z.coerce.boolean().optional() }), response: { 200: any } },
  }, async (req) => {
    const type = req.auth!.orgType!;
    if (type === 'platform') throw forbidden('Platform staff use the scorecard.');
    return svc.db.tx(req.ctx, (tx) => dashboard(tx, svc, type as DashKind, req.auth!.orgId!, req.query.fresh));
  });

  r.get('/api/v1/admin/scorecard', {
    preHandler: requirePerm('audit:read'),
    schema: { tags: ['analytics'], summary: 'Pilot scorecard: the six success metrics from the PRD', querystring: z.object({ fresh: z.coerce.boolean().optional() }), response: { 200: any } },
  }, async (req) => {
    if (!isPlatformRole(req.auth!.role ?? undefined)) throw forbidden('Only platform staff can see the scorecard.');
    return svc.db.tx(platformCtx(req), (tx) => dashboard(tx, svc, 'scorecard', null, req.query.fresh));
  });

  r.get('/api/v1/admin/network', {
    preHandler: requirePerm('audit:read'),
    schema: { tags: ['analytics'], summary: 'The network: every supplier, buyer, bank and insurer, and the relationships, limits, preferred banks and funding between them (platform staff; the read is audited)',
      response: { 200: networkOut } },
  }, async (req) => {
    const ctx = platformCtx(req);
    return svc.db.tx(ctx, async (tx) => {
      await audit(tx, req.ctx, svc.clock.now(), { action: 'platform.cross_tenant_read', entityType: 'network', orgId: null });
      return network(await context(tx, svc)) as Promise<z.infer<typeof networkOut>>;
    });
  });
}
