import { RequirementsBox } from './GovernancePages';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Accordion, Alert, Badge, Button, DataTable, DatePicker, DescriptionList, SelectField, Tag, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, Hint, Notice, Page, Panel, Section, StatusChip, TimelineList, dd, dt, noRows, type Msg } from '../ui';

type Inv = { id: string; humanId: string; status: string; route: string | null; currency: string; dueDate: string };

function useAction(onDone: () => void) {
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (fn: () => Promise<{ response: Response }>, okText: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ ok: true, text: okText }); onDone(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return { msg, run, banner: <Notice msg={msg} /> };
}

/** Plain-language cost breakdown that backs the "Explain this cost" panel. */
function Breakdown({ b, ccy }: { b: Record<string, any>; ccy: string }) {
  const { t } = useTranslation();
  const rows: [string, string][] = [[t('Advance'), b.advance], [t('Bank discount (interest)'), b.discount], [t('Processing fee'), b.processingFee], [t('Platform fee (if passed on)'), b.platformFeeSupplier ?? b.platformFee], [t('Insurance premium (if passed on)'), b.premiumSupplier ?? b.premium]];
  return (
    <DescriptionList columns={1} layout="inline" items={[
      ...rows.filter(([, v]) => v !== undefined).map(([k, v]) => ({ label: k, value: <Amt v={v} c={ccy} />, num: true })),
      { label: <strong>{t('Total charges')}</strong>, value: <Amt v={b.totalCharges} c={ccy} strong />, num: true },
      { label: <strong>{t('Net cash')}</strong>, value: <Amt v={b.netCash} c={ccy} strong />, num: true },
      { label: t('Retention (released at maturity)'), value: <Amt v={b.retention} c={ccy} />, num: true },
    ]} />
  );
}

/** Supplier: request funding, compare offers with early payment, choose, consent (SUP-05 to SUP-07). */
export function SupplierFundingPanel({ inv, onChange }: { inv: Inv; onChange: () => void }) {
  const { me } = useAuth();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['offers', inv.id] }); qc.invalidateQueries({ queryKey: ['frs'] }); onChange(); };
  const { run, banner } = useAction(refresh);
  const [gates, setGates] = useState<{ n: number; name: string; ok: boolean; reason?: string }[] | null>(null);
  const [rate, setRate] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const canManage = me?.permissions.includes('discount:manage'), canConsent = me?.permissions.includes('financing:consent');
  const live = ['OpenForFunding', 'OffersReceived', 'Funded'].includes(inv.status);
  const cmp = useQuery({ queryKey: ['offers', inv.id], enabled: live, queryFn: async () => (await api.GET('/api/v1/invoices/{id}/offers', { params: { path: { id: inv.id } } })).data });
  const frs = useQuery({ queryKey: ['frs'], enabled: live, queryFn: async () => (await api.GET('/api/v1/financing-requests')).data?.items ?? [] });
  const fr = (frs.data ?? []).find((f) => f.invoiceId === inv.id && !['Cancelled', 'Declined'].includes(f.status));

  async function open() {
    const r = await api.POST('/api/v1/invoices/{id}/open-funding', { params: { path: { id: inv.id } } });
    if (r.data) { setGates(r.data.gates); if (r.data.opened) refresh(); else onChange(); } else await ensureOk(r);
  }

  if (inv.status === 'Accepted' || inv.status === 'NotEligible') {
    return (
      <Panel title="Funding">
        <p>Open this invoice for funding to invite banks and let the buyer pay early.</p>
        {inv.status === 'NotEligible' && <Alert tone="warning" title="Not eligible yet">Fix the items below and check again.</Alert>}
        {gates && (
          <ul className="stack-3">{gates.map((g) => (
            <li key={g.n}><Badge tone={g.ok ? 'success' : 'danger'} icon={g.ok ? 'circle-check' : 'circle-alert'}>{g.ok ? 'Passed' : 'Not met'}</Badge> {g.name}{g.reason ? ` — ${g.reason}` : ''}</li>
          ))}</ul>
        )}
        {canManage && <div><Button variant="primary" onClick={open}>{inv.status === 'NotEligible' ? t('Check again') : t('Request funding')}</Button></div>}
        {banner}
      </Panel>
    );
  }
  if (!live) return null;
  const d = cmp.data;
  const ep = d?.earlyPayment;
  const submitted = d?.offers.filter((o) => o.status === 'Submitted') ?? [];
  return (
    <Panel title="Funding">
      {banner}
      {inv.route === 'early_payment' && <Alert tone="success" title={t('Paid early by the buyer. Nothing more to do.')} />}
      {fr && (
        <Section title={<>Financing with {fr.bank.name} <StatusChip status={fr.status} /></>}>
          {fr.status === 'ConsentPending' && <>
            <p>{t('Net cash {{net}} (≈ {{inr}}) at {{pct}}% a year. Please review and give your consent. You can cancel until the bank instructs payment.', { net: <Amt v={fr.netCash} c={fr.currency} /> as any, inr: <Amt v={fr.netCashInr} c="INR" /> as any, pct: fr.allInPct })}</p>
            <RequirementsBox frId={fr.id} invoiceId={inv.id} answers={answers} setAnswers={setAnswers} onChange={refresh} />
            {canConsent ? <div><Button variant="primary" onClick={() => run(() => api.POST('/api/v1/financing-requests/{id}/consent', { params: { path: { id: fr.id } }, body: { extra: answers } }), t('Consent recorded. The bank will now confirm.'))}>{t('Review and consent')}</Button></div> : <Hint>{t('An approver in your organisation must give consent.')}</Hint>}
          </>}
          {fr.consentText && <Hint>{fr.consentText}</Hint>}
          {fr.status === 'BankConfirming' && <Hint>Waiting for the bank to confirm{fr.assignmentAcknowledged ? '' : ' and for the buyer to acknowledge the assignment notice'}.</Hint>}
          {fr.status === 'Funded' && <Alert tone="success" title={t('Funded. Disbursement reference {{ref}}.', { ref: fr.disbursementRef })} />}
          {['ConsentPending', 'BankConfirming', 'Approved'].includes(fr.status) && canManage &&
            <div><Button onClick={() => run(() => api.POST('/api/v1/financing-requests/{id}/cancel', { params: { path: { id: fr.id } }, body: {} }), t('Financing cancelled.'))}>{t('Cancel')}</Button></div>}
        </Section>
      )}
      {inv.route !== 'early_payment' && !fr && d && (
        <>
          <DataTable aria-label={t('Funding options')} noun="options" rowKey={(r: { key: string }) => r.key}
            rows={[...submitted.map((o) => ({ key: o.id, o, ep: false as const })), ...(ep?.today ? [{ key: 'early', o: null, ep: true as const }] : [])] as { key: string; o: (typeof submitted)[number] | null; ep: boolean }[]}
            empty={noRows('No offers yet', 'Invited banks have been notified.')}
            columns={[
              { id: 'option', header: t('Option'), rowHeader: true, cell: (r) => r.o
                ? <><strong>{r.o.bank.name}</strong> <Tag>{t('insured · non-recourse')}</Tag><div className="hint">Advance {r.o.advancePct}% · cover {r.o.coverPct}%</div></>
                : <><strong>{t('Early payment by the buyer')}</strong><div className="hint">Paid by the buyer on {dd(String(ep!.today!.payDate))}; no bank, no insurance needed</div></> },
              { id: 'cost', header: t('All-in cost'), numeric: true, cell: (r) => r.o ? <>{r.o.allInPct}%{r.o.savingVsBorrowingPct && <div className="hint">{r.o.savingVsBorrowingPct} pts below your borrowing rate</div>}</> : `${String(ep!.today!.annualisedCostPct)}%` },
              { id: 'net', header: t('Net cash'), numeric: true, cell: (r) => r.o ? <Amt v={r.o.netCash} c={r.o.currency} /> : <Amt v={String(ep!.today!.buyerPays)} c={inv.currency} /> },
              { id: 'inr', header: t('In INR'), numeric: true, cell: (r) => (r.o ? <Amt v={r.o.netCashInr} c="INR" /> : '—') },
              { id: 'fx', header: t('FX'), cell: (r) => (r.o ? r.o.fxRate : '—') },
              { id: 'valid', header: t('Valid until'), cell: (r) => (r.o ? dt(r.o.validUntil) : 'when the buyer confirms') },
              { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (r) => r.o && canManage ? <Button size="sm" variant="primary" onClick={() => run(() => api.POST('/api/v1/offers/{id}/select', { params: { path: { id: r.o!.id } } }), t('Offer chosen. Please review and consent.'))}>{t('Choose')}</Button> : null },
            ]} />
          <Accordion type="multiple" headingLevel={4} items={[
            ...(submitted[0] ? [{ id: 'explain', title: `Explain this cost (${submitted[0].bank.name})`, children: <Breakdown b={submitted[0].breakdown} ccy={submitted[0].currency} /> }] : []),
            ...(canManage ? [{ id: 'discount', title: 'Offer the buyer an early-payment discount', children: (
              <div className="stack-3">
                <TextField label="Annual rate you would accept (%)" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} help="The discount grows the earlier the buyer pays. Compare it with the bank offers above before publishing." />
                <div><Button onClick={() => run(() => api.PUT('/api/v1/invoices/{id}/discount-schedule', { params: { path: { id: inv.id } }, body: { mode: 'annual_rate', annualRatePct: Number(rate) } }), 'Discount schedule published to the buyer.')}>Publish</Button></div>
              </div>) }] : []),
          ]} />
          {ep && !ep.today && ep.reason && <Hint>{ep.reason}</Hint>}
        </>
      )}
    </Panel>
  );
}

/** Buyer: acknowledge the assignment notice and pay early (BUY-04, BUY-05). */
export function BuyerFundingPanel({ inv, onChange }: { inv: Inv; onChange: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['notice', inv.id] }); onChange(); };
  const { run, banner } = useAction(refresh);
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
    <Panel title="Funding">
      {banner}
      {inv.route === 'early_payment' && <Alert tone="success" title="You paid this invoice early." />}
      {notice.data && (
        <Section title={`Assignment notice ${notice.data.reference}`}>
          <p>{notice.data.body}</p>
          {notice.data.usFiling && <Hint>US filing (simulated): {String(notice.data.usFiling.filingReference)} · state {String(notice.data.usFiling.state)}</Hint>}
          {notice.data.sgDataConsent && <Hint>Singapore data-handling consent recorded.</Hint>}
          {notice.data.acknowledged ? <Alert tone="success" title="You acknowledged this notice." /> : canAck && <div><Button variant="primary" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/assignment-ack', { params: { path: { id: inv.id } } }), 'Assignment acknowledged.')}>Acknowledge</Button></div>}
        </Section>
      )}
      {sched.data && sched.data.status === 'published' && inv.route === null && (
        <Section title="Pay early and earn a discount">
          <Hint>The supplier offers a discount for early payment: {sched.data.mode === 'annual_rate' ? `${sched.data.annualRatePct}% a year, pro rata` : (sched.data.entries ?? []).map((e) => `${e.discountPct}% by ${dd(e.payBy)}`).join(', ')}.</Hint>
          <div className="toolbar-fields">
            <DatePicker label="Pay on" value={payDate} onChange={(v) => setPayDate(v ?? '')} />
            <SelectField label="Funded from" value={source} onChange={(e) => setSource(e.target.value as 'cash' | 'bank_loan')}><option value="cash">Cash</option><option value="bank_loan">Bank loan</option></SelectField>
            {source === 'bank_loan' && <SelectField label="Bank" value={bank} onChange={(e) => setBank(e.target.value)}><option value="">Choose…</option>{(banks.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</SelectField>}
            <Button onClick={getQuote}>Calculate</Button>
          </div>
          {quote?.error && <Alert tone="danger" title={String(quote.error)} />}
          {quote && !quote.error && (
            <DescriptionList columns={1} layout="inline" items={[
              { label: 'You pay', value: <Amt v={quote.buyerPays} c={inv.currency} />, num: true },
              { label: `Discount (${String(quote.discountPct)}%, ${String(quote.daysEarly)} days early)`, value: <Amt v={quote.discount} c={inv.currency} />, num: true },
              { label: 'Return on your cash (annualised)', value: `${String(quote.annualisedCostPct)}%`, num: true },
              { label: 'Bank commission', value: <Amt v={quote.commission} c={inv.currency} />, num: true },
              { label: <strong>Your net saving</strong>, value: <Amt v={quote.buyerNetSaving} c={inv.currency} strong />, num: true },
            ]} />
          )}
          {quote && !quote.error && canConfirm && <div><Button variant="primary" onClick={() => run(() => api.POST('/api/v1/invoices/{id}/early-payment', { params: { path: { id: inv.id } }, body: { payDate, fundingSource: source, buyerBankOrgId: source === 'bank_loan' && bank ? bank : undefined } }), 'Paid early. The supplier has been notified.')}>Confirm early payment</Button></div>}
        </Section>
      )}
    </Panel>
  );
}

/** Bank: compose and send an offer, then confirm the financing (BNK-03, BNK-04). */
export function BankFundingPanel({ inv, onChange }: { inv: Inv; onChange: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['offers', inv.id] }); qc.invalidateQueries({ queryKey: ['frs'] }); qc.invalidateQueries({ queryKey: ['invitations'] }); onChange(); };
  const { run, banner } = useAction(refresh);
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
  const num = (k: keyof typeof f, label: string) => <TextField label={label} inputMode="decimal" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder="from terms" />;
  return (
    <Panel title="Your offer">
      {banner}
      {(mine.data?.offers ?? []).length > 0 && (
        <DataTable aria-label="Your offers" noun="offers" rowKey={(o) => o.id} rows={mine.data?.offers ?? []}
          columns={[
            { id: 'status', header: 'Status', cell: (o) => <StatusChip status={o.status} /> },
            { id: 'cost', header: 'All-in', numeric: true, cell: (o) => `${o.allInPct}%` },
            { id: 'net', header: 'Net cash', numeric: true, cell: (o) => <Amt v={o.netCash} c={o.currency} /> },
            { id: 'valid', header: 'Valid until', cell: (o) => dt(o.validUntil) },
            { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (o) => ['Drafted', 'Submitted'].includes(o.status) && can ? <Button size="sm" variant="ghost" onClick={() => run(() => api.POST('/api/v1/offers/{id}/withdraw', { params: { path: { id: o.id } } }), 'Offer withdrawn.')}>Withdraw</Button> : null },
          ]} />
      )}
      {fr && (
        <Section title={<>Financing request <StatusChip status={fr.status} /></>}>
          {fr.status === 'BankConfirming' && can && <>
            <Hint>Confirming re-checks parties, cover, limits, the dispute window and the buyer’s acknowledgement.</Hint>
            <div className="row-actions">
              <Button variant="primary" onClick={() => run(() => api.POST('/api/v1/financing-requests/{id}/confirm', { params: { path: { id: fr.id } } }), 'Confirmed. Payment instructed; the lien is active.')}>Confirm and instruct payment</Button>
              <Button variant="ghost" onClick={() => { const reason = window.prompt('Reason for declining'); if (reason) run(() => api.POST('/api/v1/financing-requests/{id}/decline', { params: { path: { id: fr.id } }, body: { reason } }), 'Declined.'); }}>Decline</Button>
            </div>
          </>}
          {fr.status === 'ConsentPending' && <Hint>Waiting for the supplier’s consent.</Hint>}
          {fr.status === 'Funded' && <Alert tone="success" title={`Funded · ${fr.disbursementRef}`} />}
        </Section>
      )}
      {can && !fr && inv.route === null && (
        <>
          <div className="field-grid">
            {num('ratePct', 'Rate % p.a.')}{num('advancePct', 'Advance %')}{num('fxSpreadPct', 'FX spread %')}
            <TextField label="Valid for (hours)" inputMode="numeric" value={f.validityHours} onChange={(e) => setF({ ...f, validityHours: e.target.value })} placeholder="from terms" />
          </div>
          <div className="row-actions">
            <Button onClick={preview}>Price it</Button>
            <Button variant="primary" disabled={!prev?.eligible} onClick={() => run(() => api.POST('/api/v1/invoices/{id}/offers', { params: { path: { id: inv.id } }, body: { ...body(), submit: true, mode: 'manual' } }), 'Offer sent to the supplier.')}>Send offer</Button>
          </div>
          {prev && !prev.eligible && <Alert tone="warning" title="This offer cannot be sent"><ul>{prev.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Alert>}
          {q && <>
            <p><strong>{String(q.breakdown.allInAnnualisedPct)}%</strong> all-in · net cash <Amt v={q.breakdown.netCash} c={inv.currency} /> (≈ <Amt v={q.fx.netCashInr} c="INR" /> at {String(q.fx.rate)}) · cover {String(q.coverPct)}%</p>
            <Breakdown b={q.breakdown} ccy={inv.currency} />
          </>}
        </>
      )}
    </Panel>
  );
}

export function BankInvitationsPage() {
  const q = useQuery({ queryKey: ['invitations'], queryFn: async () => (await api.GET('/api/v1/bank/invitations')).data?.items ?? [] });
  return (
    <>
      <Page title="Funding invitations" description="Invoices you were invited to price, or have already priced." />
      <DataTable aria-label="Funding invitations" noun="invitations" loading={q.isLoading} rowKey={(i) => i.invoiceId} rows={q.data ?? []} empty={noRows('No invitations yet')}
        columns={[
          { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (i) => <Link to={`/invoices/${i.invoiceId}`}>{i.invoiceNumber}</Link> },
          { id: 'supplier', header: 'Supplier', cell: (i) => i.supplier },
          { id: 'buyer', header: 'Buyer', cell: (i) => <>{i.buyer} <Tag>{i.buyerTier}</Tag></> },
          { id: 'amount', header: 'Amount', numeric: true, cell: (i) => <Amt v={i.amount} c={i.currency} /> },
          { id: 'due', header: 'Due', cell: (i) => dd(i.dueDate) },
          { id: 'cover', header: 'Cover', cell: (i) => <StatusChip status={i.coverStatus}>{i.coverStatus}{i.coverPct != null ? ` ${i.coverPct}%` : ''}</StatusChip> },
          { id: 'status', header: 'Invoice status', cell: (i) => <StatusChip status={i.invoiceStatus} /> },
          { id: 'offer', header: 'My offer', cell: (i) => i.myOffer ? <><StatusChip status={i.myOffer.status} /> {i.myOffer.allInPct}%</> : <span className="hint">none</span> },
        ]} />
    </>
  );
}

export function AdminLiensPage() {
  const q = useQuery({ queryKey: ['liens'], queryFn: async () => (await api.GET('/api/v1/admin/liens')).data });
  return (
    <>
      <Page title="Lien registry" description="One invoice, one financing. A second financing request on the same invoice is refused and recorded here." />
      <DataTable aria-label="Liens" noun="liens" loading={q.isLoading} rowKey={(l) => l.id} rows={q.data?.liens ?? []} empty={noRows('No liens yet')}
        columns={[
          { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (l) => l.invoiceNumber },
          { id: 'bank', header: 'Bank', cell: (l) => l.bank },
          { id: 'supplier', header: 'Supplier', cell: (l) => l.supplier },
          { id: 'status', header: 'Status', cell: (l) => <StatusChip status={l.status} /> },
          { id: 'notice', header: 'Notice', cell: (l) => <span className="mono">{l.assignmentRef ?? ''}</span> },
          { id: 'reserved', header: 'Reserved', cell: (l) => dt(l.reservedAt) },
          { id: 'released', header: 'Released', cell: (l) => (l.releasedAt ? `${dt(l.releasedAt)} (${l.releaseReason})` : '') },
        ]} />
      <Panel title="History">
        <TimelineList aria-label="Lien history" events={(q.data?.events ?? []).map((e) => ({ id: String(e.id), title: `${e.event} · ${e.invoiceNumber}`, meta: e.detail, at: e.at }))} />
        {q.data?.events.length === 0 && <Hint>No history yet.</Hint>}
      </Panel>
    </>
  );
}
