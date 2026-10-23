import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { conflict, DomainError, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { signWebhook } from '../../adapters/payments';
import { isDevLike } from '../../kernel/config';
import { createOffer } from '../marketplace/service';
import { ingestBankTransaction } from '../settlement/collection';
import { parseCsv, toCsv } from './csv';

export const ROTATION_GRACE_HOURS = 24;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const keyOut = (k: any) => ({
  id: k.id, label: k.label, prefix: k.key_prefix, status: k.status as string, expiresAt: k.expires_at ? new Date(k.expires_at).toISOString() : null,
  createdAt: new Date(k.created_at).toISOString(), lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
});

export async function listKeys(tx: Tx, orgId: string) {
  return (await tx.query<any>('select * from integration.api_keys where org_id = $1 order by created_at desc', [orgId])).map(keyOut);
}

async function issue(tx: Tx, svc: Services, orgId: string, userId: string | undefined, label: string) {
  const prefix = randomBytes(4).toString('hex'); const secret = randomBytes(24).toString('hex'); const signing = randomBytes(24).toString('hex');
  const row = await tx.one<any>(
    `insert into integration.api_keys (org_id, label, key_prefix, secret_hash, signing_secret, created_at, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [orgId, label, prefix, sha(secret), signing, svc.clock.now(), userId ?? null]);
  return { ...keyOut(row), apiKey: `ek_${prefix}_${secret}`, signingSecret: signing };
}

/** The secret and signing secret are shown once, here. */
export async function createKey(tx: Tx, svc: Services, ctx: Ctx, orgId: string, label: string) {
  const k = await issue(tx, svc, orgId, ctx.userId, label);
  await audit(tx, ctx, svc.clock.now(), { action: 'apikey.created', entityType: 'api_key', entityId: k.id, orgId, after: { label, prefix: k.prefix } });
  return k;
}

/** Rotation issues a new key and keeps the old one working for a grace period so the bank can switch over without downtime. */
export async function rotateKey(tx: Tx, svc: Services, ctx: Ctx, orgId: string, id: string) {
  const old = await tx.maybe<any>('select * from integration.api_keys where id = $1 and org_id = $2 for update', [id, orgId]);
  if (!old) throw notFound('API key');
  if (old.status !== 'active') throw conflict('wrong_state', `This key is ${old.status} and cannot be rotated.`);
  const now = svc.clock.now();
  const until = new Date(now.getTime() + ROTATION_GRACE_HOURS * 3600_000);
  await tx.query("update integration.api_keys set status = 'rotating', expires_at = $2 where id = $1", [id, until]);
  const k = await issue(tx, svc, orgId, ctx.userId, old.label);
  await audit(tx, ctx, now, { action: 'apikey.rotated', entityType: 'api_key', entityId: id, orgId, after: { replacedBy: k.id, oldKeyValidUntil: until.toISOString() } });
  return k;
}

export async function revokeKey(tx: Tx, svc: Services, ctx: Ctx, orgId: string, id: string) {
  const r = await tx.query("update integration.api_keys set status = 'revoked', expires_at = $3 where id = $1 and org_id = $2 and status <> 'revoked' returning id", [id, orgId, svc.clock.now()]);
  if (!r.length) throw notFound('API key');
  await audit(tx, ctx, svc.clock.now(), { action: 'apikey.revoked', entityType: 'api_key', entityId: id, orgId });
}

export interface MachinePrincipal { keyId: string; orgId: string; signingSecret: string }

/** Resolve `Authorization: Bearer ek_<prefix>_<secret>`. Revoked, expired and unknown keys all look the same. */
export async function authenticateKey(svc: Services, bearer: string | undefined): Promise<MachinePrincipal> {
  const bad = () => new DomainError('bad_api_key', 'The API key is missing, wrong, expired or revoked.', 401);
  const m = /^Bearer ek_([0-9a-f]{8})_([0-9a-f]{48})$/.exec(bearer ?? '');
  if (!m) throw bad();
  return svc.db.system(async (tx) => {
    const k = await tx.maybe<any>('select * from integration.api_keys where key_prefix = $1', [m[1]]);
    const hash = Buffer.from(sha(m[2]!), 'hex');
    const ok = k && timingSafeEqual(hash, Buffer.from(k.secret_hash, 'hex'));
    if (!ok) throw bad();
    const now = svc.clock.now();
    if (k.status === 'revoked' || (k.expires_at && new Date(k.expires_at) <= now)) throw bad();
    await tx.query('update integration.api_keys set last_used_at = $2 where id = $1', [k.id, now]);
    return { keyId: k.id, orgId: k.org_id, signingSecret: k.signing_secret };
  });
}

const TOLERANCE_MS = 5 * 60_000;
/** Every state-changing machine call is signed: HMAC-SHA256 over "timestamp.nonce.body" with the key's signing secret; a nonce is accepted once. */
export async function verifyMachineSignature(svc: Services, p: MachinePrincipal, headers: Record<string, unknown>, raw: string) {
  const ts = Number(headers['x-earlio-timestamp']); const nonce = String(headers['x-earlio-nonce'] ?? ''); const sig = String(headers['x-earlio-signature'] ?? '');
  const bad = (m: string) => new DomainError('bad_signature', m, 401);
  if (!ts || !nonce || !sig) throw bad('Missing signature headers.');
  if (Math.abs(svc.clock.now().getTime() - ts) > TOLERANCE_MS) throw bad('The timestamp is outside the allowed window.');
  const want = signWebhook(p.signingSecret, ts, nonce, raw);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) throw bad('The signature does not match.');
  await svc.db.system(async (tx) => {
    const fresh = await tx.query('insert into platform.webhook_nonces (nonce, bank_org_id, received_at) values ($1,$2,$3) on conflict do nothing returning nonce', [`${p.keyId}:${nonce}`, p.orgId, svc.clock.now()]);
    if (!fresh.length) throw new DomainError('replay', 'This request was already received (replay rejected).', 409);
  });
}

// ------------------------------------------------------------ webhooks (outbound)
export function checkWebhookUrl(svc: Services, url: string) {
  let u: URL; try { u = new URL(url); } catch { throw invalid('The webhook URL is not valid.'); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(isDevLike(svc.config) && local)) throw invalid('Webhook URLs must use https.');
  if (!isDevLike(svc.config) && (local || /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname))) throw invalid('Webhook URLs must be publicly reachable.');
}
export async function addWebhook(tx: Tx, svc: Services, ctx: Ctx, orgId: string, url: string, events: string[]) {
  checkWebhookUrl(svc, url);
  const w = await tx.one<any>('insert into integration.webhooks (org_id, url, events, created_at) values ($1,$2,$3,$4) returning *', [orgId, url, events, svc.clock.now()]);
  await audit(tx, ctx, svc.clock.now(), { action: 'webhook.created', entityType: 'webhook', entityId: w.id, orgId, after: { url, events } });
  return { id: w.id as string, url, events, active: true };
}
export async function listWebhooks(tx: Tx, orgId: string) {
  return (await tx.query<any>('select * from integration.webhooks where org_id = $1 and active order by created_at', [orgId])).map((w) => ({ id: w.id as string, url: w.url as string, events: w.events as string[], active: w.active as boolean }));
}
export async function removeWebhook(tx: Tx, svc: Services, ctx: Ctx, orgId: string, id: string) {
  const r = await tx.query('update integration.webhooks set active = false where id = $1 and org_id = $2 and active returning id', [id, orgId]);
  if (!r.length) throw notFound('Webhook');
  await audit(tx, ctx, svc.clock.now(), { action: 'webhook.removed', entityType: 'webhook', entityId: id, orgId });
}

/** Outbox subscriber: queue a delivery for every matching webhook of each organisation the event concerns. */
export const queueWebhooks = (svc: Services) => async (tx: Tx, e: { id: string; topic: string; payload: any; orgIds: string[] }) => {
  if (!e.orgIds?.length) return;
  const hooks = await tx.query<any>('select * from integration.webhooks where active and org_id = any($1::uuid[]) and (cardinality(events) = 0 or $2 = any(events))', [e.orgIds, e.topic]);
  for (const h of hooks) {
    await tx.query('insert into integration.webhook_deliveries (webhook_id, org_id, event_type, payload, created_at) values ($1,$2,$3,$4,$5)', [h.id, h.org_id, e.topic, JSON.stringify({ id: e.id, type: e.topic, data: e.payload }), svc.clock.now()]);
  }
};

export const MAX_DELIVERY_ATTEMPTS = 5;
/** Worker: send queued deliveries, signed with the organisation's newest active key's signing secret. A failure is retried on later passes, then parked. */
export async function deliverWebhooks(tx: Tx, svc: Services, fetchFn: typeof fetch = fetch): Promise<number> {
  const rows = await tx.query<any>(
    `select d.*, w.url from integration.webhook_deliveries d join integration.webhooks w on w.id = d.webhook_id where d.status = 'pending' and w.active order by d.id limit 50 for update of d skip locked`);
  let sent = 0;
  for (const d of rows) {
    const key = await tx.maybe<any>("select signing_secret from integration.api_keys where org_id = $1 and status in ('active','rotating') order by (status = 'active') desc, created_at desc limit 1", [d.org_id]);
    const body = JSON.stringify(d.payload); const ts = svc.clock.now().getTime(); const nonce = `dlv-${d.id}-${d.attempts + 1}`;
    try {
      const res = await fetchFn(d.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-earlio-timestamp': String(ts), 'x-earlio-nonce': nonce, 'x-earlio-signature': key ? signWebhook(key.signing_secret, ts, nonce, body) : '' }, signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await tx.query("update integration.webhook_deliveries set status = 'delivered', attempts = attempts + 1, last_error = null where id = $1", [d.id]); sent++;
    } catch (e) {
      const attempts = d.attempts + 1;
      await tx.query('update integration.webhook_deliveries set attempts = $2, last_error = $3, status = $4 where id = $1', [d.id, attempts, String((e as Error).message).slice(0, 300), attempts >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'pending']);
    }
  }
  return sent;
}
export async function listDeliveries(tx: Tx, orgId: string) {
  return (await tx.query<any>('select id, event_type, status, attempts, last_error, created_at from integration.webhook_deliveries where org_id = $1 order by id desc limit 50', [orgId]))
    .map((d) => ({ id: Number(d.id), eventType: d.event_type as string, status: d.status as string, attempts: d.attempts as number, lastError: d.last_error as string | null, createdAt: new Date(d.created_at).toISOString() }));
}

// ------------------------------------------------------------ file drop & API operations shared by console and machine routes
export interface BatchResult { id: string; rowsTotal: number; rowsOk: number; errors: { row: number; message: string }[] }
async function record(tx: Tx, svc: Services, orgId: string, kind: string, filename: string, total: number, ok: number, errors: { row: number; message: string }[], content?: string) {
  const b = await tx.one<any>('insert into integration.file_batches (org_id, kind, filename, rows_total, rows_ok, errors, content, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id',
    [orgId, kind, filename.slice(0, 120), total, ok, JSON.stringify(errors), content ?? null, svc.clock.now()]);
  return { id: b.id as string, rowsTotal: total, rowsOk: ok, errors };
}
const MAX_ROWS = 1000;

/** CSV: invoice,ratePct,advancePct,fxSpreadPct,validityHours — `invoice` is the invoice number (e.g. EXP-1042) or id. Each row stands alone: a bad row is reported and the rest still go in. */
export async function importOffersCsv(tx: Tx, svc: Services, ctx: Ctx, orgId: string, filename: string, content: string): Promise<BatchResult> {
  const rows = parseCsv(content); if (rows.length > MAX_ROWS) throw invalid(`At most ${MAX_ROWS} rows per file.`);
  const errors: { row: number; message: string }[] = []; let ok = 0;
  const num = (v: string | undefined, name: string) => { if (v == null || v === '') return undefined; const n = Number(v); if (!Number.isFinite(n)) throw invalid(`${name} is not a number.`); return n; };
  for (const [i, r] of rows.entries()) {
    await tx.query('savepoint row');
    try {
      const ref = r.invoice; if (!ref) throw invalid('invoice is required.');
      const inv = await tx.maybe<any>(`select i.id from marketplace.invitations m join invoicing.invoices i on i.id = m.invoice_id where m.bank_org_id = $1 and (i.human_id = $2 or i.id::text = $2)`, [orgId, ref]);
      if (!inv) throw notFound('Invoice');
      await createOffer(tx, svc, ctx, orgId, inv.id, { ratePct: num(r.ratePct, 'ratePct'), advancePct: num(r.advancePct, 'advancePct'), fxSpreadPct: num(r.fxSpreadPct, 'fxSpreadPct'), validityHours: num(r.validityHours, 'validityHours'), submit: true, mode: 'api', idempotencyKey: `file:${filename}:${i + 2}` } as any);
      await tx.query('release savepoint row'); ok++;
    } catch (e) { await tx.query('rollback to savepoint row'); errors.push({ row: i + 2, message: (e as Error).message }); }
  }
  return record(tx, svc, orgId, 'offers_in', filename, rows.length, ok, errors);
}

export interface StatementLineIn { bankTxnId: string; reference: string | null; currency: string; amount: string; valueDate: string; payer?: string | null }
export async function importStatementLines(tx: Tx, svc: Services, ctx: Ctx, orgId: string, lines: StatementLineIn[]) {
  let imported = 0, duplicates = 0;
  for (const l of lines) { const x = await ingestBankTransaction(tx, svc, ctx, orgId, { source: 'statement', ...l, reference: l.reference ?? null }); x.duplicate ? duplicates++ : imported++; }
  return { imported, duplicates };
}
/** CSV: bankTxnId,reference,currency,amount,valueDate,payer */
export async function importStatementCsv(tx: Tx, svc: Services, ctx: Ctx, orgId: string, filename: string, content: string): Promise<BatchResult> {
  const rows = parseCsv(content); if (rows.length > MAX_ROWS) throw invalid(`At most ${MAX_ROWS} rows per file.`);
  const errors: { row: number; message: string }[] = []; let ok = 0;
  for (const [i, r] of rows.entries()) {
    await tx.query('savepoint row');
    try {
      if (!r.bankTxnId) throw invalid('bankTxnId is required.');
      if (!['USD', 'SGD'].includes(r.currency ?? '')) throw invalid('currency must be USD or SGD.');
      if (!/^\d+(\.\d{1,2})?$/.test(r.amount ?? '')) throw invalid('amount must be a plain decimal.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.valueDate ?? '')) throw invalid('valueDate must be YYYY-MM-DD.');
      await importStatementLines(tx, svc, ctx, orgId, [{ bankTxnId: r.bankTxnId, reference: r.reference || null, currency: r.currency!, amount: r.amount!, valueDate: r.valueDate!, payer: r.payer || null }]);
      await tx.query('release savepoint row'); ok++;
    } catch (e) { await tx.query('rollback to savepoint row'); errors.push({ row: i + 2, message: (e as Error).message }); }
  }
  return record(tx, svc, orgId, 'statement_in', filename, rows.length, ok, errors);
}

export async function pendingInstructions(tx: Tx, orgId: string) {
  return (await tx.query<any>(
    `select d.reference, d.invoice_number, s.legal_name as beneficiary, d.currency, d.amount_foreign, d.fx_rate, d.amount_inr, d.value_date, d.status
       from settlement.disbursements d join identity.organisations s on s.id = d.supplier_org_id
      where d.bank_org_id = $1 and d.status in ('Instructed','FXBooked','QueuedForValueDate','Retry') order by d.instructed_at`, [orgId]))
    .map((d) => ({ reference: d.reference, invoice: d.invoice_number, beneficiary: d.beneficiary, currency: d.currency, amountForeign: d.amount_foreign, fxRate: d.fx_rate, amountInr: d.amount_inr, valueDate: String(d.value_date).slice(0, 10), status: d.status }));
}
export const INSTRUCTION_COLUMNS = ['reference', 'invoice', 'beneficiary', 'currency', 'amountForeign', 'fxRate', 'amountInr', 'valueDate', 'status'];
export async function instructionsCsv(tx: Tx, svc: Services, orgId: string, filename = 'instructions.csv') {
  const rows = await pendingInstructions(tx, orgId);
  const content = toCsv(INSTRUCTION_COLUMNS, rows);
  await record(tx, svc, orgId, 'instructions_out', filename, rows.length, rows.length, [], content);
  return content;
}
export async function listBatches(tx: Tx, orgId: string) {
  return (await tx.query<any>('select id, kind, filename, rows_total, rows_ok, errors, created_at from integration.file_batches where org_id = $1 order by created_at desc limit 50', [orgId]))
    .map((b) => ({ id: b.id as string, kind: b.kind as string, filename: b.filename as string, rowsTotal: b.rows_total as number, rowsOk: b.rows_ok as number, errors: b.errors as { row: number; message: string }[], createdAt: new Date(b.created_at).toISOString() }));
}
export async function openInvitations(tx: Tx, orgId: string) {
  return (await tx.query<any>(
    `select i.id, i.human_id, i.currency, coalesce(i.accepted_amount, i.gross_amount) as amount, i.due_date, i.status, m.status as invitation_status
       from marketplace.invitations m join invoicing.invoices i on i.id = m.invoice_id where m.bank_org_id = $1 and i.status in ('OpenForFunding','OffersReceived') order by i.due_date`, [orgId]))
    .map((r) => ({ invoiceId: r.id as string, invoice: r.human_id as string, currency: r.currency as string, amount: String(r.amount), dueDate: String(r.due_date).slice(0, 10), status: r.status as string, invitation: r.invitation_status as string }));
}
