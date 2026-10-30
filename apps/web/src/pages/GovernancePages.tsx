import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, DataTable, DescriptionList, SelectField, TextareaField, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { applyBrand } from '../branding';
import { show, type Change } from '../shared/diff';
import { Hint, Loading, Notice, Page, Panel, Section, StatusChip, TimelineList, dt, noRows, type Msg } from '../ui';

function useAct() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<Msg>(null);
  const act = async (fn: () => Promise<{ response: Response }>, ok: string) => {
    setMsg(null);
    try { await ensureOk(await fn()); setMsg({ ok: true, text: ok }); await qc.invalidateQueries(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return { act, banner: <Notice msg={msg} />, setMsg };
}

const KIND_TONE = { added: 'success', removed: 'danger', changed: 'warning' } as const;

export function DiffTable({ changes, empty = 'No differences.' }: { changes: Change[]; empty?: string }) {
  if (!changes.length) return <Hint>{empty}</Hint>;
  return (
    <DataTable aria-label="Changes" noun="changes" density="compact" rowKey={(c: Change) => c.path} rows={changes}
      columns={[
        { id: 'setting', header: 'Setting', rowHeader: true, cell: (c) => <><code>{c.path}</code> <Badge tone={KIND_TONE[c.kind]}>{c.kind}</Badge></> },
        { id: 'before', header: 'Before', cell: (c) => <code>{show(c.before)}</code> },
        { id: 'after', header: 'After', cell: (c) => <code>{show(c.after)}</code> },
      ]} />
  );
}

// ================================================================ approvals inbox (CT-6)
export function ApprovalsPage() {
  const { act, banner } = useAct();
  const [reason, setReason] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['approvals'], queryFn: async () => (await api.GET('/api/v1/approvals')).data?.items ?? [] });
  return (
    <>
      <Page title="Approvals" description="Nobody publishes their own changes: a second person reviews what changes, and only then does it take effect." />
      {banner}
      {q.isLoading && <Loading />}
      {(q.data ?? []).map((i) => (
        <Panel key={i.id} level={3} title={<>{i.title} <StatusChip status="pending">{i.kind === 'terms' ? 'terms' : 'platform setting'}</StatusChip></>}
          sub={<>Prepared by {i.maker ?? 'unknown'} on {dt(i.submittedAt)}{i.effectiveFrom && ` · takes effect ${dt(i.effectiveFrom)}`}{i.against ? ` · compared with version ${i.against}` : ''}{i.note && ` · “${i.note}”`}</>}>
          <DiffTable changes={i.changes as Change[]} empty="No differences from what is in force." />
          {i.reason && <Hint>{i.reason}</Hint>}
          <div className="toolbar-fields">
            <Button variant="primary" disabled={!i.canApprove} onClick={() => i.kind === 'terms'
              ? act(() => api.POST('/api/v1/terms/versions/{id}/approve', { params: { path: { id: i.id } } }), 'Published.')
              : act(() => api.POST('/api/v1/approvals/settings/{id}/decision', { params: { path: { id: i.id } }, body: { approve: true } }), 'Change applied.')}>Approve and publish</Button>
            <TextField label="Reason" placeholder="Reason (to send back)" value={reason[i.id] ?? ''} onChange={(e) => setReason({ ...reason, [i.id]: e.target.value })} />
            <Button disabled={(reason[i.id] ?? '').trim().length < 3} onClick={() => i.kind === 'terms'
              ? act(() => api.POST('/api/v1/terms/versions/{id}/reject', { params: { path: { id: i.id } }, body: { reason: reason[i.id]! } }), 'Sent back to the maker.')
              : act(() => api.POST('/api/v1/approvals/settings/{id}/decision', { params: { path: { id: i.id } }, body: { approve: false, note: reason[i.id] } }), 'Change rejected.')}>{i.kind === 'terms' ? 'Send back' : 'Reject'}</Button>
          </div>
        </Panel>
      ))}
      {q.data?.length === 0 && noRows('Nothing is waiting for your approval')}
    </>
  );
}

// ================================================================ guardrail console (ADM-07)
function SettingEditor({ s }: { s: any }) {
  const { act, banner } = useAct();
  const [v, setV] = useState<any>(s.value);
  const [note, setNote] = useState('');
  const num = (k: string) => <TextField key={k} label={k.replace(/([A-Z])/g, ' $1').toLowerCase()} type="number" min={0} step="any" value={v?.[k] ?? ''} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />;
  let input;
  if (s.key === 'dispute_timers') input = <div className="field-grid">{['responseHours', 'escalateAfterHours', 'timeoutAfterHours'].map(num)}</div>;
  else if (s.key === 'mode') input = <SelectField label="Mode" value={v} onChange={(e) => setV(e.target.value)}><option value="network">Network (every invited bank)</option><option value="white-label">White-label (partner bank only)</option></SelectField>;
  else if (s.key === 'governing_law') input = <TextareaField label={s.label} value={v} onChange={(e) => setV(e.target.value)} />;
  else if (Array.isArray(s.value)) input = <TextField label="Values (comma separated)" value={Array.isArray(v) ? v.join(', ') : ''} onChange={(e) => setV(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (s.key === 'dunning_days' ? Number(x) : x)))} />;
  else input = <TextField label="Value" type="number" step="any" value={v} onChange={(e) => setV(Number(e.target.value))} />;
  return (
    <Panel level={3} title={s.label} sub={s.help}>
      {banner}
      {s.pending && <Alert tone="warning" title="Waiting for another administrator">{s.pending.proposer ?? 'someone'} proposed <code>{JSON.stringify(s.pending.value)}</code> on {dt(s.pending.at)}.</Alert>}
      {input}
      <div className="toolbar-fields">
        <TextField label="Reason for the change" placeholder="Why?" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="primary" disabled={JSON.stringify(v) === JSON.stringify(s.value)} onClick={() => act(() => api.PUT('/api/v1/admin/settings/{key}', { params: { path: { key: s.key } }, body: { value: v, note: note || undefined } }), 'Proposed. A different administrator must approve it before it takes effect.')}>Propose change</Button>
      </div>
      {s.history.length > 0 && (
        <details>
          <summary>Recent changes</summary>
          <TimelineList aria-label={`Recent changes to ${s.label}`}
            events={s.history.map((h: any) => ({ id: String(h.id), tone: h.status === 'applied' ? 'success' : undefined, at: h.at,
              title: <>{h.status}: {JSON.stringify(h.before)} → {JSON.stringify(h.after)}</>, meta: <>{h.proposer ?? '?'}{h.decider && ` / ${h.decider}`}</> }))} />
        </details>
      )}
    </Panel>
  );
}

export function GuardrailConsolePage() {
  const { banner, act } = useAct();
  const g = useQuery({ queryKey: ['guardrails'], queryFn: async () => (await api.GET('/api/v1/admin/guardrails')).data });
  const s = useQuery({ queryKey: ['settings'], queryFn: async () => (await api.GET('/api/v1/admin/settings')).data?.items ?? [] });
  const banks = useQuery({ queryKey: ['admin-banks'], queryFn: async () => (await api.GET('/api/v1/admin/banks')).data?.items ?? [] });
  const [hosts, setHosts] = useState<Record<string, string>>({});
  return (
    <>
      <Page title="Platform defaults and guardrails" />
      {banner}
      <Panel title="Hard guardrails" sub="These are part of the platform itself. No one — a bank, an insurer or Earlio staff — can loosen them through a setting.">
        <DescriptionList columns={1} layout="inline" items={(g.data?.guardrails ?? []).map((x) => ({ label: x.label, value: String(x.value), num: true }))} />
        {g.data?.platformSetId && <p>Fees, the benchmark rate and platform defaults are edited as versioned terms: <Link to={`/terms/${g.data.platformSetId}`}>open the platform terms</Link>. Every change passes maker-checker.</p>}
      </Panel>
      <h2 className="bv-heading-s">Operating settings</h2>
      {(s.data ?? []).map((x) => <SettingEditor key={x.key + JSON.stringify(x.value) + (x.pending?.id ?? '')} s={x} />)}
      <Panel title="Bank hostnames" sub="A hostname decides whose branding a visitor sees (for local development use bank1.localtest.me). Only Earlio can change it.">
        <DataTable aria-label="Bank hostnames" noun="banks" rowKey={(b) => b.id} rows={banks.data ?? []} empty={noRows('No banks yet')}
          columns={[
            { id: 'bank', header: 'Bank', rowHeader: true, cell: (b) => <>{b.name}{b.isPartner && <> <Badge tone="success">partner</Badge></>}</> },
            { id: 'brand', header: 'Branding', cell: (b) => <><span className="swatch" style={{ background: b.primary }} /> {b.displayName}</> },
            { id: 'host', header: 'Hostname', cell: (b) => <TextField label={`Hostname for ${b.name}`} value={hosts[b.id] ?? b.hostname ?? ''} onChange={(e) => setHosts({ ...hosts, [b.id]: e.target.value })} /> },
            { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (b) => <Button size="sm" onClick={() => act(() => api.PUT('/api/v1/admin/banks/{id}/hostname', { params: { path: { id: b.id } }, body: { hostname: (hosts[b.id] ?? b.hostname ?? '').trim() || null } }), 'Hostname saved.')}>Save</Button> },
          ]} />
      </Panel>
    </>
  );
}

// ================================================================ bank admin console (WL-1)
const MAX_LOGO = 150_000;
export function BankConsolePage() {
  const { me } = useAuth();
  const { act, banner, setMsg } = useAct();
  const b = useQuery({ queryKey: ['bank-branding'], queryFn: async () => (await api.GET('/api/v1/bank/branding')).data });
  const sets = useQuery({ queryKey: ['terms-sets'], queryFn: async () => (await api.GET('/api/v1/terms/sets')).data?.items ?? [] });
  const [f, setF] = useState<{ displayName: string; primary: string; accent: string; logo: string | null; welcome: string } | null>(null);
  const cur = f ?? (b.data ? { displayName: b.data.displayName, primary: b.data.primary, accent: b.data.accent, logo: b.data.logo, welcome: b.data.welcome ?? '' } : null);
  if (!cur) return <Loading />;
  const canEdit = me?.permissions.includes('org:settings');
  const def = (sets.data ?? []).find((s) => Object.keys(s.scope).length === 0);
  const fee = def?.activeVersion?.body as any;
  const set = (k: keyof typeof cur) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF({ ...cur, [k]: e.target.value }); if (k === 'primary' || k === 'accent') applyBrand({ displayName: cur.displayName, primary: k === 'primary' ? e.target.value : cur.primary, accent: k === 'accent' ? e.target.value : cur.accent }); };
  return (
    <>
      <Page title="Bank console" />
      {banner}
      <div className="split">
        <Panel title="Branding" sub={<>Shown to your suppliers and buyers when they arrive at <strong>{b.data?.hostname ?? 'your hostname (ask Earlio to set one)'}</strong>.</>}>
          <TextField label="Display name" value={cur.displayName} onChange={set('displayName')} disabled={!canEdit} />
          <div className="field-grid">
            <TextField label="Primary colour" type="color" value={cur.primary} onChange={set('primary')} disabled={!canEdit} />
            <TextField label="Accent colour" type="color" value={cur.accent} onChange={set('accent')} disabled={!canEdit} />
          </div>
          <TextField label="Logo (PNG, JPEG or SVG, up to 150 KB)" type="file" accept="image/png,image/jpeg,image/svg+xml" disabled={!canEdit} onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            if (file.size > MAX_LOGO) return setMsg({ ok: false, text: 'That logo is larger than 150 KB.' });
            const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
            setF({ ...cur, logo: url });
          }} />
          {cur.logo && <div className="row-actions"><img src={cur.logo} alt="Logo preview" height={40} /> <Button size="sm" variant="ghost" onClick={() => setF({ ...cur, logo: null })}>Remove</Button></div>}
          <TextareaField label="Welcome text" value={cur.welcome} onChange={set('welcome')} disabled={!canEdit} maxLength={400} />
          <div><Button variant="primary" disabled={!canEdit} onClick={() => act(() => api.PUT('/api/v1/bank/branding', { body: { displayName: cur.displayName, primary: cur.primary, accent: cur.accent, logo: cur.logo, welcome: cur.welcome || null } }), 'Branding saved.')}>Save branding</Button></div>
          <Hint>White text must stay readable on your primary colour (contrast at least 4.5 : 1); the server rejects colours that fail.</Hint>
        </Panel>
        <Panel title="Preview">
          <div className="brand-preview">
            <div className="brand-preview__bar">
              {cur.logo && <img src={cur.logo} alt="" height={26} />}<strong style={{ color: cur.primary }}>{cur.displayName}</strong>
            </div>
            <div className="brand-preview__body">
              <p>{cur.welcome || 'Welcome text appears here.'}</p>
              <span className="brand-preview__button" style={{ background: cur.primary }}>Sign in</span>{' '}
              <span style={{ borderBottom: `3px solid ${cur.accent}` }}>Accent</span>
            </div>
          </div>
        </Panel>
      </div>
      <Panel title="Your fees, rates and limits">
        {fee ? (
          <DescriptionList columns={1} layout="inline" items={[
            { label: 'Advance', value: `${fee.advancePct}%`, num: true },
            { label: 'Pricing', value: fee.pricing?.type === 'fixed' ? `${fee.pricing.ratePct}% fixed` : 'benchmark + margin by buyer rating', num: true },
            { label: 'Processing fee', value: `${fee.processingFee?.pct}% (minimum USD ${fee.processingFee?.minUsd})`, num: true },
            { label: 'FX margin', value: `${fee.fxSpreadPct}%`, num: true },
            { label: 'Invoice size', value: `USD ${fee.invoiceSizeUsd?.min?.toLocaleString('en-US')} – ${fee.invoiceSizeUsd?.max?.toLocaleString('en-US')}`, num: true },
          ]} />
        ) : <Loading label="Loading terms…" />}
        <p>{def && <Link to={`/terms/${def.id}`}>Edit these in the terms studio</Link>} · <Link to="/limits">Exposure limits per buyer and supplier</Link> · <Link to="/approvals">Approvals inbox</Link></p>
      </Panel>
    </>
  );
}

// ================================================================ requirements on the supplier's consent form (CT-10)
export function RequirementsBox({ frId, invoiceId, answers, setAnswers, onChange }: { frId: string; invoiceId: string; answers: Record<string, string>; setAnswers: (a: Record<string, string>) => void; onChange: () => void }) {
  const { act, banner, setMsg } = useAct();
  const q = useQuery({ queryKey: ['requirements', frId], queryFn: async () => (await api.GET('/api/v1/financing-requests/{id}/requirements', { params: { path: { id: frId } } })).data });
  const r = q.data;
  if (!r || (!r.customFields.length && !r.requiredDocuments.length)) return null;
  async function attach(docType: string, file: File) {
    try {
      const fileId = await uploadFile(file);
      await act(() => api.POST('/api/v1/invoices/{id}/documents', { params: { path: { id: invoiceId } }, body: { docType: docType as 'packing_list', fileId } }), 'Document added.');
      onChange();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  return (
    <Section title="What this bank asks for" level={4}>
      {banner}
      {r.requiredDocuments.map((d) => (
        r.missingDocuments.includes(d)
          ? <TextField key={d} label={`Attach ${d.replace(/_/g, ' ')}`} type="file" help="missing" onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(d, f); }} />
          : <p key={d}>{d.replace(/_/g, ' ')}: <Badge tone="success">attached</Badge></p>
      ))}
      <div className="field-grid">
        {r.customFields.map((f) => (
          f.type === 'select'
            ? <SelectField key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}><option value="">—</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</SelectField>
            : <TextField key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step="any" value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />
        ))}
      </div>
    </Section>
  );
}
