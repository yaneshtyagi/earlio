import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney, type Currency } from '../shared/money';

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
  return (
    <section>
      <h2>Cover requests</h2>
      <p className="hint">Requests arrive when a buyer accepts an invoice. Decisions are due within 24 hours.</p>
      {err && <p className="alert" role="alert">{err}</p>}
      <table>
        <thead><tr><th>Invoice</th><th>Supplier</th><th>Buyer</th><th className="num">Amount</th><th>Asked</th><th>Status</th><th>SLA</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((c) => (
            <>
              <tr key={c.id}>
                <td>{c.invoiceNumber}</td><td>{c.supplierName}</td><td>{c.buyer.name} <span className="chip">{c.buyer.tier}</span></td>
                <td className="num">{formatMoney(c.invoiceAmount, c.currency as Currency)}</td><td>{c.requestedCoverPct}%</td>
                <td><span className={`chip ${c.status}`}>{c.status}{c.coverPct != null ? ` ${c.coverPct}%` : ''}</span></td>
                <td>{c.status === 'requested' ? (c.slaBreached ? <span className="chip Overdue">overdue</span> : `by ${new Date(c.slaDueAt!).toLocaleString()}`) : ''}</td>
                <td>{canDecide && c.status === 'requested' && <button className="link" onClick={() => setOpen(open === c.id ? null : c.id)}>Decide</button>}</td>
              </tr>
              {open === c.id && (
                <tr key={c.id + 'f'}><td colSpan={8}>
                  <div className="panel">
                    <label>Cover % (leave blank for {c.requestedCoverPct}%)<input inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} /></label>
                    <label>Reason (required to decline)<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                    <button disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, decision: 'approve' })}>Approve</button>{' '}
                    <button className="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: c.id, decision: 'decline' })}>Decline</button>
                  </div>
                </td></tr>
              )}
            </>
          ))}
          {q.data?.length === 0 && <tr><td colSpan={8} className="muted">No requests yet.</td></tr>}
        </tbody>
      </table>
    </section>
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
    <section>
      <h2>Buyer limits (USD)</h2>
      {err && <p className="alert" role="alert">{err}</p>}
      <table>
        <thead><tr><th>Buyer</th><th>Policy</th><th className="num">Limit</th><th className="num">Reserved</th><th className="num">Used</th><th className="num">Available</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((l) => (
            <tr key={l.buyer.id}>
              <td>{l.buyer.name}</td><td>{l.policyNumber}</td><td className="num">{formatMoney(l.limitUsd, 'USD')}</td><td className="num">{formatMoney(l.reservedUsd, 'USD')}</td>
              <td className="num">{formatMoney(l.usedUsd, 'USD')}</td><td className="num">{formatMoney(l.availableUsd, 'USD')}</td>
              <td>{new Date(l.expiresAt).toLocaleDateString()} {l.expired && <span className="chip Overdue">expired</span>}</td>
              <td>{canManage && <button className="link" onClick={() => edit.mutate(l)}>Edit</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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
    <div className="panel">
      <h3>Insurance cover <span className={`chip ${c.status}`}>{c.status}</span></h3>
      {c.insurerName && <p>Insurer: {c.insurerName}{c.policyNumber ? ` (policy ${c.policyNumber})` : ''}</p>}
      {c.coverPct != null && <p>Cover {c.coverPct}% — insured {formatMoney(c.insuredAmount ?? '0', c.currency as Currency)}</p>}
      {c.status === 'requested' && <p className="hint">Awaiting the insurer’s decision{c.slaDueAt ? ` (due ${new Date(c.slaDueAt).toLocaleString()})` : ''}. Early payment does not need cover.</p>}
      {(c.status === 'declined' || c.status === 'uninsured') && <p className="hint">Bank financing is not available for this invoice. Early payment from the buyer remains possible.</p>}
      {c.reason && <p className="hint">{c.reason}</p>}
    </div>
  );
}
