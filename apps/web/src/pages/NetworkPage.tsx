import { useMemo, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Checkbox, DataTable, DescriptionList, Segmented, chartColor } from '@yaneshtyagi/design-system';
import { api } from '../api/client';
import type { paths } from '../api/schema';
import { formatMoney } from '../shared/money';
import { ErrorNote, Hint, Loading, Page, Panel, StatusChip, dd, dt, label, noRows } from '../ui';

type Network = paths['/api/v1/admin/network']['get']['responses'][200]['content']['application/json'];
type Node = Network['nodes'][number];
type Edge = Network['edges'][number];
type Kind = Edge['kind'];

const usd = (v: string | null | undefined) => formatMoney(v ?? '0', 'USD');
const invoices = (n: number | null) => `${n ?? 0} invoice${n === 1 ? '' : 's'}`;

/** One colour and line style per link kind; the legend and the table say the same in words. */
const KINDS: { kind: Kind; name: string; series: number; dash?: string; help: string }[] = [
  { kind: 'trade', name: 'Trades with', series: 0, help: 'Supplier–buyer relationship; thicker with more invoices' },
  { kind: 'financed', name: 'Financed', series: 1, help: 'Bank has funded this supplier’s invoices' },
  { kind: 'bank_limit', name: 'Bank limit', series: 2, dash: '6 4', help: 'Bank exposure limit on a buyer or supplier' },
  { kind: 'cover_limit', name: 'Insurance cover', series: 3, dash: '6 4', help: 'Insurer credit limit on a buyer' },
  { kind: 'preferred_bank', name: 'Preferred bank', series: 4, dash: '2 4', help: 'Supplier or buyer prefers this bank' },
];
const KIND = new Map(KINDS.map((k) => [k.kind, k]));

// Banks across the top, suppliers down the left, buyers down the right, insurers across the bottom:
// money flows down from banks, goods and invoices flow across, cover comes up from insurers.
const W = 1100, H = 640, CX = W / 2, CY = H / 2;
const spread = (n: number, i: number, from: number, to: number) => (n === 1 ? (from + to) / 2 : from + ((to - from) * i) / (n - 1));
function layout(nodes: Node[]) {
  const pos = new Map<string, { x: number; y: number; anchor: 'start' | 'middle' | 'end'; lx: number; ly: number }>();
  const of = (t: Node['type']) => nodes.filter((n) => n.type === t);
  of('bank').forEach((n, i, a) => { const x = spread(a.length, i, 330, 770); pos.set(n.id, { x, y: 80, anchor: 'middle', lx: x, ly: 46 }); });
  of('insurer').forEach((n, i, a) => { const x = spread(a.length, i, 400, 700); pos.set(n.id, { x, y: 560, anchor: 'middle', lx: x, ly: 604 }); });
  of('supplier').forEach((n, i, a) => { const y = spread(a.length, i, 170, 470); pos.set(n.id, { x: 240, y, anchor: 'end', lx: 214, ly: y + 6 }); });
  of('buyer').forEach((n, i, a) => { const y = spread(a.length, i, 160, 480); pos.set(n.id, { x: 840, y, anchor: 'start', lx: 866, ly: y + 6 }); });
  return pos;
}

/** A gentle curve bowed towards the centre, so parallel links stay apart. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }, bend: number) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const qx = mx + (CX - mx) * bend, qy = my + (CY - my) * bend;
  return `M${a.x},${a.y} Q${qx},${qy} ${b.x},${b.y}`;
}

/** The figures on a link, without the two names (the table has them in their own columns). */
function facts(e: Edge, name: (id: string | null) => string): string {
  const exposure = `${usd(e.usedUsd)} used, ${usd(e.reservedUsd)} reserved, of ${usd(e.limitUsd)}`;
  switch (e.kind) {
    case 'trade': return `${label(e.status ?? '')} · ${invoices(e.count)}, ${usd(e.volumeUsd)}${e.detail ? ` · insured by ${name(e.detail)}` : ''}`;
    case 'financed': return `${invoices(e.count)}, ${usd(e.volumeUsd)}`;
    case 'bank_limit': return `As ${e.detail}: ${exposure}`;
    case 'cover_limit': return `Policy ${e.detail}: ${exposure}; expires ${dd(e.expiresAt)}`;
    case 'preferred_bank': return '';
  }
}

/** A sentence for the tooltip on a line. */
function describe(e: Edge, name: (id: string | null) => string): string {
  const what = { trade: 'sells to', financed: 'financed', bank_limit: 'has a limit on', cover_limit: 'covers', preferred_bank: 'prefers' }[e.kind];
  const f = facts(e, name);
  return `${name(e.from)} ${what} ${name(e.to)}${f ? ` · ${f}` : ''}`;
}

const HEAD = { fontSize: 15, fill: 'var(--ink-muted)', fontWeight: 600, letterSpacing: '0.06em' } as const;
const TYPE_TITLE: Record<Node['type'], string> = { bank: 'Banks', supplier: 'Suppliers', buyer: 'Buyers', insurer: 'Insurers' };

export function NetworkPage() {
  const q = useQuery({ queryKey: ['network'], queryFn: async () => (await api.GET('/api/v1/admin/network')).data });
  const [shown, setShown] = useState<Set<Kind>>(() => new Set(KINDS.map((k) => k.kind)));
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'table'>('map');

  const data = q.data;
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const pos = useMemo(() => layout(data?.nodes ?? []), [data]);
  const name = (id: string | null) => (id ? byId.get(id)?.name ?? 'Unknown' : '');

  if (q.isLoading) return <><Page title="Network map" /><Loading /></>;
  if (!data) return <><Page title="Network map" /><ErrorNote>The network could not be loaded.</ErrorNote></>;

  const visible = data.edges.filter((e) => shown.has(e.kind));
  const touches = (e: Edge) => e.from === selected || e.to === selected;
  const neighbours = new Set(selected ? visible.filter(touches).flatMap((e) => [e.from, e.to]) : []);
  const sel = selected ? byId.get(selected) : undefined;
  const maxTrade = Math.max(1, ...data.edges.filter((e) => e.kind === 'trade').map((e) => e.count ?? 0));
  const toggle = (k: Kind) => setShown((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const pick = (id: string) => setSelected((s) => (s === id ? null : id));
  const onKey = (id: string) => (ev: KeyboardEvent) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(id); } };
  const counts = (['bank', 'supplier', 'buyer', 'insurer'] as const).map((t) => `${data.nodes.filter((n) => n.type === t).length} ${TYPE_TITLE[t].toLowerCase()}`).join(' · ');
  const rows = (selected ? visible.filter(touches) : visible).map((e) => ({ e, text: facts(e, name) }));

  return (
    <>
      <Page title="Network map" description="Every supplier, buyer, bank and insurer on Earlio, and what links them. Select an organisation to see only its links."
        meta={`${counts} · as of ${dt(data.asOf)}`}
        actions={selected ? <Button variant="secondary" onClick={() => setSelected(null)}>Show everyone</Button> : undefined} />
      <fieldset className="fieldset network-kinds">
        <legend>Links to show</legend>
        {KINDS.map((k) => (
          <Checkbox key={k.kind} checked={shown.has(k.kind)} onChange={() => toggle(k.kind)}
            label={<><svg width="28" height="10" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" stroke={chartColor(k.series)} strokeWidth="3" strokeDasharray={k.dash} /></svg> {k.name}</>}
            help={k.help} />
        ))}
      </fieldset>
      {/* A Panel, not a ChartCard: the chart plot is role="img", which would hide the clickable organisations from assistive technology. */}
      <Panel title="Network" sub={`${visible.length} links shown; amounts in US dollars`}
        actions={<Segmented aria-label="Show the network as" value={view} onValueChange={(v) => setView(v as 'map' | 'table')}
          options={[{ value: 'map', label: 'Map' }, { value: 'table', label: 'Table' }]} />}>
        {view === 'table' ? <LinkTable rows={rows} name={name} /> : <>
        <svg className="network-map" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Network map: ${counts}`}>
          <text x={20} y={46} style={HEAD}>BANKS</text>
          <text x={240} y={130} textAnchor="end" style={HEAD}>SUPPLIERS</text>
          <text x={840} y={120} style={HEAD}>BUYERS</text>
          <text x={20} y={604} style={HEAD}>INSURERS</text>
          <g fill="none">
            {visible.map((e) => {
              const a = pos.get(e.from), b = pos.get(e.to), k = KIND.get(e.kind)!;
              if (!a || !b) return null;
              const width = e.kind === 'trade' ? 2 + (4 * (e.count ?? 0)) / maxTrade : e.kind === 'financed' ? 4 : 2;
              const faded = selected ? !touches(e) : false;
              return (
                <path key={e.id} d={curve(a, b, e.kind === 'trade' ? 0.12 : 0.25)} stroke={chartColor(k.series)} strokeWidth={width}
                  strokeDasharray={e.kind === 'trade' && e.status !== 'active' ? '3 3' : k.dash} opacity={faded ? 0.08 : 0.85} strokeLinecap="round">
                  <title>{describe(e, name)}</title>
                </path>
              );
            })}
          </g>
          {data.nodes.map((n) => {
            const p = pos.get(n.id)!;
            const on = n.id === selected, near = neighbours.has(n.id), dim = selected && !on && !near;
            const pending = n.kycStatus !== 'approved';
            const state = [pending ? `KYC ${label(n.kycStatus)}` : null, n.partner ? 'partner bank' : null].filter(Boolean).join(', ');
            // The name starts with the visible text in order (name, then "Blocked"): WCAG 2.5.3, axe label-content-name-mismatch.
            const shown = `${n.name}${n.blocked ? ' Blocked' : ''}`;
            return (
              <g key={n.id} className="network-node" role="button" tabIndex={0} aria-pressed={on}
                aria-label={`${shown}, ${n.type}, ${n.country}${state ? `, ${state}` : ''}`}
                onClick={() => pick(n.id)} onKeyDown={onKey(n.id)} opacity={dim ? 0.3 : 1}>
                <circle cx={p.x} cy={p.y} r={on ? 17 : 13}
                  fill={on ? 'var(--brand-500)' : 'var(--surface-raised)'}
                  stroke={n.blocked ? 'var(--danger)' : on ? 'var(--brand-700)' : 'var(--border-strong)'}
                  strokeWidth={n.blocked ? 3 : 2} strokeDasharray={pending ? '3 2' : undefined} />
                {n.blocked && <path d={`M${p.x - 6},${p.y - 6} L${p.x + 6},${p.y + 6}`} stroke="var(--danger)" strokeWidth={2.5} />}
                <text x={p.lx} y={p.ly} textAnchor={p.anchor} style={{ fontSize: 18, fill: 'var(--ink-primary)', fontWeight: on ? 700 : 500 }}>
                  {n.name}
                  {/* One text element with a real space, so the visible text reads "… Ltd Blocked" and matches the label. */}
                  {n.blocked && <tspan x={p.lx} dy={20} style={{ fontSize: 14, fill: 'var(--danger-ink)', fontWeight: 600 }}>{' '}Blocked</tspan>}
                </text>
                <title>{`${shown} · ${n.country}${state ? ` · ${state}` : ''}`}</title>
              </g>
            );
          })}
        </svg>
        <Hint>Dashed circles are organisations whose KYC is not approved yet; a struck-through red circle is blocked. Hover a line for its details, or switch to Table.</Hint>
        </>}
      </Panel>
      {sel ? (
        <Panel title={sel.name} sub={<>{TYPE_TITLE[sel.type].replace(/s$/, '')} · {sel.country}</>}>
          <DescriptionList columns={3} items={[
            { label: 'KYC', value: <StatusChip status={sel.kycStatus}>{label(sel.kycStatus)}</StatusChip> },
            { label: 'Sanctions screening', value: label(sel.sanctionsStatus) },
            { label: 'Blocked', value: sel.blocked ? <Badge tone="danger">Blocked</Badge> : 'No' },
            ...(sel.ratingTier ? [{ label: 'Rating tier', value: sel.ratingTier }] : []),
            ...(sel.type === 'supplier' ? [{ label: 'MSME', value: sel.msme ? 'Yes' : 'No' }] : []),
            ...(sel.type === 'bank' ? [{ label: 'Partner bank', value: sel.partner ? 'Yes' : 'No' }] : []),
          ]} />
          <LinkTable rows={rows} name={name} />
        </Panel>
      ) : null}
    </>
  );
}

function LinkTable({ rows, name }: { rows: { e: Edge; text: string }[]; name: (id: string | null) => string }) {
  return (
    <DataTable aria-label="Links" noun="links" rowKey={(r) => r.e.id} rows={rows} empty={noRows('No links to show')}
      columns={[
        { id: 'kind', header: 'Link', rowHeader: true, cell: (r) => KIND.get(r.e.kind)!.name },
        { id: 'from', header: 'From', cell: (r) => name(r.e.from) },
        { id: 'to', header: 'To', cell: (r) => name(r.e.to) },
        { id: 'detail', header: 'Details', cell: (r) => r.text || '—' },
      ]} />
  );
}
