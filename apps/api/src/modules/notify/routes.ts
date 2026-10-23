import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requirePerm, requireUser } from '../../http/context';
import { audit } from '../../platform/audit';
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

  r.get('/api/v1/org/language', {
    preHandler: requireUser,
    schema: { tags: ['notify'], summary: 'Language my organisation receives notifications in', response: { 200: z.object({ language: z.enum(['en', 'hi']) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => ({ language: (await tx.one<any>('select language from identity.organisations where id = app.org_id()')).language })));
  r.put('/api/v1/org/language', {
    preHandler: requirePerm('org:manage_users'),
    schema: { tags: ['notify'], summary: 'Choose the notification language (English or Hindi) for my organisation', body: z.object({ language: z.enum(['en', 'hi']) }), response: { 200: z.object({ language: z.enum(['en', 'hi']) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const before = (await tx.one<any>('select language from identity.organisations where id = $1', [req.auth!.orgId])).language;
    await tx.query('update identity.organisations set language = $2 where id = $1', [req.auth!.orgId, req.body.language]);
    await audit(tx, req.ctx, svc.clock.now(), { action: 'org.language_changed', entityType: 'organisation', entityId: req.auth!.orgId!, orgId: req.auth!.orgId!, before: { language: before }, after: { language: req.body.language } });
    return { language: req.body.language };
  }));
}
