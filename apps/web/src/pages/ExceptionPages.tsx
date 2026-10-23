import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney, type Currency } from '../shared/money';

const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '—');
const cur = (a: string, c: string) => formatMoney(a, c as Currency);
const label = (s: string) => s.replace(/_/g, ' ');

function useUpload() {
  const { me } = useAuth();
  return async (file: File): Promise<string> => {
    const r = await fetch(`/api/v1/files?filename=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': me?.csrfToken ?? '' }, body: await file.arrayBuffer() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message ?? 'Upload failed.');
    return j.id as string;
  };
}
function useAct() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const act = async (fn: () => Promise<{ response: Response }>, ok: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ kind: 'ok', text: ok }); await qc.invalidateQueries(); } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  };
  const banner = msg && <p className={msg.kind === 'ok' ? 'ok' : 'alert'} role={msg.kind === 'ok' ? 'status' : 'alert'}>{msg.text}</p>;
  return { act, banner, setMsg };
}

// ================================================================ disputes
export function DisputesPage() {
  const { me } = useAuth();
  const [filter, setFilter] = useState<'open' | 'resolved' | undefined>('open');
  const q = useQuery({ queryKey: ['disputes', filter], queryFn: async () => (await api.GET('/api/v1/disputes', { params: { query: filter ? { status: filter } : {} } })).data?.items ?? [] });
  const isAdmin = me?.permissions.includes('platform:admin');
  return (
    <section>
      <h2>Disputes</h2>
      <div className="filters">
        {([['open', 'Open'], ['resolved', 'Resolved'], [undefined, 'All']] as const).map(([v, l]) => <button key={l} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>)}
      </div>
      <table>
        <thead><tr><th>Invoice</th><th>Raised by</th><th>Reason</th><th>Status</th><th>Next deadline</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((d) => (
            <tr key={d.id}>
              <td><Link to={`/invoices/${d.invoiceId}`}>{d.invoiceNumber}</Link>{d.financed && <span className="chip"> financed</span>}</td><td>{d.raisedByName}</td><td>{d.reason}</td>
              <td><span className={`chip ${d.status}`}>{label(d.status)}</span>{d.cause && <div className="hint">{label(d.cause)}</div>}</td>
              <td>{['Open', 'UnderReview', 'Escalated'].includes(d.status) ? (d.status === 'Open' ? `escalates ${when(d.escalateAt)}` : `times out ${when(d.timeoutAt)}`) : when(d.resolvedAt)}</td>
              <td><Link to={`/disputes/${d.id}`}>Open case</Link></td>
            </tr>
          ))}
          {q.data?.length === 0 && <tr><td colSpan={6} className="muted">No disputes.</td></tr>}
        </tbody>
      </table>
      {isAdmin && <p className="hint">Timers are set in the <Link to="/admin/guardrails">platform defaults</Link> and need a second administrator.</p>}
    </section>
  );
}

/** SH-05 / ADM-04: the case file — thread, evidence, timers, and for platform staff the decision. */
export function DisputeDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const { act, banner, setMsg } = useAct();
  const upload = useUpload();
  const fileRef = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState('');
  const [outcome, setOutcome] = useState<'buyer' | 'supplier'>('supplier');
  const [cause, setCause] = useState(''); const [credit, setCredit] = useState(''); const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['dispute', id], queryFn: async () => (await api.GET('/api/v1/disputes/{id}', { params: { path: { id } } })).data });
  if (!q.data) return <p>Loading…</p>;
  const { dispute: d, messages, causes } = q.data;
  const open = ['Open', 'UnderReview', 'Escalated'].includes(d.status);
  const isPlatform = me?.activeOrg?.type === 'platform';
  const canDecide = isPlatform && me?.permissions.includes('dispute:decide');
  const path = { params: { path: { id } } };
  const mine = me?.activeOrg?.id === d.raisedByOrg;
  return (
    <section>
      <p><Link to="/disputes">← Disputes</Link></p>
      <h2>Dispute on {d.invoiceNumber} <span className={`chip ${d.status}`}>{label(d.status)}</span></h2>
      {banner}
      <div className="row">
        <div className="panel">
          <table><tbody>
            <tr><td>Raised by</td><td>{d.raisedByName} on {when(d.createdAt)}</td></tr>
            <tr><td>Parties</td><td>{d.supplierName} (supplier) · {d.buyerName} (buyer){d.financed && ' · financed'}</td></tr>
            <tr><td>Reason</td><td>{d.reason}{d.amount && ` — disputing ${d.amount}`}</td></tr>
            <tr><td>Response due</td><td>{when(d.responseDueAt)}</td></tr>
            <tr><td>Escalates</td><td>{when(d.escalateAt)}</td></tr>
            <tr><td>Times out</td><td>{when(d.timeoutAt)}</td></tr>
            {d.decisionNote && <tr><td>Decision</td><td>{d.decisionNote}{d.cause && ` (cause: ${label(d.cause)})`}{d.creditAmount && ` · credit ${d.creditAmount}`}</td></tr>}
          </tbody></table>
          {open && mine && <button className="secondary" onClick={() => act(() => api.POST('/api/v1/disputes/{id}/withdraw', path), 'Dispute withdrawn.')}>Withdraw dispute</button>}
        </div>
        <div className="panel">
          <h3>Case thread</h3>
          <ul className="timeline">
            {messages.map((m) => (
              <li key={m.id}><strong>{m.authorName}</strong> · {when(m.createdAt)}{m.kind === 'evidence' && ' · evidence'}
                <div>{m.body}</div>{m.fileId && <a href={`/api/v1/files/${m.fileId}`}>Download attachment</a>}</li>
            ))}
          </ul>
          {open && (
            <>
              <textarea aria-label="Message" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write to the other parties and Earlio…" />
              <p className="filters">
                <button disabled={!body.trim()} onClick={async () => { await act(() => api.POST('/api/v1/disputes/{id}/messages', { ...path, body: { body, kind: 'message' } }), 'Message sent.'); setBody(''); }}>Send</button>
                <button className="secondary" onClick={() => fileRef.current?.click()}>Attach evidence</button>
                <input ref={fileRef} type="file" hidden onChange={async (e) => {
                  const f = e.target.files?.[0]; e.target.value = '';
                  if (!f) return;
                  try { const fileId = await upload(f); await act(() => api.POST('/api/v1/disputes/{id}/messages', { ...path, body: { body: body.trim() || `Evidence: ${f.name}`, kind: 'evidence', fileId } }), 'Evidence attached.'); setBody(''); } catch (err) { setMsg({ kind: 'err', text: (err as Error).message }); }
                }} />
              </p>
            </>
          )}
        </div>
      </div>
      {canDecide && open && (
        <div className="panel">
          <h3>Decision</h3>
          {d.status !== 'UnderReview' && <button className="secondary" onClick={() => act(() => api.POST('/api/v1/disputes/{id}/review', path), 'Review started.')}>Start review</button>}
          <div className="filters">
            <label>In favour of<select value={outcome} onChange={(e) => setOutcome(e.target.value as 'buyer' | 'supplier')}><option value="supplier">The supplier</option><option value="buyer">The buyer</option></select></label>
            {outcome === 'buyer' && <>
              <label>Cause<select value={cause} onChange={(e) => setCause(e.target.value)}><option value="">—</option>{causes.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></label>
              <label>Credit note amount<input value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="optional" /></label>
            </>}
          </div>
          <label>Reasons<textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <p className="hint">A supplier-caused cause on a financed invoice with no credit note creates recourse to the bank (small suppliers repay by 20% offset or a 90-day plan). A credit note reduces the invoice; if it is financed, the advance is cut pro rata and the supplier owes the difference.</p>
          <button onClick={() => act(() => api.POST('/api/v1/disputes/{id}/decision', { ...path, body: { outcome, cause: cause || undefined, creditAmount: credit || undefined, note } }), 'Decision recorded and applied.')}>Record decision</button>
        </div>
      )}
    </section>
  );
}

// ================================================================ invoice page: dispute / credit note / default
export function InvoiceExceptionsPanel({ invoiceId, status, currency, supplierId, buyerId, windowOpen }: { invoiceId: string; status: string; currency: string; supplierId: string; buyerId: string; windowOpen: boolean }) {
  const { me } = useAuth();
  const { act, banner } = useAct();
  const [reason, setReason] = useState(''); const [amount, setAmount] = useState('');
  const [cnAmount, setCnAmount] = useState(''); const [cnReason, setCnReason] = useState('');
  const myOrg = me?.activeOrg?.id;
  const isParty = myOrg === supplierId || myOrg === buyerId;
  const canDispute = isParty && me?.permissions.includes('dispute:raise') && (windowOpen || ['Funded', 'Overdue'].includes(status));
  const canCredit = myOrg === buyerId && me?.permissions.includes('dispute:raise') && ['Accepted', 'NotEligible', 'OpenForFunding', 'OffersReceived', 'Funded', 'Overdue'].includes(status);
  const def = useQuery({ queryKey: ['default', invoiceId], retry: false, queryFn: async () => (await api.GET('/api/v1/recovery/defaults/{invoiceId}', { params: { path: { invoiceId } } })).data });
  const notes = useQuery({ queryKey: ['credit-notes', invoiceId], queryFn: async () => (await api.GET('/api/v1/invoices/{id}/credit-notes', { params: { path: { id: invoiceId } } })).data?.items ?? [] });
  const d = def.data;
  if (!canDispute && !canCredit && !d && !notes.data?.length) return null;
  return (
    <div className="panel">
      <h3>Disputes, credit notes and overdue</h3>
      {banner}
      {d && (
        <p>
          <span className={`chip ${d.status}`}>{d.status}</span> {d.overdueDays} days past due · late interest so far <strong>{cur(d.lateInterest, d.currency)}</strong> (charged to the buyer at the financing rate + 2 points{d.frozenDays > 0 ? `, paused for ${d.frozenDays} days while disputed` : ''}).
          {' '}Waiting period ends {d.waitingEndsOn}{d.claimDeadlineOn && `; claim deadline ${d.claimDeadlineOn}`}.
        </p>
      )}
      {notes.data?.map((n) => <p key={n.id}><strong>{n.number}</strong>: {cur(n.amount, n.currency)} off ({n.stage === 'post_funding' ? 'after funding' : 'before funding'}) → {cur(n.newAmount, n.currency)}. {Number(n.supplierOwes) > 0 && `The supplier owes the bank ${cur(n.supplierOwes, n.currency)}. `}<span className="hint">{n.reason}</span></p>)}
      <div className="row">
        {canDispute && (
          <div>
            <h4>Raise a dispute</h4>
            <textarea aria-label="Dispute reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong?" />
            <label>Disputed amount (optional)<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <button className="secondary" disabled={reason.trim().length < 3} onClick={async () => { await act(() => api.POST('/api/v1/invoices/{id}/disputes', { params: { path: { id: invoiceId } }, body: { reason, amount: amount || undefined } }), 'Dispute raised. The invoice, late interest and dunning are frozen.'); setReason(''); }}>Raise dispute</button>
          </div>
        )}
        {canCredit && (
          <div>
            <h4>Issue a credit note</h4>
            <label>Amount ({currency})<input value={cnAmount} onChange={(e) => setCnAmount(e.target.value)} /></label>
            <label>Reason<input value={cnReason} onChange={(e) => setCnReason(e.target.value)} /></label>
            <p className="hint">{['Funded', 'Overdue'].includes(status) ? 'The invoice is financed: the bank’s advance is reduced pro rata and the supplier owes the difference.' : 'Before funding this reduces the invoice and withdraws any offers made on the old amount.'}</p>
            <button className="secondary" disabled={!cnAmount || cnReason.trim().length < 3} onClick={async () => { await act(() => api.POST('/api/v1/invoices/{id}/credit-notes', { params: { path: { id: invoiceId } }, body: { amount: cnAmount, reason: cnReason } }), 'Credit note issued.'); setCnAmount(''); setCnReason(''); }}>Issue credit note</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ================================================================ overdue & claims
export function RecoveryPage() {
  const { me } = useAuth();
  const { act, banner, setMsg } = useAct();
  const upload = useUpload();
  const [ref, setRef] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Record<string, Record<string, string>>>({});
  const type = me?.activeOrg?.type;
  const q = useQuery({ queryKey: ['defaults'], queryFn: async () => (await api.GET('/api/v1/recovery/defaults')).data?.items ?? [] });
  const canFile = type === 'bank' && me?.permissions.includes('claim:file');
  const DOCS = ['invoice', 'acceptance', 'delivery_proof', 'statement'] as const;
  const [extra, setExtra] = useState<Record<string, Record<string, string>>>({});
  return (
    <section>
      <h2>Overdue and defaults</h2>
      <p className="hint">Financed invoices that were not paid on the due date. Late interest runs from the due date (financing rate + 2 points, paid by the buyer, never the supplier) and stops while a dispute is open.</p>
      {banner}
      {(q.data ?? []).map((d) => (
        <div className="panel" key={d.invoiceId}>
          <h3><Link to={`/invoices/${d.invoiceId}`}>{d.invoiceNumber}</Link> <span className={`chip ${d.status}`}>{label(d.status)}</span></h3>
          <p>{d.buyerName} owes {cur(d.principal, d.currency)} principal · {d.overdueDays} days overdue · late interest <strong>{cur(d.lateInterest, d.currency)}</strong> · reminder {d.dunningLevel} of 3 sent{d.frozenDays > 0 && ` · ${d.frozenDays} days paused by a dispute`}</p>
          <p>{d.insured ? <>Waiting period {d.waitingDays} days, ends <strong>{d.waitingEndsOn}</strong>{d.insolvency && ' (waived: buyer insolvency)'}{d.claimDeadlineOn && <> · claim deadline <strong>{d.claimDeadlineOn}</strong></>}</> : 'Not insured: no claim is possible.'}</p>
          {canFile && d.status === 'Overdue' && (
            <p className="filters"><input placeholder="Insolvency case reference" value={ref[d.invoiceId] ?? ''} onChange={(e) => setRef({ ...ref, [d.invoiceId]: e.target.value })} />
              <button className="secondary" onClick={() => act(() => api.POST('/api/v1/recovery/defaults/{invoiceId}/insolvency', { params: { path: { invoiceId: d.invoiceId } }, body: { reference: ref[d.invoiceId] ?? '' } }), 'Insolvency recorded: the waiting period is waived.')}>Report buyer insolvency</button></p>
          )}
          {canFile && d.status === 'ClaimEligible' && (
            <ClaimForm invoiceId={d.invoiceId} extra={extra[d.invoiceId] ?? {}} setExtra={(v) => setExtra({ ...extra, [d.invoiceId]: v })}>
              <p className="filters">{DOCS.map((t) => (
                <label key={t}>{label(t)}<input type="file" onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  try { const fileId = await upload(f); setDocs({ ...docs, [d.invoiceId]: { ...(docs[d.invoiceId] ?? {}), [t]: fileId } }); } catch (err) { setMsg({ kind: 'err', text: (err as Error).message }); }
                }} />{docs[d.invoiceId]?.[t] && <span className="chip Credited">attached</span>}</label>
              ))}</p>
              <button onClick={() => act(() => api.POST('/api/v1/invoices/{id}/claims', { params: { path: { id: d.invoiceId } }, body: { documents: Object.entries(docs[d.invoiceId] ?? {}).map(([docType, fileId]) => ({ docType: docType as typeof DOCS[number], fileId })), extra: extra[d.invoiceId] } }), 'Claim filed with the insurer.')}>File claim for {cur(d.principal, d.currency)}</button>
              <p className="hint">Missing documents do not stop you filing, but the insurer treats them as a documentation defect.</p>
            </ClaimForm>
          )}
        </div>
      ))}
      {q.data?.length === 0 && <p className="muted">Nothing overdue.</p>}
    </section>
  );
}

/** INS-05 claims desk (insurer), bank recovery workbench, supplier view. */
export function ClaimsPage() {
  const { me } = useAuth();
  const { act, banner } = useAct();
  const type = me?.activeOrg?.type;
  const [amt, setAmt] = useState<Record<string, string>>({}); const [reason, setReason] = useState<Record<string, string>>({});
  const [gross, setGross] = useState<Record<string, string>>({}); const [costs, setCosts] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['claims'], queryFn: async () => (await api.GET('/api/v1/claims')).data?.items ?? [] });
  const desk = type === 'insurer' && me?.permissions.includes('claim:decide');
  const bank = type === 'bank' && me?.permissions.includes('claim:file');
  return (
    <section>
      <h2>{desk ? 'Claims desk' : 'Claims'}</h2>
      {banner}
      {(q.data ?? []).map((c) => {
        const path = { params: { path: { id: c.id } } };
        return (
          <div className="panel" key={c.id}>
            <h3><Link to={`/invoices/${c.invoiceId}`}>{c.invoiceNumber}</Link> <span className={`chip ${c.status}`}>{label(c.status)}</span></h3>
            <p>{c.bankName} claims <strong>{cur(c.claimedAmount, c.currency)}</strong> on {cur(c.faceAmount, c.currency)} (cover {c.coverPct}%) · filed {when(c.filedAt)}</p>
            <p className="hint">Documents: {c.documents.map((d) => d.docType).join(', ') || 'none'}</p>
            {c.exclusions.length > 0 && <div className="alert"><strong>Policy exclusions</strong><ul>{c.exclusions.map((e) => <li key={e.code}>{label(e.code)} — {e.detail}</li>)}</ul></div>}
            {c.waterfall && (
              <table><tbody>
                <tr><td>Insurer pays</td><td className="num">{cur(c.waterfall.payout, c.currency)}</td></tr>
                <tr><td>To the bank (principal and charges first)</td><td className="num">{cur(c.waterfall.toBank, c.currency)}</td></tr>
                <tr><td>To the supplier’s retention</td><td className="num">{cur(c.waterfall.toSupplier, c.currency)}</td></tr>
                <tr><td>Bank shortfall</td><td className="num">{cur(c.waterfall.bankShortfall, c.currency)}</td></tr>
                <tr><td>Supplier retention lost</td><td className="num">{cur(c.waterfall.supplierLoss, c.currency)}</td></tr>
              </tbody></table>
            )}
            {c.decisionReason && <p className="hint">Insurer’s reason: {c.decisionReason}</p>}
            {desk && ['Filed', 'UnderReview'].includes(c.status) && (
              <div>
                {c.status === 'Filed' && <button className="secondary" onClick={() => act(() => api.POST('/api/v1/claims/{id}/review', path), 'Review started: exclusions re-checked.')}>Start review</button>}
                <p className="filters">
                  <input placeholder="Amount (partial)" value={amt[c.id] ?? ''} onChange={(e) => setAmt({ ...amt, [c.id]: e.target.value })} />
                  <input placeholder="Reason" value={reason[c.id] ?? ''} onChange={(e) => setReason({ ...reason, [c.id]: e.target.value })} />
                  <button onClick={() => act(() => api.POST('/api/v1/claims/{id}/decision', { ...path, body: { decision: 'approve' } }), 'Claim approved.')}>Approve in full</button>
                  <button className="secondary" onClick={() => act(() => api.POST('/api/v1/claims/{id}/decision', { ...path, body: { decision: 'partial', approvedAmount: amt[c.id], reason: reason[c.id] } }), 'Claim partly approved.')}>Approve less</button>
                  <button className="danger" onClick={() => act(() => api.POST('/api/v1/claims/{id}/decision', { ...path, body: { decision: 'reject', reason: reason[c.id] } }), 'Claim rejected.')}>Reject</button>
                </p>
              </div>
            )}
            {desk && ['Approved', 'PartiallyApproved'].includes(c.status) && <button onClick={() => act(() => api.POST('/api/v1/claims/{id}/pay', path), 'Payout recorded and distributed.')}>Record payout of {cur(c.approvedAmount ?? '0', c.currency)}</button>}
            {c.recoveries.length > 0 && (
              <table>
                <thead><tr><th>Recovery</th><th className="num">Gross</th><th className="num">Costs</th><th className="num">Net</th><th>Shared (insurer / bank / supplier)</th></tr></thead>
                <tbody>{c.recoveries.map((r) => <tr key={r.id}><td>{when(r.at)}</td><td className="num">{cur(r.gross, c.currency)}</td><td className="num">{cur(r.costs, c.currency)}</td><td className="num">{cur(r.net, c.currency)}</td><td>{cur(r.shares.insurer ?? '0', c.currency)} / {cur(r.shares.bank ?? '0', c.currency)} / {cur(r.shares.supplier ?? '0', c.currency)}</td></tr>)}</tbody>
              </table>
            )}
            {bank && ['Paid', 'Rejected'].includes(c.status) && (
              <p className="filters">
                <input placeholder="Recovered" value={gross[c.id] ?? ''} onChange={(e) => setGross({ ...gross, [c.id]: e.target.value })} />
                <input placeholder="Costs" value={costs[c.id] ?? ''} onChange={(e) => setCosts({ ...costs, [c.id]: e.target.value })} />
                <button className="secondary" onClick={() => act(() => api.POST('/api/v1/claims/{id}/recoveries', { ...path, body: { gross: gross[c.id] ?? '', costs: costs[c.id] || '0.00' } }), 'Recovery recorded and shared pro rata to losses.')}>Record recovery</button>
              </p>
            )}
          </div>
        );
      })}
      {q.data?.length === 0 && <p className="muted">No claims.</p>}
    </section>
  );
}

// ================================================================ recourse (SUP-09)
export function RecoursePage() {
  const { me } = useAuth();
  const { act, banner } = useAct();
  const [pay, setPay] = useState<Record<string, string>>({});
  const type = me?.activeOrg?.type;
  const q = useQuery({ queryKey: ['recourse'], queryFn: async () => (await api.GET('/api/v1/recovery/recourse')).data?.items ?? [] });
  return (
    <section>
      <h2>{type === 'bank' ? 'Recourse receivable' : 'What you owe your bank'}</h2>
      <p className="hint">Financing is without recourse, except where a dispute is caused by the supplier (and decided by Earlio) or a credit note reduces the invoice after the advance. There is no penalty interest.</p>
      {banner}
      {(q.data ?? []).map((r) => (
        <div className="panel" key={r.id}>
          <h3><Link to={`/invoices/${r.invoiceId}`}>{r.invoiceNumber}</Link> · {label(r.cause)} <span className={`chip ${r.status === 'open' ? 'Overdue' : 'Settled'}`}>{r.status}</span></h3>
          <p>{type === 'bank' ? r.supplierName : 'You'} owe{type === 'bank' ? 's' : ''} <strong>{cur(r.outstanding, r.currency)}</strong> of {cur(r.amountOwed, r.currency)}.</p>
          {r.smallSupplier && r.status === 'open' && (
            <>
              <p>Repayment: <strong>{r.mode === 'plan_90d' ? '90-day plan' : 'automatic offset'}</strong>. {r.mode === 'offset_20pct' ? 'At most 20% of each future payout is withheld until this is repaid.' : 'Three equal monthly instalments.'}</p>
              {type === 'supplier' && me?.permissions.includes('financing:consent') && (
                <button className="secondary" onClick={() => act(() => api.POST('/api/v1/recovery/recourse/{id}/mode', { params: { path: { id: r.id } }, body: { mode: r.mode === 'plan_90d' ? 'offset_20pct' : 'plan_90d' } }), 'Repayment method changed.')}>Switch to {r.mode === 'plan_90d' ? 'offset' : 'a 90-day plan'}</button>
              )}
            </>
          )}
          {r.plan && <table><thead><tr><th>Due</th><th className="num">Amount</th><th /></tr></thead><tbody>{r.plan.map((p) => <tr key={p.dueOn}><td>{p.dueOn}</td><td className="num">{cur(p.amount, r.currency)}</td><td>{p.paid ? <span className="chip Credited">paid</span> : ''}</td></tr>)}</tbody></table>}
          {r.payments.length > 0 && <ul className="timeline">{r.payments.map((p, i) => <li key={i}>{cur(p.amount, r.currency)} · {p.source} · {when(p.at)}</li>)}</ul>}
          {type === 'bank' && me?.permissions.includes('claim:file') && r.status === 'open' && (
            <p className="filters"><input placeholder="Amount received" value={pay[r.id] ?? ''} onChange={(e) => setPay({ ...pay, [r.id]: e.target.value })} />
              <button className="secondary" onClick={() => act(() => api.POST('/api/v1/recovery/recourse/{id}/payments', { params: { path: { id: r.id } }, body: { amount: pay[r.id] ?? '' } }), 'Repayment recorded.')}>Record repayment</button></p>
          )}
        </div>
      ))}
      {q.data?.length === 0 && <p className="muted">{type === 'bank' ? 'No recourse is owed to you.' : 'You owe nothing.'}</p>}
    </section>
  );
}

// ================================================================ export proceeds (SUP-08)
export function ExportProceedsPage() {
  const { me } = useAuth();
  const { act, banner } = useAct();
  const [ref, setRef] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['proceeds'], queryFn: async () => (await api.GET('/api/v1/export-proceeds')).data?.items ?? [] });
  const bank = me?.activeOrg?.type === 'bank' && me?.permissions.includes('settlement:operate');
  return (
    <section>
      <h2>Export proceeds</h2>
      <p className="hint">Export proceeds must normally be realised within 9 months of shipment (confirm the period for your case with your authorised dealer bank or counsel).</p>
      {banner}
      <table>
        <thead><tr><th>Invoice</th><th className="num">Amount</th><th>Shipped</th><th>Realise by</th><th>Status</th><th className="num">Rupees received</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((p) => (
            <>
              <tr key={p.id}>
                <td><Link to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link></td><td className="num">{cur(p.amountForeign, p.currency)}</td><td>{p.shipmentDate}</td>
                <td>{p.realisationDeadline} <span className="hint">({p.daysLeft >= 0 ? `${p.daysLeft} days left` : `${-p.daysLeft} days late`})</span></td>
                <td><span className={`chip ${p.status === 'Overdue' ? 'Overdue' : p.status === 'Pending' ? '' : 'Credited'}`}>{p.status}</span></td>
                <td className="num">{formatMoney(p.realisedInr, 'INR')}</td>
                <td>{bank && p.status === 'Realised' && <><input aria-label="Reference" placeholder="Report reference" value={ref[p.id] ?? ''} onChange={(e) => setRef({ ...ref, [p.id]: e.target.value })} style={{ width: 130 }} />
                  <button className="link" onClick={() => act(() => api.POST('/api/v1/export-proceeds/{id}/report', { params: { path: { id: p.id } }, body: { reference: ref[p.id] ?? '' } }), 'Marked as reported.')}>Mark reported</button></>}</td>
              </tr>
              {p.chainBroken && p.chainNote && <tr key={p.id + 'n'}><td colSpan={7} className="hint">⚠ {p.chainNote}</td></tr>}
            </>
          ))}
          {q.data?.length === 0 && <tr><td colSpan={7} className="muted">No export invoices yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

/** The insurer decides which papers and extra information a claim needs (CT-10); the form shows exactly that. */
function ClaimForm({ invoiceId, extra, setExtra, children }: { invoiceId: string; extra: Record<string, string>; setExtra: (v: Record<string, string>) => void; children: React.ReactNode }) {
  const q = useQuery({ queryKey: ['claim-req', invoiceId], queryFn: async () => (await api.GET('/api/v1/requirements/claim/{invoiceId}', { params: { path: { invoiceId } } })).data });
  return (
    <div>
      <h4>File the insurance claim</h4>
      {q.data && <p className="hint">This insurer requires: {q.data.documents.map(label).join(', ')}.</p>}
      {q.data?.customFields.map((f) => (
        <label key={f.key}>{f.label}{f.required && ' *'}
          {f.type === 'select' ? <select value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })}><option value="">—</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
            : <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step="any" value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />}
        </label>
      ))}
      {children}
    </div>
  );
}
