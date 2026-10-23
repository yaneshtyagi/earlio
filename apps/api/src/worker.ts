import type { Services } from './services';
import type { OutboxHandler } from './platform/outbox';
import { drainOutbox } from './platform/outbox';
import { requestCover, processInsurerGateway, expireCovers } from './modules/insurance/service';
import { sendAcceptanceReminders } from './modules/invoicing/service';
import { expireOffers } from './modules/marketplace/service';
import { retireExpired } from './modules/terms/service';

/** Outbox subscribers: modules react to each other's events here, never by importing each other's tables. */
export function handlersFor(svc: Services): Record<string, OutboxHandler[]> {
  const ctx = (id: string) => ({ platform: true, correlationId: `evt-${id}` });
  return {
    'invoice.accepted': [async (tx, e) => { await requestCover(tx, svc, ctx(e.id), e.payload.invoiceId); }],
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
  out.events += await drainOutbox((fn) => svc.db.system(fn), handlersFor(svc), svc.clock.now());
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
