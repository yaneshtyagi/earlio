import type { Tx } from '../../db/pool';
import type { Services } from '../../services';
import { D } from '../../kernel/money';

/** All money here is a USD equivalent at the day's mid rates, as a string with two decimals. */
export interface Ctx2 { tx: Tx; svc: Services; now: Date; sgd: string; today: string }

export async function context(tx: Tx, svc: Services): Promise<Ctx2> {
  const now = svc.clock.now();
  const [usd, sgd] = [await svc.adapters.fx.mid('USDINR', now), await svc.adapters.fx.mid('SGDINR', now)];
  return { tx, svc, now, sgd: D(sgd).div(D(usd)).toDecimalPlaces(6).toString(), today: now.toISOString().slice(0, 10) };
}

const OPEN = "('Submitted','Accepted','NotEligible','OpenForFunding','OffersReceived','Funded','Overdue','Disputed','Defaulted')";
const face = 'coalesce(i.accepted_amount, i.gross_amount)';
const toUsd = (a: string, cur = 'i.currency') => `(${a} * (case ${cur} when 'SGD' then $1::numeric else 1 end))`;
const money = (e: string) => `coalesce(round(sum(${e}), 2), 0)::numeric(20,2)::text`;
const BUCKETS = [['Overdue', 'd < 0'], ['Due in 0–30 days', 'd between 0 and 30'], ['Due in 31–60 days', 'd between 31 and 60'], ['Due in 61–90 days', 'd between 61 and 90'], ['Due later', 'd > 90']] as const;

async function aging(c: Ctx2, side: 'supplier_org_id' | 'buyer_org_id', orgId: string) {
  const cols = BUCKETS.map(([, cond], i) => `count(*) filter (where ${cond})::int as c${i}, coalesce(round(sum(${toUsd(face)}) filter (where ${cond}), 2), 0)::numeric(20,2)::text as u${i}`).join(', ');
  const rows = await c.tx.query<any>(
    `select ${cols}
       from (select i.*, (i.due_date - $2::date) as d from invoicing.invoices i where i.${side} = $3 and i.status in ${OPEN}${side === 'buyer_org_id' ? " and i.status <> 'Submitted'" : ''}) i`,
    [c.sgd, c.today, orgId]);
  const r = rows[0];
  return BUCKETS.map(([label], i) => ({ label, count: Number(r[`c${i}`]), usd: r[`u${i}`] ?? '0.00' }));
}

export async function supplierDashboard(c: Ctx2, orgId: string) {
  const [org] = await c.tx.query<any>('select borrowing_rate from identity.organisations where id = $1', [orgId]);
  const [fin] = await c.tx.query<any>(
    `select count(*)::int as n, ${money(toUsd(face))} as usd,
            coalesce(round(avg(o.all_in_pct), 2), 0)::text as avg_all_in,
            coalesce(round(sum(case when $3::numeric is not null then ${toUsd(face)} * o.advance_pct / 100 * ($3::numeric - o.all_in_pct) / 100 * greatest(i.due_date - fr.funded_at::date, 0) / 365 else 0 end), 2), 0)::text as savings
       from marketplace.financing_requests fr join invoicing.invoices i on i.id = fr.invoice_id join marketplace.offers o on o.id = fr.offer_id
      where fr.supplier_org_id = $2 and fr.status = 'Funded'`, [c.sgd, orgId, org?.borrowing_rate ?? null]);
  const [early] = await c.tx.query<any>(
    `select count(*)::int as n, coalesce(round(sum(ep.discount_amount * (case i.currency when 'SGD' then $1::numeric else 1 end)), 2), 0)::text as discount
       from marketplace.early_payments ep join invoicing.invoices i on i.id = ep.invoice_id where ep.supplier_org_id = $2`, [c.sgd, orgId]);
  const status = await c.tx.query<{ status: string; n: number }>('select status, count(*)::int as n from invoicing.invoices where supplier_org_id = $1 group by status order by n desc', [orgId]);
  return {
    kind: 'supplier', asOf: c.now.toISOString(), aging: await aging(c, 'supplier_org_id', orgId),
    financed: { count: fin.n, volumeUsd: fin.usd, avgAllInPct: fin.avg_all_in, ownBorrowingRatePct: org?.borrowing_rate ?? null, estimatedSavingsUsd: fin.savings },
    earlyPayments: { count: early.n, discountGivenUsd: early.discount }, byStatus: status,
  };
}

export async function buyerDashboard(c: Ctx2, orgId: string) {
  const [acc] = await c.tx.query<any>(
    `select count(*) filter (where i.status = 'Submitted')::int as pending,
            coalesce(round(max(extract(epoch from ($2::timestamptz - i.submitted_at)) / 3600) filter (where i.status = 'Submitted'), 1), 0)::text as oldest_hours,
            coalesce(round((percentile_cont(0.5) within group (order by extract(epoch from (a.decided_at - i.submitted_at)) / 3600))::numeric, 1), 0)::text as median_hours,
            count(a.id)::int as decided,
            count(a.id) filter (where a.decided_at - i.submitted_at <= interval '72 hours')::int as within3
       from invoicing.invoices i left join invoicing.acceptances a on a.invoice_id = i.id and a.decision in ('accepted','partial')
      where i.buyer_org_id = $1 and i.status <> 'Draft'`, [orgId, c.now]);
  const [disc] = await c.tx.query<any>(
    `select count(*)::int as n, coalesce(round(sum(ep.buyer_net_saving * (case i.currency when 'SGD' then $1::numeric else 1 end)), 2), 0)::text as saving
       from marketplace.early_payments ep join invoicing.invoices i on i.id = ep.invoice_id where ep.buyer_org_id = $2`, [c.sgd, orgId]);
  const sup = await c.tx.query<any>(
    `select s.legal_name as name, count(*)::int as invoices,
            count(*) filter (where i.status in ('Funded','Settled','Closed'))::int as financed,
            count(distinct d.invoice_id)::int as disputes, count(*) filter (where i.status in ('Overdue','Defaulted'))::int as overdue
       from invoicing.invoices i join identity.organisations s on s.id = i.supplier_org_id left join invoicing.disputes d on d.invoice_id = i.id
      where i.buyer_org_id = $1 and i.status not in ('Draft','Cancelled') group by s.legal_name order by invoices desc limit 10`, [orgId]);
  return {
    kind: 'buyer', asOf: c.now.toISOString(), payables: await aging(c, 'buyer_org_id', orgId),
    acceptance: { pending: acc.pending, oldestPendingHours: acc.oldest_hours, medianHours: acc.median_hours, decided: acc.decided, shareWithin3Days: acc.decided ? (acc.within3 / acc.decided).toFixed(2) : null, targetShare: '0.80' },
    discountIncome: { count: disc.n, netSavingUsd: disc.saving },
    suppliers: sup.map((s) => ({ ...s, stability: s.disputes + s.overdue === 0 ? 'steady' : s.overdue > 0 ? 'watch' : 'some disputes' })),
  };
}

export async function bankDashboard(c: Ctx2, orgId: string) {
  const inv = await c.tx.query<{ status: string; n: number }>('select status, count(*)::int as n from marketplace.invitations where bank_org_id = $1 group by status', [orgId]);
  const off = await c.tx.query<{ status: string; n: number }>('select status, count(*)::int as n from marketplace.offers where bank_org_id = $1 group by status', [orgId]);
  const [vol] = await c.tx.query<any>(
    `select ${money(`${toUsd(face)} * o.advance_pct / 100`)} as total, count(*)::int as n,
            coalesce(round(sum(${toUsd(face)} * o.advance_pct / 100) filter (where fr.funded_at > $2::timestamptz - interval '30 days'), 2), 0)::text as last30,
            coalesce(round(sum(${toUsd(face)} * o.advance_pct / 100) filter (where i.status in ('Funded','Overdue','Disputed','Defaulted')), 2), 0)::text as outstanding,
            coalesce(round(sum(${toUsd(face)} * o.advance_pct / 100) filter (where i.status in ('Overdue','Defaulted')), 2), 0)::text as overdue
       from marketplace.financing_requests fr join invoicing.invoices i on i.id = fr.invoice_id join marketplace.offers o on o.id = fr.offer_id
      where fr.bank_org_id = $3 and fr.status = 'Funded'`, [c.sgd, c.now, orgId]);
  const limits = await c.tx.query<any>(
    `select l.kind, o.legal_name as name, l.limit_usd::text, l.used_usd::text, l.reserved_usd::text, (l.limit_usd - l.used_usd - l.reserved_usd)::text as available
       from identity.bank_limits l join identity.organisations o on o.id = l.subject_org_id where l.bank_org_id = $1 order by l.used_usd desc, o.legal_name`, [orgId]);
  const corridors = await c.tx.query<any>(
    `select s.country || '-' || b.country as corridor, ${money(`${toUsd(face)} * o.advance_pct / 100`)} as usd, count(*)::int as n
       from marketplace.financing_requests fr join invoicing.invoices i on i.id = fr.invoice_id join marketplace.offers o on o.id = fr.offer_id
       join identity.organisations s on s.id = i.supplier_org_id join identity.organisations b on b.id = i.buyer_org_id
      where fr.bank_org_id = $2 and fr.status = 'Funded' and i.status in ('Funded','Overdue','Disputed','Defaulted') group by 1 order by 2 desc`, [c.sgd, orgId]);
  return {
    kind: 'bank', asOf: c.now.toISOString(), pipeline: { invitations: inv, offers: off },
    funded: { count: vol.n, totalUsd: vol.total, last30DaysUsd: vol.last30, outstandingUsd: vol.outstanding, overdueUsd: vol.overdue },
    exposure: { buyers: limits.filter((l) => l.kind === 'buyer'), suppliers: limits.filter((l) => l.kind === 'supplier'), corridors },
  };
}

export async function insurerDashboard(c: Ctx2, orgId: string) {
  const limits = await c.tx.query<any>(
    `select o.legal_name as buyer, l.limit_usd::text, l.used_usd::text, l.reserved_usd::text, (l.limit_usd - l.used_usd - l.reserved_usd)::text as available,
            case when l.limit_usd > 0 then round((l.used_usd + l.reserved_usd) / l.limit_usd * 100, 1) else 0 end::text as utilisation_pct
       from insurance.buyer_limits l join identity.organisations o on o.id = l.buyer_org_id where l.insurer_org_id = $1 order by l.used_usd desc`, [orgId]);
  const sum = (k: string) => limits.reduce((a, l) => a.plus(D(l[k])), D(0));
  const cover = await c.tx.query<{ status: string; n: number }>('select status, count(*)::int as n from insurance.cover_records where insurer_org_id = $1 group by status', [orgId]);
  const [sla] = await c.tx.query<any>(
    `select coalesce(round((percentile_cont(0.5) within group (order by extract(epoch from (decided_at - requested_at)) / 3600))::numeric, 1), 0)::text as median_hours,
            count(*) filter (where status = 'requested' and sla_due_at < $2::timestamptz)::int as overdue
       from insurance.cover_records where insurer_org_id = $1`, [orgId, c.now]);
  const claims = await c.tx.query<any>(
    `select status, count(*)::int as n, ${money(`cl.claimed_amount * (case cl.currency when 'SGD' then $1::numeric else 1 end)`)} as claimed,
            coalesce(round(sum(cl.approved_amount * (case cl.currency when 'SGD' then $1::numeric else 1 end)), 2), 0)::text as approved
       from recovery.claims cl where cl.insurer_org_id = $2 group by status`, [c.sgd, orgId]);
  return {
    kind: 'insurer', asOf: c.now.toISOString(),
    utilisation: { limitUsd: sum('limit_usd').toFixed(2), usedUsd: sum('used_usd').toFixed(2), reservedUsd: sum('reserved_usd').toFixed(2), pct: sum('limit_usd').gt(0) ? sum('used_usd').plus(sum('reserved_usd')).div(sum('limit_usd')).times(100).toFixed(1) : '0.0', buyers: limits },
    cover: { byStatus: cover, medianDecisionHours: sla.median_hours, overdueRequests: sla.overdue }, claims,
  };
}

/** ADM-01: the six success metrics from the PRD (section 6), plus the numbers behind them. */
export async function scorecard(c: Ctx2) {
  const [cash] = await c.tx.query<any>(
    `with t as (
        select extract(epoch from (fr.funded_at - i.accepted_at)) / 86400 as days from marketplace.financing_requests fr join invoicing.invoices i on i.id = fr.invoice_id where fr.status = 'Funded' and i.accepted_at is not null
        union all
        select extract(epoch from (ep.executed_at - i.accepted_at)) / 86400 from marketplace.early_payments ep join invoicing.invoices i on i.id = ep.invoice_id where i.accepted_at is not null)
     select count(*)::int as n, coalesce(round((percentile_cont(0.5) within group (order by days))::numeric, 2), 0)::text as median,
            count(*) filter (where days <= 2)::int as within2 from t`);
  const [cost] = await c.tx.query<any>(
    `select count(*)::int as n, coalesce(round(avg(o.all_in_pct), 2), 0)::text as all_in, coalesce(round(avg(s.borrowing_rate), 2), 0)::text as borrowing
       from marketplace.financing_requests fr join marketplace.offers o on o.id = fr.offer_id join identity.organisations s on s.id = fr.supplier_org_id
      where fr.status = 'Funded' and s.borrowing_rate is not null`);
  const [offers] = await c.tx.query<any>(
    `with inv as (select distinct invoice_id from marketplace.invitations),
          n as (select invoice_id, count(*) filter (where status <> 'Drafted') as offers from marketplace.offers group by invoice_id)
     select count(*)::int as invoices, coalesce(sum(n.offers), 0)::int as offers, count(*) filter (where n.offers >= 2)::int as multi
       from inv left join n on n.invoice_id = inv.invoice_id`);
  const [fast] = await c.tx.query<any>(
    `select count(*)::int as decided, count(*) filter (where a.decided_at - i.submitted_at <= interval '72 hours')::int as fast
       from invoicing.acceptances a join invoicing.invoices i on i.id = a.invoice_id where a.decision in ('accepted','partial') and i.submitted_at is not null`);
  const [risk] = await c.tx.query<any>(
    `select (select count(*)::int from invoicing.invoices where accepted_at is not null) as accepted,
            (select count(*)::int from (select invoice_id from invoicing.disputes union select invoice_id from recovery.defaults) x) as problem`);
  const monthly = await c.tx.query<any>(
    `select to_char(date_trunc('month', fr.funded_at), 'YYYY-MM') as month, ${money(`${toUsd(face)} * o.advance_pct / 100`)} as usd, count(*)::int as n
       from marketplace.financing_requests fr join invoicing.invoices i on i.id = fr.invoice_id join marketplace.offers o on o.id = fr.offer_id
      where fr.status = 'Funded' group by 1 order by 1 desc limit 12`, [c.sgd]);
  const early = await c.tx.query<any>(
    `select to_char(date_trunc('month', ep.executed_at), 'YYYY-MM') as month, coalesce(round(sum(ep.buyer_pays * (case i.currency when 'SGD' then $1::numeric else 1 end)), 2), 0)::text as usd, count(*)::int as n
       from marketplace.early_payments ep join invoicing.invoices i on i.id = ep.invoice_id group by 1 order by 1 desc limit 12`, [c.sgd]);
  const net = await c.tx.query<{ type: string; n: number }>("select type, count(*)::int as n from identity.organisations where kyc_status = 'approved' group by type order by type");
  const diff = D(cost.borrowing).minus(D(cost.all_in));
  return {
    kind: 'scorecard', asOf: c.now.toISOString(),
    metrics: {
      medianDaysAcceptanceToCash: { value: cash.median, sample: cash.n, within2Days: cash.within2, target: '≤ 2', met: cash.n > 0 && D(cash.median).lte(2) },
      costVsBorrowing: { avgAllInPct: cost.all_in, avgBorrowingPct: cost.borrowing, advantagePoints: diff.toFixed(2), sample: cost.n, target: '≥ 3 points cheaper', met: cost.n > 0 && diff.gte(3) },
      offersPerAcceptedInvoice: { value: offers.invoices ? D(offers.offers).div(offers.invoices).toFixed(2) : '0.00', invoicesOpened: offers.invoices, withTwoOrMore: offers.multi, shareWithTwoOrMore: offers.invoices ? D(offers.multi).div(offers.invoices).toFixed(2) : '0.00', target: '≥ 2' },
      shareAcceptedWithin3Days: { value: fast.decided ? D(fast.fast).div(fast.decided).toFixed(2) : '0.00', sample: fast.decided, target: '≥ 0.80' },
      defaultAndDisputeRate: { value: risk.accepted ? D(risk.problem).div(risk.accepted).toFixed(3) : '0.000', invoicesWithIssue: risk.problem, acceptedInvoices: risk.accepted, target: '< 0.02 defaults' },
      monthlyFinancedVolumeUsd: { latest: monthly[0]?.usd ?? '0.00', series: monthly.reverse(), earlyPaymentSeries: early.reverse() },
    },
    network: net,
  };
}

/**
 * The whole network for platform staff: every organisation except the platform itself, and every link between them.
 * Live, not a projection: limits and relationships change one at a time and staff expect to see the change at once.
 */
export async function network(c: Ctx2) {
  const nodes = await c.tx.query<any>(
    `select id, type, legal_name, country, kyc_status, sanctions_status, blocked, rating_tier, msme, is_partner
       from identity.organisations where type <> 'platform' order by type, legal_name`);
  const trade = await c.tx.query<any>(
    `select r.id, r.supplier_org_id, r.buyer_org_id, r.status, r.insurer_org_id,
            count(i.id)::int as invoices, ${money(toUsd(face))} as usd
       from identity.relationships r
       left join invoicing.invoices i on i.supplier_org_id = r.supplier_org_id and i.buyer_org_id = r.buyer_org_id and i.status not in ('Draft','Cancelled')
      group by r.id order by r.created_at`, [c.sgd]);
  const bankLimits = await c.tx.query<any>('select id, bank_org_id, subject_org_id, kind, limit_usd, reserved_usd, used_usd from identity.bank_limits order by bank_org_id, subject_org_id');
  const coverLimits = await c.tx.query<any>('select id, insurer_org_id, buyer_org_id, policy_number, limit_usd, reserved_usd, used_usd, expires_at from insurance.buyer_limits order by insurer_org_id, buyer_org_id');
  const preferred = await c.tx.query<any>('select org_id, bank_org_id from identity.org_preferred_banks order by org_id, bank_org_id');
  const financed = await c.tx.query<any>(
    `select fr.bank_org_id, fr.supplier_org_id, count(*)::int as n, ${money(toUsd(face))} as usd
       from marketplace.financing_requests fr join invoicing.invoices i on i.id = fr.invoice_id
      where fr.status = 'Funded' group by 1, 2 order by 1, 2`, [c.sgd]);
  const edge = (e: Partial<NetworkEdge> & Pick<NetworkEdge, 'id' | 'kind' | 'from' | 'to'>): NetworkEdge =>
    ({ status: null, detail: null, limitUsd: null, reservedUsd: null, usedUsd: null, count: null, volumeUsd: null, expiresAt: null, ...e });
  return {
    asOf: c.now.toISOString(),
    nodes: nodes.map((o) => ({ id: o.id as string, type: o.type as string, name: o.legal_name as string, country: o.country as string, kycStatus: o.kyc_status as string,
      sanctionsStatus: o.sanctions_status as string, blocked: o.blocked as boolean, ratingTier: o.rating_tier as string | null, msme: o.msme as boolean, partner: o.is_partner as boolean })),
    edges: [
      ...trade.map((r) => edge({ id: `trade:${r.id}`, kind: 'trade', from: r.supplier_org_id, to: r.buyer_org_id, status: r.status, detail: r.insurer_org_id, count: r.invoices, volumeUsd: r.usd })),
      ...bankLimits.map((l) => edge({ id: `bank_limit:${l.id}`, kind: 'bank_limit', from: l.bank_org_id, to: l.subject_org_id, detail: l.kind, limitUsd: l.limit_usd, reservedUsd: l.reserved_usd, usedUsd: l.used_usd })),
      ...coverLimits.map((l) => edge({ id: `cover_limit:${l.id}`, kind: 'cover_limit', from: l.insurer_org_id, to: l.buyer_org_id, detail: l.policy_number, limitUsd: l.limit_usd, reservedUsd: l.reserved_usd, usedUsd: l.used_usd, expiresAt: (l.expires_at as Date).toISOString() })),
      ...preferred.map((p) => edge({ id: `preferred_bank:${p.org_id}:${p.bank_org_id}`, kind: 'preferred_bank', from: p.org_id, to: p.bank_org_id })),
      ...financed.map((f) => edge({ id: `financed:${f.bank_org_id}:${f.supplier_org_id}`, kind: 'financed', from: f.bank_org_id, to: f.supplier_org_id, count: f.n, volumeUsd: f.usd })),
    ],
  };
}

export interface NetworkEdge {
  id: string;
  kind: 'trade' | 'bank_limit' | 'cover_limit' | 'preferred_bank' | 'financed';
  from: string;
  to: string;
  status: string | null;
  /** trade: the insurer org id on the relationship; bank_limit: 'buyer' or 'supplier'; cover_limit: the policy number. */
  detail: string | null;
  limitUsd: string | null;
  reservedUsd: string | null;
  usedUsd: string | null;
  count: number | null;
  volumeUsd: string | null;
  expiresAt: string | null;
}
