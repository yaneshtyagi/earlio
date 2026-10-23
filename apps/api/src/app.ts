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

export async function buildApp(svc: Services): Promise<FastifyInstance> {
  const app = Fastify({
    logger: svc.config.env === 'test' && !process.env.EARLIO_TEST_LOG ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    genReqId: (req) => (req.headers['x-correlation-id'] as string) || randomUUID(),
    trustProxy: true,
  });
  app.decorate('svc', svc);
  app.decorateRequest('ctx', undefined as any);
  app.decorateRequest('auth', undefined);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(cors, { origin: svc.config.corsOrigins, credentials: true });
  await app.register(rateLimit, { global: false });
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
      return reply.code(400).send({ code: 'validation', message: 'The request is not valid.', details: err.validation });
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
