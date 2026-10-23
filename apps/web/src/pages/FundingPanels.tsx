import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney, type Currency } from '../shared/money';

type Inv = { id: string; humanId: string; status: string; route: string | null; currency: string; dueDate: string };
const money = (a: unknown, c: string) => formatMoney(String(a), c as Currency);

function useAction(onDone: () => void) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<{ response: Response }>, okText: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ ok: true, text: okText }); onDone(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return { msg, run, Msg: () => (msg ? <p className={msg.ok ? 'ok' : 'alert'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p> : null) };
}

/** Plain-language cost breakdown that backs the "Explain this cost" panel. */
function Breakdown({ b, ccy }: { b: Record<string, any>; ccy: string }) {
  const rows: [string, string][] = [['Advance', b.advance], ['Bank discount (interest)', b.discount], ['Processing fee', b.processingFee], ['Platform fee (if passed on)', b.platformFeeSupplier ?? b.platformFee], ['Insurance premium (if passed on)', b.premiumSupplier ?? b.premium]];
  return (
    <table><tbody>
      {rows.filter(([, v]) => v !== undefined).map(([k, v]) => <tr key={k}><td>{k}</td><td className="num">{money(v, ccy)}</td></tr>)}
      <tr><td><strong>Total charges</strong></td><td className="num">{money(b.totalCharges, ccy)}</td></tr>
      <tr><td><strong>Net cash</strong></td><td className="num">{money(b.netCash, ccy)}</td></tr>
      <tr><td>Retention (released at maturity)</td><td className="num">{money(b.retention, ccy)}</td></tr>
    </tbody></table>
  );
}

/** Supplier: request funding, compare offers with early payment, choose, consent (SUP-05 to SUP-07). */
export function SupplierFundingPanel({ inv, onChange }: { inv: Inv; onChange: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['offers', inv.id] }); qc.invalidateQueries({ queryKey: ['frs'] }); onChange(); };
  const { run, Msg } = useAction(refresh);
  const [gates, setGates] = useState<{ n: number; name: string; ok: boolean; reason?: string }[] | null>(null);
  const [rate, setRate] = useState('');
  const canManage = me?.permissions.includes('discount:manage'), canConsent = me?.permissions.includes('financing:consent');
  const live = ['OpenForFunding', 'OffersReceived', 'Funded'].includes(inv.status);
  const cmp = useQuery({ queryKey: ['offers', inv.id], enabled: live, queryFn: async () => (await api.GET('/api/v1/invoices/{id}/offers', { params: { path: { id: inv.id } } })).data });
  const frs = useQuery({ queryKey: ['frs'], enabled: live, queryFn: async () => (await api.GET('/api/v1/financing-requests')).data?.items ?? [] });
  const fr = (frs.data ?? []).find((f) => f.invoiceId === inv.id && !['Cancelled', 'Declined'].includes(f.status));

  async function open() {
    const r = await api.POST('/api/v1/invoices/{id}/open-funding', { params: { path: { id: inv.id } } });
    if (r.data) { setGates(r.data.gates); if (r.data.opened) refresh(); else onChange(); } else await ensureOk(r);
  }
  const header = <h3>Funding</h3>;

  if (inv.status === 'Accepted' || inv.status === 'NotEligible') {
    return (
      <div className="panel">{header}
        <p>Open this invoice for funding to invite banks and let the buyer pay early.</p>
        {inv.status === 'NotEligible' && <p className="alert">Not eligible yet. Fix the items below and check again.</p>}
        {gates && <ul>{gates.map((g) => <li key={g.n}>{g.ok ? '✓' : '✗'} {g.name}{g.reason ? ` — ${g.reason}` : ''}</li>)}</ul>}
        {canManage && <button onClick={open}>{inv.status === 'NotEligible' ? 'Check again' : 'Request funding'}</button>}
        <Msg />
      </div>
    );
  }
  if (!live) return null;
  const d = cmp.data;
  const ep = d?.earlyPayment;
  return (
    <div className="panel">{header}
      <Msg />
      {inv.route === 'early_payment' && <p className="ok">Paid early by the buyer. Nothing more to do.</p>}
      {fr && (
        <div className="panel">
          <h4>Financing with {fr.bank.name} <span className={`chip ${fr.status}`}>{fr.status}</span></h4>
          {fr.status === 'ConsentPending' && <>
            <p>Net cash {money(fr.netCash, fr.currency)} (≈ {money(fr.netCashInr, 'INR')}) at {fr.allInPct}% a year. Please review and give your consent. You can cancel until the bank instructs payment.</p>
            {canConsent ? <button onClick={() => run(() => api.POST('/api/v1/financing-requests/{id}/consent', { params: { path: { id: fr.id } } }), 'Consent recorded. The bank will now confirm.')}>Review and consent</button> : <p className="hint">An approver in your organisation must give consent.</p>}
          </>}
          {fr.consentText && <p className="hint">{fr.consentText}</p>}
          {fr.status === 'BankConfirming' && <p className="hint">Waiting for the bank to confirm{fr.assignmentAcknowledged ? '' : ' and for the buyer to acknowledge the assignment notice'}.</p>}
          {fr.status === 'Funded' && <p className="ok">Funded. Disbursement reference {fr.disbursementRef}.</p>}
          {['ConsentPending', 'BankConfirming', 'Approved'].includes(fr.status) && canManage &&
            <button className="secondary" onClick={() => run(() => api.POST('/api/v1/financing-requests/{id}/cancel', { params: { path: { id: fr.id } }, body: {} }), 'Financing cancelled.')}>Cancel</button>}
        </div>
      )}
      {inv.route !== 'early_payment' && !fr && d && (
        <>
          <table>
            <thead><tr><th>Option</th><th className="num">All-in cost</th><th className="num">Net cash</th><th className="num">In INR</th><th>FX</th><th>Valid until</th><th /></tr></thead>
            <tbody>
              {d.offers.filter((o) => o.status === 'Submitted').map((o) => (
                <tr key={o.id}>
                  <td>{o.bank.name} <span className="chip">insured · non-recourse</span><div className="hint">Advance {o.advancePct}% · cover {o.coverPct}%</div></td>
                  <td className="num">{o.allInPct}%{o.savingVsBorrowingPct && <div className="hint">{o.savingVsBorrowingPct} pts below your borrowing rate</div>}</td>
                  <td className="num">{money(o.netCash, o.currency)}</td><td className="num">{money(o.netCashInr, 'INR')}</td><td>{o.fxRate}</td>
                  <td>{new Date(o.validUntil).toLocaleString()}</td>
                  <td>{canManage && <button onClick={() => run(() => api.POST('/api/v1/offers/{id}/select', { params: { path: { id: o.id } } }), 'Offer chosen. Please review and consent.')}>Choose</button>}</td>
                </tr>
              ))}
              {ep?.today && (
                <tr>
                  <td><strong>Early payment by the buyer</strong><div className="hint">Paid by the buyer on {String(ep.today.payDate)}; no bank, no insurance needed</div></td>
                  <td className="num">{String(ep.today.annualisedCostPct)}%</td><td className="num">{money(ep.today.buyerPays, inv.currency)}</td><td className="num">—</td><td>—</td><td>when the buyer confirms</td><td />
                </tr>
              )}
              {!d.offers.some((o) => o.status === 'Submitted') && !ep?.today && <tr><td colSpan={7} className="muted">No offers yet. Invited banks have been notified.</td></tr>}
            </tbody>
          </table>
          {d.offers.filter((o) => o.status === 'Submitted').slice(0, 1).map((o) => <details key={o.id}><summary>Explain this cost ({o.bank.name})</summary><Breakdown b={o.breakdown} ccy={o.currency} /></details>)}
          {ep && !ep.today && ep.reason && <p className="hint">{ep.reason}</p>}
          {canManage && (
            <details>
              <summary>Offer the buyer an early-payment discount</summary>
              <label>Annual rate you would accept (%)<input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
              <button className="secondary" onClick={() => run(() => api.PUT('/api/v1/invoices/{id}/discount-schedule', { params: { path: { id: inv.id } }, body: { mode: 'annual_rate', annualRatePct: Number(rate) } }), 'Discount schedule published to the buyer.')}>Publish</button>
              <p className="hint">The discount grows the earlier the buyer pays. Compare it with the bank offers above before publishing.</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Buyer: acknowledge the assignment notice and pay early (BUY-04, BUY-05). */
export function BuyerFundingPanel({ inv, onChange }: { inv: Inv; onChange: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notice', inv.id] }); onChange(); };
  const { run, Msg } = useAction(refresh);
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState<'cash' | 'bank_loan'>('cash');
  const [bank, setBank] = useState('');
  const [quote, setQuote] = useState<Record<string, any> | null>(null);
  const canConfirm = me?.permissions.includes('financing:consent'), canAck = me?.permissions.includes('invoice:accept');
  const notice = useQuery({ queryKey: ['notice', inv.id], retry: false, queryFn: async () => (await api.GET('/api/v1/invoices/{id}/assignment-notice', { params: { path: { id: inv.id } } })).data ?? null });
  const sched = useQuery({ queryKey: ['schedule', inv.id], retry: false, queryFn: async () => (await api.GET('/api/v1/invoices/{id}/discount-schedule', { params: { path: { id: inv.id } } })).data ?? null });
  const banks = useQuery({ queryKey: ['banks'], queryFn: async () => (await api.GET('/api/v1/org/preferred-banks')).data?.available ?? [] });
  if (!['OpenForFunding', 'OffersReceived', 'Funded'].includes(inv.status)) return null;
  async function getQuote() {
    const r = await api.POST('/api/v1/invoices/{id}/early-payment/quote', { params: { path: { id: inv.id } }, body: { payDate, fundingSource: source } });
    if (r.data) setQuote(r.data as Record<string, any>); else { setQuote(null); try { await ensureOk(r); } catch (e) { setQuote({ error: (e as Error).message }); } }
  }
  return (
    <div className="panel"><h3>Funding</h3><Msg />
      {inv.route === 'early_payment' && <p className="ok">You paid this invoice early.</p>}
      {notice.data && (
        <div className="panel"><h4>Assignment notice {notice.data.reference}</h4>
          <p>{notice.data.body}</p>
          {notice.data.usFiling && <p className="hint">US filing (simulated): {String(notice.data.usFiling.filingReference)} · state {String(notice.data.usFiling.state)}</p>}
          {notice.data.sgDataConsent && <p className="hint">Singapore data-handling consent recorded.</p>}
          {notice.data.acknowledged ? <p className="ok">You acknowledged this notice.</p> : canAck && <button onClick={() => run(() => api.POST('/api/v1/invoices/{id}/assignment-ack', { params: { path: { id: inv.id } } }), 'Assignment acknowledged.')}>Acknowledge</button>}
        </div>
      )}
      {sched.data && sched.data.status === 'published' && inv.route === null && (
        <div className="panel"><h4>Pay early and earn a discount</h4>
          <p className="hint">The supplier offers a discount for early payment: {sched.data.mode === 'annual_rate' ? `${sched.data.annualRatePct}% a year, pro rata` : (sched.data.entries ?? []).map((e) => `${e.discountPct}% by ${e.payBy}`).join(', ')}.</p>
          <div className="filters">
            <label>Pay on<input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></label>
            <label>Funded from<select value={source} onChange={(e) => setSource(e.target.value as 'cash' | 'bank_loan')}><option value="cash">Cash</option><option value="bank_loan">Bank loan</option></select></label>
            {source === 'bank_loan' && <label>Bank<select value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Choose…</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>}
            <button className="secondary" onClick={getQuote}>Calculate</button>
          </div>
          {quote?.error && <p className="alert">{String(quote.error)}</p>}
          {quote && !quote.error && (
            <table><tbody>
              <tr><td>You pay</td><td className="num">{money(quote.buyerPays, inv.currency)}</td></tr>
              <tr><td>Discount ({String(quote.discountPct)}%, {String(quote.daysEarly)} days early)</td><td className="num">{money(quote.discount, inv.currency)}</td></tr>
              <tr><td>Return on your cash (annualised)</td><td className="num">{String(quote.annualisedCostPct)}%</td></tr>
              <tr><td>Bank commission</td><td className="num">{money(quote.commission, inv.currency)}</td></tr>
              <tr><td><strong>Your net saving</strong></td><td className="num"><strong>{money(quote.buyerNetSaving, inv.currency)}</strong></td></tr>
            </tbody></table>
          )}
          {quote && !quote.error && canConfirm && <button onClick={() => run(() => api.POST('/api/v1/invoices/{id}/early-payment', { params: { path: { id: inv.id } }, body: { payDate, fundingSource: source, buyerBankOrgId: source === 'bank_loan' && bank ? bank : undefined } }), 'Paid early. The supplier has been notified.')}>Confirm early payment</button>}
        </div>
      )}
    </div>
  );
}

/** Bank: compose and send an offer, then confirm the financing (BNK-03, BNK-04). */
export function BankFundingPanel({ inv, onChange }: { inv: Inv; onChange: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['offers', inv.id] }); qc.invalidateQueries({ queryKey: ['frs'] }); qc.invalidateQueries({ queryKey: ['invitations'] }); onChange(); };
  const { run, Msg } = useAction(refresh);
  const [f, setF] = useState({ ratePct: '', advancePct: '', fxSpreadPct: '', validityHours: '' });
  const [prev, setPrev] = useState<{ eligible: boolean; reasons: string[]; quote: Record<string, any> | null } | null>(null);
  const can = me?.permissions.includes('offer:submit');
  const mine = useQuery({ queryKey: ['offers', inv.id], queryFn: async () => (await api.GET('/api/v1/invoices/{id}/offers', { params: { path: { id: inv.id } } })).data });
  const frs = useQuery({ queryKey: ['frs'], queryFn: async () => (await api.GET('/api/v1/financing-requests')).data?.items ?? [] });
  const fr = (frs.data ?? []).find((x) => x.invoiceId === inv.id && !['Cancelled', 'Declined'].includes(x.status));
  const body = () => ({ ratePct: f.ratePct ? Number(f.ratePct) : undefined, advancePct: f.advancePct ? Number(f.advancePct) : undefined, fxSpreadPct: f.fxSpreadPct ? Number(f.fxSpreadPct) : undefined, validityHours: f.validityHours ? Number(f.validityHours) : undefined });
  async function preview() {
    const r = await api.POST('/api/v1/invoices/{id}/offers/preview', { params: { path: { id: inv.id } }, body: body() });
    if (r.data) setPrev({ eligible: r.data.eligible, reasons: r.data.reasons, quote: r.data.quote as Record<string, any> | null });
    else try { await ensureOk(r); } catch (e) { setPrev({ eligible: false, reasons: [(e as Error).message], quote: null }); }
  }
  if (!['OpenForFunding', 'OffersReceived', 'Funded'].includes(inv.status)) return null;
  const q = prev?.quote;
  return (
    <div className="panel"><h3>Your offer</h3><Msg />
      {(mine.data?.offers ?? []).map((o) => <p key={o.id}><span className={`chip ${o.status}`}>{o.status}</span> {o.allInPct}% all-in · net cash {money(o.netCash, o.currency)} · valid until {new Date(o.validUntil).toLocaleString()}
        {['Drafted', 'Submitted'].includes(o.status) && can && <button className="link" onClick={() => run(() => api.POST('/api/v1/offers/{id}/withdraw', { params: { path: { id: o.id } } }), 'Offer withdrawn.')}>Withdraw</button>}</p>)}
      {fr && (
        <div className="panel"><h4>Financing request <span className={`chip ${fr.status}`}>{fr.status}</span></h4>
          {fr.status === 'BankConfirming' && can && <>
            <p className="hint">Confirming re-checks parties, cover, limits, the dispute window and the buyer’s acknowledgement.</p>
            <button onClick={() => run(() => api.POST('/api/v1/financing-requests/{id}/confirm', { params: { path: { id: fr.id } } }), 'Confirmed. Payment instructed; the lien is active.')}>Confirm and instruct payment</button>{' '}
            <button className="danger" onClick={() => { const reason = window.prompt('Reason for declining'); if (reason) run(() => api.POST('/api/v1/financing-requests/{id}/decline', { params: { path: { id: fr.id } }, body: { reason } }), 'Declined.'); }}>Decline</button>
          </>}
          {fr.status === 'ConsentPending' && <p className="hint">Waiting for the supplier’s consent.</p>}
          {fr.status === 'Funded' && <p className="ok">Funded · {fr.disbursementRef}</p>}
        </div>
      )}
      {can && !fr && inv.route === null && (
        <>
          <div className="filters">
            <label>Rate % p.a.<input inputMode="decimal" value={f.ratePct} onChange={(e) => setF({ ...f, ratePct: e.target.value })} placeholder="from terms" /></label>
            <label>Advance %<input inputMode="decimal" value={f.advancePct} onChange={(e) => setF({ ...f, advancePct: e.target.value })} placeholder="from terms" /></label>
            <label>FX spread %<input inputMode="decimal" value={f.fxSpreadPct} onChange={(e) => setF({ ...f, fxSpreadPct: e.target.value })} placeholder="from terms" /></label>
            <label>Valid for (hours)<input inputMode="numeric" value={f.validityHours} onChange={(e) => setF({ ...f, validityHours: e.target.value })} placeholder="from terms" /></label>
          </div>
          <button className="secondary" onClick={preview}>Price it</button>{' '}
          <button disabled={!prev?.eligible} onClick={() => run(() => api.POST('/api/v1/invoices/{id}/offers', { params: { path: { id: inv.id } }, body: { ...body(), submit: true, mode: 'manual' } }), 'Offer sent to the supplier.')}>Send offer</button>
          {prev && !prev.eligible && <ul className="alert">{prev.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
          {q && <><p><strong>{String(q.breakdown.allInAnnualisedPct)}%</strong> all-in · net cash {money(q.breakdown.netCash, inv.currency)} (≈ {money(q.fx.netCashInr, 'INR')} at {String(q.fx.rate)}) · cover {String(q.coverPct)}%</p><Breakdown b={q.breakdown} ccy={inv.currency} /></>}
        </>
      )}
    </div>
  );
}

export function BankInvitationsPage() {
  const q = useQuery({ queryKey: ['invitations'], queryFn: async () => (await api.GET('/api/v1/bank/invitations')).data?.items ?? [] });
  return (
    <section><h2>Funding invitations</h2>
      <table>
        <thead><tr><th>Invoice</th><th>Supplier</th><th>Buyer</th><th className="num">Amount</th><th>Due</th><th>Cover</th><th>Invoice</th><th>My offer</th></tr></thead>
        <tbody>
          {(q.data ?? []).map((i) => (
            <tr key={i.invoiceId}>
              <td><Link to={`/invoices/${i.invoiceId}`}>{i.invoiceNumber}</Link></td><td>{i.supplier}</td><td>{i.buyer} <span className="chip">{i.buyerTier}</span></td>
              <td className="num">{money(i.amount, i.currency)}</td><td>{i.dueDate}</td><td><span className={`chip ${i.coverStatus}`}>{i.coverStatus}{i.coverPct != null ? ` ${i.coverPct}%` : ''}</span></td>
              <td><span className={`chip ${i.invoiceStatus}`}>{i.invoiceStatus}</span></td><td>{i.myOffer ? <><span className={`chip ${i.myOffer.status}`}>{i.myOffer.status}</span> {i.myOffer.allInPct}%</> : <span className="muted">none</span>}</td>
            </tr>
          ))}
          {q.data?.length === 0 && <tr><td colSpan={8} className="muted">No invitations yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

export function AdminLiensPage() {
  const q = useQuery({ queryKey: ['liens'], queryFn: async () => (await api.GET('/api/v1/admin/liens')).data });
  return (
    <section><h2>Lien registry</h2>
      <table>
        <thead><tr><th>Invoice</th><th>Bank</th><th>Supplier</th><th>Status</th><th>Notice</th><th>Reserved</th><th>Released</th></tr></thead>
        <tbody>{(q.data?.liens ?? []).map((l) => <tr key={l.id}><td>{l.invoiceNumber}</td><td>{l.bank}</td><td>{l.supplier}</td><td><span className={`chip ${l.status}`}>{l.status}</span></td><td>{l.assignmentRef ?? ''}</td><td>{new Date(l.reservedAt).toLocaleString()}</td><td>{l.releasedAt ? `${new Date(l.releasedAt).toLocaleString()} (${l.releaseReason})` : ''}</td></tr>)}</tbody>
      </table>
      <h3>History</h3>
      <ul className="timeline">{(q.data?.events ?? []).map((e) => <li key={e.id}><strong>{e.event}</strong> · {e.invoiceNumber} · {new Date(e.at).toLocaleString()}{e.detail && <div className="hint">{e.detail}</div>}</li>)}</ul>
    </section>
  );
}
