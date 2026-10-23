import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireUser } from '../../http/context';
import { notFound } from '../../kernel/errors';

const out = z.object({ id: z.string(), topic: z.string(), subject: z.string(), body: z.string(), createdAt: z.string(), read: z.boolean(), payload: z.record(z.string(), z.any()) });

export function notifyRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  r.get('/api/v1/notifications', {
    preHandler: requireUser,
    schema: { tags: ['notify'], summary: 'In-app notifications for my organisation, newest first', querystring: z.object({ unread: z.coerce.boolean().optional() }),
      response: { 200: z.object({ unread: z.number(), items: z.array(out) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const own = "channel = 'in_app' and recipient_org_id = app.org_id()";
    const rows = await tx.query<any>(`select * from notify.notifications where ${own} ${req.query.unread ? 'and read_at is null' : ''} order by created_at desc, id desc limit 100`);
    const c = await tx.one<any>(`select count(*)::int as n from notify.notifications where ${own} and read_at is null`);
    return { unread: c.n, items: rows.map((n) => ({ id: n.id, topic: n.topic, subject: n.subject, body: n.body, createdAt: new Date(n.created_at).toISOString(), read: !!n.read_at, payload: n.payload })) };
  }));

  r.post('/api/v1/notifications/:id/read', {
    preHandler: requireUser,
    schema: { tags: ['notify'], summary: 'Mark one notification read', params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ ok: z.literal(true) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const n = await tx.query<any>("update notify.notifications set read_at = coalesce(read_at, $2) where id = $1 and recipient_org_id = app.org_id() and channel = 'in_app' returning id", [req.params.id, svc.clock.now()]);
    if (!n.length) throw notFound('Notification');
    return { ok: true as const };
  }));

  r.post('/api/v1/notifications/read-all', {
    preHandler: requireUser,
    schema: { tags: ['notify'], summary: 'Mark all of my organisation’s notifications read', response: { 200: z.object({ ok: z.literal(true) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    await tx.query("update notify.notifications set read_at = $1 where recipient_org_id = app.org_id() and channel = 'in_app' and read_at is null", [svc.clock.now()]);
    return { ok: true as const };
  }));
}
