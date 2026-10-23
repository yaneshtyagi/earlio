import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePerm } from '../http/context';
import { isDevLike } from '../kernel/config';

/** Demo-only: the pilot scenario invoices (INV-1001..1013) and their invoice numbers, for the Demo Director and the end-to-end suite. */
export function demoRoutes(app: FastifyInstance) {
  if (!isDevLike(app.svc.config)) return;
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/api/v1/admin/demo/scenarios', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['sim'], summary: 'Pilot scenario invoices from the seed (development / demo only)', response: { 200: z.object({ items: z.array(z.object({ label: z.string(), id: z.string(), humanId: z.string(), state: z.string() })) }) } },
  }, async () => {
    const row = await app.svc.db.system((tx) => tx.maybe<{ value: any }>("select value from platform.settings where key = 'demo_scenarios'"));
    return { items: row?.value ?? [] };
  });
}
