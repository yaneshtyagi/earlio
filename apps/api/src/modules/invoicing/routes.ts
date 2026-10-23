import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireOrgType, requirePerm, requireUser, platformCtx } from '../../http/context';
import { DomainError, invalid, notFound } from '../../kernel/errors';
import { isPlatformRole } from '../identity/permissions';
import {
  CURRENCIES, DOC_TYPES, acknowledgeAssignment, attachInvoiceDocument, cancelInvoice, createInvoice, createPurchaseOrder, csvToRows, decideInvoice,
  importRows, loadInvoice, raiseDispute, submitInvoice, UNDERTAKING_TEXT,
} from './service';
import { INVOICE_STATES } from './state';
import { formatMoney } from '../../kernel/money';

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));
const statusEnum = z.enum(INVOICE_STATES);

const listItem = z.object({
  id: z.string(), humanId: z.string(), number: z.string(), status: statusEnum,
  supplier: z.object({ id: z.string(), name: z.string() }), buyer: z.object({ id: z.string(), name: z.string() }),
  currency: z.string(), grossAmount: z.string(), acceptedAmount: z.string().nullable(), issueDate: z.string(), dueDate: z.string(),
  warnings: z.array(z.string()), disputeFlag: z.boolean(), submittedAt: z.string().nullable(), createdAt: z.string(),
});
const detail = listItem.extend({
  irn: z.string().nullable(), route: z.string().nullable(), coverStatus: z.string(), screeningStatus: z.string(), shipmentDate: z.string().nullable(),
  disputeWindowEndsAt: z.string().nullable(), acceptedAt: z.string().nullable(), poNumber: z.string().nullable(), reminderCount: z.number(),
  documents: z.array(z.object({ id: z.string(), docType: z.string(), version: z.number(), fileId: z.string(), filename: z.string(), sha256: z.string(), createdAt: z.string() })),
  acceptance: z.object({ decision: z.string(), acceptedAmount: z.string().nullable(), reason: z.string().nullable(), undertakingText: z.string().nullable(),
    undertakingSignedAt: z.string().nullable(), decidedAt: z.string(), assignmentAckAt: z.string().nullable() }).nullable(),
  disputes: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), reason: z.string(), amount: z.string().nullable(), raisedByOrg: z.string(), createdAt: z.string() })),
  history: z.array(z.object({ from: z.string().nullable(), to: z.string(), note: z.string().nullable(), at: z.string() })),
  undertakingPreview: z.string(),
});

const baseSelect = `select i.*, s.legal_name as supplier_name, b.legal_name as buyer_name, p.number as po_number
  from invoicing.invoices i join identity.organisations s on s.id = i.supplier_org_id join identity.organisations b on b.id = i.buyer_org_id
  left join invoicing.purchase_orders p on p.id = i.po_id`;

const toListItem = (r: any) => ({
  id: r.id, humanId: r.human_id, number: r.number, status: r.status,
  supplier: { id: r.supplier_org_id, name: r.supplier_name }, buyer: { id: r.buyer_org_id, name: r.buyer_name },
  currency: r.currency, grossAmount: r.gross_amount, acceptedAmount: r.accepted_amount, issueDate: r.issue_date, dueDate: r.due_date,
  warnings: r.warnings, disputeFlag: r.dispute_flag, submittedAt: iso(r.submitted_at), createdAt: iso(r.created_at)!,
});

export function invoicingRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const ctxFor = (req: any) => (isPlatformRole(req.auth?.role) ? platformCtx(req) : req.ctx);

  r.get('/api/v1/invoices', {
    preHandler: requirePerm('read'),
    schema: { tags: ['invoices'], summary: 'Invoices visible to my organisation (supplier: own; buyer: addressed to me)',
      querystring: z.object({ status: z.string().optional(), q: z.string().optional() }), response: { 200: z.object({ items: z.array(listItem) }) } },
  }, async (req) => {
    const statuses = req.query.status ? req.query.status.split(',') : null;
    const rows = await svc.db.tx(ctxFor(req), (tx) => tx.query<any>(
      `${baseSelect} where ($1::text[] is null or i.status = any($1)) and ($2::text is null or i.human_id ilike '%'||$2||'%' or i.number ilike '%'||$2||'%' or b.legal_name ilike '%'||$2||'%' or s.legal_name ilike '%'||$2||'%')
       order by i.created_at desc, i.human_id desc limit 500`, [statuses, req.query.q ?? null]));
    return { items: rows.map(toListItem) };
  });

  r.get('/api/v1/invoices/:id', {
    preHandler: requirePerm('read'),
    schema: { tags: ['invoices'], summary: 'Invoice detail with documents, acceptance, disputes and timeline', params: z.object({ id: z.string() }), response: { 200: detail } },
  }, async (req) => svc.db.tx(ctxFor(req), async (tx) => {
    const key = /^INV-/.test(req.params.id) ? 'i.human_id' : 'i.id';
    const row = await tx.maybe<any>(`${baseSelect} where ${key} = $1`, [req.params.id]);
    if (!row) throw notFound('Invoice');
    const docs = await tx.query<any>('select * from invoicing.invoice_documents where invoice_id = $1 order by doc_type, version', [row.id]);
    const acc = await tx.maybe<any>('select * from invoicing.acceptances where invoice_id = $1 order by decided_at desc limit 1', [row.id]);
    const disputes = await tx.query<any>('select * from invoicing.disputes where invoice_id = $1 order by created_at', [row.id]);
    const hist = await tx.query<any>('select * from invoicing.invoice_history where invoice_id = $1 order by id', [row.id]);
    return {
      ...toListItem(row),
      irn: row.irn, route: row.route, coverStatus: row.cover_status, screeningStatus: row.screening_status, shipmentDate: row.shipment_date,
      disputeWindowEndsAt: iso(row.dispute_window_ends_at), acceptedAt: iso(row.accepted_at), poNumber: row.po_number, reminderCount: row.reminder_count,
      documents: docs.map((d) => ({ id: d.id, docType: d.doc_type, version: d.version, fileId: d.file_id, filename: d.filename, sha256: d.sha256, createdAt: iso(d.created_at)! })),
      acceptance: acc ? { decision: acc.decision, acceptedAmount: acc.accepted_amount, reason: acc.reason, undertakingText: acc.undertaking_text, undertakingSignedAt: iso(acc.undertaking_signed_at),
        decidedAt: iso(acc.decided_at)!, assignmentAckAt: iso(acc.assignment_ack_at) } : null,
      disputes: disputes.map((d) => ({ id: d.id, kind: d.kind, status: d.status, reason: d.reason, amount: d.amount, raisedByOrg: d.raised_by_org, createdAt: iso(d.created_at)! })),
      history: hist.map((h) => ({ from: h.from_status, to: h.to_status, note: h.note, at: iso(h.at)! })),
      undertakingPreview: UNDERTAKING_TEXT(row.gross_amount, row.currency, row.due_date, row.supplier_name, row.human_id),
    };
  }));

  const createBody = z.object({
    buyerOrgId: z.string().uuid(), number: z.string().min(1).max(60), currency: z.enum(CURRENCIES), amount: z.string(),
    issueDate: z.string(), dueDate: z.string(), poNumber: z.string().max(60).nullish(), shipmentDate: z.string().nullish(),
  });

  r.post('/api/v1/invoices', {
    preHandler: async (req, reply) => { await requireOrgType('supplier')(req, reply); await requirePerm('invoice:create')(req, reply); },
    schema: { tags: ['invoices'], summary: 'Create a draft invoice', body: createBody, response: { 201: z.object({ id: z.string(), humanId: z.string(), warnings: z.array(z.string()) }) } },
  }, async (req, reply) => {
    const inv = await svc.db.tx(req.ctx, (tx) => createInvoice(tx, svc, req.ctx, req.auth!.orgId!, req.auth!.orgName!, req.body));
    return reply.code(201).send({ id: inv.id, humanId: inv.human_id, warnings: inv.warnings });
  });

  const supplierWrite = async (req: any, reply: any) => { await requireOrgType('supplier')(req, reply); await requirePerm('invoice:create')(req, reply); };
  const owned = async (tx: any, req: any) => {
    const inv = await loadInvoice(tx, req.params.id);
    if (inv.supplier_org_id !== req.auth.orgId) throw notFound('Invoice');
    return inv;
  };

  r.post('/api/v1/invoices/:id/documents', {
    preHandler: supplierWrite,
    schema: { tags: ['invoices'], summary: 'Attach an uploaded file as a (new version of a) document', params: z.object({ id: z.string() }),
      body: z.object({ docType: z.enum(DOC_TYPES), fileId: z.string().uuid() }), response: { 201: z.object({ id: z.string(), version: z.number() }) } },
  }, async (req, reply) => reply.code(201).send(await svc.db.tx(req.ctx, async (tx) => attachInvoiceDocument(tx, svc, req.ctx, await owned(tx, req), req.body.docType, req.body.fileId))));

  r.post('/api/v1/invoices/:id/submit', {
    preHandler: supplierWrite,
    schema: { tags: ['invoices'], summary: 'Submit a draft to the buyer', params: z.object({ id: z.string() }), response: { 200: z.object({ status: statusEnum }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => { await owned(tx, req); const inv = await submitInvoice(tx, svc, req.ctx, req.params.id); return { status: inv.status }; }));

  r.post('/api/v1/invoices/:id/cancel', {
    preHandler: supplierWrite,
    schema: { tags: ['invoices'], summary: 'Cancel a draft', params: z.object({ id: z.string() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, async (tx) => { await owned(tx, req); await cancelInvoice(tx, svc, req.ctx, req.params.id); }); return reply.code(204).send(); });

  r.post('/api/v1/invoices/:id/decision', {
    preHandler: async (req, reply) => { await requireOrgType('buyer')(req, reply); await requirePerm('invoice:accept')(req, reply); },
    schema: { tags: ['invoices'], summary: 'Buyer: accept, part-accept or reject', params: z.object({ id: z.string() }),
      body: z.object({ decision: z.enum(['accept', 'partial', 'reject']), acceptedAmount: z.string().optional(), reason: z.string().max(1000).optional(), undertakingAccepted: z.boolean().optional() }),
      response: { 200: z.object({ status: statusEnum, acceptedAmount: z.string().nullable() }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => {
    const inv = await decideInvoice(tx, svc, req.ctx, req.params.id, req.auth!.orgId!, req.body);
    return { status: inv.status, acceptedAmount: inv.accepted_amount };
  }));

  r.post('/api/v1/invoices/:id/assignment-ack', {
    preHandler: async (req, reply) => { await requireOrgType('buyer')(req, reply); await requirePerm('invoice:accept')(req, reply); },
    schema: { tags: ['invoices'], summary: 'Buyer: acknowledge the assignment notice', params: z.object({ id: z.string() }), response: { 204: z.undefined() } },
  }, async (req, reply) => { await svc.db.tx(req.ctx, (tx) => acknowledgeAssignment(tx, svc, req.ctx, req.params.id, req.auth!.orgId!)); return reply.code(204).send(); });

  r.post('/api/v1/invoices/:id/disputes', {
    preHandler: async (req, reply) => { await requireOrgType('supplier', 'buyer')(req, reply); await requirePerm('dispute:raise')(req, reply); },
    schema: { tags: ['invoices'], summary: 'Raise a dispute during the dispute window (freezes the invoice)', params: z.object({ id: z.string() }),
      body: z.object({ reason: z.string().min(3).max(2000) }), response: { 201: z.object({ id: z.string() }) } },
  }, async (req, reply) => {
    const id = await svc.db.tx(req.ctx, (tx) => raiseDispute(tx, svc, req.ctx, req.params.id, req.auth!.orgId!, req.body.reason));
    return reply.code(201).send({ id });
  });

  // ---- Import ----
  const importReport = z.object({ created: z.array(z.object({ row: z.number(), invoiceId: z.string(), humanId: z.string() })), errors: z.array(z.object({ row: z.number(), message: z.string() })) });
  r.post('/api/v1/invoices/import/csv', {
    preHandler: supplierWrite,
    schema: { tags: ['invoices'], summary: 'Import invoices from CSV text (columns: buyer, number, currency, amount, issueDate, dueDate, poNumber). Valid rows are created; bad rows are reported.',
      body: z.object({ csv: z.string().min(1).max(2_000_000) }), response: { 200: importReport } },
  }, async (req) => {
    const parsed = csvToRows(req.body.csv);
    if (parsed.error) throw invalid(parsed.error);
    return svc.db.tx(req.ctx, (tx) => importRows(tx, svc, req.ctx, req.auth!.orgId!, req.auth!.orgName!, parsed.rows, 2));
  });

  r.post('/api/v1/invoices/import/erp', {
    preHandler: supplierWrite,
    schema: { tags: ['invoices'], summary: 'Import the next batch from the (simulated) ERP / e-invoice portal', response: { 200: importReport } },
  }, async (req) => {
    const batch = await svc.adapters.erp.fetchBatch(req.auth!.orgName!);
    return svc.db.tx(req.ctx, (tx) => importRows(tx, svc, req.ctx, req.auth!.orgId!, req.auth!.orgName!, batch, 1));
  });

  // ---- Purchase orders ----
  r.get('/api/v1/purchase-orders', {
    preHandler: requirePerm('read'),
    schema: { tags: ['invoices'], summary: 'Purchase orders', response: { 200: z.object({ items: z.array(z.object({
      id: z.string(), number: z.string(), buyerName: z.string(), buyerOrgId: z.string(), currency: z.string(), amount: z.string(), description: z.string().nullable() })) }) } },
  }, async (req) => {
    const rows = await svc.db.tx(ctxFor(req), (tx) => tx.query<any>(
      `select p.*, b.legal_name as buyer_name from invoicing.purchase_orders p join identity.organisations b on b.id = p.buyer_org_id order by p.created_at desc`));
    return { items: rows.map((p) => ({ id: p.id, number: p.number, buyerName: p.buyer_name, buyerOrgId: p.buyer_org_id, currency: p.currency, amount: p.amount, description: p.description })) };
  });

  r.post('/api/v1/purchase-orders', {
    preHandler: supplierWrite,
    schema: { tags: ['invoices'], summary: 'Record a purchase order', body: z.object({ buyerOrgId: z.string().uuid(), number: z.string().min(1).max(60), currency: z.enum(CURRENCIES), amount: z.string(), description: z.string().max(300).optional() }),
      response: { 201: z.object({ id: z.string() }) } },
  }, async (req, reply) => reply.code(201).send({ id: await svc.db.tx(req.ctx, (tx) => createPurchaseOrder(tx, svc, req.ctx, req.auth!.orgId!, req.body)) }));

  void DomainError; void requireUser; void formatMoney;
}
