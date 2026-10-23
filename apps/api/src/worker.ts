import type { Services } from './services';
import type { OutboxHandler } from './platform/outbox';
import { drainOutbox } from './platform/outbox';
import { requestCover, processInsurerGateway, expireCovers } from './modules/insurance/service';
import { sendAcceptanceReminders } from './modules/invoicing/service';
import { expireOffers } from './modules/marketplace/service';
import { retireExpired } from './modules/terms/service';
import { instructDisbursement, processDisbursements } from './modules/settlement/disbursement';
import { createExpectation, fetchStatements, markOverdue, reconcile, settleEarlyPayments } from './modules/settlement/collection';
import { openProceeds, flagOverdueProceeds } from './modules/settlement/export';
import { openDefault, processDefaults } from './modules/recovery/service';
import { remindInstallments } from './modules/recovery/recourse';
import { processDisputeTimers } from './modules/invoicing/disputes';
import { deliverWebhooks, queueWebhooks } from './modules/integration/service';
import { refreshAll } from './modules/analytics/service';
import { deliverNotifications, notifySubscriber } from './modules/notify/service';

/** Outbox subscribers: modules react to each other's events here, never by importing each other's tables. */
export function handlersFor(svc: Services): Record<string, OutboxHandler[]> {
  const ctx = (id: string) => ({ platform: true, correlationId: `evt-${id}` });
  return {
    'invoice.accepted': [
      async (tx, e) => { await requestCover(tx, svc, ctx(e.id), e.payload.invoiceId); },
      async (tx, e) => { await openProceeds(tx, svc, ctx(e.id), e.payload.invoiceId); },
    ],
    'invoice.overdue': [async (tx, e) => { await openDefault(tx, svc, ctx(e.id), e.payload.invoiceId); }],
    'financing.approved': [async (tx, e) => { await instructDisbursement(tx, svc, ctx(e.id), e.payload.financingRequestId); }],
    'financing.funded': [async (tx, e) => { await createExpectation(tx, svc, ctx(e.id), e.payload.financingRequestId); }],
    '*': [notifySubscriber(svc), queueWebhooks(svc)],
  };
}

/** One pass over every background job. The server runs it on an interval; tests call it after moving the virtual clock. */
export async function runWorkOnce(svc: Services): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const ctx = { platform: true, correlationId: `work-${svc.clock.now().getTime()}` };
  out.events = await drainOutbox((fn) => svc.db.system(fn), handlersFor(svc), svc.clock.now());
  out.reminders = await svc.db.system((tx) => sendAcceptanceReminders(tx, svc, ctx));
  out.insurerApi = await svc.db.system((tx) => processInsurerGateway(tx, svc, ctx));
  out.offersExpired = await svc.db.system((tx) => expireOffers(tx, svc, ctx));
  out.coversExpired = await svc.db.system((tx) => expireCovers(tx, svc, ctx));
  await svc.db.system((tx) => retireExpired(tx, svc));
  out.disbursements = await svc.db.system((tx) => processDisbursements(tx, svc, ctx));
  out.statements = await svc.db.system((tx) => fetchStatements(tx, svc, ctx));
  out.reconciled = await svc.db.system((tx) => reconcile(tx, svc, ctx));
  out.overdue = await svc.db.system((tx) => markOverdue(tx, svc, ctx));
  out.disputeTimers = await svc.db.system((tx) => processDisputeTimers(tx, svc, ctx));
  out.installments = await svc.db.system((tx) => remindInstallments(tx, svc));
  out.proceedsOverdue = await svc.db.system((tx) => flagOverdueProceeds(tx, svc));
  out.earlyPaymentsSettled = await svc.db.system((tx) => settleEarlyPayments(tx, svc, ctx));
  out.webhooks = await svc.db.system((tx) => deliverWebhooks(tx, svc));
  out.dashboards = await svc.db.system((tx) => refreshAll(tx, svc));
  // Disbursement credit → completeFunding → financing.funded → expectation: drain until quiet (bounded).
  for (let i = 0; i < 4; i++) {
    const n = await drainOutbox((fn) => svc.db.system(fn), handlersFor(svc), svc.clock.now());
    out.events += n;
    if (!n) break;
  }
  out.defaults = await svc.db.system((tx) => processDefaults(tx, svc, ctx)); // after events: a default opened this pass is processed this pass
  out.events += await drainOutbox((fn) => svc.db.system(fn), handlersFor(svc), svc.clock.now());
  out.notificationsDelivered = await svc.db.system((tx) => deliverNotifications(tx, svc));
  return out;
}

export function startWorker(svc: Services, everyMs = 15_000, log: (m: string) => void = console.error) {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runWorkOnce(svc); } catch (e) { log(`worker error: ${(e as Error).message}`); } finally { running = false; }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
