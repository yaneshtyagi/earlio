import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { releaseUsed } from '../identity/limits';
import { rescaleCover } from '../insurance/service';
import { createRecourse } from '../recovery/recourse';
import { creditNoteEffect } from '../recovery/waterfall';
import { loadInvoice } from './service';
import { transition } from './state';

const PRE = ['Accepted', 'NotEligible', 'OpenForFunding', 'OffersReceived'];
const POST = ['Funded', 'Overdue'];

/**
 * BR-13. Before funding a credit note simply reduces the invoice, and every live offer is superseded because its price was for the old amount.
 * After funding it reduces the bank's exposure and the insured amount; the supplier owes the bank the difference in the advance.
 */
export async function issueCreditNote(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string, buyerOrgId: string | null, a: { amount: string; reason: string; disputeId?: string }) {
  const inv = await loadInvoice(tx, invoiceId, true);
  if (buyerOrgId && inv.buyer_org_id !== buyerOrgId) throw forbidden('Only the buyer on this invoice can issue a credit note.');
  if (!a.reason || a.reason.trim().length < 3) throw invalid('Say why the credit note is being issued.');
  if (D(a.amount).lte(0)) throw invalid('The credit amount must be positive.');
  const status = inv.status === 'Disputed' ? (inv.status_before_dispute as string) : inv.status;
  const stage = POST.includes(status) ? 'post_funding' : PRE.includes(status) ? 'pre_funding' : null;
  if (!stage) throw conflict('cannot_credit', `Invoice ${inv.human_id} is ${inv.status}; a credit note can be issued before funding, or while it is funded or overdue.`);
  const prior = inv.accepted_amount ?? inv.gross_amount;
  if (D(a.amount).gte(prior)) throw invalid(`A credit note must be below the invoice amount of ${prior}; to cancel the whole invoice, reject or dispute it instead.`);
  const now = svc.clock.now();
  const newAmount = D(prior).minus(a.amount).toFixed(2);
  const n = (await tx.one<any>('select count(*)::int as n from invoicing.credit_notes where invoice_id = $1', [inv.id])).n + 1;
  let bankOrgId: string | null = null, owes = '0.00';

  if (stage === 'pre_funding') {
    await tx.query('update invoicing.invoices set accepted_amount = $2, updated_at = $3 where id = $1', [inv.id, newAmount, now]);
    await tx.elevated(async () => {
      await tx.query("update marketplace.offers set status = 'Superseded' where invoice_id = $1 and status in ('Drafted','Submitted')", [inv.id]);
      await rescaleCover(tx, svc, inv.id, newAmount, prior);
    });
    const fresh = await loadInvoice(tx, inv.id, true);
    if (fresh.status === 'OffersReceived') await transition(tx, svc, ctx, fresh, 'OpenForFunding', { note: 'The invoice amount changed, so earlier offers were withdrawn' });
  } else {
    if (inv.route !== 'financing') throw conflict('early_payment', 'This invoice was paid early; there is nothing to credit against.');
    const r = await tx.elevated(async () => {
      const fr = await tx.one<any>("select * from marketplace.financing_requests where invoice_id = $1 and status = 'Funded' for update", [inv.id]);
      const exp = await tx.maybe<any>('select * from settlement.expectations where invoice_id = $1 for update', [inv.id]);
      if (!exp) throw conflict('not_ready', 'The payment instructions for this invoice are not ready yet; try again shortly.');
      if (['Distributed', 'Reconciled'].includes(exp.status)) throw conflict('settled', 'This invoice has already been paid.');
      const eff = creditNoteEffect(exp.expected_amount, exp.advance_amount, a.amount);
      await tx.query('update settlement.expectations set expected_amount = $2, advance_amount = $3, retention_amount = $4, updated_at = $5 where id = $1', [exp.id, eff.newFace, eff.newAdvance, D(eff.newFace).minus(eff.newAdvance).toFixed(2), now]);
      await tx.query('update invoicing.invoices set accepted_amount = $2, updated_at = $3 where id = $1', [inv.id, eff.newFace, now]);
      const release = D(fr.reserved_usd).times(eff.exposureReleasedPct).div(100).toDecimalPlaces(2);
      if (release.gt(0)) {
        await releaseUsed(tx, svc, { bankOrgId: fr.bank_org_id, buyerOrgId: inv.buyer_org_id, supplierOrgId: inv.supplier_org_id, amountUsd: release.toFixed(2) });
        await tx.query('update marketplace.financing_requests set reserved_usd = reserved_usd - $2 where id = $1', [fr.id, release.toFixed(2)]);
      }
      await rescaleCover(tx, svc, inv.id, eff.newFace, exp.expected_amount);
      await tx.query("update recovery.defaults set principal = $2, updated_at = $3 where invoice_id = $1", [inv.id, eff.newAdvance, now]);
      await tx.query(
        `insert into settlement.ledger_entries (invoice_id, invoice_number, bank_org_id, supplier_org_id, buyer_org_id, kind, party, currency, amount, note, at) values ($1,$2,$3,$4,$5,'credit_note','buyer',$6,$7,$8,$9)`,
        [inv.id, inv.human_id, fr.bank_org_id, inv.supplier_org_id, inv.buyer_org_id, inv.currency, a.amount, `Credit note CN-${inv.human_id}-${n}: ${a.reason.trim()}`, now]);
      return { bank: fr.bank_org_id as string, owes: eff.supplierOwes };
    });
    bankOrgId = r.bank; owes = r.owes;
    if (D(owes).gt(0)) await createRecourse(tx, svc, ctx, { invoiceId: inv.id, invoiceNumber: inv.human_id, supplierOrgId: inv.supplier_org_id, bankOrgId, currency: inv.currency, amount: owes, cause: 'credit_note', note: `Advance reduced after credit note CN-${inv.human_id}-${n}` });
  }
  const cn = await tx.one<any>(
    `insert into invoicing.credit_notes (invoice_id, invoice_number, number, supplier_org_id, buyer_org_id, bank_org_id, stage, currency, amount, prior_amount, new_amount, supplier_owes, reason, dispute_id, issued_by_org, issued_by_user, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
    [inv.id, inv.human_id, `CN-${inv.human_id}-${n}`, inv.supplier_org_id, inv.buyer_org_id, bankOrgId, stage, inv.currency, a.amount, prior, newAmount, owes, a.reason.trim(), a.disputeId ?? null, ctx.orgId ?? null, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'invoice.credit_note', entityType: 'invoice', entityId: inv.id, orgId: inv.supplier_org_id, after: { number: cn.number, amount: a.amount, stage } });
  await audit(tx, ctx, now, { action: 'invoice.credit_note', entityType: 'invoice', entityId: inv.id, orgId: inv.buyer_org_id });
  await emit(tx, now, 'invoice.credit_note', { invoiceId: inv.id, humanId: inv.human_id, number: cn.number, amount: a.amount, newAmount, currency: inv.currency, supplierOwes: owes }, [inv.supplier_org_id, inv.buyer_org_id, ...(bankOrgId ? [bankOrgId] : [])]);
  return cn;
}

export async function creditNotesFor(tx: Tx, invoiceId: string) {
  const inv = await loadInvoice(tx, invoiceId);
  return tx.query<any>('select * from invoicing.credit_notes where invoice_id = $1 order by created_at', [inv.id]);
}
export { notFound };
