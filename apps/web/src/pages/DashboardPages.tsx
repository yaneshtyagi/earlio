import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { formatMoney } from '../shared/money';
import type { OrgType } from '../shared/nav';

type D = Record<string, any>;
const usd = (v: unknown) => formatMoney(String(v ?? 0), 'USD');

/** A horizontal bar whose length is the share of the largest value; the figures are always printed next to it, so the bar never carries meaning alone. */
function Bars({ rows }: { rows: { label: string; value: number; text: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars" role="list">
      {rows.map((r) => (
        <div className="bar-row" role="listitem" key={r.label}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="bar-text">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
const Tile = ({ label, value, hint, ok }: { label: string; value: string; hint?: string; ok?: boolean }) => (
  <div className={`tile${ok === true ? ' met' : ok === false ? ' unmet' : ''}`}><div className="tile-label">{label}</div><div className="tile-value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>
);

function Aging({ rows, title }: { rows: { label: string; count: number; usd: string }[]; title: string }) {
  const { t } = useTranslation();
  return (<div className="panel"><h3>{title}</h3><Bars rows={rows.map((r) => ({ label: t(r.label), value: Number(r.usd), text: `${usd(r.usd)} · ${t('{{n}} invoices', { n: r.count })}` }))} /><p className="hint">{t("Amounts are shown in US dollars at today's mid-market rates.")}</p></div>);
}

function Supplier({ d }: { d: D }) {
  const { t } = useTranslation();
  return (<>
    <Aging rows={d.aging} title={t('Receivables by due date')} />
    <div className="panel"><h3>{t('Financed through Earlio')}</h3>
      <div className="tiles">
        <Tile label={t('Invoices financed')} value={String(d.financed.count)} />
        <Tile label={t('Volume')} value={usd(d.financed.volumeUsd)} />
        <Tile label={t('Average all-in cost')} value={d.financed.count ? `${d.financed.avgAllInPct}%` : '—'} />
        <Tile label={t('Your own borrowing rate')} value={d.financed.ownBorrowingRatePct != null ? `${Number(d.financed.ownBorrowingRatePct).toFixed(2)}%` : '—'} />
        <Tile label={t('Estimated saving versus your own borrowing')} value={usd(d.financed.estimatedSavingsUsd)} ok={Number(d.financed.estimatedSavingsUsd) > 0 ? true : undefined} />
        <Tile label={t('Early payments by buyers')} value={String(d.earlyPayments.count)} hint={`${t('Discount given')}: ${usd(d.earlyPayments.discountGivenUsd)}`} />
      </div></div>
    <div className="panel"><h3>{t('Invoices by status')}</h3><Bars rows={d.byStatus.map((s: any) => ({ label: s.status, value: s.n, text: String(s.n) }))} /></div>
  </>);
}

function Buyer({ d }: { d: D }) {
  const a = d.acceptance;
  return (<>
    <Aging rows={d.payables} title="Payables by due date" />
    <div className="panel"><h3>Acceptance</h3><div className="tiles">
      <Tile label="Waiting for you" value={String(a.pending)} hint={a.pending ? `oldest waiting ${a.oldestPendingHours} h` : undefined} />
      <Tile label="Median time to accept" value={`${a.medianHours} h`} />
      <Tile label="Accepted within 3 days" value={a.shareWithin3Days == null ? '—' : `${Math.round(Number(a.shareWithin3Days) * 100)}%`} hint="target 80%" ok={a.shareWithin3Days == null ? undefined : Number(a.shareWithin3Days) >= Number(a.targetShare)} />
      <Tile label="Early-payment saving" value={usd(d.discountIncome.netSavingUsd)} hint={`${d.discountIncome.count} early payments`} />
    </div></div>
    <div className="panel"><h3>Suppliers</h3>
      <table><thead><tr><th>Supplier</th><th className="num">Open invoices</th><th className="num">Disputes</th><th className="num">Overdue</th><th>Stability</th></tr></thead>
        <tbody>{d.suppliers.map((s: any) => <tr key={s.supplier ?? s.name}><td>{s.supplier ?? s.name}</td><td className="num">{s.open ?? s.invoices}</td><td className="num">{s.disputes}</td><td className="num">{s.overdue}</td><td><span className="chip">{s.stability}</span></td></tr>)}</tbody></table></div>
  </>);
}

function Bank({ d }: { d: D }) {
  const rows = (xs: any[], name: string) => xs.map((x) => ({ label: x[name] ?? x.name ?? x.buyer ?? x.supplier ?? x.corridor ?? '—', value: Number(x.exposureUsd ?? x.usedUsd ?? x.used_usd ?? x.usd ?? 0), text: usd(x.exposureUsd ?? x.usedUsd ?? x.used_usd ?? x.usd ?? 0) }));
  return (<>
    <div className="panel"><h3>Funded</h3><div className="tiles">
      <Tile label="Invoices funded" value={String(d.funded.count)} /><Tile label="Total advanced" value={usd(d.funded.totalUsd)} /><Tile label="Last 30 days" value={usd(d.funded.last30DaysUsd)} />
      <Tile label="Outstanding" value={usd(d.funded.outstandingUsd)} /><Tile label="Overdue" value={usd(d.funded.overdueUsd)} ok={Number(d.funded.overdueUsd) === 0 ? true : false} />
    </div></div>
    <div className="panel"><h3>Pipeline</h3>
      <div className="row"><div><h4>Invitations</h4><Bars rows={d.pipeline.invitations.map((x: any) => ({ label: x.status, value: x.n, text: String(x.n) }))} /></div>
        <div><h4>Offers</h4><Bars rows={d.pipeline.offers.map((x: any) => ({ label: x.status, value: x.n, text: String(x.n) }))} /></div></div></div>
    {(['buyers', 'suppliers', 'corridors'] as const).map((k) => d.exposure[k]?.length > 0 && <div className="panel" key={k}><h3>Exposure by {k === 'corridors' ? 'corridor' : k.slice(0, -1)}</h3><Bars rows={rows(d.exposure[k], 'name')} /></div>)}
  </>);
}

function Insurer({ d }: { d: D }) {
  return (<>
    <div className="panel"><h3>Limit utilisation</h3><div className="tiles">
      <Tile label="Limits granted" value={usd(d.utilisation.limitUsd)} /><Tile label="Used" value={usd(d.utilisation.usedUsd)} /><Tile label="Reserved" value={usd(d.utilisation.reservedUsd)} /><Tile label="Utilisation" value={`${d.utilisation.pct}%`} />
    </div>
      <Bars rows={d.utilisation.buyers.map((b: any) => ({ label: b.buyer, value: Number(b.utilisation_pct), text: `${b.utilisation_pct}% of ${usd(b.limit_usd)}` }))} /></div>
    <div className="panel"><h3>Cover requests</h3><div className="tiles">
      <Tile label="Median time to decide" value={`${d.cover.medianDecisionHours} h`} /><Tile label="Past SLA" value={String(d.cover.overdueRequests)} ok={Number(d.cover.overdueRequests) === 0} /></div>
      <Bars rows={d.cover.byStatus.map((x: any) => ({ label: x.status, value: x.n, text: String(x.n) }))} /></div>
    {Array.isArray(d.claims) && d.claims.length > 0 && <div className="panel"><h3>Claims</h3><Bars rows={d.claims.map((x: any) => ({ label: x.status, value: Number(x.n ?? x.count ?? 0), text: String(x.n ?? x.count ?? 0) }))} /></div>}
  </>);
}

export function Dashboard({ type }: { type: Exclude<OrgType, 'platform'> }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: async () => (await api.GET('/api/v1/dashboard')).data as D | undefined });
  if (q.isLoading) return <p>{t('Loading…')}</p>;
  if (!q.data) return <p className="alert" role="alert">The dashboard could not be loaded.</p>;
  const d = q.data;
  return (
    <section aria-label={t('Your dashboard')}>
      <h3>{t('Your dashboard')} <small className="hint">{t('As of {{when}}', { when: new Date(d.computedAt ?? d.asOf).toLocaleString() })}</small></h3>
      {type === 'supplier' && <Supplier d={d} />}{type === 'buyer' && <Buyer d={d} />}{type === 'bank' && <Bank d={d} />}{type === 'insurer' && <Insurer d={d} />}
    </section>
  );
}

// ================================================================ ADM-01 pilot scorecard
export function ScorecardPage() {
  const q = useQuery({ queryKey: ['scorecard'], queryFn: async () => (await api.GET('/api/v1/admin/scorecard')).data as D | undefined });
  if (!q.data) return <p>Loading…</p>;
  const m = q.data.metrics;
  const pct = (v: string) => `${Math.round(Number(v) * 100)}%`;
  return (
    <section>
      <h2>Pilot scorecard</h2>
      <p className="hint">The six measures of success from the product requirements. As of {new Date(q.data.computedAt ?? q.data.asOf).toLocaleString()}.</p>
      <div className="tiles">
        <Tile label="Median days, acceptance to cash" value={`${m.medianDaysAcceptanceToCash.value}`} hint={`target ${m.medianDaysAcceptanceToCash.target} · ${m.medianDaysAcceptanceToCash.sample} cases`} ok={m.medianDaysAcceptanceToCash.sample ? m.medianDaysAcceptanceToCash.met : undefined} />
        <Tile label="Average cost vs own borrowing" value={`${m.costVsBorrowing.avgAllInPct}% vs ${m.costVsBorrowing.avgBorrowingPct}%`} hint={`${m.costVsBorrowing.advantagePoints} points cheaper · target ${m.costVsBorrowing.target}`} ok={m.costVsBorrowing.sample ? m.costVsBorrowing.met : undefined} />
        <Tile label="Offers per accepted invoice" value={m.offersPerAcceptedInvoice.value} hint={`${pct(m.offersPerAcceptedInvoice.shareWithTwoOrMore)} have 2 or more · target ${m.offersPerAcceptedInvoice.target}`} ok={m.offersPerAcceptedInvoice.invoicesOpened ? Number(m.offersPerAcceptedInvoice.value) >= 2 : undefined} />
        <Tile label="Accepted within 3 days" value={pct(m.shareAcceptedWithin3Days.value)} hint={`target ${m.shareAcceptedWithin3Days.target.replace('0.80', '80%')} · ${m.shareAcceptedWithin3Days.sample} invoices`} ok={m.shareAcceptedWithin3Days.sample ? Number(m.shareAcceptedWithin3Days.value) >= 0.8 : undefined} />
        <Tile label="Default and dispute rate" value={`${(Number(m.defaultAndDisputeRate.value) * 100).toFixed(1)}%`} hint={`${m.defaultAndDisputeRate.invoicesWithIssue} of ${m.defaultAndDisputeRate.acceptedInvoices} accepted invoices`} ok={m.defaultAndDisputeRate.acceptedInvoices ? Number(m.defaultAndDisputeRate.value) < 0.02 : undefined} />
        <Tile label="Financed volume, latest month" value={usd(m.monthlyFinancedVolumeUsd.latest)} />
      </div>
      <div className="panel"><h3>Monthly financed volume</h3>
        {m.monthlyFinancedVolumeUsd.series.length === 0 ? <p className="hint">Nothing financed yet.</p> : <Bars rows={m.monthlyFinancedVolumeUsd.series.map((s: any) => ({ label: s.month, value: Number(s.usd), text: `${usd(s.usd)} · ${s.n} invoices` }))} />}</div>
      <div className="panel"><h3>Network</h3><p>{q.data.network.map((n: any) => `${n.n} ${n.type}${n.n === 1 ? '' : 's'}`).join(' · ')}</p></div>
    </section>
  );
}
