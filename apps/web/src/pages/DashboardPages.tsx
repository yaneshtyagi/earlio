import { Children, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge, BarList, ChartCard, DataTable, KpiRow, Stat, Tag, formatPercent } from '@yaneshtyagi/design-system';
import { api } from '../api/client';
import { formatMoney } from '../shared/money';
import type { OrgType } from '../shared/nav';
import { ErrorNote, Loading, Page, Panel, dt } from '../ui';

type D = Record<string, any>;
const usd = (v: unknown) => formatMoney(String(v ?? 0), 'USD');

/** Bars whose length is the share of the largest value; the figure is always printed beside the bar, so a bar never carries meaning alone. */
function Bars({ title, unit, rows }: { title: ReactNode; unit: string; rows: { label: string; value: number; text: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const summary = `${typeof title === 'string' ? title : 'Chart'}: ${rows.map((r) => `${r.label} ${r.text}`).join('; ')}`;
  return (
    <ChartCard title={title} unit={unit} summary={summary}>
      <BarList items={rows.map((r) => ({ label: r.label, value: Math.round((r.value / max) * 100), valueText: r.text }))} />
    </ChartCard>
  );
}

/** One KPI. `ok` adds a word (not only a colour) saying whether the target is met. */
function Tile({ label, value, hint, ok }: { label: string; value: string; hint?: string; ok?: boolean }) {
  const { t } = useTranslation();
  return (
    <Stat label={ok === undefined ? label : <>{label} <Badge tone={ok ? 'success' : 'danger'}>{ok ? t('Target met') : t('Below target')}</Badge></>}
      value={<>{value}{hint && <span className="stat-hint">{hint}</span>}</>} />
  );
}

/** KPI rows hold at most four tiles; more are split into even rows. */
function Tiles({ children }: { children: ReactNode }) {
  const items = Children.toArray(children);
  const per = items.length <= 4 ? items.length : items.length === 5 ? 3 : 3;
  const rows: ReactNode[][] = [];
  for (let i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per));
  return <>{rows.map((r, i) => <KpiRow key={i} columns={r.length === 4 ? 4 : 3}>{r}</KpiRow>)}</>;
}

function Aging({ rows, title }: { rows: { label: string; count: number; usd: string }[]; title: string }) {
  const { t } = useTranslation();
  return <Bars title={title} unit={t("US dollars at today's mid-market rates")} rows={rows.map((r) => ({ label: t(r.label), value: Number(r.usd), text: `${usd(r.usd)} · ${t('{{n}} invoices', { n: r.count })}` }))} />;
}

function Supplier({ d }: { d: D }) {
  const { t } = useTranslation();
  return (<>
    <Aging rows={d.aging} title={t('Receivables by due date')} />
    <Panel title={t('Financed through Earlio')}>
      <Tiles>
        <Tile label={t('Invoices financed')} value={String(d.financed.count)} />
        <Tile label={t('Volume')} value={usd(d.financed.volumeUsd)} />
        <Tile label={t('Average all-in cost')} value={d.financed.count ? `${d.financed.avgAllInPct}%` : '—'} />
        <Tile label={t('Your own borrowing rate')} value={d.financed.ownBorrowingRatePct != null ? `${Number(d.financed.ownBorrowingRatePct).toFixed(2)}%` : '—'} />
        <Tile label={t('Estimated saving versus your own borrowing')} value={usd(d.financed.estimatedSavingsUsd)} ok={Number(d.financed.estimatedSavingsUsd) > 0 ? true : undefined} />
        <Tile label={t('Early payments by buyers')} value={String(d.earlyPayments.count)} hint={`${t('Discount given')}: ${usd(d.earlyPayments.discountGivenUsd)}`} />
      </Tiles>
    </Panel>
    <Bars title={t('Invoices by status')} unit={t('Invoices')} rows={d.byStatus.map((s: any) => ({ label: s.status, value: s.n, text: String(s.n) }))} />
  </>);
}

function Buyer({ d }: { d: D }) {
  const a = d.acceptance;
  return (<>
    <Aging rows={d.payables} title="Payables by due date" />
    <Panel title="Acceptance">
      <Tiles>
        <Tile label="Waiting for you" value={String(a.pending)} hint={a.pending ? `oldest waiting ${a.oldestPendingHours} h` : undefined} />
        <Tile label="Median time to accept" value={`${a.medianHours} h`} />
        <Tile label="Accepted within 3 days" value={a.shareWithin3Days == null ? '—' : `${Math.round(Number(a.shareWithin3Days) * 100)}%`} hint="target 80%" ok={a.shareWithin3Days == null ? undefined : Number(a.shareWithin3Days) >= Number(a.targetShare)} />
        <Tile label="Early-payment saving" value={usd(d.discountIncome.netSavingUsd)} hint={`${d.discountIncome.count} early payments`} />
      </Tiles>
    </Panel>
    <DataTable aria-label="Suppliers" noun="suppliers" rowKey={(s: any) => s.supplier ?? s.name}
      columns={[
        { id: 'supplier', header: 'Supplier', rowHeader: true, cell: (s: any) => s.supplier ?? s.name },
        { id: 'open', header: 'Open invoices', numeric: true, cell: (s: any) => s.open ?? s.invoices },
        { id: 'disputes', header: 'Disputes', numeric: true, cell: (s: any) => s.disputes },
        { id: 'overdue', header: 'Overdue', numeric: true, cell: (s: any) => s.overdue },
        { id: 'stability', header: 'Stability', cell: (s: any) => <Tag>{s.stability}</Tag> },
      ]}
      rows={d.suppliers} />
  </>);
}

function Bank({ d }: { d: D }) {
  const rows = (xs: any[], name: string) => xs.map((x) => ({ label: x[name] ?? x.name ?? x.buyer ?? x.supplier ?? x.corridor ?? '—', value: Number(x.exposureUsd ?? x.usedUsd ?? x.used_usd ?? x.usd ?? 0), text: usd(x.exposureUsd ?? x.usedUsd ?? x.used_usd ?? x.usd ?? 0) }));
  return (<>
    <Panel title="Funded">
      <Tiles>
        <Tile label="Invoices funded" value={String(d.funded.count)} /><Tile label="Total advanced" value={usd(d.funded.totalUsd)} /><Tile label="Last 30 days" value={usd(d.funded.last30DaysUsd)} />
        <Tile label="Outstanding" value={usd(d.funded.outstandingUsd)} /><Tile label="Overdue" value={usd(d.funded.overdueUsd)} ok={Number(d.funded.overdueUsd) === 0} />
      </Tiles>
    </Panel>
    <div className="split">
      <Bars title="Invitations" unit="Invitations by status" rows={d.pipeline.invitations.map((x: any) => ({ label: x.status, value: x.n, text: String(x.n) }))} />
      <Bars title="Offers" unit="Offers by status" rows={d.pipeline.offers.map((x: any) => ({ label: x.status, value: x.n, text: String(x.n) }))} />
    </div>
    {(['buyers', 'suppliers', 'corridors'] as const).map((k) => d.exposure[k]?.length > 0 && <Bars key={k} title={`Exposure by ${k === 'corridors' ? 'corridor' : k.slice(0, -1)}`} unit="US dollars" rows={rows(d.exposure[k], 'name')} />)}
  </>);
}

function Insurer({ d }: { d: D }) {
  return (<>
    <Panel title="Limit utilisation">
      <Tiles>
        <Tile label="Limits granted" value={usd(d.utilisation.limitUsd)} /><Tile label="Used" value={usd(d.utilisation.usedUsd)} /><Tile label="Reserved" value={usd(d.utilisation.reservedUsd)} /><Tile label="Utilisation" value={`${d.utilisation.pct}%`} />
      </Tiles>
    </Panel>
    <Bars title="Utilisation by buyer" unit="Share of each buyer's limit used" rows={d.utilisation.buyers.map((b: any) => ({ label: b.buyer, value: Number(b.utilisation_pct), text: `${b.utilisation_pct}% of ${usd(b.limit_usd)}` }))} />
    <Panel title="Cover requests">
      <Tiles><Tile label="Median time to decide" value={`${d.cover.medianDecisionHours} h`} /><Tile label="Past SLA" value={String(d.cover.overdueRequests)} ok={Number(d.cover.overdueRequests) === 0} /></Tiles>
    </Panel>
    <Bars title="Cover requests by status" unit="Requests" rows={d.cover.byStatus.map((x: any) => ({ label: x.status, value: x.n, text: String(x.n) }))} />
    {Array.isArray(d.claims) && d.claims.length > 0 && <Bars title="Claims" unit="Claims by status" rows={d.claims.map((x: any) => ({ label: x.status, value: Number(x.n ?? x.count ?? 0), text: String(x.n ?? x.count ?? 0) }))} />}
  </>);
}

export function Dashboard({ type }: { type: Exclude<OrgType, 'platform'> }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api.GET('/api/v1/dashboard')).data as D | undefined });
  if (q.isLoading) return <Loading label={t('Loading…')} />;
  if (!q.data) return <ErrorNote>The dashboard could not be loaded.</ErrorNote>;
  const d = q.data;
  return (
    <>
      <p className="hint" aria-label={t('Your dashboard')}>{t('As of {{when}}', { when: dt(d.computedAt ?? d.asOf) })}</p>
      {type === 'supplier' && <Supplier d={d} />}{type === 'buyer' && <Buyer d={d} />}{type === 'bank' && <Bank d={d} />}{type === 'insurer' && <Insurer d={d} />}
    </>
  );
}

// ================================================================ ADM-01 pilot scorecard
export function ScorecardBody() {
  const q = useQuery({ queryKey: ['scorecard'], queryFn: async () => (await api.GET('/api/v1/admin/scorecard')).data as D | undefined });
  if (!q.data) return <Loading />;
  const m = q.data.metrics;
  const pct = (v: string) => `${Math.round(Number(v) * 100)}%`;
  return (
    <>
      <p className="hint">The six measures of success from the product requirements. As of {dt(q.data.computedAt ?? q.data.asOf)}.</p>
      <Tiles>
        <Tile label="Median days, acceptance to cash" value={`${m.medianDaysAcceptanceToCash.value}`} hint={`target ${m.medianDaysAcceptanceToCash.target} · ${m.medianDaysAcceptanceToCash.sample} cases`} ok={m.medianDaysAcceptanceToCash.sample ? m.medianDaysAcceptanceToCash.met : undefined} />
        <Tile label="Average cost vs own borrowing" value={`${m.costVsBorrowing.avgAllInPct}% vs ${m.costVsBorrowing.avgBorrowingPct}%`} hint={`${m.costVsBorrowing.advantagePoints} points cheaper · target ${m.costVsBorrowing.target}`} ok={m.costVsBorrowing.sample ? m.costVsBorrowing.met : undefined} />
        <Tile label="Offers per accepted invoice" value={m.offersPerAcceptedInvoice.value} hint={`${pct(m.offersPerAcceptedInvoice.shareWithTwoOrMore)} have 2 or more · target ${m.offersPerAcceptedInvoice.target}`} ok={m.offersPerAcceptedInvoice.invoicesOpened ? Number(m.offersPerAcceptedInvoice.value) >= 2 : undefined} />
        <Tile label="Accepted within 3 days" value={pct(m.shareAcceptedWithin3Days.value)} hint={`target ${m.shareAcceptedWithin3Days.target.replace('0.80', '80%')} · ${m.shareAcceptedWithin3Days.sample} invoices`} ok={m.shareAcceptedWithin3Days.sample ? Number(m.shareAcceptedWithin3Days.value) >= 0.8 : undefined} />
        <Tile label="Default and dispute rate" value={formatPercent(Number(m.defaultAndDisputeRate.value) * 100)} hint={`${m.defaultAndDisputeRate.invoicesWithIssue} of ${m.defaultAndDisputeRate.acceptedInvoices} accepted invoices`} ok={m.defaultAndDisputeRate.acceptedInvoices ? Number(m.defaultAndDisputeRate.value) < 0.02 : undefined} />
        <Tile label="Financed volume, latest month" value={usd(m.monthlyFinancedVolumeUsd.latest)} />
      </Tiles>
      {m.monthlyFinancedVolumeUsd.series.length === 0
        ? <Panel title="Monthly financed volume"><p className="hint">Nothing financed yet.</p></Panel>
        : <Bars title="Monthly financed volume" unit="US dollars" rows={m.monthlyFinancedVolumeUsd.series.map((s: any) => ({ label: s.month, value: Number(s.usd), text: `${usd(s.usd)} · ${s.n} invoices` }))} />}
      <Panel title="Network"><p>{q.data.network.map((n: any) => `${n.n} ${n.type}${n.n === 1 ? '' : 's'}`).join(' · ')}</p></Panel>
    </>
  );
}

export function ScorecardPage() {
  return (
    <>
      <Page title="Pilot scorecard" />
      <ScorecardBody />
    </>
  );
}
