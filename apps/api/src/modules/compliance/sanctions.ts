import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';

export type ScreeningOutcome = 'clear' | 'hit' | 'false_positive' | 'confirmed';

export interface ScreeningRow {
  id: string; subject_org_id: string | null; subject_name: string; invoice_id: string | null; list_version: string;
  matches: { entry: string; list: string; score: number }[]; top_score: string; outcome: ScreeningOutcome;
  reviewed_by: string | null; reviewed_at: Date | null; review_reason: string | null; created_at: Date;
}

/**
 * Screen a name against the watch list (XB-2). A match already cleared as a false positive for the same
 * organisation is not raised again (whitelist), so re-screening on every invoice does not re-open a reviewed hit.
 */
export async function screenName(
  tx: Tx, svc: Services, ctx: Ctx,
  input: { name: string; orgId?: string | null; invoiceId?: string | null },
): Promise<ScreeningRow> {
  const now = svc.clock.now();
  const res = await svc.adapters.sanctions.screen(input.name);
  let outcome: ScreeningOutcome = res.matches.length ? 'hit' : 'clear';
  if (outcome === 'hit' && input.orgId) {
    const wl = await tx.query<{ entry: string }>('select entry from compliance.sanctions_whitelist where org_id = $1', [input.orgId]);
    const cleared = new Set(wl.map((w) => w.entry));
    if (res.matches.every((m) => cleared.has(m.entry))) outcome = 'false_positive';
  }
  // Screening detail is platform-only (RLS), so the insert runs elevated; callers only ever see the outcome.
  const row = await tx.elevated(() => tx.one<ScreeningRow>(
    `insert into compliance.screening_results (subject_org_id, subject_name, invoice_id, list_version, matches, top_score, outcome, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [input.orgId ?? null, input.name, input.invoiceId ?? null, res.listVersion, JSON.stringify(res.matches), res.topScore, outcome, now]));
  if (input.orgId) {
    const org = await tx.one<{ sanctions_status: string }>('select sanctions_status from identity.organisations where id = $1', [input.orgId]);
    // Never downgrade a confirmed hit by re-screening.
    if (org.sanctions_status !== 'confirmed') {
      const status = outcome === 'hit' ? 'review' : outcome === 'false_positive' ? 'false_positive' : 'clear';
      await tx.query('update identity.organisations set sanctions_status = $2 where id = $1', [input.orgId, status]);
    }
  }
  await audit(tx, ctx, now, { action: 'sanctions.screened', entityType: 'screening', entityId: row.id, orgId: input.orgId ?? null, after: { name: input.name, outcome, topScore: res.topScore } });
  return row;
}

/** Platform review of a hit: false positive (cleared and whitelisted) or confirmed (organisation blocked). */
export async function decideScreening(
  tx: Tx, svc: Services, ctx: Ctx, id: string, decision: 'false_positive' | 'confirmed', reason: string,
) {
  const now = svc.clock.now();
  const s = await tx.maybe<ScreeningRow>('select * from compliance.screening_results where id = $1 for update', [id]);
  if (!s) throw notFound('Screening result');
  if (s.outcome !== 'hit') throw new DomainError('not_reviewable', 'Only open hits can be reviewed.', 409);
  await tx.query('update compliance.screening_results set outcome = $2, reviewed_by = $3, reviewed_at = $4, review_reason = $5 where id = $1',
    [id, decision, ctx.userId ?? null, now, reason]);
  if (s.subject_org_id) {
    if (decision === 'confirmed') {
      await tx.query("update identity.organisations set sanctions_status = 'confirmed', blocked = true where id = $1", [s.subject_org_id]);
    } else {
      for (const m of s.matches) {
        await tx.query('insert into compliance.sanctions_whitelist (org_id, entry, reason, created_at) values ($1,$2,$3,$4) on conflict do nothing',
          [s.subject_org_id, m.entry, reason, now]);
      }
      await tx.query("update identity.organisations set sanctions_status = 'false_positive' where id = $1 and sanctions_status = 'review'", [s.subject_org_id]);
    }
  }
  await audit(tx, ctx, now, { action: `sanctions.${decision}`, entityType: 'screening', entityId: id, orgId: s.subject_org_id, before: { outcome: 'hit' }, after: { outcome: decision, reason } });
}

/**
 * Funding gate input (BR-1 gate 1): why an organisation cannot transact, in plain language, or null if it can.
 * Runs with elevated visibility because counterparties' status must be checked.
 */
export async function transactBlockReason(tx: Tx, orgId: string): Promise<string | null> {
  const o = await tx.elevated(() => tx.maybe<any>('select legal_name, kyc_status, sanctions_status, blocked from identity.organisations where id = $1', [orgId]));
  if (!o) return 'The organisation does not exist.';
  if (o.blocked || o.sanctions_status === 'confirmed') return `${o.legal_name} is blocked following a sanctions screening hit.`;
  if (o.sanctions_status === 'review') return `${o.legal_name} has a sanctions screening hit awaiting review.`;
  if (o.kyc_status !== 'approved') return `${o.legal_name} has not completed KYC approval.`;
  return null;
}
