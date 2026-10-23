import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { D, round2 } from '../../kernel/money';
import { usdEquivalent } from '../pricing/fx';
import { resolveTerms } from '../terms/service';
import { parseCsv } from '../invoicing/service';
import type { InsurerCoverRequest } from '../../adapters/insurer';

export const COVER_SLA_HOURS = 24;
export const COVER_VALIDITY_DAYS = 30;
export type CoverStatus = 'requested' | 'approved' | 'partial' | 'declined' | 'expired' | 'uninsured';
const ACTIVE: CoverStatus[] = ['approved', 'partial'];
export const isInsured = (s: string) => ACTIVE.includes(s as CoverStatus);

async function usdMids(svc: Services) {
  const now = svc.clock.now();
  return { USDINR: await svc.adapters.fx.mid('USDINR', now), SGDINR: await svc.adapters.fx.mid('SGDINR', now) };
}

export async function gatewayFor(tx: Tx, insurerOrgId: string): Promise<'manual' | 'api' | 'file'> {
  const s = await tx.elevated(() => tx.maybe<{ value: any }>('select value from platform.settings where key = $1', [`insurer_gateway:${insurerOrgId}`]));
  return (s?.value as any) ?? 'manual';
}

/** Cover for an accepted invoice is requested automatically (A-1). No insurer configured => uninsured (financing may be unavailable). */
export async function requestCover(tx: Tx, svc: Services, ctx: Ctx, invoiceId: string) {
  const existing = await tx.maybe<any>('select * from insurance.cover_records where invoice_id = $1', [invoiceId]);
  if (existing) return existing;
  const inv = await tx.maybe<any>('select * from invoicing.invoices where id = $1', [invoiceId]);
  if (!inv) throw notFound('Invoice');
  const rel = await tx.elevated(() => tx.maybe<any>('select insurer_org_id from identity.relationships where supplier_org_id = $1 and buyer_org_id = $2', [inv.supplier_org_id, inv.buyer_org_id]));
  const buyer = await tx.elevated(() => tx.one<any>('select rating_tier from identity.organisations where id = $1', [inv.buyer_org_id]));
  const now = svc.clock.now();
  const amount = inv.accepted_amount ?? inv.gross_amount;
  const insurerId: string | null = rel?.insurer_org_id ?? null;
  let row: any;
  if (!insurerId) {
    row = await tx.one(
      `insert into insurance.cover_records (invoice_id, invoice_number, supplier_org_id, buyer_org_id, status, currency, invoice_amount, buyer_tier, requested_at, decision_reason, created_at)
       values ($1,$9,$2,$3,'uninsured',$4,$5,$6,$7,$8,$7) returning *`,
      [inv.id, inv.supplier_org_id, inv.buyer_org_id, inv.currency, amount, buyer.rating_tier, now, 'No insurer is configured for this buyer–supplier relationship.', inv.human_id]);
  } else {
    const terms = (await resolveTerms(tx, now, 'insurer', insurerId, {})).terms;
    const reqPct = terms.coverPctByTier?.[buyer.rating_tier] ?? terms.coverPct;
    const gw = await gatewayFor(tx, insurerId);
    row = await tx.one(
      `insert into insurance.cover_records (invoice_id, invoice_number, supplier_org_id, buyer_org_id, insurer_org_id, status, gateway, currency, invoice_amount, requested_cover_pct, buyer_tier, requested_at, sla_due_at, created_at)
       values ($1,$12,$2,$3,$4,'requested',$5,$6,$7,$8,$9,$10,$11,$10) returning *`,
      [inv.id, inv.supplier_org_id, inv.buyer_org_id, insurerId, gw, inv.currency, amount, reqPct, buyer.rating_tier, now, new Date(now.getTime() + COVER_SLA_HOURS * 3_600_000), inv.human_id]);
  }
  await tx.query('update invoicing.invoices set cover_status = $2 where id = $1', [inv.id, row.status]);
  await audit(tx, ctx, now, { action: 'cover.requested', entityType: 'cover', entityId: row.id, orgId: insurerId ?? inv.supplier_org_id, after: { invoiceId: inv.id, status: row.status } });
  await emit(tx, now, row.status === 'uninsured' ? 'cover.uninsured' : 'cover.requested', { coverId: row.id, invoiceId: inv.id, humanId: inv.human_id }, [inv.supplier_org_id, inv.buyer_org_id, ...(insurerId ? [insurerId] : [])]);
  return row;
}

// ---------- buyer limits (concurrency-safe) ----------
export async function setBuyerLimit(tx: Tx, svc: Services, ctx: Ctx, insurerOrgId: string, a: { buyerOrgId: string; limitUsd: string; expiresAt: Date; policyNumber: string }) {
  const b = await tx.elevated(() => tx.maybe<any>("select type from identity.organisations where id = $1", [a.buyerOrgId]));
  if (!b || b.type !== 'buyer') throw invalid('That organisation is not a buyer.');
  const terms = (await resolveTerms(tx, svc.clock.now(), 'insurer', insurerOrgId, {})).terms;
  if (terms.limits && D(a.limitUsd).gt(terms.limits.perBuyerUsd)) throw new DomainError('above_policy_limit', `The per-buyer limit cannot exceed USD ${terms.limits.perBuyerUsd} under your terms.`, 422);
  const before = await tx.maybe<any>('select * from insurance.buyer_limits where insurer_org_id = $1 and buyer_org_id = $2', [insurerOrgId, a.buyerOrgId]);
  if (before && D(a.limitUsd).lt(D(before.reserved_usd).plus(before.used_usd))) {
    throw new DomainError('limit_below_usage', `The limit cannot be set below current exposure (USD ${D(before.reserved_usd).plus(before.used_usd).toFixed(2)}).`, 422);
  }
  if (!before) {
    const port = await tx.one<{ s: string }>('select coalesce(sum(limit_usd),0)::text as s from insurance.buyer_limits where insurer_org_id = $1', [insurerOrgId]);
    if (terms.limits && D(port.s).plus(a.limitUsd).gt(terms.limits.portfolioUsd)) throw new DomainError('above_portfolio_limit', `This would take the portfolio above USD ${terms.limits.portfolioUsd}.`, 422);
  }
  const now = svc.clock.now();
  await tx.query(
    `insert into insurance.buyer_limits (insurer_org_id, buyer_org_id, policy_number, limit_usd, expires_at, updated_at) values ($1,$2,$3,$4,$5,$6)
     on conflict (insurer_org_id, buyer_org_id) do update set policy_number = excluded.policy_number, limit_usd = excluded.limit_usd, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    [insurerOrgId, a.buyerOrgId, a.policyNumber, a.limitUsd, a.expiresAt, now]);
  await audit(tx, ctx, now, { action: 'insurer_limit.set', entityType: 'insurer_limit', entityId: `${insurerOrgId}:${a.buyerOrgId}`, orgId: insurerOrgId, before, after: a });
}

type Move = 'reserve' | 'consume' | 'release_reserved' | 'release_used';
const SET: Record<Move, string> = {
  reserve: 'reserved_usd = reserved_usd + $3', consume: 'reserved_usd = reserved_usd - $3, used_usd = used_usd + $3',
  release_reserved: 'reserved_usd = reserved_usd - $3', release_used: 'used_usd = used_usd - $3',
};
const GUARD: Record<Move, string> = {
  reserve: 'limit_usd - reserved_usd - used_usd >= $3 and expires_at > $4', consume: 'reserved_usd >= $3', release_reserved: 'reserved_usd >= $3', release_used: 'used_usd >= $3',
};
export async function moveBuyerLimit(tx: Tx, svc: Services, op: Move, insurerOrgId: string, buyerOrgId: string, usd: string): Promise<boolean> {
  const rows = await tx.elevated(() => tx.query(
    `update insurance.buyer_limits set ${SET[op]}, updated_at = $4 where insurer_org_id = $1 and buyer_org_id = $2 and ${GUARD[op]} returning id`,
    [insurerOrgId, buyerOrgId, usd, svc.clock.now()]));
  return rows.length === 1;
}

export async function availableLimit(tx: Tx, insurerOrgId: string, buyerOrgId: string, now: Date) {
  const l = await tx.elevated(() => tx.maybe<any>('select * from insurance.buyer_limits where insurer_org_id = $1 and buyer_org_id = $2', [insurerOrgId, buyerOrgId]));
  if (!l) return null;
  const expired = new Date(l.expires_at) <= now;
  return { ...l, expired, available: expired ? D(0) : D(l.limit_usd).minus(l.reserved_usd).minus(l.used_usd) };
}

// ---------- decisions ----------
export interface CoverDecision { decision: 'approve' | 'decline'; coverPct?: number; reason?: string }

export async function decideCover(tx: Tx, svc: Services, ctx: Ctx, coverId: string, insurerOrgId: string | null, d: CoverDecision) {
  const c = /^[0-9a-f-]{36}$/i.test(coverId) ? await tx.maybe<any>('select * from insurance.cover_records where id = $1 for update', [coverId]) : undefined;
  if (!c || (insurerOrgId && c.insurer_org_id !== insurerOrgId)) throw notFound('Cover request');
  if (c.status !== 'requested') throw conflict('already_decided', `This request is already ${c.status}.`);
  const now = svc.clock.now();
  const inv = await tx.elevated(() => tx.one<any>('select human_id, accepted_amount, gross_amount, status from invoicing.invoices where id = $1', [c.invoice_id]));
  if (['Rejected', 'Cancelled', 'Closed'].includes(inv.status)) throw conflict('invoice_closed', `Invoice ${inv.human_id} is ${inv.status}.`);
  let status: CoverStatus, coverPct: number | null = null, insured: string | null = null, reservedUsd = D(0), reason = d.reason?.trim() ?? null;
  if (d.decision === 'decline') {
    if (!reason) throw invalid('Please give a reason for declining cover.');
    status = 'declined';
  } else {
    const terms = (await resolveTerms(tx, now, 'insurer', c.insurer_org_id, {})).terms;
    const maxPct: number = terms.coverPctByTier?.[c.buyer_tier] ?? terms.coverPct;
    const wanted = d.coverPct ?? maxPct;
    if (wanted <= 0 || wanted > maxPct) throw invalid(`Cover must be above 0% and at most ${maxPct}% under your terms for a ${c.buyer_tier} buyer.`);
    const mids = await usdMids(svc);
    const amountUsd = usdEquivalent(c.invoice_amount, c.currency, mids);
    let insuredUsd = amountUsd.times(wanted).div(100).toDecimalPlaces(2);
    let capped = false;
    for (let attempt = 0; ; attempt++) {
      const lim = await availableLimit(tx, c.insurer_org_id, c.buyer_org_id, now);
      if (!lim) throw new DomainError('no_limit', 'You have not set a limit for this buyer. Set one before approving cover, or decline.', 422);
      if (lim.expired) throw new DomainError('limit_expired', 'The buyer limit has expired. Renew it before approving cover, or decline.', 422);
      if (lim.available.lte(0)) throw new DomainError('no_headroom', 'The buyer limit is fully used. Decline this request or raise the limit.', 422);
      const take = insuredUsd.gt(lim.available) ? lim.available : insuredUsd;
      capped = take.lt(insuredUsd);
      if (await moveBuyerLimit(tx, svc, 'reserve', c.insurer_org_id, c.buyer_org_id, take.toFixed(2))) { reservedUsd = take; break; }
      if (attempt > 4) throw conflict('limit_busy', 'The buyer limit changed while you were deciding. Try again.');
    }
    const fraction = reservedUsd.div(amountUsd);
    coverPct = round2(fraction.times(100)).toNumber();
    insured = round2(D(c.invoice_amount).times(fraction)).toFixed(2);
    status = coverPct >= maxPct - 1e-9 ? 'approved' : 'partial';
    if (capped) reason = `${reason ? reason + ' ' : ''}Cover reduced to ${coverPct}% because the buyer limit has only USD ${reservedUsd.toFixed(2)} of headroom.`;
  }
  const policy = d.decision === 'approve' ? (await availableLimit(tx, c.insurer_org_id, c.buyer_org_id, now))?.policy_number ?? null : null;
  await tx.query(
    `update insurance.cover_records set status = $2, cover_pct = $3, insured_amount = $4, reserved_usd = $5, decision_reason = $6, decided_by = $7, decided_at = $8, policy_number = $9, valid_until = $10 where id = $1`,
    [coverId, status, coverPct, insured, reservedUsd.toFixed(2), reason, ctx.userId ?? null, now, policy, isInsured(status) ? new Date(now.getTime() + COVER_VALIDITY_DAYS * 86_400_000) : null]);
  await tx.elevated(() => tx.query('update invoicing.invoices set cover_status = $2 where id = $1', [c.invoice_id, status]));
  await audit(tx, ctx, now, { action: `cover.${status}`, entityType: 'cover', entityId: coverId, orgId: c.insurer_org_id, before: { status: 'requested' }, after: { status, coverPct, insured, reason } });
  await audit(tx, ctx, now, { action: `cover.${status}`, entityType: 'cover', entityId: coverId, orgId: c.supplier_org_id });
  await emit(tx, now, 'cover.decided', { coverId, invoiceId: c.invoice_id, humanId: inv.human_id, status, coverPct }, [c.supplier_org_id, c.buyer_org_id, c.insurer_org_id]);
  return { status, coverPct, insuredAmount: insured };
}

/** Funding consumes the reservation; settlement or cancellation releases it. Called by Marketplace / Settlement. */
export async function consumeCover(tx: Tx, svc: Services, invoiceId: string) {
  // Funding is triggered by the bank, who cannot lock or update the insurer's record under RLS, so this runs elevated.
  return tx.elevated(() => consumeCoverInner(tx, svc, invoiceId));
}
async function consumeCoverInner(tx: Tx, svc: Services, invoiceId: string) {
  const c = await tx.maybe<any>('select * from insurance.cover_records where invoice_id = $1 for update', [invoiceId]);
  if (!c || !isInsured(c.status) || D(c.reserved_usd).lte(0)) return;
  if (!(await moveBuyerLimit(tx, svc, 'consume', c.insurer_org_id, c.buyer_org_id, c.reserved_usd))) throw new DomainError('limit_state', 'Insurer limit bookkeeping error.', 500);
  await tx.query('update insurance.cover_records set consumed_usd = reserved_usd, reserved_usd = 0 where id = $1', [c.id]);
}
export async function releaseCover(tx: Tx, svc: Services, invoiceId: string) {
  return tx.elevated(() => releaseCoverInner(tx, svc, invoiceId));
}
async function releaseCoverInner(tx: Tx, svc: Services, invoiceId: string) {
  const c = await tx.maybe<any>('select * from insurance.cover_records where invoice_id = $1 for update', [invoiceId]);
  if (!c) return;
  if (D(c.reserved_usd).gt(0)) await moveBuyerLimit(tx, svc, 'release_reserved', c.insurer_org_id, c.buyer_org_id, c.reserved_usd);
  if (D(c.consumed_usd).gt(0)) await moveBuyerLimit(tx, svc, 'release_used', c.insurer_org_id, c.buyer_org_id, c.consumed_usd);
  await tx.query('update insurance.cover_records set reserved_usd = 0, consumed_usd = 0 where id = $1', [c.id]);
}

/** Approved cover that was not used for funding in time lapses and frees its limit. */
export async function expireCovers(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const now = svc.clock.now();
  const rows = await tx.query<any>("select * from insurance.cover_records where status in ('approved','partial') and valid_until <= $1 and consumed_usd = 0", [now]);
  for (const c of rows) {
    await releaseCover(tx, svc, c.invoice_id);
    await tx.query("update insurance.cover_records set status = 'expired' where id = $1", [c.id]);
    await tx.elevated(() => tx.query("update invoicing.invoices set cover_status = 'expired' where id = $1", [c.invoice_id]));
    await audit(tx, ctx, now, { action: 'cover.expired', entityType: 'cover', entityId: c.id, orgId: c.insurer_org_id });
    await emit(tx, now, 'cover.expired', { coverId: c.id, invoiceId: c.invoice_id }, [c.supplier_org_id, c.insurer_org_id]);
  }
  return rows.length;
}

/** Insurer API gateway (XB-5): ask the simulated insurer about open API-mode requests and apply any decision. */
export async function processInsurerGateway(tx: Tx, svc: Services, ctx: Ctx): Promise<number> {
  const rows = await tx.query<any>(
    `select c.*, c.invoice_number as human_id, b.legal_name as buyer_name, b.country as buyer_country from insurance.cover_records c
       join identity.organisations b on b.id = c.buyer_org_id where c.status = 'requested' and c.gateway = 'api'`);
  let n = 0;
  for (const c of rows) {
    const req: InsurerCoverRequest = { reference: c.id, invoiceId: c.invoice_id, humanId: c.human_id, buyerName: c.buyer_name, buyerTier: c.buyer_tier, buyerCountry: c.buyer_country,
      amount: c.invoice_amount, currency: c.currency, requestedCoverPct: Number(c.requested_cover_pct), requestedAt: new Date(c.requested_at) };
    await tx.query(`insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ('insurer','request',$1,$2,$3)`, [c.id, JSON.stringify(req), svc.clock.now()]);
    const dec = await svc.adapters.insurerApi.poll(req, svc.clock.now());
    if (!dec) continue;
    await tx.query(`insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ('insurer','response',$1,$2,$3)`, [c.id, JSON.stringify(dec), svc.clock.now()]);
    await tx.query('savepoint gw');
    try {
      await decideCover(tx, svc, { platform: true, correlationId: ctx.correlationId }, c.id, null, dec.decision === 'approve'
        ? { decision: 'approve', coverPct: dec.coverPct, reason: 'Decided by the insurer API.' } : { decision: 'decline', reason: dec.reason });
      await tx.query('release savepoint gw');
      n++;
    } catch (e) {
      await tx.query('rollback to savepoint gw');
      if (e instanceof DomainError && ['no_limit', 'no_headroom', 'limit_expired'].includes(e.code)) {
        // The API approved but there is no headroom: decline automatically with the limit reason.
        await decideCover(tx, svc, { platform: true, correlationId: ctx.correlationId }, c.id, null, { decision: 'decline', reason: e.message });
        n++;
      } else throw e;
    }
  }
  return n;
}

// ---------- CSV file exchange ----------
export async function exportRequestsCsv(tx: Tx, insurerOrgId: string): Promise<string> {
  const rows = await tx.query<any>(
    `select c.id, c.invoice_number as human_id, b.legal_name as buyer, c.buyer_tier, c.currency, c.invoice_amount, c.requested_cover_pct from insurance.cover_records c
       join identity.organisations b on b.id = c.buyer_org_id
      where c.insurer_org_id = $1 and c.status = 'requested' order by c.requested_at`, [insurerOrgId]);
  const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return ['requestId,invoice,buyer,buyerTier,currency,amount,requestedCoverPct', ...rows.map((r) => [r.id, r.human_id, r.buyer, r.buyer_tier, r.currency, r.invoice_amount, r.requested_cover_pct].map(esc).join(','))].join('\n') + '\n';
}

export async function importDecisionsCsv(tx: Tx, svc: Services, ctx: Ctx, insurerOrgId: string, csv: string) {
  const parsed = parseCsv(csv);
  if (parsed.length < 2) throw invalid('The file needs a header row and at least one decision.');
  const h = parsed[0]!.map((x) => x.trim());
  for (const col of ['requestId', 'decision']) if (!h.includes(col)) throw invalid(`Missing column: ${col}. Expected requestId, decision, coverPct, reason.`);
  const ix = (c: string) => h.indexOf(c);
  const report = { applied: 0, errors: [] as { row: number; message: string }[] };
  for (let i = 1; i < parsed.length; i++) {
    const r = parsed[i]!;
    const decision = (r[ix('decision')] ?? '').trim().toLowerCase();
    if (decision !== 'approve' && decision !== 'decline') { report.errors.push({ row: i + 1, message: `Decision must be approve or decline (got "${decision}").` }); continue; }
    await tx.query('savepoint csvrow');
    try {
      const pct = ix('coverPct') >= 0 && (r[ix('coverPct')] ?? '').trim() !== '' ? Number(r[ix('coverPct')]) : undefined;
      await decideCover(tx, svc, ctx, (r[ix('requestId')] ?? '').trim(), insurerOrgId, { decision, coverPct: pct, reason: ix('reason') >= 0 ? r[ix('reason')] : undefined });
      await tx.query('release savepoint csvrow'); report.applied++;
    } catch (e) {
      await tx.query('rollback to savepoint csvrow');
      if (e instanceof DomainError) report.errors.push({ row: i + 1, message: e.message }); else throw e;
    }
  }
  return report;
}

/** BR-1 gate 5 and BR-11.6. */
export function coverGate(cover: { status: string; coverPct: number | null } | null, bankMinCoverPct: number): { ok: boolean; reason?: string; coverPct?: number } {
  if (!cover || cover.status === 'uninsured') return { ok: false, reason: 'This invoice is not insured, so bank financing is not available. Early payment is still possible.' };
  if (cover.status === 'requested') return { ok: false, reason: 'Insurance cover is still awaiting the insurer’s decision.' };
  if (cover.status === 'declined') return { ok: false, reason: 'The insurer declined cover, so bank financing is not available. Early payment is still possible.' };
  if (cover.status === 'expired') return { ok: false, reason: 'The insurance cover has expired.' };
  if ((cover.coverPct ?? 0) < bankMinCoverPct) return { ok: false, reason: `Insurance cover of ${cover.coverPct}% is below this bank's minimum of ${bankMinCoverPct}%.`, coverPct: cover.coverPct ?? 0 };
  return { ok: true, coverPct: cover.coverPct! };
}

export function availableRoutes(coverStatus: string): ('financing' | 'early_payment')[] {
  return ['requested', 'approved', 'partial'].includes(coverStatus) ? ['financing', 'early_payment'] : ['early_payment'];
}

/** Read-only lookup used by pricing/eligibility (cross-party, so elevated). */
export async function coverForInvoice(tx: Tx, invoiceId: string) {
  const c = await tx.elevated(() => tx.maybe<any>('select * from insurance.cover_records where invoice_id = $1', [invoiceId]));
  return c ? { status: c.status as string, coverPct: c.cover_pct == null ? null : Number(c.cover_pct), insurerOrgId: c.insurer_org_id as string | null } : null;
}

/** The invoice amount changed (credit note): scale the reserved / consumed cover and give the difference back to the insurer's buyer limit (BR-13). */
export async function rescaleCover(tx: Tx, svc: Services, invoiceId: string, newFace: string, oldFace: string) {
  return tx.elevated(async () => {
    const c = await tx.maybe<any>('select * from insurance.cover_records where invoice_id = $1 for update', [invoiceId]);
    if (!c) return;
    const ratio = D(newFace).div(oldFace);
    const newReserved = D(c.reserved_usd).times(ratio).toDecimalPlaces(2), newConsumed = D(c.consumed_usd).times(ratio).toDecimalPlaces(2);
    const dr = D(c.reserved_usd).minus(newReserved), dc = D(c.consumed_usd).minus(newConsumed);
    if (dr.gt(0)) await moveBuyerLimit(tx, svc, 'release_reserved', c.insurer_org_id, c.buyer_org_id, dr.toFixed(2));
    if (dc.gt(0)) await moveBuyerLimit(tx, svc, 'release_used', c.insurer_org_id, c.buyer_org_id, dc.toFixed(2));
    await tx.query('update insurance.cover_records set reserved_usd = $2, consumed_usd = $3, invoice_amount = $4, insured_amount = case when insured_amount is null then null else round(insured_amount * $5, 2) end where id = $1',
      [c.id, newReserved.toFixed(2), newConsumed.toFixed(2), newFace, ratio.toFixed(10)]);
  });
}
