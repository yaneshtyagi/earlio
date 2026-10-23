import { createHash } from 'node:crypto';
import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { shareFile } from '../../platform/files';
import { D, formatMoney } from '../../kernel/money';
import { activeRelationship } from '../identity/relationships';
import { screenName, transactBlockReason } from '../compliance/sanctions';
import { transition, type InvoiceRow } from './state';

export const CURRENCIES = ['USD', 'SGD'] as const;
export const DOC_TYPES = ['commercial_invoice', 'packing_list', 'shipping_bill', 'transport_document', 'delivery_proof'] as const;
export const REQUIRED_DOCS_FOR_SUBMIT = ['commercial_invoice', 'delivery_proof'] as const;
/** Platform guardrail (BR-9): the dispute window can be configured but never below 24 hours. */
export const MIN_DISPUTE_WINDOW_HOURS = 24;
export const REMINDER_DAYS = [1, 3] as const;

export const UNDERTAKING_TEXT = (amount: string, ccy: string, due: string, supplier: string, humanId: string) =>
  `We irrevocably undertake to pay ${formatMoney(amount, ccy as 'USD')} on or before ${due} for invoice ${humanId} issued by ${supplier}, ` +
  `free of any set-off or counterclaim except as recorded on this platform, to the financier to whom ${supplier} assigns the receivable, and we acknowledge the assignment notice.`;

export interface InvoiceInput {
  buyerOrgId: string; number: string; currency: string; amount: string; issueDate: string; dueDate: string; poNumber?: string | null; shipmentDate?: string | null;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const fingerprintOf = (supplier: string, i: { number: string; amount: string; issueDate: string }) =>
  createHash('sha256').update([supplier, i.number.trim().toLowerCase(), D(i.amount).toFixed(2), i.issueDate].join('|')).digest('hex');

export function validateInvoiceFields(i: InvoiceInput): string | null {
  if (!i.number?.trim()) return 'The invoice number is required.';
  if (!(CURRENCIES as readonly string[]).includes(i.currency)) return `Currency must be USD or SGD (got ${i.currency || 'nothing'}).`;
  let amt;
  try { amt = D(i.amount); } catch { return 'The amount is not a valid number.'; }
  if (!amt.isFinite() || amt.lte(0)) return 'The amount must be greater than zero.';
  if (amt.decimalPlaces() > 2) return 'The amount can have at most two decimal places.';
  if (!isoDate.test(i.issueDate) || Number.isNaN(Date.parse(i.issueDate))) return 'The issue date must be a valid date (YYYY-MM-DD).';
  if (!isoDate.test(i.dueDate) || Number.isNaN(Date.parse(i.dueDate))) return 'The due date must be a valid date (YYYY-MM-DD).';
  if (Date.parse(i.dueDate) <= Date.parse(i.issueDate)) return 'The due date must be after the issue date.';
  return null;
}

export async function createPurchaseOrder(tx: Tx, svc: Services, ctx: Ctx, supplierId: string, a: { buyerOrgId: string; number: string; currency: string; amount: string; description?: string }) {
  if (!(await activeRelationship(tx, supplierId, a.buyerOrgId))) throw invalid('You need an active relationship with this buyer first.');
  if (!(CURRENCIES as readonly string[]).includes(a.currency)) throw invalid('Currency must be USD or SGD.');
  const now = svc.clock.now();
  const po = await tx.maybe('select 1 from invoicing.purchase_orders where supplier_org_id = $1 and buyer_org_id = $2 and number = $3', [supplierId, a.buyerOrgId, a.number]);
  if (po) throw conflict('duplicate_po', `Purchase order ${a.number} already exists for this buyer.`);
  const row = await tx.one<{ id: string }>(
    'insert into invoicing.purchase_orders (supplier_org_id, buyer_org_id, number, currency, amount, description, created_at) values ($1,$2,$3,$4,$5,$6,$7) returning id',
    [supplierId, a.buyerOrgId, a.number, a.currency, a.amount, a.description ?? null, now]);
  await audit(tx, ctx, now, { action: 'po.created', entityType: 'purchase_order', entityId: row.id, orgId: supplierId, after: a });
  return row.id;
}

/** Create a Draft invoice (IN-1). */
export async function createInvoice(tx: Tx, svc: Services, ctx: Ctx, supplierId: string, supplierName: string, input: InvoiceInput) {
  const err = validateInvoiceFields(input);
  if (err) throw invalid(err);
  const rel = await activeRelationship(tx, supplierId, input.buyerOrgId);
  if (!rel) throw new DomainError('no_relationship', 'You need an active relationship with this buyer before you can invoice them.', 422);
  const blocked = await transactBlockReason(tx, input.buyerOrgId);
  if (blocked) throw new DomainError('buyer_not_ready', blocked, 422);
  const fp = fingerprintOf(supplierId, input);
  const dup = await tx.maybe<{ human_id: string }>("select human_id from invoicing.invoices where fingerprint = $1 and status <> 'Cancelled'", [fp]);
  if (dup) throw conflict('duplicate_invoice', `This looks like a duplicate of ${dup.human_id} (same number, amount and issue date).`);

  const warnings: string[] = [];
  let poId: string | null = null;
  if (input.poNumber?.trim()) {
    const po = await tx.maybe<any>('select id, currency from invoicing.purchase_orders where supplier_org_id = $1 and buyer_org_id = $2 and number = $3', [supplierId, input.buyerOrgId, input.poNumber.trim()]);
    if (!po) throw invalid(`Purchase order ${input.poNumber} was not found for this buyer.`);
    poId = po.id;
    if (po.currency !== input.currency) warnings.push('currency_differs_from_po');
  } else warnings.push('no_purchase_order'); // A-15: allowed, but flagged

  const now = svc.clock.now();
  const seq = await tx.one<{ n: string }>("select nextval('invoicing.invoice_seq')::text as n");
  const humanId = `INV-${seq.n}`;
  const irn = (await svc.adapters.einvoice.register({ supplierName, invoiceNumber: input.number.trim(), issueDate: input.issueDate, amount: D(input.amount).toFixed(2), currency: input.currency })).irn;
  const row = await tx.one<InvoiceRow>(
    `insert into invoicing.invoices (human_id, supplier_org_id, buyer_org_id, po_id, number, currency, gross_amount, issue_date, due_date, shipment_date, irn, warnings, fingerprint, created_by, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) returning *`,
    [humanId, supplierId, input.buyerOrgId, poId, input.number.trim(), input.currency, D(input.amount).toFixed(2), input.issueDate, input.dueDate, input.shipmentDate ?? null, irn, JSON.stringify(warnings), fp, ctx.userId ?? null, now]);
  await tx.query(
    'insert into invoicing.invoice_history (invoice_id, supplier_org_id, buyer_org_id, from_status, to_status, actor_user, actor_org, note, at) values ($1,$2,$3,null,$4,$5,$6,$7,$8)',
    [row.id, supplierId, input.buyerOrgId, 'Draft', ctx.userId ?? null, ctx.orgId ?? null, 'Created', now]);
  await audit(tx, ctx, now, { action: 'invoice.created', entityType: 'invoice', entityId: row.id, orgId: supplierId, after: { humanId, number: input.number, amount: input.amount, currency: input.currency } });
  await emit(tx, now, 'invoice.created', { invoiceId: row.id, humanId }, [supplierId]);
  return row;
}

export async function loadInvoice(tx: Tx, id: string, lock = false): Promise<InvoiceRow> {
  const row = await tx.maybe<InvoiceRow>(`select * from invoicing.invoices where ${/^INV-/.test(id) ? 'human_id' : 'id'} = $1 ${lock ? 'for update' : ''}`, [id]);
  if (!row) throw notFound('Invoice');
  return row;
}

export async function attachInvoiceDocument(tx: Tx, svc: Services, ctx: Ctx, inv: InvoiceRow, docType: string, fileId: string) {
  if (!(DOC_TYPES as readonly string[]).includes(docType)) throw invalid(`Unknown document type ${docType}.`);
  // Once accepted, the invoice and delivery proof the buyer accepted are fixed; a bank may still ask for supporting papers before funding (CT-10).
  const supplementary = ['packing_list', 'shipping_bill', 'transport_document'].includes(docType) && ['Accepted', 'OpenForFunding', 'OffersReceived'].includes(inv.status);
  if (!['Draft', 'Submitted'].includes(inv.status) && !supplementary) throw conflict('locked', 'Documents can only be added while the invoice is a draft or awaiting acceptance (supporting papers can be added until it is funded).');
  const file = await tx.maybe<any>('select id, filename, sha256, org_id from platform.files where id = $1', [fileId]);
  if (!file || file.org_id !== inv.supplier_org_id) throw notFound('File');
  const now = svc.clock.now();
  const v = await tx.one<{ v: number }>('select coalesce(max(version),0)+1 as v from invoicing.invoice_documents where invoice_id = $1 and doc_type = $2', [inv.id, docType]);
  const row = await tx.one<{ id: string }>(
    `insert into invoicing.invoice_documents (invoice_id, supplier_org_id, buyer_org_id, doc_type, version, file_id, filename, sha256, uploaded_by, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [inv.id, inv.supplier_org_id, inv.buyer_org_id, docType, v.v, fileId, file.filename, file.sha256, ctx.userId ?? null, now]);
  if (inv.status !== 'Draft') {
    const banks = supplementary ? (await tx.elevated(() => tx.query<{ bank_org_id: string }>("select bank_org_id from marketplace.invitations where invoice_id = $1", [inv.id]))).map((b) => b.bank_org_id) : [];
    await shareFile(tx, fileId, [inv.buyer_org_id, ...banks]);
  }
  await audit(tx, ctx, now, { action: 'invoice.document_added', entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id, after: { docType, version: v.v, sha256: file.sha256 } });
  return { id: row.id, version: v.v };
}

/** Draft -> Submitted (IN-3, XB-6, XB-2). */
export async function submitInvoice(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (inv.status !== 'Draft') throw conflict('not_draft', `Invoice ${inv.human_id} is ${inv.status} and cannot be submitted.`);
  const docs = await tx.query<{ doc_type: string; file_id: string }>(
    `select distinct on (doc_type) doc_type, file_id from invoicing.invoice_documents where invoice_id = $1 order by doc_type, version desc`, [inv.id]);
  const have = new Set(docs.map((d) => d.doc_type));
  const missing = REQUIRED_DOCS_FOR_SUBMIT.filter((d) => !have.has(d));
  if (missing.length) throw new DomainError('missing_documents', `Add the ${missing.map((m) => m.replace('_', ' ')).join(' and ')} before submitting.`, 422);
  if (!(await activeRelationship(tx, inv.supplier_org_id, inv.buyer_org_id))) throw new DomainError('no_relationship', 'The relationship with this buyer is no longer active.', 422);
  const why = await transactBlockReason(tx, inv.buyer_org_id);
  if (why) throw new DomainError('buyer_not_ready', why, 422);

  const buyer = await tx.elevated(() => tx.one<any>('select legal_name from identity.organisations where id = $1', [inv.buyer_org_id]));
  const screening = await screenName(tx, svc, ctx, { name: buyer.legal_name, orgId: inv.buyer_org_id, invoiceId: inv.id });
  const now = svc.clock.now();
  for (const d of await tx.query<{ file_id: string }>('select distinct file_id from invoicing.invoice_documents where invoice_id = $1', [inv.id])) {
    await shareFile(tx, d.file_id, [inv.buyer_org_id]);
  }
  await transition(tx, svc, ctx, inv, 'Submitted', {
    note: 'Submitted to buyer', event: 'invoice.submitted',
    set: { submitted_at: now, screening_status: screening.outcome },
    payload: { screening: screening.outcome },
  });
  return loadInvoice(tx, inv.id);
}

export async function cancelInvoice(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  const inv = await loadInvoice(tx, invoiceId, true);
  await transition(tx, svc, ctx, inv, 'Cancelled', { note: 'Cancelled by supplier' });
}

async function disputeWindowHours(tx: Tx): Promise<number> {
  const s = await tx.maybe<{ value: any }>("select value from platform.settings where key = 'dispute_window_hours'");
  const h = s ? Number(s.value) : MIN_DISPUTE_WINDOW_HOURS;
  return Math.max(MIN_DISPUTE_WINDOW_HOURS, Number.isFinite(h) ? h : MIN_DISPUTE_WINDOW_HOURS);
}

export interface DecisionInput { decision: 'accept' | 'partial' | 'reject'; acceptedAmount?: string; reason?: string; undertakingAccepted?: boolean }

/** Buyer decision (IN-4). Silence is never acceptance (A-16, BR-11.7). */
export async function decideInvoice(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string, buyerOrgId: string, input: DecisionInput) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (inv.buyer_org_id !== buyerOrgId) throw notFound('Invoice');
  if (inv.status !== 'Submitted') throw conflict('not_submitted', `Invoice ${inv.human_id} is ${inv.status}; only submitted invoices can be decided.`);
  const now = svc.clock.now();
  if (input.decision === 'reject') {
    if (!input.reason?.trim() || input.reason.trim().length < 3) throw invalid('Please give a reason for rejecting the invoice.');
    await tx.query(
      `insert into invoicing.acceptances (invoice_id, supplier_org_id, buyer_org_id, decision, reason, decided_by, decided_at) values ($1,$2,$3,'rejected',$4,$5,$6)`,
      [inv.id, inv.supplier_org_id, inv.buyer_org_id, input.reason.trim(), ctx.userId, now]);
    await transition(tx, svc, ctx, inv, 'Rejected', { note: input.reason.trim(), event: 'invoice.rejected' });
    return loadInvoice(tx, inv.id);
  }
  if (!input.undertakingAccepted) throw invalid('Accepting an invoice requires signing the payment undertaking.');
  let accepted = D(inv.gross_amount);
  if (input.decision === 'partial') {
    if (!input.acceptedAmount) throw invalid('Enter the amount you accept.');
    accepted = D(input.acceptedAmount);
    if (accepted.lte(0) || accepted.gte(D(inv.gross_amount))) throw invalid(`The accepted amount must be above zero and below the invoice amount (${formatMoney(inv.gross_amount, inv.currency as 'USD')}).`);
    if (accepted.decimalPlaces() > 2) throw invalid('The amount can have at most two decimal places.');
    if (!input.reason?.trim()) throw invalid('Please say why part of the invoice is not accepted.');
  }
  const supplier = await tx.elevated(() => tx.one<any>('select legal_name from identity.organisations where id = $1', [inv.supplier_org_id]));
  const text = UNDERTAKING_TEXT(accepted.toFixed(2), inv.currency, String(inv.due_date).slice(0, 10), supplier.legal_name, inv.human_id);
  await tx.query(
    `insert into invoicing.acceptances (invoice_id, supplier_org_id, buyer_org_id, decision, accepted_amount, reason, undertaking_text, undertaking_signed_at, decided_by, decided_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8)`,
    [inv.id, inv.supplier_org_id, inv.buyer_org_id, input.decision === 'partial' ? 'partial' : 'accepted', accepted.toFixed(2), input.reason ?? null, text, now, ctx.userId]);
  if (input.decision === 'partial') {
    // A-17: the remainder is recorded as a (non-freezing) dispute so it can become a credit note later.
    await tx.query(
      `insert into invoicing.disputes (invoice_id, supplier_org_id, buyer_org_id, kind, freezes, raised_by_org, raised_by_user, reason, amount, created_at)
       values ($1,$2,$3,'partial_remainder',false,$4,$5,$6,$7,$8)`,
      [inv.id, inv.supplier_org_id, inv.buyer_org_id, inv.buyer_org_id, ctx.userId, input.reason!.trim(), D(inv.gross_amount).minus(accepted).toFixed(2), now]);
  }
  const hours = await disputeWindowHours(tx);
  await transition(tx, svc, ctx, inv, 'Accepted', {
    note: input.decision === 'partial' ? `Part-accepted: ${accepted.toFixed(2)} of ${inv.gross_amount}` : 'Accepted in full',
    event: 'invoice.accepted',
    set: { accepted_amount: accepted.toFixed(2), accepted_at: now, dispute_window_ends_at: new Date(now.getTime() + hours * 3_600_000) },
    payload: { acceptedAmount: accepted.toFixed(2), partial: input.decision === 'partial' },
  });
  return loadInvoice(tx, inv.id);
}

export async function acknowledgeAssignment(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string, buyerOrgId: string) {
  const inv = await loadInvoice(tx, invoiceId);
  if (inv.buyer_org_id !== buyerOrgId) throw notFound('Invoice');
  const a = await tx.maybe<any>(`select id, assignment_ack_at from invoicing.acceptances where invoice_id = $1 and decision <> 'rejected' order by decided_at desc limit 1`, [inv.id]);
  if (!a) throw conflict('not_accepted', 'The invoice has not been accepted.');
  if (a.assignment_ack_at) throw conflict('already_acknowledged', 'The assignment notice was already acknowledged.');
  const now = svc.clock.now();
  await tx.query('update invoicing.acceptances set assignment_ack_at = $2, assignment_ack_by = $3 where id = $1', [a.id, now, ctx.userId]);
  await audit(tx, ctx, now, { action: 'invoice.assignment_acknowledged', entityType: 'invoice', entityId: inv.id, orgId: inv.buyer_org_id });
  await audit(tx, ctx, now, { action: 'invoice.assignment_acknowledged', entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id });
}

/**
 * Any party can dispute an accepted invoice while the dispute window is open, and the buyer or supplier can dispute a funded or
 * overdue invoice afterwards (J-B3). A freezing dispute stops progression, late interest and dunning until it is resolved.
 */
export async function raiseDispute(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string, myOrgId: string, reason: string, opts: { amount?: string } = {}) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (inv.supplier_org_id !== myOrgId && inv.buyer_org_id !== myOrgId) throw notFound('Invoice');
  if (!reason || reason.trim().length < 3) throw invalid('Please describe the dispute.');
  const postFunding = ['Funded', 'Overdue'].includes(inv.status);
  if (inv.status !== 'Accepted' && !postFunding) {
    throw conflict('cannot_dispute', `Invoice ${inv.human_id} is ${inv.status}; disputes can be raised on accepted invoices during the dispute window, or on funded and overdue invoices.`);
  }
  const now = svc.clock.now();
  if (inv.status === 'Accepted' && inv.dispute_window_ends_at && now > new Date(inv.dispute_window_ends_at)) {
    throw new DomainError('window_closed', 'The dispute window for this invoice has closed.', 409);
  }
  if (opts.amount && (D(opts.amount).lte(0) || D(opts.amount).gt(inv.accepted_amount ?? inv.gross_amount))) throw invalid('The disputed amount must be between zero and the invoice amount.');
  const t = await disputeTimers(tx);
  const fr = postFunding ? await tx.elevated(() => tx.maybe<any>("select bank_org_id from marketplace.financing_requests where invoice_id = $1 and status = 'Funded'", [inv.id])) : undefined;
  const d = await tx.one<{ id: string }>(
    `insert into invoicing.disputes (invoice_id, supplier_org_id, buyer_org_id, raised_by_org, raised_by_user, reason, amount, phase, frozen_status, bank_org_id, response_due_at, escalate_at, timeout_at, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [inv.id, inv.supplier_org_id, inv.buyer_org_id, myOrgId, ctx.userId, reason.trim(), opts.amount ?? null, postFunding ? 'post_funding' : 'window', inv.status, fr?.bank_org_id ?? null,
      new Date(now.getTime() + t.responseHours * 3_600_000), new Date(now.getTime() + t.escalateAfterHours * 3_600_000), new Date(now.getTime() + t.timeoutAfterHours * 3_600_000), now]);
  await transition(tx, svc, ctx, inv, 'Disputed', {
    note: reason.trim(), event: 'invoice.disputed', set: { dispute_flag: true, status_before_dispute: inv.status }, payload: { disputeId: d.id },
  });
  if (postFunding) await tx.elevated(() => tx.query('update recovery.defaults set frozen_since = coalesce(frozen_since, $2), updated_at = $2 where invoice_id = $1', [inv.id, now]));
  const who = await tx.one<{ legal_name: string }>('select legal_name from identity.organisations where id = $1', [myOrgId]);
  await tx.query(
    `insert into invoicing.dispute_messages (dispute_id, invoice_id, supplier_org_id, buyer_org_id, bank_org_id, author_org_id, author_name, author_user, kind, body, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'system',$9,$10)`,
    [d.id, inv.id, inv.supplier_org_id, inv.buyer_org_id, fr?.bank_org_id ?? null, myOrgId, who.legal_name, ctx.userId ?? null, `${who.legal_name} raised this dispute: ${reason.trim()}`, now]);
  await emit(tx, now, 'dispute.raised', { disputeId: d.id, invoiceId: inv.id, humanId: inv.human_id }, [inv.supplier_org_id, inv.buyer_org_id, ...(fr?.bank_org_id ? [fr.bank_org_id] : [])]);
  return d.id;
}

export interface DisputeTimers { responseHours: number; escalateAfterHours: number; timeoutAfterHours: number }
export const DEFAULT_DISPUTE_TIMERS: DisputeTimers = { responseHours: 48, escalateAfterHours: 72, timeoutAfterHours: 240 };
export async function disputeTimers(tx: Tx): Promise<DisputeTimers> {
  const s = await tx.elevated(() => tx.maybe<{ value: any }>("select value from platform.settings where key = 'dispute_timers'"));
  return { ...DEFAULT_DISPUTE_TIMERS, ...(s?.value ?? {}) };
}

export function dueForReminder(submittedAt: Date, now: Date, sent: number): boolean {
  const days = (now.getTime() - submittedAt.getTime()) / 86_400_000;
  return sent < REMINDER_DAYS.length && days >= REMINDER_DAYS[sent]!;
}

/** Acceptance SLA reminders at 1 and 3 days (A-16). Never auto-accepts. Called by the worker loop and tests. */
export async function sendAcceptanceReminders(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = svc.clock.now();
  const rows = await tx.query<any>("select * from invoicing.invoices where status = 'Submitted' and submitted_at is not null");
  let n = 0;
  for (const inv of rows) {
    if (!dueForReminder(new Date(inv.submitted_at), now, inv.reminder_count)) continue;
    await tx.query('update invoicing.invoices set reminder_count = reminder_count + 1 where id = $1', [inv.id]);
    await emit(tx, now, 'invoice.acceptance_reminder', { invoiceId: inv.id, humanId: inv.human_id, reminder: inv.reminder_count + 1 }, [inv.buyer_org_id, inv.supplier_org_id]);
    await audit(tx, ctx, now, { action: 'invoice.acceptance_reminder', entityType: 'invoice', entityId: inv.id, orgId: inv.buyer_org_id, after: { reminder: inv.reminder_count + 1 } });
    n++;
  }
  return n;
}

// ---------- CSV / ERP import (IN-1, IN-2, IN-5) ----------
export const CSV_COLUMNS = ['buyer', 'number', 'currency', 'amount', 'issueDate', 'dueDate', 'poNumber'] as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export interface ImportRow { buyer: string; number: string; currency: string; amount: string; issueDate: string; dueDate: string; poNumber?: string }
export interface ImportReport { created: { row: number; invoiceId: string; humanId: string }[]; errors: { row: number; message: string }[] }

/** Row-by-row import: each row is isolated by a savepoint so one bad row does not affect the others. */
export async function importRows(tx: Tx, svc: Services, ctx: Ctx, supplierId: string, supplierName: string, rows: ImportRow[], firstRowNumber = 1): Promise<ImportReport> {
  const report: ImportReport = { created: [], errors: [] };
  const buyers = await tx.query<{ id: string; legal_name: string }>(
    `select o.id, o.legal_name from identity.relationships r join identity.organisations o on o.id = r.buyer_org_id where r.supplier_org_id = $1 and r.status = 'active'`, [supplierId]);
  const byName = new Map(buyers.map((b) => [b.legal_name.trim().toLowerCase(), b.id]));
  for (let i = 0; i < rows.length; i++) {
    const n = i + firstRowNumber;
    const r = rows[i]!;
    const buyerId = byName.get((r.buyer ?? '').trim().toLowerCase());
    if (!buyerId) { report.errors.push({ row: n, message: `"${r.buyer}" is not one of your linked buyers.` }); continue; }
    await tx.query('savepoint imp');
    try {
      const inv = await createInvoice(tx, svc, ctx, supplierId, supplierName, {
        buyerOrgId: buyerId, number: r.number ?? '', currency: (r.currency ?? '').toUpperCase(), amount: (r.amount ?? '').replace(/,/g, '').trim(),
        issueDate: (r.issueDate ?? '').trim(), dueDate: (r.dueDate ?? '').trim(), poNumber: r.poNumber?.trim() || null,
      });
      await tx.query('release savepoint imp');
      report.created.push({ row: n, invoiceId: inv.id, humanId: inv.human_id });
    } catch (e) {
      await tx.query('rollback to savepoint imp');
      if (e instanceof DomainError) report.errors.push({ row: n, message: e.message });
      else throw e;
    }
  }
  return report;
}

export function csvToRows(text: string): { rows: ImportRow[]; error?: string } {
  const parsed = parseCsv(text);
  if (parsed.length < 2) return { rows: [], error: 'The file needs a header row and at least one invoice.' };
  const header = parsed[0]!.map((h) => h.trim());
  const missing = CSV_COLUMNS.filter((c) => c !== 'poNumber' && !header.includes(c));
  if (missing.length) return { rows: [], error: `Missing column(s): ${missing.join(', ')}. Expected: ${CSV_COLUMNS.join(', ')}.` };
  const idx = (c: string) => header.indexOf(c);
  const rows = parsed.slice(1).map((r) => ({
    buyer: r[idx('buyer')] ?? '', number: r[idx('number')] ?? '', currency: r[idx('currency')] ?? '', amount: r[idx('amount')] ?? '',
    issueDate: r[idx('issueDate')] ?? '', dueDate: r[idx('dueDate')] ?? '', poNumber: idx('poNumber') >= 0 ? r[idx('poNumber')] : undefined,
  }));
  return { rows };
}

void forbidden;
