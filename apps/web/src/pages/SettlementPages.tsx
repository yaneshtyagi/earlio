import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, DataTable, DescriptionList, SelectField, TabPanel, Tabs, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, ErrorNote, Hint, Notice, Page, Panel, StatusChip, TimelineList, dd, dt, label, noRows, type Msg } from '../ui';

/** BUY-07: what to pay, by when, with which reference and into which collection account. */
export function BuyerPaymentsPage() {
  const q = useQuery({ queryKey: ['payments-due'], queryFn: async () => (await api.GET('/api/v1/settlement/payments-due')).data?.items ?? [] });
  return (
    <>
      <Page title="Payments due" description="Pay the full amount into the collection account and quote the reference exactly, so the payment is matched automatically." />
      {(q.data ?? []).map((p) => (
        <Panel key={p.id} title={<><Link to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link> <StatusChip status={p.status} /> {p.late && <StatusChip status="late">late</StatusChip>}</>}>
          <DescriptionList columns={2} items={[
            { label: 'Amount due', value: <><Amt v={p.expectedAmount} c={p.currency} strong /> by {dd(p.dueDate)}</> },
            { label: 'Payment reference', value: p.reference, mono: true },
            { label: 'Pay to', value: `${p.collectionAccount.name} · ${p.collectionAccount.number} · SWIFT ${p.collectionAccount.swift}`, wide: true },
            { label: 'Received so far', value: <Amt v={p.receivedAmount} c={p.currency} />, num: true },
          ]} />
        </Panel>
      ))}
      {q.data?.length === 0 && noRows('Nothing to pay yet', 'A payment reference appears once an invoice of yours is funded by a bank.')}
    </>
  );
}

const ACTION_LABEL: Record<string, string> = { assign: 'Assign to invoice', wait: 'Wait for balance', accept_short: 'Accept as full', refund: 'Refund buyer', acknowledge: 'Acknowledge', accept_credit: 'Accept credited amount' };
type Tab = 'exceptions' | 'expectations' | 'transactions' | 'disbursements';

/** BNK-10: expectations, bank transactions, exceptions and disbursements in one console. */
export function SettlementConsolePage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('exceptions');
  const [err, setErr] = useState<string | null>(null);
  const [invNo, setInvNo] = useState<Record<string, string>>({});
  const exc = useQuery({ queryKey: ['exceptions'], queryFn: async () => (await api.GET('/api/v1/settlement/exceptions', { params: { query: {} } })).data?.items ?? [] });
  const exp = useQuery({ queryKey: ['expectations'], queryFn: async () => (await api.GET('/api/v1/settlement/expectations', { params: { query: {} } })).data?.items ?? [] });
  const txn = useQuery({ queryKey: ['transactions'], queryFn: async () => (await api.GET('/api/v1/settlement/transactions')).data?.items ?? [] });
  const dis = useQuery({ queryKey: ['disbursements'], queryFn: async () => (await api.GET('/api/v1/settlement/disbursements', { params: { query: {} } })).data?.items ?? [] });
  const canOperate = me?.permissions.includes('settlement:operate');
  const resolve = useMutation({
    mutationFn: async (a: { id: string; action: string }) => {
      const r = await api.POST('/api/v1/settlement/exceptions/{id}/resolve', { params: { path: { id: a.id } }, body: { action: a.action as any, invoiceNumber: invNo[a.id] || undefined } });
      await ensureOk(r);
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries(); },
    onError: (e: Error) => setErr(e.message),
  });
  const open = (exc.data ?? []).filter((e) => e.status === 'open').length;
  const P = 'settlement';
  const panel = (id: Tab, children: React.ReactNode) => <TabPanel tabId={id} activeTab={tab} idPrefix={P}>{children}</TabPanel>;
  return (
    <>
      <Page title="Settlement" />
      <Tabs aria-label="Settlement views" idPrefix={P} value={tab} onValueChange={(v) => setTab(v as Tab)}
        items={[{ id: 'exceptions', label: 'Exceptions', count: open || undefined }, { id: 'expectations', label: 'Expectations' }, { id: 'transactions', label: 'Transactions' }, { id: 'disbursements', label: 'Disbursements' }]} />
      <ErrorNote>{err}</ErrorNote>
      {tab === 'exceptions' && panel('exceptions',
        <DataTable aria-label="Exceptions" noun="exceptions" loading={exc.isLoading} rowKey={(e) => e.id} rows={exc.data ?? []} empty={noRows('No exceptions', 'Everything matched.')}
          columns={[
            { id: 'type', header: 'Type', cell: (e) => <Badge tone="warning">{e.type}</Badge> },
            { id: 'invoice', header: 'Invoice', cell: (e) => e.invoiceNumber ?? '—' },
            { id: 'amount', header: 'Amount', numeric: true, cell: (e) => (e.amount ? <Amt v={e.amount} c={e.currency ?? 'USD'} /> : '—') },
            { id: 'detail', header: 'Detail', cell: (e) => <>{e.detail}{e.resolution && <div className="hint">Resolved: {e.resolution}</div>}</> },
            { id: 'status', header: 'Status', cell: (e) => <StatusChip status={e.status} /> },
            { id: 'act', header: <span className="bv-sr-only">Actions</span>, cell: (e) => canOperate ? (
              <div className="row-actions">{e.allowedActions.map((a) => (
                <span key={a} className="row-actions">
                  {a === 'assign' && <TextField label="Invoice number" size="sm" placeholder="INV-…" value={invNo[e.id] ?? ''} onChange={(ev) => setInvNo({ ...invNo, [e.id]: ev.target.value })} />}
                  <Button size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: e.id, action: a })}>{ACTION_LABEL[a]}</Button>
                </span>
              ))}</div>) : null },
          ]} />)}
      {tab === 'expectations' && panel('expectations',
        <DataTable aria-label="Payment expectations" noun="expectations" loading={exp.isLoading} rowKey={(e) => e.id} rows={exp.data ?? []} empty={noRows('No expectations yet')}
          columns={[
            { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (e) => <Link to={`/invoices/${e.invoiceId}`}>{e.invoiceNumber}</Link> },
            { id: 'ref', header: 'Reference', cell: (e) => <span className="mono">{e.reference}</span> },
            { id: 'buyer', header: 'Buyer', cell: (e) => e.buyerName },
            { id: 'expected', header: 'Expected', numeric: true, cell: (e) => <Amt v={e.expectedAmount} c={e.currency} /> },
            { id: 'received', header: 'Received', numeric: true, cell: (e) => <Amt v={e.receivedAmount} c={e.currency} /> },
            { id: 'due', header: 'Due', cell: (e) => dd(e.dueDate) },
            { id: 'status', header: 'Status', cell: (e) => <StatusChip status={e.status} /> },
          ]} />)}
      {tab === 'transactions' && panel('transactions',
        <DataTable aria-label="Bank transactions" noun="transactions" loading={txn.isLoading} rowKey={(t) => t.id} rows={txn.data ?? []} empty={noRows('No transactions yet')}
          columns={[
            { id: 'source', header: 'Source', cell: (t) => t.source },
            { id: 'txn', header: 'Bank txn', rowHeader: true, cell: (t) => <span className="mono">{t.bankTxnId}</span> },
            { id: 'ref', header: 'Reference', cell: (t) => <span className="mono">{t.reference ?? '—'}</span> },
            { id: 'amount', header: 'Amount', numeric: true, cell: (t) => <Amt v={t.amount} c={t.currency} /> },
            { id: 'value', header: 'Value date', cell: (t) => dd(t.valueDate) },
            { id: 'match', header: 'Match', cell: (t) => <>{label(t.matchStatus)}{t.invoiceNumber && ` · ${t.invoiceNumber}`}</> },
          ]} />)}
      {tab === 'disbursements' && panel('disbursements',
        <DataTable aria-label="Disbursements" noun="disbursements" loading={dis.isLoading} rowKey={(d) => d.id} rows={dis.data ?? []} empty={noRows('No disbursements yet')}
          columns={[
            { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (d) => <Link to={`/invoices/${d.invoiceId}`}>{d.invoiceNumber}</Link> },
            { id: 'status', header: 'Status', cell: (d) => <><StatusChip status={d.status} />{d.failureReason && <div className="hint">{d.failureReason}</div>}</> },
            { id: 'foreign', header: 'Foreign', numeric: true, cell: (d) => <Amt v={d.amountForeign} c={d.currency} /> },
            { id: 'fx', header: 'FX', numeric: true, cell: (d) => d.fxRate },
            { id: 'inr', header: 'INR', numeric: true, cell: (d) => <Amt v={d.amountInr} c="INR" /> },
            { id: 'value', header: 'Value date', cell: (d) => <>{dd(d.valueDate)}{d.cutoffMissed && ' (cut-off missed)'}</> },
            { id: 'attempts', header: 'Attempts', numeric: true, cell: (d) => d.attempts },
          ]} />)}
    </>
  );
}

/** On the invoice page: where the money is (disbursement steps) and the settlement ledger. */
export function SettlementPanel({ invoiceId }: { invoiceId: string }) {
  const dis = useQuery({ queryKey: ['disbursements', invoiceId], queryFn: async () => (await api.GET('/api/v1/settlement/disbursements', { params: { query: { invoiceId } } })).data?.items ?? [] });
  const led = useQuery({ queryKey: ['ledger', invoiceId], queryFn: async () => (await api.GET('/api/v1/settlement/ledger/{invoiceId}', { params: { path: { invoiceId } } })).data?.items ?? [] });
  const d = dis.data?.[0];
  if (!d && !led.data?.length) return null;
  return (
    <Panel title="Payment and settlement">
      {d && (
        <>
          <p>Payout of <Amt v={d.amountInr} c="INR" strong /> (<Amt v={d.amountForeign} c={d.currency} /> at {d.fxRate}) — <StatusChip status={d.status} />, value date {dd(d.valueDate)}{d.cutoffMissed && ' (bank cut-off had passed)'}.</p>
          <TimelineList aria-label="Disbursement steps" events={d.events.map((e, i) => ({ id: String(i), title: e.status, meta: e.note, at: e.at }))} />
        </>
      )}
      {!!led.data?.length && (
        <DataTable aria-label="Settlement ledger" noun="entries" density="compact" rowKey={(l) => l.id} rows={led.data}
          columns={[
            { id: 'when', header: 'When', rowHeader: true, cell: (l) => dt(l.at) },
            { id: 'entry', header: 'Entry', cell: (l) => l.note ?? l.kind },
            { id: 'party', header: 'Party', cell: (l) => l.party },
            { id: 'amount', header: 'Amount', numeric: true, cell: (l) => <Amt v={l.amount} c={l.currency} /> },
            { id: 'inr', header: 'INR', numeric: true, cell: (l) => (l.amountInr ? <Amt v={l.amountInr} c="INR" /> : '') },
          ]} />
      )}
    </Panel>
  );
}

export function NotificationsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: async () => (await api.GET('/api/v1/notifications', { params: { query: {} } })).data });
  const mark = useMutation({
    mutationFn: async (id?: string) => { id ? await api.POST('/api/v1/notifications/{id}/read', { params: { path: { id } } }) : await api.POST('/api/v1/notifications/read-all'); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <>
      <Page title={t('Notifications')} description={`${q.data?.unread ?? 0} ${t('unread')}`} actions={<Button onClick={() => mark.mutate(undefined)}>{t('Mark all read')}</Button>} />
      {(q.data?.items ?? []).map((n) => (
        <Panel key={n.id} level={3} title={<>{n.subject} {!n.read && <Badge tone="info">{t('New')}</Badge>}</>} sub={dt(n.createdAt)}
          actions={!n.read ? <Button size="sm" variant="ghost" onClick={() => mark.mutate(n.id)}>{t('Mark read')}</Button> : undefined}>
          <p>{n.body}</p>
        </Panel>
      ))}
      {q.data?.items.length === 0 && noRows(t('No notifications yet.'))}
    </>
  );
}

/** Platform admin control room: virtual clock, fault injection, payer simulator, calendars. */
export function ControlRoomPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<Msg>(null);
  const [invoiceNumber, setInvoiceNumber] = useState(''); const [amount, setAmount] = useState(''); const [via, setVia] = useState<'both' | 'callback' | 'statement'>('both');
  const clock = useQuery({ queryKey: ['clock'], queryFn: async () => (await api.GET('/api/v1/admin/clock')).data });
  const faults = useQuery({ queryKey: ['faults'], queryFn: async () => (await api.GET('/api/v1/admin/sim-settings')).data });
  const cal = useQuery({ queryKey: ['calendars'], queryFn: async () => (await api.GET('/api/v1/admin/calendars')).data });
  const run = (f: () => Promise<{ response: Response }>, ok: string) => async () => {
    try { const r = await f(); await ensureOk(r); setMsg({ ok: true, text: ok }); qc.invalidateQueries(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const move = (b: { advanceHours?: number; advanceDays?: number; reset?: boolean }) => run(() => api.POST('/api/v1/admin/clock', { body: b }), 'Clock moved.');
  return (
    <>
      <Page title="Control room" description="Simulation controls for demos and tests. Not available in production." />
      <Notice msg={msg} />
      <div className="split">
        <Panel title="Platform time">
          <p>{clock.data ? dt(clock.data.now) : '…'} {clock.data?.virtual ? '(virtual)' : '(real time)'}</p>
          <div className="row-actions">
            <Button onClick={move({ advanceHours: 1 })}>+1 hour</Button><Button onClick={move({ advanceHours: 25 })}>+25 hours</Button>
            <Button onClick={move({ advanceDays: 1 })}>+1 day</Button><Button onClick={move({ advanceDays: 30 })}>+30 days</Button>
            <Button variant="ghost" onClick={move({ reset: true })}>Reset</Button>
          </div>
          <Hint>Background jobs run every few seconds, so effects appear shortly after you move time.</Hint>
        </Panel>
        <Panel title="Bank behaviour">
          <SelectField label="Payout faults" value={faults.data?.disbursement ?? 'none'} onChange={(e) => run(() => api.PUT('/api/v1/admin/sim-settings', { body: { disbursement: e.target.value as any } }), 'Fault mode saved.')()}
            help="reject: bank refuses (retried 3×, then reversed) · timeout: no answer for 24 h · mismatch: credits ₹100 short · return: funds come back · random: seeded mix.">
            {['none', 'reject', 'timeout', 'mismatch', 'return', 'random'].map((m) => <option key={m}>{m}</option>)}
          </SelectField>
        </Panel>
      </div>
      <Panel title="Simulate the buyer paying">
        <div className="toolbar-fields">
          <TextField label="Invoice number" placeholder="e.g. INV-1001" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          <TextField label="Amount (blank = exact)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <SelectField label="Delivered by" value={via} onChange={(e) => setVia(e.target.value as any)}><option value="both">callback + statement</option><option value="callback">callback only</option><option value="statement">statement only</option></SelectField>
          <Button variant="primary" onClick={run(() => api.POST('/api/v1/sim/pay', { body: { invoiceNumber, amount: amount || undefined, via } }), 'Payment simulated.')}>Pay</Button>
        </div>
      </Panel>
      <Panel title="Holiday calendars">
        {cal.data?.verifyBeforeProduction && <Hint>Seed dates — verify with the authorised dealer bank before production use.</Hint>}
        <div className="split">{Object.entries(cal.data?.calendars ?? {}).map(([c, days]) => (
          <div key={c}><h3 className="bv-heading-xs">{c}</h3><ul>{days.map((d) => <li key={d.date}>{dd(d.date)} — {d.name}</li>)}</ul></div>
        ))}</div>
      </Panel>
    </>
  );
}

export function IntegrationInspectorPage() {
  const [adapter, setAdapter] = useState('');
  const q = useQuery({ queryKey: ['integration', adapter], queryFn: async () => (await api.GET('/api/v1/admin/integration-messages', { params: { query: adapter ? { adapter } : {} } })).data?.items ?? [] });
  return (
    <>
      <Page title="Integration inspector" description="The messages the simulated bank, insurer, FX and notification adapters sent and received." />
      <DataTable aria-label="Integration messages" noun="messages" density="compact" loading={q.isLoading} rowKey={(m) => m.id} rows={q.data ?? []} empty={noRows('No messages yet')}
        toolbar={<SelectField label="Adapter" value={adapter} onChange={(e) => setAdapter(e.target.value)}><option value="">All</option><option>payments</option><option>notify</option><option>insurer</option><option>fx</option></SelectField>}
        columns={[
          { id: 'when', header: 'When', rowHeader: true, cell: (m) => dt(m.createdAt) },
          { id: 'adapter', header: 'Adapter', cell: (m) => m.adapter },
          { id: 'dir', header: 'Direction', cell: (m) => m.direction },
          { id: 'ref', header: 'Reference', cell: (m) => m.reference },
          { id: 'payload', header: 'Payload', cell: (m) => <span className="mono">{typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}</span> },
        ]} />
    </>
  );
}
