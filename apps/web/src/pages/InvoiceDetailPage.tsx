import { CoverPanel } from './InsurancePages';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ensureOk, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney } from '../shared/money';

const DOCS = [['commercial_invoice', 'Commercial invoice'], ['delivery_proof', 'Delivery proof'], ['packing_list', 'Packing list'], ['shipping_bill', 'Shipping bill'], ['transport_document', 'Transport document']] as const;
const WARN: Record<string, string> = { no_purchase_order: 'No purchase order linked.', currency_differs_from_po: 'Currency differs from the purchase order.' };

export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: async () => (await api.GET('/api/v1/invoices/{id}', { params: { path: { id } } })).data });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [partial, setPartial] = useState('');
  const [signed, setSigned] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>('commercial_invoice');
  const inv = q.data;
  if (!inv) return <p>Loading…</p>;
  const me_ = me?.activeOrg;
  const isSupplier = me_?.id === inv.supplier.id, isBuyer = me_?.id === inv.buyer.id;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoice', id] }); qc.invalidateQueries({ queryKey: ['invoices'] }); };
  const run = async (fn: () => Promise<{ response: Response }>, okText: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ kind: 'ok', text: okText }); refresh(); } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };
  const path = { params: { path: { id: inv.id } } };
  const cur = (a: string) => formatMoney(a, inv.currency as 'USD');

  async function upload(file: File) {
    setMsg(null);
    const r = await fetch(`/api/v1/files?filename=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': me?.csrfToken ?? '' }, body: await file.arrayBuffer() });
    const j = await r.json();
    if (!r.ok) return setMsg({ kind: 'err', text: j.message ?? 'Upload failed.' });
    await run(() => api.POST('/api/v1/invoices/{id}/documents', { ...path, body: { docType: docType as 'delivery_proof', fileId: j.id } }), 'Document added.');
  }

  const canSupplier = isSupplier && me?.permissions.includes('invoice:create');
  const canBuyer = isBuyer && me?.permissions.includes('invoice:accept');
  const needsDecision = inv.status === 'Submitted';
  const windowOpen = inv.status === 'Accepted' && inv.disputeWindowEndsAt && new Date(inv.disputeWindowEndsAt) > new Date();

  return (
    <section>
      <h2>{inv.humanId} <span className={`chip ${inv.status}`}>{inv.status}</span></h2>
      <p className="muted">{inv.supplier.name} → {inv.buyer.name} · invoice {inv.number} · IRN <code>{inv.irn?.slice(0, 16)}…</code></p>
      {inv.warnings.map((w) => <p className="alert" key={w}>⚠ {WARN[w] ?? w}</p>)}
      {msg && <p className={msg.kind === 'ok' ? 'ok' : 'alert'}>{msg.text}</p>}

      <div className="row">
        <div className="panel">
          <h3>Amounts</h3>
          <table><tbody>
            <tr><td>Invoice amount</td><td className="num">{cur(inv.grossAmount)}</td></tr>
            <tr><td>Accepted amount</td><td className="num">{inv.acceptedAmount ? cur(inv.acceptedAmount) : '—'}</td></tr>
            <tr><td>Issued / due</td><td className="num">{inv.issueDate} / {inv.dueDate}</td></tr>
            <tr><td>Purchase order</td><td className="num">{inv.poNumber ?? '—'}</td></tr>
            <tr><td>Sanctions screening</td><td className="num">{inv.screeningStatus}</td></tr>
          </tbody></table>
          {inv.disputeWindowEndsAt && <p className="hint">Dispute window {windowOpen ? 'closes' : 'closed'} {new Date(inv.disputeWindowEndsAt).toLocaleString()}.</p>}
        </div>
        <div className="panel">
          <h3>Timeline</h3>
          <ul className="timeline">{inv.history.map((h, i) => <li key={i}><strong>{h.to}</strong> · {new Date(h.at).toLocaleString()}{h.note && <div className="hint">{h.note}</div>}</li>)}</ul>
        </div>
      </div>

      {inv.acceptedAt && <CoverPanel invoiceId={inv.id} />}

      <div className="panel">
        <h3>Documents</h3>
        <table>
          <thead><tr><th>Type</th><th>Version</th><th>File</th><th>SHA-256</th></tr></thead>
          <tbody>
            {inv.documents.map((d) => <tr key={d.id}><td>{d.docType.replace('_', ' ')}</td><td>v{d.version}</td><td><a href={`/api/v1/files/${d.fileId}`}>{d.filename}</a></td><td><code>{d.sha256.slice(0, 12)}…</code></td></tr>)}
            {inv.documents.length === 0 && <tr><td colSpan={4} className="muted">No documents yet.</td></tr>}
          </tbody>
        </table>
        {canSupplier && ['Draft', 'Submitted'].includes(inv.status) && (
          <p className="filters">
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>{DOCS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <button className="secondary" onClick={() => fileRef.current?.click()}>Upload</button>
            <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </p>
        )}
      </div>

      {canSupplier && inv.status === 'Draft' && (
        <p>
          <button onClick={() => run(() => api.POST('/api/v1/invoices/{id}/submit', path), 'Submitted to the buyer.')}>Submit to buyer</button>{' '}
          <button className="secondary" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/cancel', path), 'Draft cancelled.')}>Cancel draft</button>
        </p>
      )}

      {canBuyer && needsDecision && (
        <div className="panel">
          <h3>Your decision</h3>
          <p className="hint">Check the delivery proof above. Silence is never treated as acceptance.</p>
          <label>Reason (required for rejection or partial acceptance)<textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <label>Amount to accept if partial ({inv.currency})<input value={partial} onChange={(e) => setPartial(e.target.value)} inputMode="decimal" /></label>
          <blockquote className="hint">{inv.undertakingPreview}</blockquote>
          <label><input type="checkbox" style={{ width: 'auto' }} checked={signed} onChange={(e) => setSigned(e.target.checked)} /> I sign this irrevocable payment undertaking and acknowledge the assignment notice.</label>
          <button disabled={!signed} onClick={() => run(() => api.POST('/api/v1/invoices/{id}/decision', { ...path, body: { decision: 'accept', undertakingAccepted: true } }), 'Accepted.')}>Accept in full</button>{' '}
          <button disabled={!signed || !partial} className="secondary" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/decision', { ...path, body: { decision: 'partial', acceptedAmount: partial, reason, undertakingAccepted: true } }), 'Part-accepted.')}>Part-accept</button>{' '}
          <button className="danger" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/decision', { ...path, body: { decision: 'reject', reason } }), 'Rejected.')}>Reject</button>
        </div>
      )}

      {inv.acceptance && (
        <div className="panel">
          <h3>Acceptance</h3>
          <p>{inv.acceptance.decision}{inv.acceptance.reason && ` — ${inv.acceptance.reason}`}</p>
          {inv.acceptance.undertakingText && <blockquote className="hint">{inv.acceptance.undertakingText}<br />Signed {new Date(inv.acceptance.undertakingSignedAt!).toLocaleString()}</blockquote>}
          {inv.acceptance.undertakingText && (inv.acceptance.assignmentAckAt
            ? <p className="ok">Assignment notice acknowledged {new Date(inv.acceptance.assignmentAckAt).toLocaleString()}.</p>
            : canBuyer && <button className="secondary" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/assignment-ack', path), 'Acknowledged.')}>Acknowledge assignment notice</button>)}
        </div>
      )}

      {inv.disputes.length > 0 && (
        <div className="panel"><h3>Disputes</h3>
          {inv.disputes.map((d) => <p key={d.id}><span className="chip Disputed">{d.status}</span> {d.kind === 'partial_remainder' ? `Remainder of ${d.amount} not accepted: ` : ''}{d.reason}</p>)}
        </div>
      )}
      {windowOpen && me?.permissions.includes('dispute:raise') && (isSupplier || isBuyer) && (
        <p><button className="secondary" onClick={() => { const r = window.prompt('Describe the dispute'); if (r) void run(() => api.POST('/api/v1/invoices/{id}/disputes', { ...path, body: { reason: r } }), 'Dispute raised. The invoice is frozen.'); }}>Raise a dispute</button></p>
      )}
    </section>
  );
}
