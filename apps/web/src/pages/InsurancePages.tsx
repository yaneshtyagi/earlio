import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, DataTable, DescriptionList, Drawer, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, ErrorNote, Hint, Page, Panel, StatusChip, dd, dt, noRows } from '../ui';

/** INS-02: the underwriter's queue of cover requests with an approve / reduce / decline form. */
export function InsuranceRequestsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [pct, setPct] = useState(''); const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['cover-requests'], queryFn: async () => (await api.GET('/api/v1/insurance/requests', { params: { query: {} } })).data?.items ?? [] });
  const canDecide = me?.permissions.includes('cover:decide');
  const decide = useMutation({
    mutationFn: async (a: { id: string; decision: 'approve' | 'decline' }) => {
      const r = await api.POST('/api/v1/insurance/requests/{id}/decision', { params: { path: { id: a.id } }, body: { decision: a.decision, coverPct: a.decision === 'approve' && pct ? Number(pct) : undefined, reason: reason || undefined } });
      await ensureOk(r);
    },
    onSuccess: () => { setErr(null); setOpen(null); setPct(''); setReason(''); qc.invalidateQueries({ queryKey: ['cover-requests'] }); },
    onError: (e: Error) => setErr(e.message),
  });
  const current = (q.data ?? []).find((c) => c.id === open);
  return (
    <>
      <Page title="Cover requests" description="Requests arrive when a buyer accepts an invoice. Decisions are due within 24 hours." />
      <ErrorNote>{err}</ErrorNote>
      <DataTable aria-label="Cover requests" noun="requests" loading={q.isLoading} rowKey={(c) => c.id} rows={q.data ?? []} empty={noRows('No requests yet')}
        columns={[
          { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (c) => c.invoiceNumber },
          { id: 'supplier', header: 'Supplier', cell: (c) => c.supplierName },
          { id: 'buyer', header: 'Buyer', cell: (c) => <>{c.buyer.name} <Badge tone="neutral">{c.buyer.tier}</Badge></> },
          { id: 'amount', header: 'Amount', numeric: true, cell: (c) => <Amt v={c.invoiceAmount} c={c.currency} /> },
          { id: 'asked', header: 'Asked', numeric: true, cell: (c) => `${c.requestedCoverPct}%` },
          { id: 'status', header: 'Status', cell: (c) => <StatusChip status={c.status}>{c.status}{c.coverPct != null ? ` ${c.coverPct}%` : ''}</StatusChip> },
          { id: 'sla', header: 'SLA', cell: (c) => c.status === 'requested' ? (c.slaBreached ? <StatusChip status="overdue">overdue</StatusChip> : `by ${dt(c.slaDueAt)}`) : '' },
          { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (c) => canDecide && c.status === 'requested' ? <Button size="sm" onClick={() => { setOpen(c.id); setPct(''); setReason(''); }}>Decide</Button> : null },
        ]} />
      <Drawer open={!!current} onClose={() => setOpen(null)} title={current ? `Decide on ${current.invoiceNumber}` : ''}
        footer={current ? <>
          <Button variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
          <Button variant="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: current.id, decision: 'decline' })}>Decline</Button>
          <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate({ id: current.id, decision: 'approve' })}>Approve</Button>
        </> : undefined}>
        {current && (
          <div className="stack-3">
            <TextField label={`Cover % (leave blank for ${current.requestedCoverPct}%)`} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
            <TextField label="Reason (required to decline)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
      </Drawer>
    </>
  );
}

/** INS-03: per-buyer insured limits. */
export function InsuranceLimitsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['ins-limits'], queryFn: async () => (await api.GET('/api/v1/insurance/limits')).data?.items ?? [] });
  const canManage = me?.permissions.includes('limits:manage');
  const edit = useMutation({
    mutationFn: async (l: { buyer: { id: string }; limitUsd: string; policyNumber: string; expiresAt: string }) => {
      const v = window.prompt('New limit (USD)', l.limitUsd);
      if (!v) return;
      const r = await api.PUT('/api/v1/insurance/limits', { body: { buyerOrgId: l.buyer.id, limitUsd: v, policyNumber: l.policyNumber, expiresAt: l.expiresAt } });
      await ensureOk(r);
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['ins-limits'] }); }, onError: (e: Error) => setErr(e.message),
  });
  return (
    <>
      <Page title="Buyer limits" description="Amounts in US dollars." />
      <ErrorNote>{err}</ErrorNote>
      <DataTable aria-label="Buyer limits" noun="buyers" loading={q.isLoading} rowKey={(l) => l.buyer.id} rows={q.data ?? []} empty={noRows('No limits set')}
        columns={[
          { id: 'buyer', header: 'Buyer', rowHeader: true, cell: (l) => l.buyer.name },
          { id: 'policy', header: 'Policy', cell: (l) => <span className="mono">{l.policyNumber}</span> },
          { id: 'limit', header: 'Limit (USD)', numeric: true, cell: (l) => <Amt v={l.limitUsd} c="USD" /> },
          { id: 'reserved', header: 'Reserved (USD)', numeric: true, cell: (l) => <Amt v={l.reservedUsd} c="USD" /> },
          { id: 'used', header: 'Used (USD)', numeric: true, cell: (l) => <Amt v={l.usedUsd} c="USD" /> },
          { id: 'available', header: 'Available (USD)', numeric: true, cell: (l) => <Amt v={l.availableUsd} c="USD" /> },
          { id: 'expires', header: 'Expires', cell: (l) => <>{dd(l.expiresAt)} {l.expired && <StatusChip status="expired">expired</StatusChip>}</> },
          { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (l) => canManage ? <Button size="sm" variant="ghost" icon="pencil" onClick={() => edit.mutate(l)}>Edit</Button> : null },
        ]} />
    </>
  );
}

/** Cover summary for the invoice detail page (supplier, buyer and insurer view). */
export function CoverPanel({ invoiceId }: { invoiceId: string }) {
  const q = useQuery({ queryKey: ['cover', invoiceId], queryFn: async () => {
    const r = await api.GET('/api/v1/invoices/{id}/cover', { params: { path: { id: invoiceId } } });
    return r.data ?? null;
  } });
  const c = q.data;
  if (!c) return null;
  return (
    <Panel title="Insurance cover" actions={<StatusChip status={c.status} />}>
      <DescriptionList columns={2} items={[
        ...(c.insurerName ? [{ label: 'Insurer', value: `${c.insurerName}${c.policyNumber ? ` (policy ${c.policyNumber})` : ''}` }] : []),
        ...(c.coverPct != null ? [{ label: 'Cover', value: <>{c.coverPct}% — insured <Amt v={c.insuredAmount ?? '0'} c={c.currency} /></> }] : []),
      ]} />
      {c.status === 'requested' && <Hint>Awaiting the insurer’s decision{c.slaDueAt ? ` (due ${dt(c.slaDueAt)})` : ''}. Early payment does not need cover.</Hint>}
      {(c.status === 'declined' || c.status === 'uninsured') && <Hint>Bank financing is not available for this invoice. Early payment from the buyer remains possible.</Hint>}
      {c.reason && <Hint>{c.reason}</Hint>}
    </Panel>
  );
}
