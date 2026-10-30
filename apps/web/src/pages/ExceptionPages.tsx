import { Fragment, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, DataTable, DescriptionList, FilterChip, SelectField, TextareaField, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, Hint, Loading, Notice, Page, Panel, Section, StatusChip, TimelineList, dd, dt, label, noRows, type Msg } from '../ui';

function useAct() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<Msg>(null);
  const act = async (fn: () => Promise<{ response: Response }>, ok: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ ok: true, text: ok }); await qc.invalidateQueries(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return { act, banner: <Notice msg={msg} />, setMsg };
}

// ================================================================ disputes
export function DisputesPage() {
  const { me } = useAuth();
  const [filter, setFilter] = useState<'open' | 'resolved' | undefined>('open');
  const q = useQuery({ queryKey: ['disputes', filter], queryFn: async () => (await api.GET('/api/v1/disputes', { params: { query: filter ? { status: filter } : {} } })).data?.items ?? [] });
  const isAdmin = me?.permissions.includes('platform:admin');
  return (
    <>
      <Page title="Disputes" />
      <DataTable aria-label="Disputes" noun="disputes" loading={q.isLoading} rowKey={(d) => d.id} rows={q.data ?? []} empty={noRows('No disputes')}
        toolbar={([['open', 'Open'], ['resolved', 'Resolved'], [undefined, 'All']] as const).map(([v, l]) => <FilterChip key={l} pressed={filter === v} onClick={() => setFilter(v)}>{l}</FilterChip>)}
        columns={[
          { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (d) => <><Link to={`/invoices/${d.invoiceId}`}>{d.invoiceNumber}</Link>{d.financed && <> <Badge tone="neutral">financed</Badge></>}</> },
          { id: 'by', header: 'Raised by', cell: (d) => d.raisedByName },
          { id: 'reason', header: 'Reason', cell: (d) => d.reason },
          { id: 'status', header: 'Status', cell: (d) => <><StatusChip status={d.status}>{label(d.status)}</StatusChip>{d.cause && <div className="hint">{label(d.cause)}</div>}</> },
          { id: 'next', header: 'Next deadline', cell: (d) => ['Open', 'UnderReview', 'Escalated'].includes(d.status) ? (d.status === 'Open' ? `escalates ${dt(d.escalateAt)}` : `times out ${dt(d.timeoutAt)}`) : dt(d.resolvedAt) },
          { id: 'act', header: <span className="bv-sr-only">Case</span>, cell: (d) => <Link to={`/disputes/${d.id}`}>Open case</Link> },
        ]} />
      {isAdmin && <Hint>Timers are set in the <Link to="/admin/guardrails">platform defaults</Link> and need a second administrator.</Hint>}
    </>
  );
}

/** SH-05 / ADM-04: the case file — thread, evidence, timers, and for platform staff the decision. */
export function DisputeDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const { act, banner, setMsg } = useAct();
  const fileRef = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState('');
  const [outcome, setOutcome] = useState<'buyer' | 'supplier'>('supplier');
  const [cause, setCause] = useState(''); const [credit, setCredit] = useState(''); const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['dispute', id], queryFn: async () => (await api.GET('/api/v1/disputes/{id}', { params: { path: { id } } })).data });
  if (!q.data) return <Loading />;
  const { dispute: d, messages, causes } = q.data;
  const open = ['Open', 'UnderReview', 'Escalated'].includes(d.status);
  const isPlatform = me?.activeOrg?.type === 'platform';
  const canDecide = isPlatform && me?.permissions.includes('dispute:decide');
  const path = { params: { path: { id } } };
  const mine = me?.activeOrg?.id === d.raisedByOrg;
  return (
    <>
      <Page title={<>Dispute on {d.invoiceNumber} <StatusChip status={d.status}>{label(d.status)}</StatusChip></>}
        breadcrumbs={[{ label: 'Disputes', href: '/disputes' }, { label: d.invoiceNumber }]}
        actions={open && mine ? <Button onClick={() => act(() => api.POST('/api/v1/disputes/{id}/withdraw', path), 'Dispute withdrawn.')}>Withdraw dispute</Button> : undefined} />
      {banner}
      <div className="split">
        <Panel title="Case">
          <DescriptionList columns={1} layout="inline" items={[
            { label: 'Raised by', value: `${d.raisedByName} on ${dt(d.createdAt)}` },
            { label: 'Parties', value: `${d.supplierName} (supplier) · ${d.buyerName} (buyer)${d.financed ? ' · financed' : ''}` },
            { label: 'Reason', value: `${d.reason}${d.amount ? ` — disputing ${d.amount}` : ''}` },
            { label: 'Response due', value: dt(d.responseDueAt) },
            { label: 'Escalates', value: dt(d.escalateAt) },
            { label: 'Times out', value: dt(d.timeoutAt) },
            ...(d.decisionNote ? [{ label: 'Decision', value: `${d.decisionNote}${d.cause ? ` (cause: ${label(d.cause)})` : ''}${d.creditAmount ? ` · credit ${d.creditAmount}` : ''}` }] : []),
          ]} />
        </Panel>
        <Panel title="Case thread">
          <TimelineList aria-label="Case thread"
            events={[...messages].reverse().map((m) => ({ id: m.id, title: <>{m.authorName}{m.kind === 'evidence' && ' · evidence'}</>, at: m.createdAt,
              meta: <>{m.body}{m.fileId && <> <a href={`/api/v1/files/${m.fileId}`}>Download attachment</a></>}</> }))} />
          {open && (
            <>
              <TextareaField label="Message" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write to the other parties and Earlio…" />
              <div className="row-actions">
                <Button variant="primary" disabled={!body.trim()} onClick={async () => { await act(() => api.POST('/api/v1/disputes/{id}/messages', { ...path, body: { body, kind: 'message' } }), 'Message sent.'); setBody(''); }}>Send</Button>
                <Button onClick={() => fileRef.current?.click()}>Attach evidence</Button>
                <input ref={fileRef} type="file" hidden aria-label="Evidence file" onChange={async (e) => {
                  const f = e.target.files?.[0]; e.target.value = '';
                  if (!f) return;
                  try { const fileId = await uploadFile(f); await act(() => api.POST('/api/v1/disputes/{id}/messages', { ...path, body: { body: body.trim() || `Evidence: ${f.name}`, kind: 'evidence', fileId } }), 'Evidence attached.'); setBody(''); } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
                }} />
              </div>
            </>
          )}
        </Panel>
      </div>
      {canDecide && open && (
        <Panel title="Decision">
          {d.status !== 'UnderReview' && <div><Button onClick={() => act(() => api.POST('/api/v1/disputes/{id}/review', path), 'Review started.')}>Start review</Button></div>}
          <div className="toolbar-fields">
            <SelectField label="In favour of" value={outcome} onChange={(e) => setOutcome(e.target.value as 'buyer' | 'supplier')}><option value="supplier">The supplier</option><option value="buyer">The buyer</option></SelectField>
            {outcome === 'buyer' && <>
              <SelectField label="Cause" value={cause} onChange={(e) => setCause(e.target.value)}><option value="">—</option>{causes.map((c) => <option key={c} value={c}>{label(c)}</option>)}</SelectField>
              <TextField label="Credit note amount" inputMode="decimal" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="optional" />
            </>}
          </div>
          <TextareaField label="Reasons" value={note} onChange={(e) => setNote(e.target.value)} />
          <Hint>A supplier-caused cause on a financed invoice with no credit note creates recourse to the bank (small suppliers repay by 20% offset or a 90-day plan). A credit note reduces the invoice; if it is financed, the advance is cut pro rata and the supplier owes the difference.</Hint>
          <div><Button variant="primary" onClick={() => act(() => api.POST('/api/v1/disputes/{id}/decision', { ...path, body: { outcome, cause: cause || undefined, creditAmount: credit || undefined, note } }), 'Decision recorded and applied.')}>Record decision</Button></div>
        </Panel>
      )}
    </>
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
    <Panel title="Disputes, credit notes and overdue">
      {banner}
      {d && (
        <p>
          <StatusChip status={d.status} /> {d.overdueDays} days past due · late interest so far <Amt v={d.lateInterest} c={d.currency} strong /> (charged to the buyer at the financing rate + 2 points{d.frozenDays > 0 ? `, paused for ${d.frozenDays} days while disputed` : ''}).
          {' '}Waiting period ends {dd(d.waitingEndsOn)}{d.claimDeadlineOn && `; claim deadline ${dd(d.claimDeadlineOn)}`}.
        </p>
      )}
      {notes.data?.map((n) => <p key={n.id}><strong>{n.number}</strong>: <Amt v={n.amount} c={n.currency} /> off ({n.stage === 'post_funding' ? 'after funding' : 'before funding'}) → <Amt v={n.newAmount} c={n.currency} />. {Number(n.supplierOwes) > 0 && <>The supplier owes the bank <Amt v={n.supplierOwes} c={n.currency} />. </>}<span className="hint">{n.reason}</span></p>)}
      <div className="split">
        {canDispute && (
          <Section title="Raise a dispute" level={4}>
            <TextareaField label="Dispute reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong?" />
            <TextField label="Disputed amount (optional)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <div><Button disabled={reason.trim().length < 3} onClick={async () => { await act(() => api.POST('/api/v1/invoices/{id}/disputes', { params: { path: { id: invoiceId } }, body: { reason, amount: amount || undefined } }), 'Dispute raised. The invoice, late interest and dunning are frozen.'); setReason(''); }}>Raise dispute</Button></div>
          </Section>
        )}
        {canCredit && (
          <Section title="Issue a credit note" level={4}>
            <TextField label={`Amount (${currency})`} inputMode="decimal" value={cnAmount} onChange={(e) => setCnAmount(e.target.value)} />
            <TextField label="Reason" value={cnReason} onChange={(e) => setCnReason(e.target.value)} />
            <Hint>{['Funded', 'Overdue'].includes(status) ? 'The invoice is financed: the bank’s advance is reduced pro rata and the supplier owes the difference.' : 'Before funding this reduces the invoice and withdraws any offers made on the old amount.'}</Hint>
            <div><Button disabled={!cnAmount || cnReason.trim().length < 3} onClick={async () => { await act(() => api.POST('/api/v1/invoices/{id}/credit-notes', { params: { path: { id: invoiceId } }, body: { amount: cnAmount, reason: cnReason } }), 'Credit note issued.'); setCnAmount(''); setCnReason(''); }}>Issue credit note</Button></div>
          </Section>
        )}
      </div>
    </Panel>
  );
}

// ================================================================ overdue & claims
export function RecoveryPage() {
  const { me } = useAuth();
  const { act, banner, setMsg } = useAct();
  const [ref, setRef] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Record<string, Record<string, string>>>({});
  const type = me?.activeOrg?.type;
  const q = useQuery({ queryKey: ['defaults'], queryFn: async () => (await api.GET('/api/v1/recovery/defaults')).data?.items ?? [] });
  const canFile = type === 'bank' && me?.permissions.includes('claim:file');
  const DOCS = ['invoice', 'acceptance', 'delivery_proof', 'statement'] as const;
  const [extra, setExtra] = useState<Record<string, Record<string, string>>>({});
  return (
    <>
      <Page title="Overdue and defaults" description="Financed invoices that were not paid on the due date. Late interest runs from the due date (financing rate + 2 points, paid by the buyer, never the supplier) and stops while a dispute is open." />
      {banner}
      {q.isLoading && <Loading />}
      {(q.data ?? []).map((d) => (
        <Panel key={d.invoiceId} level={3} title={<><Link to={`/invoices/${d.invoiceId}`}>{d.invoiceNumber}</Link> <StatusChip status={d.status}>{label(d.status)}</StatusChip></>}>
          <p>{d.buyerName} owes <Amt v={d.principal} c={d.currency} /> principal · {d.overdueDays} days overdue · late interest <Amt v={d.lateInterest} c={d.currency} strong /> · reminder {d.dunningLevel} of 3 sent{d.frozenDays > 0 && ` · ${d.frozenDays} days paused by a dispute`}</p>
          <p>{d.insured ? <>Waiting period {d.waitingDays} days, ends <strong>{dd(d.waitingEndsOn)}</strong>{d.insolvency && ' (waived: buyer insolvency)'}{d.claimDeadlineOn && <> · claim deadline <strong>{dd(d.claimDeadlineOn)}</strong></>}</> : 'Not insured: no claim is possible.'}</p>
          {canFile && d.status === 'Overdue' && (
            <div className="toolbar-fields">
              <TextField label="Insolvency case reference" value={ref[d.invoiceId] ?? ''} onChange={(e) => setRef({ ...ref, [d.invoiceId]: e.target.value })} />
              <Button onClick={() => act(() => api.POST('/api/v1/recovery/defaults/{invoiceId}/insolvency', { params: { path: { invoiceId: d.invoiceId } }, body: { reference: ref[d.invoiceId] ?? '' } }), 'Insolvency recorded: the waiting period is waived.')}>Report buyer insolvency</Button>
            </div>
          )}
          {canFile && d.status === 'ClaimEligible' && (
            <ClaimForm invoiceId={d.invoiceId} extra={extra[d.invoiceId] ?? {}} setExtra={(v) => setExtra({ ...extra, [d.invoiceId]: v })}>
              <div className="toolbar-fields">{DOCS.map((t) => (
                <TextField key={t} label={label(t)} type="file" onChange={async (e) => {
                  const f = e.target.files?.[0]; if (!f) return;
                  try { const fileId = await uploadFile(f); setDocs({ ...docs, [d.invoiceId]: { ...(docs[d.invoiceId] ?? {}), [t]: fileId } }); } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
                }} help={docs[d.invoiceId]?.[t] ? 'attached' : undefined} />
              ))}</div>
              <div><Button variant="primary" onClick={() => act(() => api.POST('/api/v1/invoices/{id}/claims', { params: { path: { id: d.invoiceId } }, body: { documents: Object.entries(docs[d.invoiceId] ?? {}).map(([docType, fileId]) => ({ docType: docType as typeof DOCS[number], fileId })), extra: extra[d.invoiceId] } }), 'Claim filed with the insurer.')}>File claim for <Amt v={d.principal} c={d.currency} /></Button></div>
              <Hint>Missing documents do not stop you filing, but the insurer treats them as a documentation defect.</Hint>
            </ClaimForm>
          )}
        </Panel>
      ))}
      {q.data?.length === 0 && noRows('Nothing overdue')}
    </>
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
    <>
      <Page title={desk ? 'Claims desk' : 'Claims'} />
      {banner}
      {q.isLoading && <Loading />}
      {(q.data ?? []).map((c) => {
        const path = { params: { path: { id: c.id } } };
        return (
          <Panel key={c.id} level={3} title={<><Link to={`/invoices/${c.invoiceId}`}>{c.invoiceNumber}</Link> <StatusChip status={c.status}>{label(c.status)}</StatusChip></>}>
            <p>{c.bankName} claims <Amt v={c.claimedAmount} c={c.currency} strong /> on <Amt v={c.faceAmount} c={c.currency} /> (cover {c.coverPct}%) · filed {dt(c.filedAt)}</p>
            <Hint>Documents: {c.documents.map((d) => d.docType).join(', ') || 'none'}</Hint>
            {c.exclusions.length > 0 && <Alert tone="warning" title="Policy exclusions"><ul>{c.exclusions.map((e) => <li key={e.code}>{label(e.code)} — {e.detail}</li>)}</ul></Alert>}
            {c.waterfall && (
              <DescriptionList columns={1} layout="inline" items={[
                { label: 'Insurer pays', value: <Amt v={c.waterfall.payout} c={c.currency} />, num: true },
                { label: 'To the bank (principal and charges first)', value: <Amt v={c.waterfall.toBank} c={c.currency} />, num: true },
                { label: 'To the supplier’s retention', value: <Amt v={c.waterfall.toSupplier} c={c.currency} />, num: true },
                { label: 'Bank shortfall', value: <Amt v={c.waterfall.bankShortfall} c={c.currency} />, num: true },
                { label: 'Supplier retention lost', value: <Amt v={c.waterfall.supplierLoss} c={c.currency} />, num: true },
              ]} />
            )}
            {c.decisionReason && <Hint>Insurer’s reason: {c.decisionReason}</Hint>}
            {desk && ['Filed', 'UnderReview'].includes(c.status) && (
              <>
                {c.status === 'Filed' && <div><Button onClick={() => act(() => api.POST('/api/v1/claims/{id}/review', path), 'Review started: exclusions re-checked.')}>Start review</Button></div>}
                <div className="toolbar-fields">
                  <TextField label="Amount (partial)" inputMode="decimal" value={amt[c.id] ?? ''} onChange={(e) => setAmt({ ...amt, [c.id]: e.target.value })} />
                  <TextField label="Reason" value={reason[c.id] ?? ''} onChange={(e) => setReason({ ...reason, [c.id]: e.target.value })} />
                </div>
                <div className="row-actions">
                  <Button variant="primary" onClick={() => act(() => api.POST('/api/v1/claims/{id}/decision', { ...path, body: { decision: 'approve' } }), 'Claim approved.')}>Approve in full</Button>
                  <Button onClick={() => act(() => api.POST('/api/v1/claims/{id}/decision', { ...path, body: { decision: 'partial', approvedAmount: amt[c.id], reason: reason[c.id] } }), 'Claim partly approved.')}>Approve less</Button>
                  <Button variant="danger" onClick={() => act(() => api.POST('/api/v1/claims/{id}/decision', { ...path, body: { decision: 'reject', reason: reason[c.id] } }), 'Claim rejected.')}>Reject</Button>
                </div>
              </>
            )}
            {desk && ['Approved', 'PartiallyApproved'].includes(c.status) && <div><Button variant="primary" onClick={() => act(() => api.POST('/api/v1/claims/{id}/pay', path), 'Payout recorded and distributed.')}>Record payout of <Amt v={c.approvedAmount ?? '0'} c={c.currency} /></Button></div>}
            {c.recoveries.length > 0 && (
              <DataTable aria-label="Recoveries" noun="recoveries" density="compact" rowKey={(r) => r.id} rows={c.recoveries}
                columns={[
                  { id: 'when', header: 'Recovery', rowHeader: true, cell: (r) => dt(r.at) },
                  { id: 'gross', header: 'Gross', numeric: true, cell: (r) => <Amt v={r.gross} c={c.currency} /> },
                  { id: 'costs', header: 'Costs', numeric: true, cell: (r) => <Amt v={r.costs} c={c.currency} /> },
                  { id: 'net', header: 'Net', numeric: true, cell: (r) => <Amt v={r.net} c={c.currency} /> },
                  { id: 'shared', header: 'Shared (insurer / bank / supplier)', cell: (r) => <><Amt v={r.shares.insurer ?? '0'} c={c.currency} /> / <Amt v={r.shares.bank ?? '0'} c={c.currency} /> / <Amt v={r.shares.supplier ?? '0'} c={c.currency} /></> },
                ]} />
            )}
            {bank && ['Paid', 'Rejected'].includes(c.status) && (
              <div className="toolbar-fields">
                <TextField label="Recovered" inputMode="decimal" value={gross[c.id] ?? ''} onChange={(e) => setGross({ ...gross, [c.id]: e.target.value })} />
                <TextField label="Costs" inputMode="decimal" value={costs[c.id] ?? ''} onChange={(e) => setCosts({ ...costs, [c.id]: e.target.value })} />
                <Button onClick={() => act(() => api.POST('/api/v1/claims/{id}/recoveries', { ...path, body: { gross: gross[c.id] ?? '', costs: costs[c.id] || '0.00' } }), 'Recovery recorded and shared pro rata to losses.')}>Record recovery</Button>
              </div>
            )}
          </Panel>
        );
      })}
      {q.data?.length === 0 && noRows('No claims')}
    </>
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
    <>
      <Page title={type === 'bank' ? 'Recourse receivable' : 'What you owe your bank'} description="Financing is without recourse, except where a dispute is caused by the supplier (and decided by Earlio) or a credit note reduces the invoice after the advance. There is no penalty interest." />
      {banner}
      {q.isLoading && <Loading />}
      {(q.data ?? []).map((r) => (
        <Panel key={r.id} level={3} title={<><Link to={`/invoices/${r.invoiceId}`}>{r.invoiceNumber}</Link> · {label(r.cause)} <StatusChip status={r.status === 'open' ? 'Overdue' : 'Settled'}>{r.status}</StatusChip></>}>
          <p>{type === 'bank' ? r.supplierName : 'You'} owe{type === 'bank' ? 's' : ''} <Amt v={r.outstanding} c={r.currency} strong /> of <Amt v={r.amountOwed} c={r.currency} />.</p>
          {r.smallSupplier && r.status === 'open' && (
            <>
              <p>Repayment: <strong>{r.mode === 'plan_90d' ? '90-day plan' : 'automatic offset'}</strong>. {r.mode === 'offset_20pct' ? 'At most 20% of each future payout is withheld until this is repaid.' : 'Three equal monthly instalments.'}</p>
              {type === 'supplier' && me?.permissions.includes('financing:consent') && (
                <div><Button onClick={() => act(() => api.POST('/api/v1/recovery/recourse/{id}/mode', { params: { path: { id: r.id } }, body: { mode: r.mode === 'plan_90d' ? 'offset_20pct' : 'plan_90d' } }), 'Repayment method changed.')}>Switch to {r.mode === 'plan_90d' ? 'offset' : 'a 90-day plan'}</Button></div>
              )}
            </>
          )}
          {r.plan && (
            <DataTable aria-label="Repayment plan" noun="instalments" density="compact" rowKey={(p) => p.dueOn} rows={r.plan}
              columns={[
                { id: 'due', header: 'Due', rowHeader: true, cell: (p) => dd(p.dueOn) },
                { id: 'amount', header: 'Amount', numeric: true, cell: (p) => <Amt v={p.amount} c={r.currency} /> },
                { id: 'paid', header: 'Paid', cell: (p) => (p.paid ? <Badge tone="success">paid</Badge> : '') },
              ]} />
          )}
          {r.payments.length > 0 && (
            <TimelineList aria-label="Repayments" events={[...r.payments].reverse().map((p, i) => ({ id: String(i), title: <><Amt v={p.amount} c={r.currency} /> · {p.source}</>, at: p.at }))} />
          )}
          {type === 'bank' && me?.permissions.includes('claim:file') && r.status === 'open' && (
            <div className="toolbar-fields">
              <TextField label="Amount received" inputMode="decimal" value={pay[r.id] ?? ''} onChange={(e) => setPay({ ...pay, [r.id]: e.target.value })} />
              <Button onClick={() => act(() => api.POST('/api/v1/recovery/recourse/{id}/payments', { params: { path: { id: r.id } }, body: { amount: pay[r.id] ?? '' } }), 'Repayment recorded.')}>Record repayment</Button>
            </div>
          )}
        </Panel>
      ))}
      {q.data?.length === 0 && noRows(type === 'bank' ? 'No recourse is owed to you' : 'You owe nothing')}
    </>
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
    <>
      <Page title="Export proceeds" description="Export proceeds must normally be realised within 9 months of shipment (confirm the period for your case with your authorised dealer bank or counsel)." />
      {banner}
      <DataTable aria-label="Export proceeds" noun="export invoices" loading={q.isLoading} rowKey={(p) => p.id} rows={q.data ?? []} empty={noRows('No export invoices yet')}
        columns={[
          { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (p) => <><Link to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link>{p.chainBroken && p.chainNote && <div className="hint"><Badge tone="warning" icon="triangle-alert">Check</Badge> {p.chainNote}</div>}</> },
          { id: 'amount', header: 'Amount', numeric: true, cell: (p) => <Amt v={p.amountForeign} c={p.currency} /> },
          { id: 'shipped', header: 'Shipped', cell: (p) => dd(p.shipmentDate) },
          { id: 'by', header: 'Realise by', cell: (p) => <>{dd(p.realisationDeadline)} <span className="hint">({p.daysLeft >= 0 ? `${p.daysLeft} days left` : `${-p.daysLeft} days late`})</span></> },
          { id: 'status', header: 'Status', cell: (p) => <StatusChip status={p.status === 'Overdue' ? 'Overdue' : p.status === 'Pending' ? 'Pending' : 'Credited'}>{p.status}</StatusChip> },
          { id: 'inr', header: 'Rupees received', numeric: true, cell: (p) => <Amt v={p.realisedInr} c="INR" /> },
          { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (p) => bank && p.status === 'Realised' ? (
            <div className="row-actions">
              <TextField label="Report reference" value={ref[p.id] ?? ''} onChange={(e) => setRef({ ...ref, [p.id]: e.target.value })} />
              <Button size="sm" onClick={() => act(() => api.POST('/api/v1/export-proceeds/{id}/report', { params: { path: { id: p.id } }, body: { reference: ref[p.id] ?? '' } }), 'Marked as reported.')}>Mark reported</Button>
            </div>) : null },
        ]} />
    </>
  );
}

/** The insurer decides which papers and extra information a claim needs (CT-10); the form shows exactly that. */
function ClaimForm({ invoiceId, extra, setExtra, children }: { invoiceId: string; extra: Record<string, string>; setExtra: (v: Record<string, string>) => void; children: React.ReactNode }) {
  const q = useQuery({ queryKey: ['claim-req', invoiceId], queryFn: async () => (await api.GET('/api/v1/requirements/claim/{invoiceId}', { params: { path: { invoiceId } } })).data });
  return (
    <Section title="File the insurance claim" level={4}>
      {q.data && <Hint>This insurer requires: {q.data.documents.map(label).join(', ')}.</Hint>}
      {q.data?.customFields.map((f) => (
        <Fragment key={f.key}>
          {f.type === 'select'
            ? <SelectField label={`${f.label}${f.required ? ' *' : ''}`} value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })}><option value="">—</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</SelectField>
            : <TextField label={`${f.label}${f.required ? ' *' : ''}`} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step="any" value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} />}
        </Fragment>
      ))}
      {children}
    </Section>
  );
}
