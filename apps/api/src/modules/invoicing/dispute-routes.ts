import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requireOrgType, requirePerm, requireUser } from '../../http/context';
import { notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { addDisputeMessage, allowedCauses, decideDispute, saveTimers, startReview, withdrawDispute } from './disputes';
import { issueCreditNote, creditNotesFor } from './credit-notes';
import { disputeTimers } from './service';

const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount with at most two decimals.');
const disputeOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), status: z.string(), phase: z.string(), reason: z.string(), amount: z.string().nullable(), cause: z.string().nullable(), outcome: z.string().nullable(),
  raisedByOrg: z.string(), raisedByName: z.string(), supplierName: z.string(), buyerName: z.string(), createdAt: z.string(), responseDueAt: z.string().nullable(), escalateAt: z.string().nullable(), timeoutAt: z.string().nullable(),
  resolvedAt: z.string().nullable(), decisionNote: z.string().nullable(), creditAmount: z.string().nullable(), financed: z.boolean(),
});
const cnOut = z.object({ id: z.string(), number: z.string(), stage: z.string(), currency: z.string(), amount: z.string(), priorAmount: z.string(), newAmount: z.string(), supplierOwes: z.string(), reason: z.string(), createdAt: z.string() });

export function disputeRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const ctxOf = (req: FastifyRequest) => (req.auth!.orgType === 'platform' ? platformCtx(req) : req.ctx);

  async function rows(tx: any, where: string, params: unknown[]) {
    const ds = await tx.query(`select * from invoicing.disputes d where d.freezes ${where} order by d.created_at desc limit 200`, params);
    if (!ds.length) return [];
    const meta = await tx.elevated(async () => {
      const inv = await tx.query('select i.id, i.human_id, s.legal_name as supplier, b.legal_name as buyer from invoicing.invoices i join identity.organisations s on s.id = i.supplier_org_id join identity.organisations b on b.id = i.buyer_org_id where i.id = any($1::uuid[])', [ds.map((d: any) => d.invoice_id)]);
      return new Map<string, any>(inv.map((i: any) => [i.id, i]));
    });
    return ds.map((d: any) => {
      const m = meta.get(d.invoice_id);
      return {
        id: d.id, invoiceId: d.invoice_id, invoiceNumber: m?.human_id ?? '', status: d.status, phase: d.phase, reason: d.reason, amount: d.amount, cause: d.cause, outcome: d.outcome, raisedByOrg: d.raised_by_org,
        raisedByName: d.raised_by_org === d.buyer_org_id ? m?.buyer : m?.supplier, supplierName: m?.supplier ?? '', buyerName: m?.buyer ?? '', createdAt: iso(d.created_at)!, responseDueAt: iso(d.response_due_at), escalateAt: iso(d.escalate_at),
        timeoutAt: iso(d.timeout_at), resolvedAt: iso(d.resolved_at), decisionNote: d.decision_note, creditAmount: d.credit_amount, financed: !!d.bank_org_id,
      };
    });
  }

  r.get('/api/v1/disputes', {
    preHandler: requireUser,
    schema: { tags: ['disputes'], summary: 'Disputes my organisation is party to (platform staff see the whole queue)', querystring: z.object({ status: z.enum(['open', 'resolved']).optional() }),
      response: { 200: z.object({ items: z.array(disputeOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({
    items: await rows(tx, req.query.status === 'open' ? "and d.status in ('Open','UnderReview','Escalated')" : req.query.status === 'resolved' ? "and d.status in ('ResolvedForBuyer','ResolvedForSupplier','TimedOut')" : '', []),
  })));

  r.get('/api/v1/disputes/:id', {
    preHandler: requireUser,
    schema: { tags: ['disputes'], summary: 'Dispute with its thread, evidence and timers', params: z.object({ id: z.string().uuid() }),
      response: { 200: z.object({ dispute: disputeOut, causes: z.array(z.string()),
        messages: z.array(z.object({ id: z.string(), kind: z.string(), authorName: z.string(), body: z.string(), fileId: z.string().nullable(), createdAt: z.string() })) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => {
    const [dispute] = await rows(tx, 'and d.id = $1', [req.params.id]);
    if (!dispute) throw notFound('Dispute');
    const ms = await tx.query<any>('select * from invoicing.dispute_messages where dispute_id = $1 order by id', [req.params.id]);
    return { dispute, causes: await allowedCauses(tx), messages: ms.map((m) => ({ id: String(m.id), kind: m.kind, authorName: m.author_name, body: m.body, fileId: m.file_id, createdAt: iso(m.created_at)! })) };
  }));

  r.post('/api/v1/disputes/:id/messages', {
    preHandler: requireUser,
    schema: { tags: ['disputes'], summary: 'Post a message or attach evidence to a dispute', params: z.object({ id: z.string().uuid() }),
      body: z.object({ body: z.string().min(1).max(4000), fileId: z.string().uuid().optional(), kind: z.enum(['message', 'evidence']).default('message') }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    await svc.db.tx(ctxOf(req), (tx) => addDisputeMessage(tx, svc, req.ctx, req.params.id, req.auth!.orgType === 'platform' ? null : req.auth!.orgId!, req.body));
    return reply.code(204).send();
  });

  r.post('/api/v1/disputes/:id/withdraw', {
    preHandler: async (req, reply) => { await requireOrgType('supplier', 'buyer')(req, reply); await requirePerm('dispute:raise')(req, reply); },
    schema: { tags: ['disputes'], summary: 'Withdraw a dispute I raised (concedes the point)', params: z.object({ id: z.string().uuid() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => tx.elevated(() => withdrawDispute(tx, svc, req.ctx, req.params.id, req.auth!.orgId!))); return reply.code(204).send(); });

  r.post('/api/v1/disputes/:id/review', {
    preHandler: requirePerm('dispute:decide'),
    schema: { tags: ['disputes'], summary: 'Platform: start reviewing a dispute', params: z.object({ id: z.string().uuid() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(platformCtx(req), (tx) => startReview(tx, svc, platformCtx(req), req.params.id)); return reply.code(204).send(); });

  r.post('/api/v1/disputes/:id/decision', {
    preHandler: requirePerm('dispute:decide'),
    schema: { tags: ['disputes'], summary: 'Platform: decide a dispute; the decision is applied to the invoice and its financing (credit note, recourse, unfreeze)', params: z.object({ id: z.string().uuid() }),
      body: z.object({ outcome: z.enum(['buyer', 'supplier']), cause: z.string().max(60).optional(), creditAmount: money.optional(), note: z.string().min(3).max(2000) }),
      response: { 200: z.object({ status: z.string(), creditNote: z.string().nullable(), recourseId: z.string().nullable() }) } },
  }, async (req) => svc.db.tx(platformCtx(req), (tx) => decideDispute(tx, svc, platformCtx(req), req.params.id, req.body)));

  // ---- credit notes (BR-13)
  r.post('/api/v1/invoices/:id/credit-notes', {
    preHandler: async (req, reply) => { await requireOrgType('buyer')(req, reply); await requirePerm('dispute:raise')(req, reply); },
    schema: { tags: ['invoices'], summary: 'Buyer issues a credit note (before funding it reduces the invoice; after funding it reduces exposure)', params: z.object({ id: z.string() }),
      body: z.object({ amount: money, reason: z.string().min(3).max(1000) }), response: { 201: cnOut } },
  }, async (req, reply) => {
    const cn = await svc.db.tx(req.ctx, (tx) => issueCreditNote(tx, svc, req.ctx, req.params.id, req.auth!.orgId!, req.body));
    return reply.code(201).send(toCn(cn));
  });
  const toCn = (c: any) => ({ id: c.id, number: c.number, stage: c.stage, currency: c.currency, amount: c.amount, priorAmount: c.prior_amount, newAmount: c.new_amount, supplierOwes: c.supplier_owes, reason: c.reason, createdAt: iso(c.created_at)! });
  r.get('/api/v1/invoices/:id/credit-notes', {
    preHandler: requireUser,
    schema: { tags: ['invoices'], summary: 'Credit notes on an invoice', params: z.object({ id: z.string() }), response: { 200: z.object({ items: z.array(cnOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({ items: (await creditNotesFor(tx, req.params.id)).map(toCn) })));

  // ---- admin console (ADM-04): configurable timers
  const timers = z.object({ responseHours: z.number().positive().max(24 * 60), escalateAfterHours: z.number().positive().max(24 * 90), timeoutAfterHours: z.number().positive().max(24 * 365) });
  r.get('/api/v1/admin/dispute-timers', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['admin'], summary: 'Dispute timers', response: { 200: timers } },
  }, async (req) => svc.db.tx(platformCtx(req), (tx) => disputeTimers(tx)));
  void audit;
}
