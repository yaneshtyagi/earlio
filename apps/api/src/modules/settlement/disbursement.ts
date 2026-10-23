import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { resolveTerms } from '../terms/service';
import { completeFunding, failFinancing } from '../marketplace/service';
import { DEFAULT_FAULTS, type SimFaults } from '../../adapters/payments';
import { localParts, valueDateFor } from './calendars';

export const MAX_DISBURSEMENT_ATTEMPTS = 3;
export async function simFaults(tx: Tx): Promise<SimFaults> {
  const s = await tx.elevated(() => tx.maybe<any>("select value from platform.settings where key = 'sim.faults'"));
  return { ...DEFAULT_FAULTS, ...((s?.value as Partial<SimFaults>) ?? {}) };
}

async function devent(tx: Tx, d: any, status: string, note: string | null, now: Date) {
  await tx.query('insert into settlement.disbursement_events (disbursement_id, bank_org_id, supplier_org_id, status, note, at) values ($1,$2,$3,$4,$5,$6)', [d.id, d.bank_org_id, d.supplier_org_id, status, note, now]);
  await tx.query('update settlement.disbursements set status = $2, updated_at = $3 where id = $1', [d.id, status, now]);
}

export async function raiseException(tx: Tx, svc: Services, e: { type: string; bankOrgId: string; invoiceId?: string | null; invoiceNumber?: string | null; expectationId?: string | null; bankTxnId?: string | null; disbursementId?: string | null; amount?: string | null; currency?: string | null; detail: string }) {
  const now = svc.clock.now();
  const row = await tx.one<any>(
    `insert into settlement.exceptions (type, bank_org_id, invoice_id, invoice_number, expectation_id, bank_txn_id, disbursement_id, amount, currency, detail, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [e.type, e.bankOrgId, e.invoiceId ?? null, e.invoiceNumber ?? null, e.expectationId ?? null, e.bankTxnId ?? null, e.disbursementId ?? null, e.amount ?? null, e.currency ?? null, e.detail, now]);
  await emit(tx, now, 'settlement.exception', { exceptionId: row.id, type: e.type, invoiceId: e.invoiceId, humanId: e.invoiceNumber, detail: e.detail }, [e.bankOrgId]);
  return row;
}

/** Marketplace hands over an approved financing: book the FX, work out the value date from the bank's cut-off and calendar, and queue or send. */
export async function instructDisbursement(tx: Tx, svc: Services, ctx: Ctx, frId: string) {
  const prior = await tx.maybe<any>('select * from settlement.disbursements where financing_request_id = $1', [frId]);
  if (prior) return prior; // idempotent: one instruction per financing
  const fr = await tx.one<any>('select * from marketplace.financing_requests where id = $1', [frId]);
  const inv = await tx.one<any>('select * from invoicing.invoices where id = $1', [fr.invoice_id]);
  const offer = await tx.one<any>('select * from marketplace.offers where id = $1', [fr.offer_id]);
  const bank = await tx.one<any>('select id, country, legal_name from identity.organisations where id = $1', [fr.bank_org_id]);
  const supplier = await tx.one<any>('select legal_name from identity.organisations where id = $1', [fr.supplier_org_id]);
  const now = svc.clock.now();
  const terms = (await resolveTerms(tx, now, 'bank', bank.id, { buyerOrgId: inv.buyer_org_id, supplierOrgId: inv.supplier_org_id })).terms;
  const vd = valueDateFor({ country: bank.country, timeZone: terms.cutoff.timezone, cutoff: terms.cutoff.time, now, settlementDays: terms.settlementDays });
  const fx = (offer.quote as any).fx;
  const d = await tx.one<any>(
    `insert into settlement.disbursements (financing_request_id, invoice_id, invoice_number, bank_org_id, supplier_org_id, reference, status, currency, amount_foreign, fx_pair, fx_mid, fx_spread_pct, fx_rate, amount_inr, value_date, cutoff_missed, instructed_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,'Instructed',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) returning *`,
    [fr.id, inv.id, inv.human_id, bank.id, fr.supplier_org_id, `DSB-${inv.human_id}`, inv.currency, offer.net_cash, fx.pair, fx.mid, fx.spreadPct, fx.rate, offer.net_cash_inr, vd.valueDate, vd.cutoffMissed, now]);
  await tx.query('insert into settlement.disbursement_events (disbursement_id, bank_org_id, supplier_org_id, status, note, at) values ($1,$2,$3,$4,$5,$6)', [d.id, d.bank_org_id, d.supplier_org_id, 'Instructed', `Instructed to pay ${supplier.legal_name}`, now]);
  await devent(tx, d, 'FXBooked', `${fx.pair} at ${fx.rate} (mid ${fx.mid}, spread ${fx.spreadPct}%) → ₹${offer.net_cash_inr}`, now);
  await audit(tx, ctx, now, { action: 'disbursement.instructed', entityType: 'disbursement', entityId: d.id, orgId: bank.id, after: { valueDate: vd.valueDate, amountInr: offer.net_cash_inr } });
  await audit(tx, ctx, now, { action: 'disbursement.instructed', entityType: 'disbursement', entityId: d.id, orgId: fr.supplier_org_id });
  if (vd.valueDate > vd.localDate) {
    await devent(tx, d, 'QueuedForValueDate', vd.cutoffMissed ? `After the bank's cut-off or on a non-business day; value date ${vd.valueDate}.` : `Value date ${vd.valueDate}.`, now);
    await emit(tx, now, 'disbursement.queued', { disbursementId: d.id, invoiceId: inv.id, humanId: inv.human_id, valueDate: vd.valueDate }, [fr.supplier_org_id, bank.id]);
  } else {
    await send(tx, svc, ctx, { ...d, status: 'FXBooked' });
  }
  return tx.one<any>('select * from settlement.disbursements where id = $1', [d.id]);
}

async function send(tx: Tx, svc: Services, ctx: Ctx, d: any) {
  const now = svc.clock.now();
  const supplier = await tx.one<any>('select legal_name from identity.organisations where id = $1', [d.supplier_org_id]);
  const attempt = d.attempts + 1;
  const r = await svc.adapters.payments.instruct({ reference: d.reference, bankOrgId: d.bank_org_id, beneficiary: supplier.legal_name, amountInr: d.amount_inr, valueDate: d.value_date, attempt }, now, await simFaults(tx));
  await tx.query('insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ($1,$2,$3,$4,$5)',
    ['payments', 'request', d.reference, JSON.stringify({ attempt, amountInr: d.amount_inr, valueDate: d.value_date, accepted: r.accepted, reason: r.reason ?? null }), now]);
  await tx.query('update settlement.disbursements set attempts = $2 where id = $1', [d.id, attempt]);
  if (!r.accepted) return failed(tx, svc, ctx, { ...d, attempts: attempt }, r.reason ?? 'Rejected by the bank.');
  await tx.query('update settlement.disbursements set gateway_ref = $2, sent_at = $3 where id = $1', [d.id, r.gatewayRef, now]);
  await devent(tx, d, 'Sent', `Sent to the bank (attempt ${attempt}).`, now);
  await emit(tx, now, 'disbursement.sent', { disbursementId: d.id, invoiceId: d.invoice_id, humanId: d.invoice_number }, [d.supplier_org_id, d.bank_org_id]);
}

async function failed(tx: Tx, svc: Services, ctx: Ctx, d: any, reason: string) {
  const now = svc.clock.now();
  await tx.query('update settlement.disbursements set failure_reason = $2 where id = $1', [d.id, reason]);
  await devent(tx, d, 'Failed', reason, now);
  if (d.attempts < MAX_DISBURSEMENT_ATTEMPTS) { await devent(tx, d, 'Retry', `Will retry (attempt ${d.attempts + 1} of ${MAX_DISBURSEMENT_ATTEMPTS}).`, now); return; }
  await devent(tx, d, 'Reversed', 'Retries exhausted; the instruction is reversed and the financing is released.', now);
  await raiseException(tx, svc, { type: 'DisbursementFailed', bankOrgId: d.bank_org_id, invoiceId: d.invoice_id, invoiceNumber: d.invoice_number, disbursementId: d.id, detail: `Payment to the supplier failed after ${d.attempts} attempts: ${reason}` });
  await failFinancing(tx, svc, ctx, d.financing_request_id, `Disbursement failed: ${reason}`);
  await emit(tx, now, 'disbursement.reversed', { disbursementId: d.id, invoiceId: d.invoice_id, humanId: d.invoice_number, reason }, [d.supplier_org_id, d.bank_org_id]);
}

async function credited(tx: Tx, svc: Services, ctx: Ctx, d: any) {
  const now = svc.clock.now();
  await tx.query('update settlement.disbursements set credited_at = $2 where id = $1', [d.id, now]);
  await devent(tx, d, 'Credited', `₹${d.amount_inr} credited to the supplier.`, now);
  await tx.query(
    `insert into settlement.ledger_entries (invoice_id, invoice_number, bank_org_id, supplier_org_id, kind, party, currency, amount, amount_inr, fx_rate, note, at) values ($1,$2,$3,$4,'disbursement','supplier',$5,$6,$7,$8,$9,$10)`,
    [d.invoice_id, d.invoice_number, d.bank_org_id, d.supplier_org_id, d.currency, d.amount_foreign, d.amount_inr, d.fx_rate, `Net cash disbursed at the bank's rate ${d.fx_rate}`, now]);
  await emit(tx, now, 'disbursement.credited', { disbursementId: d.id, invoiceId: d.invoice_id, humanId: d.invoice_number, amountInr: d.amount_inr }, [d.supplier_org_id, d.bank_org_id]);
  await completeFunding(tx, svc, ctx, d.financing_request_id);
}

/** Worker: send queued instructions on their value date, retry failures and poll the bank for the outcome. */
export async function processDisbursements(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = svc.clock.now();
  const rows = await tx.query<any>("select d.*, o.country as bank_country from settlement.disbursements d join identity.organisations o on o.id = d.bank_org_id where d.status in ('QueuedForValueDate','Retry','Sent') and coalesce(d.failure_reason,'') <> 'held for operations' order by d.instructed_at");
  let n = 0;
  const faults = await simFaults(tx);
  for (const d of rows) {
    await tx.query('savepoint disb');
    try {
      if (d.status === 'QueuedForValueDate' || d.status === 'Retry') {
        const terms = (await resolveTerms(tx, now, 'bank', d.bank_org_id, {})).terms;
        const today = localParts(now, terms.cutoff.timezone).date;
        if (today >= d.value_date) { await send(tx, svc, ctx, d); n++; }
      } else {
        const st = await svc.adapters.payments.query(d.gateway_ref, { amountInr: d.amount_inr }, now, faults);
        if (st.status === 'pending') { await tx.query('release savepoint disb'); continue; }
        await tx.query('insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ($1,$2,$3,$4,$5)', ['payments', 'response', d.reference, JSON.stringify(st), now]);
        if (st.status === 'credited') {
          if (st.creditedInr && st.creditedInr !== d.amount_inr) {
            await raiseException(tx, svc, { type: 'AmountMismatch', bankOrgId: d.bank_org_id, invoiceId: d.invoice_id, invoiceNumber: d.invoice_number, disbursementId: d.id, amount: st.creditedInr, currency: 'INR',
              detail: `The bank credited ₹${st.creditedInr} but ₹${d.amount_inr} was instructed.` });
            await devent(tx, d, 'Sent', 'Credit amount differs from the instruction; held for operations.', now);
            await tx.query("update settlement.disbursements set failure_reason = 'held for operations' where id = $1", [d.id]);
          } else await credited(tx, svc, ctx, d);
        } else if (st.status === 'returned') {
          await devent(tx, d, 'Returned', st.reason ?? 'Returned by the bank.', now);
          await raiseException(tx, svc, { type: 'DisbursementReturned', bankOrgId: d.bank_org_id, invoiceId: d.invoice_id, invoiceNumber: d.invoice_number, disbursementId: d.id, detail: st.reason ?? 'Funds were returned.' });
        } else await failed(tx, svc, ctx, d, st.reason ?? 'Failed.');
        n++;
      }
      await tx.query('release savepoint disb');
    } catch (e) {
      await tx.query('rollback to savepoint disb');
      throw e;
    }
  }
  return n;
}

/** Operations accepted an amount mismatch: treat the instruction as credited (the difference is booked as a ledger note). */
export async function acceptMismatch(tx: Tx, svc: Services, ctx: Ctx, disbursementId: string) {
  const d = await tx.maybe<any>('select * from settlement.disbursements where id = $1 for update', [disbursementId]);
  if (!d) throw notFound('Disbursement');
  if (d.status !== 'Sent') throw conflict('wrong_state', `The disbursement is ${d.status}.`);
  await credited(tx, svc, ctx, d);
}
export { DomainError };
