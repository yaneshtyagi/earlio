import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireOrgType, requirePerm } from '../../http/context';
import { DomainError, invalid } from '../../kernel/errors';
import type { Ctx } from '../../db/pool';
import { INSTRUCTION_COLUMNS } from './service';
import { toCsv } from './csv';
import * as S from './service';

const keyShape = z.object({ id: z.string(), label: z.string(), prefix: z.string(), status: z.string(), expiresAt: z.string().nullable(), createdAt: z.string(), lastUsedAt: z.string().nullable() });
const issued = keyShape.extend({ apiKey: z.string(), signingSecret: z.string() });
const batchOut = z.object({ id: z.string(), rowsTotal: z.number(), rowsOk: z.number(), errors: z.array(z.object({ row: z.number(), message: z.string() })) });
const lineIn = z.object({ bankTxnId: z.string().min(1).max(80), reference: z.string().max(80).nullable().optional(), currency: z.enum(['USD', 'SGD']), amount: z.string().regex(/^\d+(\.\d{1,2})?$/), valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), payer: z.string().max(120).nullable().optional() });
const offerIn = z.object({ invoiceId: z.string(), ratePct: z.number().optional(), advancePct: z.number().optional(), fxSpreadPct: z.number().optional(), validityHours: z.number().optional() });
const fileIn = z.object({ filename: z.string().min(1).max(120), content: z.string().min(1).max(2_000_000) });

export function integrationRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const bankAdmin = async (req: FastifyRequest, reply: any) => { await requireOrgType('bank')(req, reply); await requirePerm('org:manage_users')(req, reply); };
  const bankOps = async (req: FastifyRequest, reply: any) => { await requireOrgType('bank')(req, reply); await requirePerm('settlement:operate')(req, reply); };
  const bankCredit = async (req: FastifyRequest, reply: any) => { await requireOrgType('bank')(req, reply); await requirePerm('offer:submit')(req, reply); };
  const org = (req: FastifyRequest) => req.auth!.orgId!;

  // ------------------------------------------------ console: keys, webhooks, files (session-authenticated)
  r.get('/api/v1/bank/api-keys', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'API keys of my bank (secrets are never shown again)', response: { 200: z.object({ items: z.array(keyShape) }) } } },
    async (req) => ({ items: await svc.db.tx(req.ctx, (tx) => S.listKeys(tx, org(req))) }));
  r.post('/api/v1/bank/api-keys', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'Create an API key. The key and its signing secret are returned once.', body: z.object({ label: z.string().min(1).max(60) }), response: { 201: issued } } },
    async (req, reply) => reply.code(201).send(await svc.db.tx(req.ctx, (tx) => S.createKey(tx, svc, req.ctx, org(req), req.body.label))));
  r.post('/api/v1/bank/api-keys/:id/rotate', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'Rotate: issues a new key; the old key keeps working for 24 hours', params: z.object({ id: z.string().uuid() }), response: { 200: issued } } },
    async (req) => svc.db.tx(req.ctx, (tx) => S.rotateKey(tx, svc, req.ctx, org(req), req.params.id)));
  r.post('/api/v1/bank/api-keys/:id/revoke', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'Revoke a key immediately', params: z.object({ id: z.string().uuid() }), response: { 204: z.null() } } },
    async (req, reply) => { await svc.db.tx(req.ctx, (tx) => S.revokeKey(tx, svc, req.ctx, org(req), req.params.id)); return reply.code(204).send(null); });

  r.get('/api/v1/bank/webhooks', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'Webhook endpoints and recent deliveries', response: { 200: z.object({ items: z.array(z.object({ id: z.string(), url: z.string(), events: z.array(z.string()), active: z.boolean() })), deliveries: z.array(z.object({ id: z.number(), eventType: z.string(), status: z.string(), attempts: z.number(), lastError: z.string().nullable(), createdAt: z.string() })) }) } } },
    async (req) => svc.db.tx(req.ctx, async (tx) => ({ items: await S.listWebhooks(tx, org(req)), deliveries: await S.listDeliveries(tx, org(req)) })));
  r.post('/api/v1/bank/webhooks', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'Register a webhook endpoint (events empty = all)', body: z.object({ url: z.string().max(300), events: z.array(z.string().max(60)).max(30).default([]) }), response: { 201: z.object({ id: z.string(), url: z.string(), events: z.array(z.string()), active: z.boolean() }) } } },
    async (req, reply) => reply.code(201).send(await svc.db.tx(req.ctx, (tx) => S.addWebhook(tx, svc, req.ctx, org(req), req.body.url, req.body.events))));
  r.delete('/api/v1/bank/webhooks/:id', { preHandler: bankAdmin, schema: { tags: ['integration'], summary: 'Remove a webhook endpoint', params: z.object({ id: z.string().uuid() }), response: { 204: z.null() } } },
    async (req, reply) => { await svc.db.tx(req.ctx, (tx) => S.removeWebhook(tx, svc, req.ctx, org(req), req.params.id)); return reply.code(204).send(null); });

  r.get('/api/v1/bank/file-batches', { preHandler: bankOps, schema: { tags: ['integration'], summary: 'File-drop history', response: { 200: z.object({ items: z.array(batchOut.extend({ kind: z.string(), filename: z.string(), createdAt: z.string() })) }) } } },
    async (req) => ({ items: await svc.db.tx(req.ctx, (tx) => S.listBatches(tx, org(req))) }));
  r.post('/api/v1/bank/files/offers', { preHandler: bankCredit, schema: { tags: ['integration'], summary: 'File drop: offers in (CSV: invoice,ratePct,advancePct,fxSpreadPct,validityHours)', body: fileIn, response: { 200: batchOut } } },
    async (req) => svc.db.tx(req.ctx, (tx) => S.importOffersCsv(tx, svc, req.ctx, org(req), req.body.filename, req.body.content)));
  r.post('/api/v1/bank/files/statements', { preHandler: bankOps, schema: { tags: ['integration'], summary: 'File drop: statement in (CSV: bankTxnId,reference,currency,amount,valueDate,payer)', body: fileIn, response: { 200: batchOut } } },
    async (req) => svc.db.tx(req.ctx, (tx) => S.importStatementCsv(tx, svc, req.ctx, org(req), req.body.filename, req.body.content)));
  r.get('/api/v1/bank/files/instructions', { preHandler: bankOps, schema: { tags: ['integration'], summary: 'File drop: disbursement instructions out (CSV)' } },
    async (req, reply) => {
      const csv = await svc.db.tx(req.ctx, (tx) => S.instructionsCsv(tx, svc, org(req)));
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="instructions.csv"').send(csv);
    });

  // ------------------------------------------------ machine API (API key + signed requests)
  app.register(async (a) => {
    a.addContentTypeParser(['application/json', 'text/csv'], { parseAs: 'string' }, (_req, body, done) => done(null, body));
    const mr = a.withTypeProvider<ZodTypeProvider>();
    const auth = async (req: FastifyRequest) => {
      const p = await S.authenticateKey(svc, req.headers.authorization);
      const org = await svc.db.system((tx) => tx.maybe<any>("select id from identity.organisations where id = $1 and type = 'bank' and kyc_status = 'approved'", [p.orgId]));
      if (!org) throw new DomainError('bad_api_key', 'The API key is missing, wrong, expired or revoked.', 401);
      return p;
    };
    const ctxFor = (orgId: string, req: FastifyRequest): Ctx => ({ orgId, role: 'Operations' as any, correlationId: `api-${String(req.id)}` });
    const json = <T extends z.ZodTypeAny>(raw: unknown, schema: T): z.infer<T> => {
      try { return schema.parse(JSON.parse(String(raw ?? ''))); } catch { throw invalid('The request body is not valid.'); }
    };
    /** Signed write: authenticate, verify the signature over the raw body, then run as the bank. */
    const signed = async <T>(req: FastifyRequest, fn: (tx: import('../../db/pool').Tx, ctx: Ctx, orgId: string) => Promise<T>) => {
      const p = await auth(req); await S.verifyMachineSignature(svc, p, req.headers, String(req.body ?? ''));
      const ctx = ctxFor(p.orgId, req);
      return svc.db.tx(ctx, (tx) => fn(tx, ctx, p.orgId));
    };
    const read = async <T>(req: FastifyRequest, fn: (tx: import('../../db/pool').Tx, orgId: string) => Promise<T>) => {
      const p = await auth(req); return svc.db.tx(ctxFor(p.orgId, req), (tx) => fn(tx, p.orgId));
    };

    mr.get('/api/v1/machine/invitations', { schema: { tags: ['machine'], summary: 'Invoices open for offers from my bank (Bearer API key)' } },
      async (req) => ({ items: await read(req, (tx, o) => S.openInvitations(tx, o)) }));
    mr.post('/api/v1/machine/offers', { schema: { tags: ['machine'], summary: 'Submit an offer. Signed (HMAC over "timestamp.nonce.body"); send Idempotency-Key to make retries safe.' } },
      async (req, reply) => {
        const body = json(req.body, offerIn); const key = req.headers['idempotency-key'] as string | undefined;
        const out = await signed(req, async (tx, ctx, o) => {
          const offer = await (await import('../marketplace/service')).createOffer(tx, svc, ctx, o, body.invoiceId, { ...body, submit: true, mode: 'api', idempotencyKey: key });
          return { id: offer.id as string, status: offer.status as string };
        });
        return reply.code(201).send(out);
      });
    mr.post('/api/v1/machine/statements', { schema: { tags: ['machine'], summary: 'Push statement lines. Signed.' } },
      async (req) => { const b = json(req.body, z.object({ lines: z.array(lineIn).min(1).max(500) })); return signed(req, (tx, ctx, o) => S.importStatementLines(tx, svc, ctx, o, b.lines.map((l) => ({ ...l, reference: l.reference ?? null })))); });
    mr.get('/api/v1/machine/instructions', { schema: { tags: ['machine'], summary: 'Disbursement instructions waiting for the bank; add ?format=csv for the file form' } },
      async (req, reply) => {
        const items = await read(req, (tx, o) => S.pendingInstructions(tx, o));
        if ((req.query as any)?.format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').send(toCsv(INSTRUCTION_COLUMNS, items));
        return { items };
      });
    mr.post('/api/v1/machine/files/offers', { schema: { tags: ['machine'], summary: 'File drop (text/csv body): offers in. Signed. ?filename=…' } },
      async (req) => signed(req, (tx, ctx, o) => S.importOffersCsv(tx, svc, ctx, o, String((req.query as any)?.filename ?? 'offers.csv'), String(req.body ?? ''))));
    mr.post('/api/v1/machine/files/statements', { schema: { tags: ['machine'], summary: 'File drop (text/csv body): statement in. Signed. ?filename=…' } },
      async (req) => signed(req, (tx, ctx, o) => S.importStatementCsv(tx, svc, ctx, o, String((req.query as any)?.filename ?? 'statement.csv'), String(req.body ?? ''))));
  });
}
