import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requirePerm, requireUser } from '../../http/context';
import { forbidden } from '../../kernel/errors';
import { isPlatformRole } from '../identity/permissions';
import { dashboard, type DashKind } from './service';

const any = z.record(z.string(), z.any());

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
}
