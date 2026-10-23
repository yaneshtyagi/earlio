import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { conflict, notFound } from '../../kernel/errors';
import { D, round2 } from '../../kernel/money';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';

/** XB-6 / BR-12: realisation deadline in months from shipment. Configurable (platform.settings `export_realisation_months`); confirm the period with counsel. */
export async function realisationMonths(tx: Tx): Promise<number> {
  const s = await tx.elevated(() => tx.maybe<{ value: any }>("select value from platform.settings where key = 'export_realisation_months'"));
  return Number(s?.value) > 0 ? Number(s!.value) : 9;
}
const addMonths = (iso: string, m: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };

/** When an invoice is accepted its export proceeds start the realisation clock. Shipment date falls back to the issue date. */
export async function openProceeds(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  if (await tx.maybe('select 1 as x from settlement.export_proceeds where invoice_id = $1', [invoiceId])) return;
  const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [invoiceId]);
  const shipped = String(inv.shipment_date ?? inv.issue_date).slice(0, 10);
  const now = svc.clock.now();
  await tx.query(
    `insert into settlement.export_proceeds (invoice_id, invoice_number, supplier_org_id, buyer_org_id, currency, amount_foreign, shipment_date, realisation_deadline, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
    [inv.id, inv.human_id, inv.supplier_org_id, inv.buyer_org_id, inv.currency, inv.accepted_amount ?? inv.gross_amount, shipped, addMonths(shipped, await realisationMonths(tx)), now]);
}

/** Financing routes the money through the financing bank under an assignment, which can break the link between shipment and remittance (SUP-08). */
export async function noteFinancing(tx: Tx, svc: Services, invoiceId: string, bankOrgId: string) {
  await tx.elevated(() => tx.query(
    `update settlement.export_proceeds set ad_bank_org_id = $2, chain_broken = true, updated_at = $3,
       chain_note = 'The proceeds are paid to you by your financing bank under an assignment, not remitted by the buyer to you directly. Give your authorised dealer bank the assignment notice so it can match the payment to the shipping bill.' where invoice_id = $1`,
    [invoiceId, bankOrgId, svc.clock.now()]));
}

/** Rupees received so far; the record becomes Realised only once the whole invoice has been paid out (`complete`). */
export async function addRealised(tx: Tx, svc: Services, invoiceId: string, inr: string, complete = false) {
  await tx.elevated(() => tx.query(
    `update settlement.export_proceeds set realised_inr = realised_inr + $2, updated_at = $3,
       realised_at = case when $4 then $3 else realised_at end, status = case when $4 and status in ('Pending','Overdue') then 'Realised' else status end where invoice_id = $1`, [invoiceId, inr, svc.clock.now(), complete]));
}

/** Early payments arrive from the buyer in the invoice currency: convert at the day's mid rate for the record. */
export async function realiseEarly(tx: Tx, svc: Services, invoiceId: string, currency: string, amount: string) {
  const mid = await svc.adapters.fx.mid(currency === 'USD' ? 'USDINR' : 'SGDINR', svc.clock.now());
  await addRealised(tx, svc, invoiceId, round2(D(amount).times(mid)).toFixed(2), true);
}

/** Worker: proceeds not realised by the deadline are flagged and the supplier is told. */
export async function flagOverdueProceeds(tx: Tx, svc: Services): Promise<number> {
  const today = svc.clock.now().toISOString().slice(0, 10);
  const rows = await tx.query<any>("select * from settlement.export_proceeds where status = 'Pending' and realisation_deadline < $1 and invoice_id in (select id from invoicing.invoices where status not in ('Rejected','Cancelled'))", [today]);
  const now = svc.clock.now();
  for (const p of rows) {
    await tx.query("update settlement.export_proceeds set status = 'Overdue', updated_at = $2 where id = $1", [p.id, now]);
    await emit(tx, now, 'export_proceeds.overdue', { invoiceId: p.invoice_id, humanId: p.invoice_number, deadline: String(p.realisation_deadline).slice(0, 10) }, [p.supplier_org_id, ...(p.ad_bank_org_id ? [p.ad_bank_org_id] : [])]);
  }
  return rows.length;
}

/** The authorised dealer bank records that it has reported the realisation (e.g. in the export data processing system). */
export async function reportProceeds(tx: Tx, svc: Services, ctx: Ctx, bankOrgId: string, id: string, reference: string) {
  const p = await tx.maybe<any>('select * from settlement.export_proceeds where id = $1 and ad_bank_org_id = $2', [id, bankOrgId]);
  if (!p) throw notFound('Export proceeds record');
  if (p.status !== 'Realised') throw conflict('not_realised', `These proceeds are ${p.status}; they can be reported once realised.`);
  const now = svc.clock.now();
  await tx.elevated(() => tx.query("update settlement.export_proceeds set status = 'Reported', reported_at = $2, reported_by = $3, updated_at = $2 where id = $1", [id, now, ctx.userId ?? null]));
  await audit(tx, ctx, now, { action: 'export_proceeds.reported', entityType: 'export_proceeds', entityId: id, orgId: p.supplier_org_id, after: { reference } });
  await audit(tx, ctx, now, { action: 'export_proceeds.reported', entityType: 'export_proceeds', entityId: id, orgId: bankOrgId });
}
