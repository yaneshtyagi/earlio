import { InvoiceExceptionsPanel } from './ExceptionPages';
import { SettlementPanel } from './SettlementPages';
import { CoverPanel } from './InsurancePages';
import { BankFundingPanel, BuyerFundingPanel, SupplierFundingPanel } from './FundingPanels';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Checkbox, DataTable, DescriptionList, SelectField, TextareaField, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, Hint, Loading, Notice, Page, Panel, StatusChip, TimelineList, dd, dt, label, noRows, type Msg } from '../ui';

const DOCS = [['commercial_invoice', 'Commercial invoice'], ['delivery_proof', 'Delivery proof'], ['packing_list', 'Packing list'], ['shipping_bill', 'Shipping bill'], ['transport_document', 'Transport document']] as const;
const WARN: Record<string, string> = { no_purchase_order: 'No purchase order linked.', currency_differs_from_po: 'Currency differs from the purchase order.' };

export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: async () => (await api.GET('/api/v1/invoices/{id}', { params: { path: { id } } })).data });
  const [msg, setMsg] = useState<Msg>(null);
  const [reason, setReason] = useState('');
  const [partial, setPartial] = useState('');
  const [signed, setSigned] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>('commercial_invoice');
  const inv = q.data;
  if (!inv) return <Loading />;
  const me_ = me?.activeOrg;
  const isSupplier = me_?.id === inv.supplier.id, isBuyer = me_?.id === inv.buyer.id;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoice', id] }); qc.invalidateQueries({ queryKey: ['invoices'] }); };
  const run = async (fn: () => Promise<{ response: Response }>, okText: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ ok: true, text: okText }); refresh(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const path = { params: { path: { id: inv.id } } };
  const cur = (a: string) => <Amt v={a} c={inv.currency} />;

  async function upload(file: File) {
    setMsg(null);
    let fileId: string;
    try { fileId = await uploadFile(file); } catch (e) { return setMsg({ ok: false, text: (e as Error).message }); }
    await run(() => api.POST('/api/v1/invoices/{id}/documents', { ...path, body: { docType: docType as 'delivery_proof', fileId } }), 'Document added.');
  }

  const canSupplier = isSupplier && me?.permissions.includes('invoice:create');
  const canBuyer = isBuyer && me?.permissions.includes('invoice:accept');
  const needsDecision = inv.status === 'Submitted';
  const windowOpen = inv.status === 'Accepted' && inv.disputeWindowEndsAt && new Date(inv.disputeWindowEndsAt) > new Date();

  return (
    <>
      <Page
        title={<>{inv.humanId} <StatusChip status={inv.status} /></>}
        breadcrumbs={[{ label: 'Invoices', href: '/invoices' }, { label: inv.humanId }]}
        description={<>{inv.supplier.name} → {inv.buyer.name} · invoice {inv.number} · IRN <code>{inv.irn?.slice(0, 16)}…</code></>}
        actions={canSupplier && inv.status === 'Draft' ? <>
          <Button onClick={() => run(() => api.POST('/api/v1/invoices/{id}/cancel', path), 'Draft cancelled.')}>Cancel draft</Button>
          <Button variant="primary" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/submit', path), 'Submitted to the buyer.')}>Submit to buyer</Button>
        </> : undefined} />
      {inv.warnings.map((w) => <Alert key={w} tone="warning" title={WARN[w] ?? w} />)}
      <Notice msg={msg} />

      <div className="split">
        <Panel title="Amounts">
          <DescriptionList columns={1} layout="inline" items={[
            { label: 'Invoice amount', value: cur(inv.grossAmount), num: true },
            { label: 'Accepted amount', value: inv.acceptedAmount ? cur(inv.acceptedAmount) : '—', num: true },
            { label: 'Issued / due', value: `${dd(inv.issueDate)} / ${dd(inv.dueDate)}`, num: true },
            { label: 'Purchase order', value: inv.poNumber ?? '—' },
            { label: 'Sanctions screening', value: inv.screeningStatus },
          ]} />
          {inv.disputeWindowEndsAt && <Hint>Dispute window {windowOpen ? 'closes' : 'closed'} {dt(inv.disputeWindowEndsAt)}.</Hint>}
        </Panel>
        <Panel title="Timeline">
          <TimelineList aria-label="Invoice timeline"
            events={[...inv.history].reverse().map((h, i) => ({ id: String(i), title: h.to, meta: h.note ?? undefined, at: h.at }))} />
        </Panel>
      </div>

      {inv.acceptedAt && <CoverPanel invoiceId={inv.id} />}
      {inv.acceptedAt && (() => {
        const f = { id: inv.id, humanId: inv.humanId, status: inv.status, route: inv.route, currency: inv.currency, dueDate: inv.dueDate };
        return isSupplier ? <SupplierFundingPanel inv={f} onChange={refresh} /> : isBuyer ? <BuyerFundingPanel inv={f} onChange={refresh} />
          : me_?.type === 'bank' ? <BankFundingPanel inv={f} onChange={refresh} /> : null;
      })()}

      {['Funded', 'Overdue', 'Settled', 'Closed'].includes(inv.status) && <SettlementPanel invoiceId={inv.id} />}

      <Panel title="Documents">
        <DataTable aria-label="Documents" noun="documents" rowKey={(d) => d.id} rows={inv.documents} empty={noRows('No documents yet')}
          columns={[
            { id: 'type', header: 'Type', rowHeader: true, cell: (d) => label(d.docType) },
            { id: 'version', header: 'Version', numeric: true, cell: (d) => `v${d.version}` },
            { id: 'file', header: 'File', cell: (d) => <a href={`/api/v1/files/${d.fileId}`}>{d.filename}</a> },
            { id: 'sha', header: 'SHA-256', cell: (d) => <code>{d.sha256.slice(0, 12)}…</code> },
          ]} />
        {canSupplier && ['Draft', 'Submitted'].includes(inv.status) && (
          <div className="toolbar-fields">
            <SelectField label="Document type" value={docType} onChange={(e) => setDocType(e.target.value)}>{DOCS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</SelectField>
            <Button icon="upload" onClick={() => fileRef.current?.click()}>Upload</Button>
            <input ref={fileRef} type="file" hidden aria-label="Choose a document" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
          </div>
        )}
      </Panel>

      {canBuyer && needsDecision && (
        <Panel title="Your decision" sub="Check the delivery proof above. Silence is never treated as acceptance.">
          <TextareaField label="Reason (required for rejection or partial acceptance)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <TextField label={`Amount to accept if partial (${inv.currency})`} inputMode="decimal" value={partial} onChange={(e) => setPartial(e.target.value)} />
          <blockquote className="hint">{inv.undertakingPreview}</blockquote>
          <Checkbox label="I sign this irrevocable payment undertaking and acknowledge the assignment notice." checked={signed} onChange={(e) => setSigned(e.target.checked)} />
          <div className="row-actions">
            <Button variant="primary" disabled={!signed} onClick={() => run(() => api.POST('/api/v1/invoices/{id}/decision', { ...path, body: { decision: 'accept', undertakingAccepted: true } }), 'Accepted.')}>Accept in full</Button>
            <Button disabled={!signed || !partial} onClick={() => run(() => api.POST('/api/v1/invoices/{id}/decision', { ...path, body: { decision: 'partial', acceptedAmount: partial, reason, undertakingAccepted: true } }), 'Part-accepted.')}>Part-accept</Button>
            <Button variant="danger" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/decision', { ...path, body: { decision: 'reject', reason } }), 'Rejected.')}>Reject</Button>
          </div>
        </Panel>
      )}

      {inv.acceptance && (
        <Panel title="Acceptance">
          <p>{inv.acceptance.decision}{inv.acceptance.reason && ` — ${inv.acceptance.reason}`}</p>
          {inv.acceptance.undertakingText && <blockquote className="hint">{inv.acceptance.undertakingText}<br />Signed {dt(inv.acceptance.undertakingSignedAt)}</blockquote>}
          {inv.acceptance.undertakingText && (inv.acceptance.assignmentAckAt
            ? <Alert tone="success" title={`Assignment notice acknowledged ${dt(inv.acceptance.assignmentAckAt)}.`} />
            : canBuyer && <div><Button onClick={() => run(() => api.POST('/api/v1/invoices/{id}/assignment-ack', path), 'Acknowledged.')}>Acknowledge assignment notice</Button></div>)}
        </Panel>
      )}

      {inv.disputes.length > 0 && (
        <Panel title="Disputes">
          <DataTable aria-label="Invoice disputes" noun="disputes" rowKey={(d) => d.id} rows={inv.disputes}
            columns={[
              { id: 'status', header: 'Status', cell: (d) => <Link to={`/disputes/${d.id}`}><StatusChip status="Disputed">{d.status}</StatusChip></Link> },
              { id: 'reason', header: 'Reason', cell: (d) => <>{d.kind === 'partial_remainder' ? `Remainder of ${d.amount} not accepted: ` : ''}{d.reason}</> },
            ]} />
        </Panel>
      )}
      <InvoiceExceptionsPanel invoiceId={inv.id} status={inv.status} currency={inv.currency} supplierId={inv.supplier.id} buyerId={inv.buyer.id} windowOpen={!!windowOpen} />
    </>
  );
}
