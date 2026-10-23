import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney, type Currency } from '../shared/money';

const when = (s: string) => new Date(s).toLocaleString();

/** BUY-07: what to pay, by when, with which reference and into which collection account. */
export function BuyerPaymentsPage() {
  const q = useQuery({ queryKey: ['payments-due'], queryFn: async () => (await api.GET('/api/v1/settlement/payments-due')).data?.items ?? [] });
  return (
    <section>
      <h2>Payments due</h2>
      <p className="hint">Pay the full amount into the collection account and quote the reference exactly, so the payment is matched automatically.</p>
      {(q.data ?? []).map((p) => (
        <div className="panel" key={p.id}>
          <h3><Link to={`/invoices/${p.invoiceId}`}>{p.invoiceNumber}</Link> <span className={`chip ${p.status}`}>{p.status}</span> {p.late && <span className="chip Overdue">late</span>}</h3>
          <table><tbody>
            <tr><td>Amount due</td><td className="num"><strong>{formatMoney(p.expectedAmount, p.currency as Currency)}</strong> by {p.dueDate}</td></tr>
            <tr><td>Payment reference</td><td className="num"><code>{p.reference}</code></td></tr>
            <tr><td>Pay to</td><td className="num">{p.collectionAccount.name} · {p.collectionAccount.number} · SWIFT {p.collectionAccount.swift}</td></tr>
            <tr><td>Received so far</td><td className="num">{formatMoney(p.receivedAmount, p.currency as Currency)}</td></tr>
          </tbody></table>
        </div>
      ))}
      {q.data?.length === 0 && <p className="muted">Nothing to pay yet. A payment reference appears once an invoice of yours is funded by a bank.</p>}
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = { assign: 'Assign to invoice', wait: 'Wait for balance', accept_short: 'Accept as full', refund: 'Refund buyer', acknowledge: 'Acknowledge', accept_credit: 'Accept credited amount' };

/** BNK-10: expectations, bank transactions, exceptions and disbursements in one console. */
export function SettlementConsolePage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'exceptions' | 'expectations' | 'transactions' | 'disbursements'>('exceptions');
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
  return (
    <section>
      <h2>Settlement</h2>
      <div className="filters">
        {(['exceptions', 'expectations', 'transactions', 'disbursements'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}{t === 'exceptions' && open ? ` (${open})` : ''}</button>
        ))}
      </div>
      {err && <p className="alert" role="alert">{err}</p>}
      {tab === 'exceptions' && (
        <table>
          <thead><tr><th>Type</th><th>Invoice</th><th className="num">Amount</th><th>Detail</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(exc.data ?? []).map((e) => (
              <tr key={e.id}>
                <td><span className="chip Disputed">{e.type}</span></td><td>{e.invoiceNumber ?? '—'}</td>
                <td className="num">{e.amount ? formatMoney(e.amount, (e.currency ?? 'USD') as Currency) : '—'}</td>
                <td>{e.detail}{e.resolution && <div className="hint">Resolved: {e.resolution}</div>}</td><td>{e.status}</td>
                <td>{canOperate && e.allowedActions.map((a) => (
                  <span key={a}>
                    {a === 'assign' && <input aria-label="Invoice number" placeholder="INV-…" value={invNo[e.id] ?? ''} onChange={(ev) => setInvNo({ ...invNo, [e.id]: ev.target.value })} style={{ width: 110 }} />}
                    <button className="link" disabled={resolve.isPending} onClick={() => resolve.mutate({ id: e.id, action: a })}>{ACTION_LABEL[a]}</button>
                  </span>
                ))}</td>
              </tr>
            ))}
            {exc.data?.length === 0 && <tr><td colSpan={6} className="muted">No exceptions. Everything matched.</td></tr>}
          </tbody>
        </table>
      )}
      {tab === 'expectations' && (
        <table>
          <thead><tr><th>Invoice</th><th>Reference</th><th>Buyer</th><th className="num">Expected</th><th className="num">Received</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>{(exp.data ?? []).map((e) => (
            <tr key={e.id}><td><Link to={`/invoices/${e.invoiceId}`}>{e.invoiceNumber}</Link></td><td><code>{e.reference}</code></td><td>{e.buyerName}</td>
              <td className="num">{formatMoney(e.expectedAmount, e.currency as Currency)}</td><td className="num">{formatMoney(e.receivedAmount, e.currency as Currency)}</td><td>{e.dueDate}</td><td><span className={`chip ${e.status}`}>{e.status}</span></td></tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'transactions' && (
        <table>
          <thead><tr><th>Source</th><th>Bank txn</th><th>Reference</th><th className="num">Amount</th><th>Value date</th><th>Match</th></tr></thead>
          <tbody>{(txn.data ?? []).map((t) => (
            <tr key={t.id}><td>{t.source}</td><td>{t.bankTxnId}</td><td><code>{t.reference ?? '—'}</code></td><td className="num">{formatMoney(t.amount, t.currency as Currency)}</td><td>{t.valueDate}</td><td>{t.matchStatus}{t.invoiceNumber && ` · ${t.invoiceNumber}`}</td></tr>
          ))}</tbody>
        </table>
      )}
      {tab === 'disbursements' && (
        <table>
          <thead><tr><th>Invoice</th><th>Status</th><th className="num">Foreign</th><th className="num">FX</th><th className="num">INR</th><th>Value date</th><th>Attempts</th></tr></thead>
          <tbody>{(dis.data ?? []).map((d) => (
            <tr key={d.id}><td><Link to={`/invoices/${d.invoiceId}`}>{d.invoiceNumber}</Link></td><td><span className={`chip ${d.status}`}>{d.status}</span>{d.failureReason && <div className="hint">{d.failureReason}</div>}</td>
              <td className="num">{formatMoney(d.amountForeign, d.currency as Currency)}</td><td className="num">{d.fxRate}</td><td className="num">{formatMoney(d.amountInr, 'INR')}</td><td>{d.valueDate}{d.cutoffMissed && ' (cut-off missed)'}</td><td>{d.attempts}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  );
}

/** On the invoice page: where the money is (disbursement steps) and the settlement ledger. */
export function SettlementPanel({ invoiceId }: { invoiceId: string }) {
  const dis = useQuery({ queryKey: ['disbursements', invoiceId], queryFn: async () => (await api.GET('/api/v1/settlement/disbursements', { params: { query: { invoiceId } } })).data?.items ?? [] });
  const led = useQuery({ queryKey: ['ledger', invoiceId], queryFn: async () => (await api.GET('/api/v1/settlement/ledger/{invoiceId}', { params: { path: { invoiceId } } })).data?.items ?? [] });
  const d = dis.data?.[0];
  if (!d && !led.data?.length) return null;
  return (
    <div className="panel">
      <h3>Payment and settlement</h3>
      {d && (
        <>
          <p>Payout of <strong>{formatMoney(d.amountInr, 'INR')}</strong> ({formatMoney(d.amountForeign, d.currency as Currency)} at {d.fxRate}) — <span className={`chip ${d.status}`}>{d.status}</span>, value date {d.valueDate}{d.cutoffMissed && ' (bank cut-off had passed)'}.</p>
          <ul className="timeline">{d.events.map((e, i) => <li key={i}><strong>{e.status}</strong> · {when(e.at)}{e.note && <div className="hint">{e.note}</div>}</li>)}</ul>
        </>
      )}
      {!!led.data?.length && (
        <table>
          <thead><tr><th>When</th><th>Entry</th><th>Party</th><th className="num">Amount</th><th className="num">INR</th></tr></thead>
          <tbody>{led.data.map((l) => <tr key={l.id}><td>{when(l.at)}</td><td>{l.note ?? l.kind}</td><td>{l.party}</td><td className="num">{formatMoney(l.amount, l.currency as Currency)}</td><td className="num">{l.amountInr ? formatMoney(l.amountInr, 'INR') : ''}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

/** Header bell with unread count, linking to the notification centre. */
export function NotificationBell() {
  const q = useQuery({ queryKey: ['notifications'], queryFn: async () => (await api.GET('/api/v1/notifications', { params: { query: {} } })).data, refetchInterval: 15_000 });
  const n = q.data?.unread ?? 0;
  return <Link to="/notifications" aria-label={`Notifications, ${n} unread`} className="bell">🔔{n > 0 && <span className="badge">{n}</span>}</Link>;
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: async () => (await api.GET('/api/v1/notifications', { params: { query: {} } })).data });
  const mark = useMutation({
    mutationFn: async (id?: string) => { id ? await api.POST('/api/v1/notifications/{id}/read', { params: { path: { id } } }) : await api.POST('/api/v1/notifications/read-all'); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <section>
      <h2>Notifications</h2>
      <p className="filters"><span className="hint">{q.data?.unread ?? 0} unread</span><button className="secondary" onClick={() => mark.mutate(undefined)}>Mark all read</button></p>
      {(q.data?.items ?? []).map((n) => (
        <div className="panel" key={n.id} style={{ opacity: n.read ? 0.65 : 1 }}>
          <strong>{n.subject}</strong> <span className="hint">{when(n.createdAt)}</span>
          <div>{n.body}</div>
          {!n.read && <button className="link" onClick={() => mark.mutate(n.id)}>Mark read</button>}
        </div>
      ))}
      {q.data?.items.length === 0 && <p className="muted">Nothing yet.</p>}
    </section>
  );
}

/** Platform admin control room: virtual clock, fault injection, payer simulator, calendars. */
export function ControlRoomPage() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState(''); const [amount, setAmount] = useState(''); const [via, setVia] = useState<'both' | 'callback' | 'statement'>('both');
  const clock = useQuery({ queryKey: ['clock'], queryFn: async () => (await api.GET('/api/v1/admin/clock')).data });
  const faults = useQuery({ queryKey: ['faults'], queryFn: async () => (await api.GET('/api/v1/admin/sim-settings')).data });
  const cal = useQuery({ queryKey: ['calendars'], queryFn: async () => (await api.GET('/api/v1/admin/calendars')).data });
  const run = (f: () => Promise<{ response: Response }>, ok: string) => async () => {
    try { const r = await f(); await ensureOk(r); setMsg(ok); qc.invalidateQueries(); } catch (e) { setMsg((e as Error).message); }
  };
  const move = (b: { advanceHours?: number; advanceDays?: number; reset?: boolean }) => run(() => api.POST('/api/v1/admin/clock', { body: b }), 'Clock moved.');
  return (
    <section>
      <h2>Control room</h2>
      <p className="hint">Simulation controls for demos and tests. Not available in production.</p>
      {msg && <p className="ok" role="status">{msg}</p>}
      <div className="row">
        <div className="panel">
          <h3>Platform time</h3>
          <p>{clock.data ? when(clock.data.now) : '…'} {clock.data?.virtual ? '(virtual)' : '(real time)'}</p>
          <p className="filters">
            <button className="secondary" onClick={move({ advanceHours: 1 })}>+1 hour</button><button className="secondary" onClick={move({ advanceHours: 25 })}>+25 hours</button>
            <button className="secondary" onClick={move({ advanceDays: 1 })}>+1 day</button><button className="secondary" onClick={move({ advanceDays: 30 })}>+30 days</button>
            <button className="secondary" onClick={move({ reset: true })}>Reset</button>
          </p>
          <p className="hint">Background jobs run every few seconds, so effects appear shortly after you move time.</p>
        </div>
        <div className="panel">
          <h3>Bank behaviour</h3>
          <label>Payout faults
            <select value={faults.data?.disbursement ?? 'none'} onChange={(e) => run(() => api.PUT('/api/v1/admin/sim-settings', { body: { disbursement: e.target.value as any } }), 'Fault mode saved.')()}>
              {['none', 'reject', 'timeout', 'mismatch', 'return', 'random'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <p className="hint">reject: bank refuses (retried 3×, then reversed) · timeout: no answer for 24 h · mismatch: credits ₹100 short · return: funds come back · random: seeded mix.</p>
        </div>
      </div>
      <div className="panel">
        <h3>Simulate the buyer paying</h3>
        <p className="filters">
          <input placeholder="Invoice number, e.g. INV-1001" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          <input placeholder="Amount (blank = exact)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select value={via} onChange={(e) => setVia(e.target.value as any)}><option value="both">callback + statement</option><option value="callback">callback only</option><option value="statement">statement only</option></select>
          <button onClick={run(() => api.POST('/api/v1/sim/pay', { body: { invoiceNumber, amount: amount || undefined, via } }), 'Payment simulated.')}>Pay</button>
        </p>
      </div>
      <div className="panel">
        <h3>Holiday calendars</h3>
        {cal.data?.verifyBeforeProduction && <p className="hint">Seed dates — verify with the authorised dealer bank before production use.</p>}
        <div className="row">{Object.entries(cal.data?.calendars ?? {}).map(([c, days]) => (
          <div key={c}><strong>{c}</strong><ul>{days.map((d) => <li key={d.date}>{d.date} — {d.name}</li>)}</ul></div>
        ))}</div>
      </div>
    </section>
  );
}

export function IntegrationInspectorPage() {
  const [adapter, setAdapter] = useState('');
  const q = useQuery({ queryKey: ['integration', adapter], queryFn: async () => (await api.GET('/api/v1/admin/integration-messages', { params: { query: adapter ? { adapter } : {} } })).data?.items ?? [] });
  return (
    <section>
      <h2>Integration inspector</h2>
      <p className="filters"><select value={adapter} onChange={(e) => setAdapter(e.target.value)}><option value="">All</option><option>payments</option><option>notify</option><option>insurer</option><option>fx</option></select></p>
      <table>
        <thead><tr><th>When</th><th>Adapter</th><th>Direction</th><th>Reference</th><th>Payload</th></tr></thead>
        <tbody>{(q.data ?? []).map((m) => <tr key={m.id}><td>{when(m.createdAt)}</td><td>{m.adapter}</td><td>{m.direction}</td><td>{m.reference}</td><td><code>{typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)}</code></td></tr>)}</tbody>
      </table>
    </section>
  );
}
