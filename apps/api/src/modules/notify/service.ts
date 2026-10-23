import type { Tx } from '../../db/pool';
import type { Services } from '../../services';
import type { OutboxHandler } from '../../platform/outbox';

type Tpl = { subject: (p: any) => string; body: (p: any) => string; sms?: boolean };
const h = (p: any) => p.humanId ?? 'an invoice';
const TEMPLATES: Record<string, Tpl> = {
  'invoice.created': { subject: (p) => `Invoice ${h(p)} created`, body: (p) => `Invoice ${h(p)} was created.` },
  'invoice.submitted': { subject: (p) => `Invoice ${h(p)} awaiting acceptance`, body: (p) => `Invoice ${h(p)} has been submitted and is waiting for the buyer to accept it.` },
  'invoice.acceptance_reminder': { subject: (p) => `Reminder: accept invoice ${h(p)}`, body: (p) => `Invoice ${h(p)} is still waiting for your acceptance.` },
  'invoice.accepted': { subject: (p) => `Invoice ${h(p)} accepted`, body: (p) => `The buyer accepted invoice ${h(p)}. You can now ask for early payment or financing.`, sms: true },
  'invoice.rejected': { subject: (p) => `Invoice ${h(p)} rejected`, body: (p) => `The buyer rejected invoice ${h(p)}.` },
  'invoice.overdue': { subject: (p) => `Invoice ${h(p)} is overdue`, body: (p) => `Invoice ${h(p)} was not paid by its due date.`, sms: true },
  'invoice.settled': { subject: (p) => `Invoice ${h(p)} settled`, body: (p) => `Invoice ${h(p)} has been settled.` },
  'invoice.closed': { subject: (p) => `Invoice ${h(p)} closed`, body: (p) => `Invoice ${h(p)} is closed; the books agree with the bank statement.` },
  'cover.decided': { subject: (p) => `Insurance decision for ${h(p)}`, body: (p) => `The insurer has decided cover for ${h(p)}.` },
  'cover.uninsured': { subject: (p) => `${h(p)} cannot be insured`, body: (p) => `Invoice ${h(p)} has no cover, so only early payment is available.` },
  'cover.expired': { subject: (p) => `Cover for ${h(p)} expired`, body: (p) => `The insurance cover for ${h(p)} has expired.` },
  'marketplace.invited': { subject: (p) => `New financing invitation for ${h(p)}`, body: (p) => `You have been invited to quote on ${h(p)}.` },
  'offer.submitted': { subject: (p) => `New offer on ${h(p)}`, body: (p) => `A bank submitted an offer on ${h(p)}.`, sms: true },
  'financing.selected': { subject: (p) => `Offer selected for ${h(p)}`, body: (p) => `An offer was selected for ${h(p)}.` },
  'financing.consented': { subject: (p) => `Financing consent for ${h(p)}`, body: (p) => `The supplier consented to financing on ${h(p)}.` },
  'financing.approved': { subject: (p) => `Financing approved for ${h(p)}`, body: (p) => `The bank approved financing on ${h(p)}. Payment is being arranged.`, sms: true },
  'financing.funded': { subject: (p) => `${h(p)} funded`, body: (p) => `Financing on ${h(p)} is complete.`, sms: true },
  'financing.failed': { subject: (p) => `Financing failed for ${h(p)}`, body: (p) => `Financing on ${h(p)} did not complete: ${p.reason ?? 'see details'}.` },
  'disbursement.queued': { subject: (p) => `Payment for ${h(p)} scheduled`, body: (p) => `The payment for ${h(p)} is queued for its value date.` },
  'disbursement.sent': { subject: (p) => `Payment for ${h(p)} sent`, body: (p) => `The bank has sent the payment for ${h(p)}.` },
  'disbursement.credited': { subject: (p) => `₹${p.amountInr} credited for ${h(p)}`, body: (p) => `₹${p.amountInr} has been credited to your account for ${h(p)}.`, sms: true },
  'disbursement.reversed': { subject: (p) => `Payment for ${h(p)} failed`, body: (p) => `The payment for ${h(p)} failed and was reversed: ${p.reason ?? ''}`, sms: true },
  'settlement.payment_due': { subject: (p) => `Payment due for ${h(p)}`, body: (p) => `Pay ${p.currency} ${p.amount} by ${p.dueDate} using reference ${p.reference}.`, sms: true },
  'settlement.short_paid': { subject: (p) => `Short payment on ${h(p)}`, body: (p) => `The payment on ${h(p)} is short by ${p.shortBy}.`, sms: true },
  'settlement.distributed': { subject: (p) => `Payment distributed for ${h(p)}`, body: (p) => `The buyer's payment for ${h(p)} has been distributed (bank ${p.toBank}, supplier retention ${p.retention} ${p.currency}).`, sms: true },
  'settlement.reconciled': { subject: (p) => `${h(p)} reconciled`, body: (p) => `${h(p)} matches the bank statement.` },
  'settlement.exception': { subject: (p) => `Exception: ${p.type}`, body: (p) => p.detail },
  'terms.version_pending': { subject: () => 'Terms awaiting approval', body: () => 'A new terms version is waiting for a second approver.' },
  'terms.version_published': { subject: () => 'Terms published', body: () => 'A new terms version has been published.' },
  'relationship.proposed': { subject: () => 'New relationship proposed', body: () => 'A trading relationship was proposed to you.' },
  'relationship.activated': { subject: () => 'Relationship active', body: () => 'A trading relationship is now active.' },
};

const SMS_ORG = new Set(['supplier', 'buyer']);

/** `*` outbox subscriber: one in-app row per recipient organisation, plus email (and SMS / WhatsApp for key events) to be delivered by the worker. */
export const notifySubscriber = (svc: Services): OutboxHandler => async (tx, e) => {
  const tpl = TEMPLATES[e.topic];
  if (!tpl || !e.orgIds?.length) return;
  const now = svc.clock.now();
  const orgs = await tx.query<any>('select id, type from identity.organisations where id = any($1::uuid[])', [e.orgIds]);
  for (const o of orgs) {
    const channels = ['in_app', 'email', ...(tpl.sms && SMS_ORG.has(o.type) ? ['sms', 'whatsapp'] : [])];
    for (const channel of channels) {
      await tx.query(
        `insert into notify.notifications (recipient_org_id, topic, channel, status, lang, subject, body, payload, outbox_id, created_at)
         values ($1,$2,$3,$4,'en',$5,$6,$7,$8,$9) on conflict (outbox_id, recipient_org_id, channel) do nothing`,
        [o.id, e.topic, channel, channel === 'in_app' ? 'delivered' : 'queued', tpl.subject(e.payload), tpl.body(e.payload), JSON.stringify(e.payload), e.id, now]);
    }
  }
};

/** Worker: hand queued email / SMS / WhatsApp to the (simulated) channel and record what was sent. */
export async function deliverNotifications(tx: Tx, svc: Services): Promise<number> {
  const now = svc.clock.now();
  const rows = await tx.query<any>("select * from notify.notifications where status = 'queued' and channel <> 'in_app' order by created_at limit 200");
  for (const n of rows) {
    await tx.query('insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ($1,$2,$3,$4,$5)',
      ['notify', 'request', n.id, JSON.stringify({ channel: n.channel, topic: n.topic, subject: n.subject, recipientOrg: n.recipient_org_id }), now]);
    await tx.query("update notify.notifications set status = 'delivered' where id = $1", [n.id]);
  }
  return rows.length;
}
