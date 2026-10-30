import { currentMode } from './modules/governance/settings';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { randomUUID } from 'node:crypto';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Services } from './services';
import { DomainError } from './kernel/errors';
import { hashToken } from './kernel/password';
import { identityRoutes } from './modules/identity/routes';
import { auditRoutes } from './modules/audit/routes';
import { registerModules } from './modules';
import { Metrics } from './kernel/metrics';

export async function buildApp(svc: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: svc.config.env === 'test' && !process.env.EARLIO_TEST_LOG ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    genReqId: (req) => (req.headers['x-correlation-id'] as string) || randomUUID(),
    trustProxy: true,
    bodyLimit: 3 * 1024 * 1024,
  });
  const metrics = new Metrics();
  app.decorate('svc', svc);
  app.decorateRequest('ctx', undefined as any);
  app.decorateRequest('auth', undefined);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(cors, { origin: svc.config.corsOrigins, credentials: true });
  // Global ceiling per client address; sensitive routes (login, MFA) set tighter limits of their own.
  await app.register(rateLimit, { global: true, max: svc.config.env === 'test' ? 100_000 : Number(process.env.RATE_LIMIT_MAX ?? 600), timeWindow: '1 minute', allowList: (req) => req.url === '/health' || req.url === '/ready' });
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Earlio API', version: '0.1.0', description: 'Tri-party receivables financing platform. Simulated environment: all names and rates are fictional.' },
      components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'earlio_sid' }, csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token' } } },
      security: [{ cookieAuth: [], csrf: [] }],
    },
    transform: jsonSchemaTransform,
  });

  // Security headers (the API serves JSON only).
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('x-correlation-id', req.id);
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cross-origin-resource-policy', 'same-site');
    if (svc.config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });
  app.addHook('onRequest', async (req) => { (req as any).startedAt = process.hrtime.bigint(); });
  app.addHook('onResponse', async (req, reply) => {
    const started = (req as any).startedAt as bigint | undefined;
    const route = (req.routeOptions?.url ?? 'unmatched') as string;
    metrics.observe(req.method, route, reply.statusCode, started ? Number(process.hrtime.bigint() - started) / 1e9 : 0);
  });

  // Session -> request context.
  app.addHook('onRequest', async (req) => {
    req.ctx = { correlationId: req.id };
    const token = req.cookies?.earlio_sid;
    if (!token) return;
    const row = await svc.db.system((tx) =>
      tx.maybe<any>(
        `select s.id, s.user_id, s.org_id, s.mfa_verified, s.csrf_token, s.expires_at, u.email, u.name as user_name, u.mfa_enabled,
                o.type as org_type, o.legal_name as org_name, m.role
           from identity.sessions s
           join identity.users u on u.id = s.user_id
           left join identity.organisations o on o.id = s.org_id
           left join identity.memberships m on m.user_id = s.user_id and m.org_id = s.org_id
          where s.id = $1`, [hashToken(token)]));
    if (!row || new Date(row.expires_at) <= svc.clock.now()) return;
    req.auth = {
      sessionId: row.id, userId: row.user_id, email: row.email, userName: row.user_name, orgId: row.org_id,
      orgType: row.org_type, orgName: row.org_name, role: row.role, mfaVerified: row.mfa_verified, mfaEnabled: row.mfa_enabled, csrfToken: row.csrf_token,
    };
    req.ctx = { correlationId: req.id, userId: row.user_id, orgId: row.org_id ?? undefined, role: row.role ?? undefined };
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({ code: err.code, message: err.message, details: err.details ?? null });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ code: 'validation', message: validationMessage(err.validation), details: err.validation });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response does not match schema');
      return reply.code(500).send({ code: 'internal', message: 'Internal error.', details: null });
    }
    if (err.statusCode === 429) return reply.code(429).send({ code: 'rate_limited', message: 'Too many requests. Please wait and try again.', details: null });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ code: 'bad_request', message: err.message, details: null });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal', message: 'Internal error.', details: null });
  });

  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/health', {
    schema: { tags: ['system'], summary: 'Liveness and database check', response: { 200: z.object({ status: z.literal('ok'), db: z.boolean(), time: z.string() }) } },
  }, async () => {
    await svc.db.pool.query('select 1');
    return { status: 'ok' as const, db: true, time: svc.clock.now().toISOString() };
  });
  r.get('/ready', {
    schema: { tags: ['system'], summary: 'Readiness: database reachable, migrations applied, outbox not stuck', response: { 200: z.object({ ready: z.literal(true), migrations: z.number(), outboxBacklog: z.number() }), 503: z.object({ ready: z.literal(false), reason: z.string() }) } },
  }, async (_req, reply) => {
    try {
      const m = await svc.db.pool.query('select count(*)::int as n from public.schema_migrations');
      const o = await svc.db.system((tx) => tx.one<{ n: number }>("select count(*)::int as n from platform.outbox where processed_at is null and created_at < $1", [new Date(svc.clock.now().getTime() - 15 * 60_000)]));
      if (o.n > 1000) return reply.code(503).send({ ready: false as const, reason: `outbox backlog ${o.n}` });
      return { ready: true as const, migrations: m.rows[0].n as number, outboxBacklog: o.n };
    } catch (e) { return reply.code(503).send({ ready: false as const, reason: (e as Error).message.slice(0, 120) }); }
  });
  app.get('/metrics', { schema: { hide: true } as any }, async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (svc.config.env === 'production' && (!token || req.headers.authorization !== `Bearer ${token}`)) return reply.code(401).send({ code: 'unauthenticated', message: 'Metrics need the scrape token.', details: null });
    const backlog = await svc.db.system((tx) => tx.one<{ n: number }>('select count(*)::int as n from platform.outbox where processed_at is null'));
    return reply.header('content-type', 'text/plain; version=0.0.4').send(metrics.render({ earlio_outbox_pending: backlog.n, earlio_db_pool_waiting: svc.db.pool.waitingCount, earlio_db_pool_total: svc.db.pool.totalCount }));
  });
  r.get('/api/v1/system/config', {
    schema: { tags: ['system'], summary: 'Public runtime configuration for the SPA',
      response: { 200: z.object({ env: z.string(), simulated: z.boolean(), mode: z.enum(['network', 'white-label']), apiVersion: z.string() }) } },
  }, async () => ({ env: svc.config.env, simulated: svc.config.simulatedBanner, mode: await svc.db.system((tx) => currentMode(tx, svc)), apiVersion: '0.1.0' }));
  app.get('/openapi.json', { schema: { hide: true } as any }, async () => app.swagger());

  await app.register(async (a) => identityRoutes(a));
  await app.register(async (a) => auditRoutes(a));
  await registerModules(app);
  return app;
}

/** Turns schema validation issues into one plain-language sentence naming the fields at fault. */
export function validationMessage(issues: { instancePath: string; message?: string }[]): string {
  const parts = issues.slice(0, 3).map((i) => {
    const field = i.instancePath.split('/').filter(Boolean).join('.');
    const msg = (i.message ?? 'is not valid').replace(/^Invalid input: /, '');
    if (/received undefined$/.test(msg)) return field ? `${field} is required` : 'the request is empty';
    return field ? `${field}: ${msg}` : msg;
  });
  const more = issues.length > 3 ? ` (and ${issues.length - 3} more)` : '';
  return `Some details are missing or not valid: ${parts.join('; ')}${more}.`;
}
