import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireOrgType, requirePerm, requireUser, platformCtx } from '../../http/context';
import { DomainError, forbidden, notFound } from '../../kernel/errors';
import { loadInvoice } from '../invoicing/service';
import { coverForInvoice } from '../insurance/service';
import { quoteForBank } from '../terms/quote';
import { can, isPlatformRole } from '../identity/permissions';
import {
  bankConfirm, bankDecline, cancelFinancing, confirmEarlyPayment, consentFinancing, createOffer, declineInvitation, discountFor, earlyPaymentQuote, fundingGates, openForFunding,
  publishSchedule, recordLienConflict, selectOffer, submitOffer, withdrawOffer, withdrawSchedule,
} from './service';

const both = (...fns: any[]) => async (req: any, reply: any) => { for (const f of fns) await f(req, reply); };
const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));

const gateOut = z.object({ n: z.number(), name: z.string(), ok: z.boolean(), reason: z.string().optional() });
const offerOut = z.object({
  id: z.string(), invoiceId: z.string(), bank: z.object({ id: z.string(), name: z.string() }), status: z.string(), mode: z.string(),
  ratePct: z.string(), advancePct: z.string(), fxSpreadPct: z.string(), netCash: z.string(), netCashInr: z.string(), allInPct: z.string(), currency: z.string(),
  fxRate: z.string(), coverPct: z.number(), insured: z.boolean(), nonRecourse: z.boolean(), supplierBorrowingRatePct: z.number().nullable(), savingVsBorrowingPct: z.string().nullable(),
  breakdown: z.record(z.string(), z.any()), validUntil: z.string(), createdAt: z.string(), expired: z.boolean(),
});
const frOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), offerId: z.string(), status: z.string(), supplier: z.object({ id: z.string(), name: z.string() }), bank: z.object({ id: z.string(), name: z.string() }),
  buyerName: z.string(), currency: z.string(), amount: z.string(), netCash: z.string(), netCashInr: z.string(), allInPct: z.string(), consentText: z.string().nullable(), consentedAt: z.string().nullable(),
  decisionReason: z.string().nullable(), disbursementRef: z.string().nullable(), fundedAt: z.string().nullable(), createdAt: z.string(),
  assignmentAcknowledged: z.boolean(), noticeRef: z.string().nullable(),
});
const scheduleIn = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('table'), entries: z.array(z.object({ payBy: z.string(), discountPct: z.number() })).min(1).max(12) }),
  z.object({ mode: z.literal('annual_rate'), annualRatePct: z.number() }),
]);

export function marketplaceRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const supplierOnly = (perm: any) => both(requireOrgType('supplier'), requirePerm(perm));
  const bankOnly = (perm: any) => both(requireOrgType('bank'), requirePerm(perm));

  const OFFER_SQL = `select o.*, b.legal_name as bank_name from marketplace.offers o join identity.organisations b on b.id = o.bank_org_id`;
  const toOffer = (o: any, now: Date) => ({
    id: o.id, invoiceId: o.invoice_id, bank: { id: o.bank_org_id, name: o.bank_name }, status: o.status, mode: o.mode, ratePct: D2(o.rate_pct), advancePct: D2(o.advance_pct), fxSpreadPct: D2(o.fx_spread_pct),
    netCash: o.net_cash, netCashInr: o.net_cash_inr, allInPct: o.all_in_pct, currency: o.currency, fxRate: o.quote.fx.rate, coverPct: o.quote.coverPct, insured: true, nonRecourse: true,
    supplierBorrowingRatePct: o.quote.supplierBorrowingRatePct ?? null, savingVsBorrowingPct: o.quote.savingVsBorrowingPct ?? null, breakdown: o.quote.breakdown,
    validUntil: iso(o.valid_until)!, createdAt: iso(o.created_at)!, expired: new Date(o.valid_until) <= now,
  });
  const D2 = (v: any) => String(Number(v));

  // ---------------- opening for funding
  r.post('/api/v1/invoices/:id/open-funding', {
    preHandler: supplierOnly('discount:manage'),
    schema: { tags: ['marketplace'], summary: 'Run the funding gates and invite banks (Accepted → OpenForFunding, or NotEligible with reasons)', params: z.object({ id: z.string() }),
      response: { 200: z.object({ opened: z.boolean(), gates: z.array(gateOut), invited: z.number() }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => openForFunding(tx, svc, req.ctx, req.params.id)));

  r.get('/api/v1/invoices/:id/funding-gates', {
    preHandler: requireUser,
    schema: { tags: ['marketplace'], summary: 'Funding gates 1 to 4 for this invoice, in plain language', params: z.object({ id: z.string() }), response: { 200: z.object({ gates: z.array(gateOut) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => ({ gates: await fundingGates(tx, svc, await loadInvoice(tx, req.params.id), { forFunding: true }) })));

  // ---------------- offers
  r.get('/api/v1/invoices/:id/offers', {
    preHandler: both(requireOrgType('supplier', 'bank', 'buyer'), requirePerm('read')),
    schema: { tags: ['marketplace'], summary: 'Offers side by side (supplier: all live offers; bank: my own offers) with the early-payment option',
      params: z.object({ id: z.string() }),
      response: { 200: z.object({ route: z.string().nullable(), offers: z.array(offerOut), earlyPayment: z.object({ available: z.boolean(), reason: z.string().nullable(), schedule: z.record(z.string(), z.any()).nullable(),
        today: z.record(z.string(), z.any()).nullable() }) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const inv = await loadInvoice(tx, req.params.id);
    if (req.auth!.orgType === 'buyer') throw forbidden('Bank rates are between the supplier and the bank.');
    const now = svc.clock.now();
    const rows = await tx.query<any>(`${OFFER_SQL} where o.invoice_id = $1 and ($2::boolean or o.status in ('Submitted','Selected','Drafted','Expired','Withdrawn','Superseded','Rejected')) order by (o.status = 'Selected') desc, o.all_in_pct asc`, [inv.id, true]);
    const offers = rows.map((o) => toOffer(o, now));
    const s = req.auth!.orgType === 'supplier' ? await tx.maybe<any>("select * from marketplace.discount_schedules where invoice_id = $1 and status in ('published','used')", [inv.id]) : null;
    let today = null as Record<string, any> | null, reason: string | null = null;
    if (!s) reason = 'Publish a discount schedule to offer early payment.';
    else if (s.status === 'used') reason = 'The buyer already paid early.';
    else if (inv.route === 'financing') reason = 'A bank financing is in progress.';
    else {
      const d = discountFor(s, now.toISOString().slice(0, 10), String(inv.due_date).slice(0, 10));
      if (d) { const q = await earlyPaymentQuote(tx, svc, inv, now.toISOString().slice(0, 10), 'bank_loan'); today = { ...q, annualisedCostPct: q.annualisedCostPct }; } else reason = 'The schedule gives no discount for today.';
    }
    return { route: inv.route, offers, earlyPayment: { available: !!today, reason, schedule: s ? { mode: s.mode, entries: s.entries, annualRatePct: s.annual_rate_pct, status: s.status } : null, today } };
  }));

  r.post('/api/v1/invoices/:id/offers/preview', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Price an offer within my terms without sending it (offer composer)', params: z.object({ id: z.string() }),
      body: z.object({ ratePct: z.number().optional(), advancePct: z.number().optional(), fxSpreadPct: z.number().optional(), validityHours: z.number().optional() }),
      response: { 200: z.object({ eligible: z.boolean(), reasons: z.array(z.string()), gate: z.string().nullable(), quote: z.record(z.string(), z.any()).nullable() }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const inv = await loadInvoice(tx, req.params.id);
    const q = await quoteForBank(tx, svc, inv, req.auth!.orgId!, { overrides: req.body });
    return { eligible: q.evaluation.eligible, reasons: q.evaluation.reasons, gate: q.evaluation.gate ?? null, quote: (q.evaluation.quote ?? null) as Record<string, any> | null };
  }));

  r.post('/api/v1/invoices/:id/offers', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Create (and by default send) an offer. Send an Idempotency-Key header to make retries safe (API offers).', params: z.object({ id: z.string() }),
      headers: z.object({ 'idempotency-key': z.string().max(100).optional() }),
      body: z.object({ ratePct: z.number().optional(), advancePct: z.number().optional(), fxSpreadPct: z.number().optional(), validityHours: z.number().optional(), submit: z.boolean().default(true), mode: z.enum(['manual', 'api']).default('manual') }),
      response: { 201: offerOut } },
  }, async (req, reply) => {
    const key = req.headers['idempotency-key'] as string | undefined;
    const row = await svc.db.tx(req.ctx, async (tx) => {
      const o = await createOffer(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, { ...req.body, idempotencyKey: key });
      return tx.one<any>(`${OFFER_SQL} where o.id = $1`, [o.id]);
    });
    return reply.code(201).send(toOffer(row, svc.clock.now()));
  });

  r.post('/api/v1/offers/:id/submit', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Send a drafted offer (re-priced at send time)', params: z.object({ id: z.string().uuid() }), response: { 200: offerOut } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => { const o = await submitOffer(tx, svc, req.ctx, req.auth!.orgId!, req.params.id); return toOffer(await tx.one(`${OFFER_SQL} where o.id = $1`, [o.id]), svc.clock.now()); }));

  r.post('/api/v1/offers/:id/withdraw', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Withdraw my offer', params: z.object({ id: z.string().uuid() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => withdrawOffer(tx, svc, req.ctx, req.auth!.orgId!, req.params.id)); return reply.code(204).send(); });

  // ---------------- bank inbox
  r.get('/api/v1/bank/invitations', {
    preHandler: requireOrgType('bank'),
    schema: { tags: ['marketplace'], summary: 'Invoices I am invited to fund (BNK-02)', response: { 200: z.object({ items: z.array(z.object({
      invoiceId: z.string(), invoiceNumber: z.string(), supplier: z.string(), buyer: z.string(), buyerTier: z.string().nullable(), currency: z.string(), amount: z.string(), dueDate: z.string(), invoiceStatus: z.string(),
      invitationStatus: z.string(), source: z.string(), coverStatus: z.string(), coverPct: z.number().nullable(), myOffer: z.object({ id: z.string(), status: z.string(), allInPct: z.string() }).nullable(), invitedAt: z.string(),
    })) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const rows = await tx.query<any>(
      `select m.*, i.human_id, i.currency, i.accepted_amount, i.gross_amount, i.due_date, i.status as inv_status, s.legal_name as sname, b.legal_name as bname, b.rating_tier,
              c.status as cover_status, c.cover_pct,
              (select jsonb_build_object('id', o.id, 'status', o.status, 'allInPct', o.all_in_pct::text) from marketplace.offers o where o.invoice_id = m.invoice_id and o.bank_org_id = m.bank_org_id
                order by (o.status = 'Selected') desc, (o.status = 'Submitted') desc, o.created_at desc limit 1) as my_offer
         from marketplace.invitations m join invoicing.invoices i on i.id = m.invoice_id join identity.organisations s on s.id = m.supplier_org_id join identity.organisations b on b.id = m.buyer_org_id
         left join insurance.cover_records c on c.invoice_id = m.invoice_id where m.bank_org_id = $1 order by m.created_at desc`, [req.auth!.orgId]);
    return { items: rows.map((x) => ({ invoiceId: x.invoice_id, invoiceNumber: x.human_id, supplier: x.sname, buyer: x.bname, buyerTier: x.rating_tier, currency: x.currency, amount: x.accepted_amount ?? x.gross_amount, dueDate: String(x.due_date).slice(0, 10),
      invoiceStatus: x.inv_status, invitationStatus: x.status, source: x.source, coverStatus: x.cover_status ?? 'none', coverPct: x.cover_pct == null ? null : Number(x.cover_pct), myOffer: x.my_offer, invitedAt: iso(x.created_at)! })) };
  }));

  r.post('/api/v1/invoices/:id/invitation/decline', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Decline an invitation', params: z.object({ id: z.string() }), body: z.object({ reason: z.string().min(3).max(300) }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => declineInvitation(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.reason)); return reply.code(204).send(); });

  // ---------------- financing requests
  const FR_SQL = `select f.*, i.human_id, i.currency, i.accepted_amount, i.gross_amount, s.legal_name as sname, b.legal_name as bname, u.legal_name as uname, o.net_cash, o.net_cash_inr, o.all_in_pct,
      (select assignment_ack_at is not null from invoicing.acceptances a where a.invoice_id = f.invoice_id and a.decision <> 'rejected' order by a.decided_at desc limit 1) as ack,
      (select reference from marketplace.assignment_notices n where n.invoice_id = f.invoice_id) as notice_ref
    from marketplace.financing_requests f join invoicing.invoices i on i.id = f.invoice_id join identity.organisations s on s.id = f.supplier_org_id
    join identity.organisations b on b.id = f.bank_org_id join identity.organisations u on u.id = f.buyer_org_id join marketplace.offers o on o.id = f.offer_id`;
  const toFr = (x: any) => ({
    id: x.id, invoiceId: x.invoice_id, invoiceNumber: x.human_id, offerId: x.offer_id, status: x.status, supplier: { id: x.supplier_org_id, name: x.sname }, bank: { id: x.bank_org_id, name: x.bname }, buyerName: x.uname,
    currency: x.currency, amount: x.accepted_amount ?? x.gross_amount, netCash: x.net_cash, netCashInr: x.net_cash_inr, allInPct: x.all_in_pct, consentText: x.consent_text, consentedAt: iso(x.consented_at),
    decisionReason: x.decision_reason, disbursementRef: x.disbursement_ref, fundedAt: iso(x.funded_at), createdAt: iso(x.created_at)!, assignmentAcknowledged: !!x.ack, noticeRef: x.notice_ref ?? null,
  });
  const loadFr = async (tx: any, id: string) => { const x = await tx.maybe(`${FR_SQL} where f.id = $1`, [id]); if (!x) throw notFound('Financing request'); return toFr(x); };

  r.post('/api/v1/offers/:id/select', {
    preHandler: supplierOnly('discount:manage'),
    schema: { tags: ['marketplace'], summary: 'Choose an offer: reserves limits and a lien, then asks for consent. A second parallel choice fails with a lien conflict.', params: z.object({ id: z.string().uuid() }), response: { 201: frOut } },
  }, async (req, reply) => {
    try {
      const out = await svc.db.tx(req.ctx, async (tx) => { const fr = await selectOffer(tx, svc, req.ctx, req.auth!.orgId!, req.params.id); return loadFr(tx, fr.id); });
      return reply.code(201).send(out);
    } catch (e) {
      if (e instanceof DomainError && e.code === 'lien_conflict') {
        const d = e.details as { invoiceId: string; bankOrgId?: string };
        await recordLienConflict(svc, req.ctx, d.invoiceId, d.bankOrgId, e.message);
      }
      throw e;
    }
  });

  r.get('/api/v1/financing-requests', {
    preHandler: both(requireOrgType('supplier', 'bank'), requirePerm('read')),
    schema: { tags: ['marketplace'], summary: 'My financing requests', response: { 200: z.object({ items: z.array(frOut) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => ({ items: (await tx.query<any>(`${FR_SQL} where f.supplier_org_id = $1 or f.bank_org_id = $1 order by f.created_at desc`, [req.auth!.orgId])).map(toFr) })));

  r.get('/api/v1/financing-requests/:id', {
    preHandler: requireUser,
    schema: { tags: ['marketplace'], summary: 'One financing request', params: z.object({ id: z.string().uuid() }), response: { 200: frOut } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => loadFr(tx, req.params.id)));

  r.post('/api/v1/financing-requests/:id/consent', {
    preHandler: supplierOnly('financing:consent'),
    schema: { tags: ['marketplace'], summary: 'Supplier consents to the assignment and terms', params: z.object({ id: z.string().uuid() }), response: { 200: frOut } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => { await consentFinancing(tx, svc, req.ctx, req.auth!.orgId!, req.params.id); return loadFr(tx, req.params.id); }));

  r.post('/api/v1/financing-requests/:id/cancel', {
    preHandler: requireOrgType('supplier'),
    schema: { tags: ['marketplace'], summary: 'Cancel during the cooling-off period (before the bank instructs payment)', params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().max(300).optional() }), response: { 200: frOut } },
  }, async (req) => {
    if (!can(req.auth!.role ?? undefined, 'discount:manage') && !can(req.auth!.role ?? undefined, 'financing:consent')) throw forbidden('You need permission to manage funding.');
    return svc.db.tx(req.ctx, async (tx) => { await cancelFinancing(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.reason); return loadFr(tx, req.params.id); });
  });

  r.post('/api/v1/financing-requests/:id/confirm', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Bank re-checks and confirms; the (simulated) payment is instructed and the lien becomes active', params: z.object({ id: z.string().uuid() }), response: { 200: frOut } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => { await bankConfirm(tx, svc, req.ctx, req.auth!.orgId!, req.params.id); return loadFr(tx, req.params.id); }));

  r.post('/api/v1/financing-requests/:id/decline', {
    preHandler: bankOnly('offer:submit'),
    schema: { tags: ['marketplace'], summary: 'Bank declines at confirmation; limits and lien are released', params: z.object({ id: z.string().uuid() }), body: z.object({ reason: z.string().min(3).max(300) }), response: { 200: frOut } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => { await bankDecline(tx, svc, req.ctx, req.auth!.orgId!, req.params.id, req.body.reason); return loadFr(tx, req.params.id); }));

  r.get('/api/v1/invoices/:id/assignment-notice', {
    preHandler: requireUser,
    schema: { tags: ['marketplace'], summary: 'Assignment notice for an invoice (BUY-04)', params: z.object({ id: z.string() }), response: { 200: z.object({ reference: z.string(), governingLaw: z.string(), body: z.string(), issuedAt: z.string(),
      usFiling: z.record(z.string(), z.any()).nullable(), sgDataConsent: z.boolean().nullable(), acknowledged: z.boolean() }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const inv = await loadInvoice(tx, req.params.id);
    const n = await tx.maybe<any>('select * from marketplace.assignment_notices where invoice_id = $1', [inv.id]);
    if (!n) throw notFound('Assignment notice');
    const ack = await tx.maybe<any>("select assignment_ack_at from invoicing.acceptances where invoice_id = $1 and decision <> 'rejected' order by decided_at desc limit 1", [inv.id]);
    return { reference: n.reference, governingLaw: n.governing_law, body: n.body, issuedAt: iso(n.issued_at)!, usFiling: n.us_filing, sgDataConsent: n.sg_data_consent, acknowledged: !!ack?.assignment_ack_at };
  }));

  // ---------------- early payment (route 1)
  r.put('/api/v1/invoices/:id/discount-schedule', {
    preHandler: supplierOnly('discount:manage'),
    schema: { tags: ['marketplace'], summary: 'Publish a discount schedule (dates with discounts, or an annual rate applied pro rata)', params: z.object({ id: z.string() }), body: scheduleIn, response: { 200: z.object({ warnings: z.array(z.string()) }) } },
  }, async (req) => svc.db.tx(req.ctx, (tx) => publishSchedule(tx, svc, req.ctx, req.params.id, req.body.mode === 'table' ? { mode: 'table', entries: req.body.entries } : { mode: 'annual_rate', annualRatePct: req.body.annualRatePct })));

  r.delete('/api/v1/invoices/:id/discount-schedule', {
    preHandler: supplierOnly('discount:manage'),
    schema: { tags: ['marketplace'], summary: 'Withdraw the schedule', params: z.object({ id: z.string() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => withdrawSchedule(tx, svc, req.ctx, req.params.id)); return reply.code(204).send(); });

  r.get('/api/v1/invoices/:id/discount-schedule', {
    preHandler: both(requireOrgType('supplier', 'buyer'), requirePerm('read')),
    schema: { tags: ['marketplace'], summary: 'The published schedule', params: z.object({ id: z.string() }),
      response: { 200: z.object({ mode: z.string(), entries: z.array(z.object({ payBy: z.string(), discountPct: z.number() })).nullable(), annualRatePct: z.string().nullable(), status: z.string() }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const inv = await loadInvoice(tx, req.params.id);
    const s = await tx.maybe<any>('select * from marketplace.discount_schedules where invoice_id = $1', [inv.id]);
    if (!s) throw notFound('Discount schedule');
    return { mode: s.mode, entries: s.entries, annualRatePct: s.annual_rate_pct, status: s.status };
  }));

  const quoteBody = z.object({ payDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), fundingSource: z.enum(['cash', 'bank_loan']).default('cash') });
  r.post('/api/v1/invoices/:id/early-payment/quote', {
    preHandler: both(requireOrgType('buyer'), requirePerm('read')),
    schema: { tags: ['marketplace'], summary: 'What would paying on this date cost and save?', params: z.object({ id: z.string() }), body: quoteBody, response: { 200: z.record(z.string(), z.any()) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => earlyPaymentQuote(tx, svc, await loadInvoice(tx, req.params.id), req.body.payDate, req.body.fundingSource) as unknown as Record<string, unknown>));

  r.post('/api/v1/invoices/:id/early-payment', {
    preHandler: both(requireOrgType('buyer'), requirePerm('financing:consent')),
    schema: { tags: ['marketplace'], summary: 'Buyer confirms early payment: executes the (simulated) payment and locks this route', params: z.object({ id: z.string() }),
      body: quoteBody.extend({ buyerBankOrgId: z.string().uuid().optional() }), response: { 200: z.record(z.string(), z.any()) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => confirmEarlyPayment(tx, svc, req.ctx, req.params.id, req.body) as unknown as Record<string, unknown>));

  // ---------------- admin: lien registry (ADM-05)
  r.get('/api/v1/admin/liens', {
    preHandler: requirePerm('audit:read'),
    schema: { tags: ['admin'], summary: 'Lien registry with transfer-of-rights history', response: { 200: z.object({ liens: z.array(z.object({ id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), bank: z.string(), supplier: z.string(), buyer: z.string(), status: z.string(),
      assignmentRef: z.string().nullable(), reservedAt: z.string(), activatedAt: z.string().nullable(), releasedAt: z.string().nullable(), releaseReason: z.string().nullable() })),
      events: z.array(z.object({ id: z.string(), invoiceNumber: z.string().nullable(), event: z.string(), detail: z.string().nullable(), at: z.string() })) }) } },
  }, async (req) => {
    const ctx = platformCtx(req);
    return svc.db.tx(ctx, async (tx) => {
      const liens = await tx.query<any>(`select l.*, b.legal_name as bname, s.legal_name as sname, u.legal_name as uname from marketplace.liens l join identity.organisations b on b.id = l.bank_org_id
        join identity.organisations s on s.id = l.supplier_org_id join identity.organisations u on u.id = l.buyer_org_id order by l.reserved_at desc limit 200`);
      const events = await tx.query<any>('select * from marketplace.lien_events order by id desc limit 200');
      return { liens: liens.map((l) => ({ id: l.id, invoiceId: l.invoice_id, invoiceNumber: l.invoice_number, bank: l.bname, supplier: l.sname, buyer: l.uname, status: l.status, assignmentRef: l.assignment_ref,
        reservedAt: iso(l.reserved_at)!, activatedAt: iso(l.activated_at), releasedAt: iso(l.released_at), releaseReason: l.release_reason })),
        events: events.map((e) => ({ id: String(e.id), invoiceNumber: e.invoice_number, event: e.event, detail: e.detail, at: iso(e.at)! })) };
    });
  });

  void coverForInvoice; void isPlatformRole;
}
