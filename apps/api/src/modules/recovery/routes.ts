import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requireOrgType, requirePerm, requireUser } from '../../http/context';
import { notFound } from '../../kernel/errors';
import { decideClaim, defaultView, fileClaim, payClaim, recordRecovery, reportInsolvency, reviewClaim, CLAIM_DOC_TYPES } from './service';
import { recordRecoursePayment, setRecourseMode } from './recourse';
import { reportProceeds } from '../settlement/export';

const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));
const day = (d: any) => (d == null ? null : String(d).slice(0, 10));
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount with at most two decimals.');

const defOut = z.object({
  invoiceId: z.string(), invoiceNumber: z.string(), status: z.string(), currency: z.string(), principal: z.string(), financingRatePct: z.string(), dueDate: z.string(), overdueDays: z.number(), frozenDays: z.number(),
  lateInterest: z.string(), waitingDays: z.number(), waitingEndsOn: z.string(), claimDeadlineOn: z.string().nullable(), insolvency: z.boolean(), dunningLevel: z.number(), insured: z.boolean(),
  bankName: z.string(), buyerName: z.string(), supplierName: z.string(),
});
const waterfallOut = z.object({ bankClaim: z.string(), payout: z.string(), toBank: z.string(), toSupplier: z.string(), bankShortfall: z.string(), supplierLoss: z.string(), insurerLoss: z.string() }).nullable();
const claimOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), status: z.string(), currency: z.string(), faceAmount: z.string(), advanceAmount: z.string(), coverPct: z.string(), claimedAmount: z.string(), approvedAmount: z.string().nullable(),
  decisionReason: z.string().nullable(), exclusions: z.array(z.object({ code: z.string(), detail: z.string() })), documents: z.array(z.object({ docType: z.string(), fileId: z.string() })), waterfall: waterfallOut,
  filedAt: z.string(), decidedAt: z.string().nullable(), paidAt: z.string().nullable(), bankName: z.string(), insurerName: z.string(), supplierName: z.string(),
  recoveries: z.array(z.object({ id: z.string(), gross: z.string(), costs: z.string(), net: z.string(), shares: z.record(z.string(), z.string()), note: z.string().nullable(), at: z.string() })),
});
const recourseOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), currency: z.string(), cause: z.string(), amountOwed: z.string(), outstanding: z.string(), smallSupplier: z.boolean(), mode: z.string(), status: z.string(),
  plan: z.array(z.object({ dueOn: z.string(), amount: z.string(), paid: z.boolean() })).nullable(), note: z.string().nullable(), supplierName: z.string(), bankName: z.string(), createdAt: z.string(),
  payments: z.array(z.object({ amount: z.string(), source: z.string(), note: z.string().nullable(), at: z.string() })),
});
const proceedsOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), currency: z.string(), amountForeign: z.string(), shipmentDate: z.string(), realisationDeadline: z.string(), status: z.string(),
  realisedInr: z.string(), realisedAt: z.string().nullable(), reportedAt: z.string().nullable(), chainBroken: z.boolean(), chainNote: z.string().nullable(), daysLeft: z.number(),
});

export function recoveryRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const ctxOf = (req: FastifyRequest) => (req.auth!.orgType === 'platform' ? platformCtx(req) : req.ctx);
  const names = `(select legal_name from identity.organisations o where o.id = `;

  // ---------------------------------------------------------------- overdue and default
  const DEF_SQL = `select d.*, ${names}d.bank_org_id) as bank_name, ${names}d.buyer_org_id) as buyer_name, ${names}d.supplier_org_id) as supplier_name from recovery.defaults d`;
  const toDef = (d: any, now: Date) => {
    const v = defaultView(d, now);
    return { invoiceId: d.invoice_id, invoiceNumber: d.invoice_number, status: d.status, currency: d.currency, principal: d.principal, financingRatePct: String(Number(d.financing_rate_pct)), dueDate: day(d.due_date)!, overdueDays: v.overdueDays,
      frozenDays: v.frozenDays, lateInterest: v.lateInterest, waitingDays: d.waiting_days, waitingEndsOn: v.waitingEndsOn, claimDeadlineOn: day(d.claim_deadline_on), insolvency: d.insolvency, dunningLevel: d.dunning_level,
      insured: !!d.insurer_org_id, bankName: d.bank_name, buyerName: d.buyer_name, supplierName: d.supplier_name };
  };
  r.get('/api/v1/recovery/defaults', {
    preHandler: requireUser,
    schema: { tags: ['recovery'], summary: 'Overdue and defaulted financed invoices with late interest, waiting period and claim deadline', response: { 200: z.object({ items: z.array(defOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({ items: (await tx.query<any>(`${DEF_SQL} order by d.due_date`)).map((d) => toDef(d, svc.clock.now())) })));

  r.get('/api/v1/recovery/defaults/:invoiceId', {
    preHandler: requireUser,
    schema: { tags: ['recovery'], summary: 'One default, with the live late-interest figure', params: z.object({ invoiceId: z.string().uuid() }), response: { 200: defOut } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => {
    const d = await tx.maybe<any>(`${DEF_SQL} where d.invoice_id = $1`, [req.params.invoiceId]);
    if (!d) throw notFound('Default');
    return toDef(d, svc.clock.now());
  }));

  r.post('/api/v1/recovery/defaults/:invoiceId/insolvency', {
    preHandler: async (req, reply) => { await requireUser(req, reply); if (req.auth!.orgType === 'bank') await requirePerm('claim:file')(req, reply); else await requirePerm('platform:admin')(req, reply); },
    schema: { tags: ['recovery'], summary: 'Report a buyer insolvency event: the waiting period is waived (A-14)', params: z.object({ invoiceId: z.string().uuid() }), body: z.object({ reference: z.string().min(3).max(200) }), response: { 204: z.undefined() } },
  }, async (req, reply) => {
    await svc.db.tx(ctxOf(req), (tx) => reportInsolvency(tx, svc, req.ctx, req.auth!.orgType === 'bank' ? req.auth!.orgId! : null, req.params.invoiceId, req.body.reference));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- claims
  const CL_SQL = `select c.*, ${names}c.bank_org_id) as bank_name, ${names}c.insurer_org_id) as insurer_name, ${names}c.supplier_org_id) as supplier_name from recovery.claims c`;
  const toClaim = (c: any, recs: any[]) => ({
    id: c.id, invoiceId: c.invoice_id, invoiceNumber: c.invoice_number, status: c.status, currency: c.currency, faceAmount: c.face_amount, advanceAmount: c.advance_amount, coverPct: String(Number(c.cover_pct)), claimedAmount: c.claimed_amount,
    approvedAmount: c.approved_amount, decisionReason: c.decision_reason, exclusions: c.exclusions, documents: c.documents, waterfall: c.waterfall ?? null, filedAt: iso(c.filed_at)!, decidedAt: iso(c.decided_at), paidAt: iso(c.paid_at),
    bankName: c.bank_name, insurerName: c.insurer_name, supplierName: c.supplier_name,
    recoveries: recs.map((x) => ({ id: x.id, gross: x.gross, costs: x.costs, net: x.net, shares: x.shares, note: x.note, at: iso(x.at)! })),
  });
  const claimWith = async (tx: any, where: string, params: unknown[]) => {
    const cs = await tx.query(`${CL_SQL} ${where} order by c.filed_at desc`, params);
    const out = [];
    for (const c of cs) out.push(toClaim(c, await tx.query('select * from recovery.recoveries where claim_id = $1 order by at', [c.id])));
    return out;
  };

  r.post('/api/v1/invoices/:id/claims', {
    preHandler: async (req, reply) => { await requireOrgType('bank')(req, reply); await requirePerm('claim:file')(req, reply); },
    schema: { tags: ['recovery'], summary: 'Bank files an insurance claim once the waiting period has ended (or the buyer is insolvent)', params: z.object({ id: z.string().uuid() }),
      body: z.object({ documents: z.array(z.object({ docType: z.enum(CLAIM_DOC_TYPES), fileId: z.string().uuid() })).max(20) }), response: { 201: claimOut } },
  }, async (req, reply) => {
    const id = await svc.db.tx(req.ctx, async (tx) => (await fileClaim(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.documents)).id);
    const [c] = await svc.db.tx(req.ctx, (tx) => claimWith(tx, 'where c.id = $1', [id]));
    return reply.code(201).send(c!);
  });
  r.get('/api/v1/claims', {
    preHandler: requireUser,
    schema: { tags: ['recovery'], summary: 'Claims my organisation is party to', response: { 200: z.object({ items: z.array(claimOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({ items: await claimWith(tx, '', []) })));
  r.get('/api/v1/claims/:id', {
    preHandler: requireUser,
    schema: { tags: ['recovery'], summary: 'One claim with documents, exclusions, waterfall and recoveries', params: z.object({ id: z.string().uuid() }), response: { 200: claimOut } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => {
    const [c] = await claimWith(tx, 'where c.id = $1', [req.params.id]);
    if (!c) throw notFound('Claim');
    return c;
  }));
  const claimsDesk = async (req: FastifyRequest, reply: any) => { await requireOrgType('insurer')(req, reply); await requirePerm('claim:decide')(req, reply); };
  r.post('/api/v1/claims/:id/review', {
    preHandler: claimsDesk,
    schema: { tags: ['recovery'], summary: 'Insurer starts reviewing: documents and exclusions are checked', params: z.object({ id: z.string().uuid() }), response: { 200: z.object({ exclusions: z.array(z.object({ code: z.string(), detail: z.string() })) }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => reviewClaim(tx, svc, req.ctx, req.auth!.orgId!, req.params.id)));
  r.post('/api/v1/claims/:id/decision', {
    preHandler: claimsDesk,
    schema: { tags: ['recovery'], summary: 'Insurer approves in full, approves less, or rejects', params: z.object({ id: z.string().uuid() }),
      body: z.object({ decision: z.enum(['approve', 'partial', 'reject']), approvedAmount: money.optional(), reason: z.string().max(2000).optional() }),
      response: { 200: z.object({ status: z.string(), approvedAmount: z.string().nullable(), waterfall: waterfallOut, exclusions: z.array(z.object({ code: z.string(), detail: z.string() })), recourseId: z.string().nullable() }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => decideClaim(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body)));
  r.post('/api/v1/claims/:id/pay', {
    preHandler: claimsDesk,
    schema: { tags: ['recovery'], summary: 'Insurer records the payout; the waterfall pays the bank first, then the supplier’s retention', params: z.object({ id: z.string().uuid() }), response: { 200: waterfallOut } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => payClaim(tx, svc, req.ctx, req.auth!.orgId!, req.params.id)));
  r.post('/api/v1/claims/:id/recoveries', {
    preHandler: async (req, reply) => { await requireOrgType('bank')(req, reply); await requirePerm('claim:file')(req, reply); },
    schema: { tags: ['recovery'], summary: 'Bank records a recovery from the buyer; net of costs it is shared pro rata to losses', params: z.object({ id: z.string().uuid() }),
      body: z.object({ gross: money, costs: money.default('0.00'), note: z.string().max(500).optional() }), response: { 201: z.object({ id: z.string(), net: z.string(), shares: z.record(z.string(), z.string()) }) } },
  }, async (req, reply) => reply.code(201).send(await svc.db.tx(req.ctx, async (tx) => { const x = await recordRecovery(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body); return { id: x.id, net: x.net, shares: { ...x.shares } }; })));

  // ---------------------------------------------------------------- recourse (SUP-09)
  const toRec = (x: any, pays: any[]) => ({ id: x.id, invoiceId: x.invoice_id, invoiceNumber: x.invoice_number, currency: x.currency, cause: x.cause, amountOwed: x.amount_owed, outstanding: x.outstanding, smallSupplier: x.small_supplier,
    mode: x.mode, status: x.status, plan: x.plan, note: x.note, supplierName: x.supplier_name, bankName: x.bank_name, createdAt: iso(x.created_at)!, payments: pays.map((p) => ({ amount: p.amount, source: p.source, note: p.note, at: iso(p.at)! })) });
  r.get('/api/v1/recovery/recourse', {
    preHandler: requireUser,
    schema: { tags: ['recovery'], summary: 'What a supplier owes its bank, in plain terms (or what a bank is owed)', response: { 200: z.object({ items: z.array(recourseOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => {
    const rs = await tx.query<any>(`select x.*, ${names}x.supplier_org_id) as supplier_name, ${names}x.bank_org_id) as bank_name from recovery.recourse x order by x.created_at desc`);
    const out = [];
    for (const x of rs) out.push(toRec(x, await tx.query('select * from recovery.recourse_payments where recourse_id = $1 order by id', [x.id])));
    return { items: out };
  }));
  r.post('/api/v1/recovery/recourse/:id/mode', {
    preHandler: async (req, reply) => { await requireOrgType('supplier')(req, reply); await requirePerm('financing:consent')(req, reply); },
    schema: { tags: ['recovery'], summary: 'Small supplier chooses how to repay: offset of at most 20% of each payout, or a 90-day plan', params: z.object({ id: z.string().uuid() }), body: z.object({ mode: z.enum(['offset_20pct', 'plan_90d']) }),
      response: { 200: z.object({ mode: z.string(), plan: z.array(z.object({ dueOn: z.string(), amount: z.string(), paid: z.boolean() })).nullable() }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => setRecourseMode(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.mode)));
  r.post('/api/v1/recovery/recourse/:id/payments', {
    preHandler: async (req, reply) => { await requireOrgType('bank')(req, reply); await requirePerm('claim:file')(req, reply); },
    schema: { tags: ['recovery'], summary: 'Bank records a repayment received from the supplier', params: z.object({ id: z.string().uuid() }), body: z.object({ amount: money, note: z.string().max(300).optional() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => recordRecoursePayment(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.amount, req.body.note)); return reply.code(204).send(); });

  // ---------------------------------------------------------------- export proceeds (SUP-08)
  r.get('/api/v1/export-proceeds', {
    preHandler: requireUser,
    schema: { tags: ['export'], summary: 'Export proceeds realisation tracker', response: { 200: z.object({ items: z.array(proceedsOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({
    items: (await tx.query<any>('select * from settlement.export_proceeds order by realisation_deadline')).map((p) => ({
      id: p.id, invoiceId: p.invoice_id, invoiceNumber: p.invoice_number, currency: p.currency, amountForeign: p.amount_foreign, shipmentDate: day(p.shipment_date)!, realisationDeadline: day(p.realisation_deadline)!, status: p.status,
      realisedInr: p.realised_inr, realisedAt: iso(p.realised_at), reportedAt: iso(p.reported_at), chainBroken: p.chain_broken, chainNote: p.chain_note,
      daysLeft: Math.round((new Date(day(p.realisation_deadline) + 'T00:00:00Z').getTime() - new Date(svc.clock.now().toISOString().slice(0, 10) + 'T00:00:00Z').getTime()) / 86_400_000),
    })),
  })));
  r.post('/api/v1/export-proceeds/:id/report', {
    preHandler: async (req, reply) => { await requireOrgType('bank')(req, reply); await requirePerm('settlement:operate')(req, reply); },
    schema: { tags: ['export'], summary: 'Authorised dealer bank records that the realisation was reported', params: z.object({ id: z.string().uuid() }), body: z.object({ reference: z.string().min(2).max(100) }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => reportProceeds(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.reference)); return reply.code(204).send(); });
}
