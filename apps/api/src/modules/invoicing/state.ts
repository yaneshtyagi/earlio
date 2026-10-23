import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';

export const INVOICE_STATES = ['Draft', 'Submitted', 'Rejected', 'Accepted', 'NotEligible', 'OpenForFunding', 'OffersReceived', 'Funded', 'Settled',
  'Disputed', 'Overdue', 'Defaulted', 'Closed', 'Cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATES)[number];

/** Transition table from POC plan section 3.2. Anything not listed is illegal. */
export const TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  Draft: ['Submitted', 'Cancelled'],
  Submitted: ['Accepted', 'Rejected'],
  Rejected: ['Closed'],
  Accepted: ['NotEligible', 'OpenForFunding', 'Disputed'],
  NotEligible: ['Accepted'],
  OpenForFunding: ['OffersReceived', 'Funded'],
  OffersReceived: ['Funded', 'OpenForFunding'],
  Funded: ['Settled', 'Disputed', 'Overdue'],
  Overdue: ['Settled', 'Defaulted'],
  Disputed: ['Funded', 'Settled'],
  Defaulted: ['Closed'],
  Settled: ['Closed'],
  Closed: [],
  Cancelled: [],
};

export const canTransition = (from: InvoiceStatus, to: InvoiceStatus) => TRANSITIONS[from].includes(to);

export interface InvoiceRow {
  id: string; human_id: string; supplier_org_id: string; buyer_org_id: string; status: InvoiceStatus; gross_amount: string; accepted_amount: string | null;
  currency: string; issue_date: string; due_date: string; number: string; [k: string]: any;
}

/** The single place where invoice status changes: guards the table, writes history, audit and outbox. */
export async function transition(
  tx: Tx, svc: Services, ctx: Ctx, inv: Pick<InvoiceRow, 'id' | 'human_id' | 'status' | 'supplier_org_id' | 'buyer_org_id'>, to: InvoiceStatus,
  opts: { note?: string; set?: Record<string, unknown>; event?: string; payload?: Record<string, unknown> } = {},
) {
  if (!canTransition(inv.status, to)) {
    throw new DomainError('illegal_transition', `Invoice ${inv.human_id} cannot move from ${inv.status} to ${to}.`, 409);
  }
  const now = svc.clock.now();
  const sets = ['status = $2', 'updated_at = $3'];
  const params: unknown[] = [inv.id, to, now];
  for (const [col, val] of Object.entries(opts.set ?? {})) {
    if (!/^[a-z_]+$/.test(col)) throw new Error('bad column');
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  // Compare-and-set on the old status so two concurrent transitions cannot both win.
  const res = await tx.query(`update invoicing.invoices set ${sets.join(', ')} where id = $1 and status = '${inv.status}' returning id`, params);
  if (res.length !== 1) throw new DomainError('stale_state', `Invoice ${inv.human_id} changed while you were working. Reload and try again.`, 409);
  await tx.query(
    `insert into invoicing.invoice_history (invoice_id, supplier_org_id, buyer_org_id, from_status, to_status, actor_user, actor_org, note, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [inv.id, inv.supplier_org_id, inv.buyer_org_id, inv.status, to, ctx.userId ?? null, ctx.orgId ?? null, opts.note ?? null, now]);
  await audit(tx, ctx, now, { action: `invoice.${to}`, entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id, before: { status: inv.status }, after: { status: to, note: opts.note ?? null } });
  await audit(tx, ctx, now, { action: `invoice.${to}`, entityType: 'invoice', entityId: inv.id, orgId: inv.buyer_org_id });
  await emit(tx, now, opts.event ?? `invoice.${to.toLowerCase()}`, { invoiceId: inv.id, humanId: inv.human_id, from: inv.status, to, ...(opts.payload ?? {}) }, [inv.supplier_org_id, inv.buyer_org_id]);
}
