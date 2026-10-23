import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { applyBrand } from '../branding';
import { show, type Change } from '../shared/diff';

const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');

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

export function DiffTable({ changes, empty = 'No differences.' }: { changes: Change[]; empty?: string }) {
  if (!changes.length) return <p className="hint">{empty}</p>;
  return (
    <table className="diff">
      <thead><tr><th>Setting</th><th>Before</th><th>After</th></tr></thead>
      <tbody>{changes.map((c) => <tr key={c.path} className={c.kind}><td><code>{c.path}</code></td><td><code>{show(c.before)}</code></td><td><code>{show(c.after)}</code></td></tr>)}</tbody>
    </table>
  );
}

// ================================================================ approvals inbox (CT-6)
export function ApprovalsPage() {
  const { act, banner } = useAct();
  const [reason, setReason] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['approvals'], queryFn: async () => (await api.GET('/api/v1/approvals')).data?.items ?? [] });
  return (
    <section>
      <h2>Approvals</h2>
      <p className="hint">Nobody publishes their own changes: a second person reviews what changes, and only then does it take effect.</p>
      {banner}
      {(q.data ?? []).map((i) => (
        <div className="panel" key={i.id}>
          <h3>{i.title} <span className="chip pending">{i.kind === 'terms' ? 'terms' : 'platform setting'}</span></h3>
          <p className="hint">Prepared by {i.maker ?? 'unknown'} on {when(i.submittedAt)}{i.effectiveFrom && ` · takes effect ${when(i.effectiveFrom)}`}{i.against ? ` · compared with version ${i.against}` : ''}{i.note && ` · “${i.note}”`}</p>
          <DiffTable changes={i.changes as Change[]} empty="No differences from what is in force." />
          {i.reason && <p className="hint">{i.reason}</p>}
          <p className="filters">
            <button disabled={!i.canApprove} onClick={() => i.kind === 'terms'
              ? act(() => api.POST('/api/v1/terms/versions/{id}/approve', { params: { path: { id: i.id } } }), 'Published.')
              : act(() => api.POST('/api/v1/approvals/settings/{id}/decision', { params: { path: { id: i.id } }, body: { approve: true } }), 'Change applied.')}>Approve and publish</button>
            <input aria-label="Reason" placeholder="Reason (to send back)" value={reason[i.id] ?? ''} onChange={(e) => setReason({ ...reason, [i.id]: e.target.value })} />
            <button className="secondary" disabled={(reason[i.id] ?? '').trim().length < 3} onClick={() => i.kind === 'terms'
              ? act(() => api.POST('/api/v1/terms/versions/{id}/reject', { params: { path: { id: i.id } }, body: { reason: reason[i.id]! } }), 'Sent back to the maker.')
              : act(() => api.POST('/api/v1/approvals/settings/{id}/decision', { params: { path: { id: i.id } }, body: { approve: false, note: reason[i.id] } }), 'Change rejected.')}>{i.kind === 'terms' ? 'Send back' : 'Reject'}</button>
          </p>
        </div>
      ))}
      {q.data?.length === 0 && <p className="muted">Nothing is waiting for your approval.</p>}
    </section>
  );
}

// ================================================================ guardrail console (ADM-07)
function SettingEditor({ s }: { s: any }) {
  const { act } = useAct();
  const [v, setV] = useState<any>(s.value);
  const [note, setNote] = useState('');
  const num = (k: string) => <label key={k}>{k.replace(/([A-Z])/g, ' $1').toLowerCase()}<input type="number" min={0} step="any" value={v?.[k] ?? ''} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} /></label>;
  let input;
  if (s.key === 'dispute_timers') input = <div className="grid2">{['responseHours', 'escalateAfterHours', 'timeoutAfterHours'].map(num)}</div>;
  else if (s.key === 'mode') input = <label>Mode<select value={v} onChange={(e) => setV(e.target.value)}><option value="network">Network (every invited bank)</option><option value="white-label">White-label (partner bank only)</option></select></label>;
  else if (s.key === 'governing_law') input = <textarea aria-label={s.label} value={v} onChange={(e) => setV(e.target.value)} />;
  else if (Array.isArray(s.value)) input = <label>Values (comma separated)<input value={Array.isArray(v) ? v.join(', ') : ''} onChange={(e) => setV(e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => (s.key === 'dunning_days' ? Number(x) : x)))} /></label>;
  else input = <label>Value<input type="number" step="any" value={v} onChange={(e) => setV(Number(e.target.value))} /></label>;
  return (
    <div className="panel">
      <h3>{s.label}</h3>
      <p className="hint">{s.help}</p>
      {s.pending && <p className="alert" style={{ background: '#fffaeb', color: 'var(--warn)' }}>Waiting for another administrator: {s.pending.proposer ?? 'someone'} proposed <code>{JSON.stringify(s.pending.value)}</code> on {when(s.pending.at)}.</p>}
      {input}
      <p className="filters">
        <input aria-label="Reason for the change" placeholder="Why?" value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={JSON.stringify(v) === JSON.stringify(s.value)} onClick={() => act(() => api.PUT('/api/v1/admin/settings/{key}', { params: { path: { key: s.key } }, body: { value: v, note: note || undefined } }), 'Proposed. A different administrator must approve it before it takes effect.')}>Propose change</button>
      </p>
      {s.history.length > 0 && <details><summary>Recent changes</summary><ul className="timeline">{s.history.map((h: any) => <li key={h.id}><span className={`chip ${h.status === 'applied' ? 'active' : 'retired'}`}>{h.status}</span> {JSON.stringify(h.before)} → {JSON.stringify(h.after)} · {h.proposer ?? '?'}{h.decider && ` / ${h.decider}`} · {when(h.at)}</li>)}</ul></details>}
    </div>
  );
}

export function GuardrailConsolePage() {
  const { banner, act } = useAct();
  const g = useQuery({ queryKey: ['guardrails'], queryFn: async () => (await api.GET('/api/v1/admin/guardrails')).data });
  const s = useQuery({ queryKey: ['settings'], queryFn: async () => (await api.GET('/api/v1/admin/settings')).data?.items ?? [] });
  const banks = useQuery({ queryKey: ['admin-banks'], queryFn: async () => (await api.GET('/api/v1/admin/banks')).data?.items ?? [] });
  const [hosts, setHosts] = useState<Record<string, string>>({});
  return (
    <section>
      <h2>Platform defaults and guardrails</h2>
      {banner}
      <div className="panel">
        <h3>Hard guardrails</h3>
        <p className="hint">These are part of the platform itself. No one — a bank, an insurer or Earlio staff — can loosen them through a setting.</p>
        <table><tbody>{g.data?.guardrails.map((x) => <tr key={x.key}><td>{x.label}</td><td className="num">{x.value}</td></tr>)}</tbody></table>
        {g.data?.platformSetId && <p>Fees, the benchmark rate and platform defaults are edited as versioned terms: <Link to={`/terms/${g.data.platformSetId}`}>open the platform terms</Link>. Every change passes maker-checker.</p>}
      </div>
      <h3>Operating settings</h3>
      {(s.data ?? []).map((x) => <SettingEditor key={x.key + JSON.stringify(x.value) + (x.pending?.id ?? '')} s={x} />)}
      <div className="panel">
        <h3>Bank hostnames</h3>
        <p className="hint">A hostname decides whose branding a visitor sees (for local development use bank1.localtest.me). Only Earlio can change it.</p>
        <table>
          <thead><tr><th>Bank</th><th>Branding</th><th>Hostname</th><th /></tr></thead>
          <tbody>{(banks.data ?? []).map((b) => (
            <tr key={b.id}>
              <td>{b.name}{b.isPartner && <span className="chip active"> partner</span>}</td>
              <td><span className="swatch" style={{ background: b.primary }} /> {b.displayName}</td>
              <td><input aria-label={`Hostname for ${b.name}`} value={hosts[b.id] ?? b.hostname ?? ''} onChange={(e) => setHosts({ ...hosts, [b.id]: e.target.value })} /></td>
              <td><button className="secondary" onClick={() => act(() => api.PUT('/api/v1/admin/banks/{id}/hostname', { params: { path: { id: b.id } }, body: { hostname: (hosts[b.id] ?? b.hostname ?? '').trim() || null } }), 'Hostname saved.')}>Save</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
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
  if (!cur) return <p>Loading…</p>;
  const canEdit = me?.permissions.includes('org:settings');
  const def = (sets.data ?? []).find((s) => Object.keys(s.scope).length === 0);
  const fee = def?.activeVersion?.body as any;
  const set = (k: keyof typeof cur) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF({ ...cur, [k]: e.target.value }); if (k === 'primary' || k === 'accent') applyBrand({ displayName: cur.displayName, primary: k === 'primary' ? e.target.value : cur.primary, accent: k === 'accent' ? e.target.value : cur.accent }); };
  return (
    <section>
      <h2>Bank console</h2>
      {banner}
      <div className="row">
        <div className="panel">
          <h3>Branding</h3>
          <p className="hint">Shown to your suppliers and buyers when they arrive at <strong>{b.data?.hostname ?? 'your hostname (ask Earlio to set one)'}</strong>.</p>
          <label>Display name<input value={cur.displayName} onChange={set('displayName')} disabled={!canEdit} /></label>
          <div className="grid2">
            <label>Primary colour<input type="color" value={cur.primary} onChange={set('primary')} disabled={!canEdit} /></label>
            <label>Accent colour<input type="color" value={cur.accent} onChange={set('accent')} disabled={!canEdit} /></label>
          </div>
          <label>Logo (PNG, JPEG or SVG, up to 150 KB)<input type="file" accept="image/png,image/jpeg,image/svg+xml" disabled={!canEdit} onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            if (file.size > MAX_LOGO) return setMsg({ kind: 'err', text: 'That logo is larger than 150 KB.' });
            const url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
            setF({ ...cur, logo: url });
          }} /></label>
          {cur.logo && <p><img src={cur.logo} alt="Logo preview" height={40} /> <button className="link" onClick={() => setF({ ...cur, logo: null })}>Remove</button></p>}
          <label>Welcome text<textarea value={cur.welcome} onChange={set('welcome')} disabled={!canEdit} maxLength={400} /></label>
          <button disabled={!canEdit} onClick={() => act(() => api.PUT('/api/v1/bank/branding', { body: { displayName: cur.displayName, primary: cur.primary, accent: cur.accent, logo: cur.logo, welcome: cur.welcome || null } }), 'Branding saved.')}>Save branding</button>
          <p className="hint">White text must stay readable on your primary colour (contrast at least 4.5 : 1); the server rejects colours that fail.</p>
        </div>
        <div className="panel">
          <h3>Preview</h3>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ background: '#fff', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--line)' }}>
              {cur.logo && <img src={cur.logo} alt="" height={26} />}<strong style={{ color: cur.primary }}>{cur.displayName}</strong>
            </div>
            <div style={{ padding: 14 }}>
              <p>{cur.welcome || 'Welcome text appears here.'}</p>
              <button style={{ background: cur.primary }} type="button">Sign in</button>{' '}
              <span style={{ borderBottom: `3px solid ${cur.accent}` }}>Accent</span>
            </div>
          </div>
        </div>
      </div>
      <div className="panel">
        <h3>Your fees, rates and limits</h3>
        {fee ? (
          <table><tbody>
            <tr><td>Advance</td><td className="num">{fee.advancePct}%</td></tr>
            <tr><td>Pricing</td><td className="num">{fee.pricing?.type === 'fixed' ? `${fee.pricing.ratePct}% fixed` : 'benchmark + margin by buyer rating'}</td></tr>
            <tr><td>Processing fee</td><td className="num">{fee.processingFee?.pct}% (minimum USD {fee.processingFee?.minUsd})</td></tr>
            <tr><td>FX margin</td><td className="num">{fee.fxSpreadPct}%</td></tr>
            <tr><td>Invoice size</td><td className="num">USD {fee.invoiceSizeUsd?.min?.toLocaleString('en-US')} – {fee.invoiceSizeUsd?.max?.toLocaleString('en-US')}</td></tr>
          </tbody></table>
        ) : <p className="muted">Loading terms…</p>}
        <p>{def && <Link to={`/terms/${def.id}`}>Edit these in the terms studio</Link>} · <Link to="/limits">Exposure limits per buyer and supplier</Link> · <Link to="/approvals">Approvals inbox</Link></p>
      </div>
    </section>
  );
}

// ================================================================ requirements on the supplier's consent form (CT-10)
export function RequirementsBox({ frId, invoiceId, answers, setAnswers, onChange }: { frId: string; invoiceId: string; answers: Record<string, string>; setAnswers: (a: Record<string, string>) => void; onChange: () => void }) {
  const { me } = useAuth();
  const { act, banner, setMsg } = useAct();
  const q = useQuery({ queryKey: ['requirements', frId], queryFn: async () => (await api.GET('/api/v1/financing-requests/{id}/requirements', { params: { path: { id: frId } } })).data });
  const r = q.data;
  if (!r || (!r.customFields.length && !r.requiredDocuments.length)) return null;
  async function attach(docType: string, file: File) {
    try {
      const up = await fetch(`/api/v1/files?filename=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': me?.csrfToken ?? '' }, body: await file.arrayBuffer() });
      const j = await up.json(); if (!up.ok) throw new Error(j.message ?? 'Upload failed.');
      await act(() => api.POST('/api/v1/invoices/{id}/documents', { params: { path: { id: invoiceId } }, body: { docType: docType as 'packing_list', fileId: j.id } }), 'Document added.');
      onChange();
    } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); }
  }
  return (
    <div className="panel">
      <h4>What this bank asks for</h4>
      {banner}
      {r.requiredDocuments.map((d) => (
        <p key={d}>{d.replace(/_/g, ' ')}: {r.missingDocuments.includes(d)
          ? <><span className="chip Overdue">missing</span> <label className="link">Attach<input type="file" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(d, f); }} /></label></>
          : <span className="chip active">attached</span>}</p>
      ))}
      <div className="grid2">
        {r.customFields.map((f) => (
          <label key={f.key}>{f.label}{f.required && ' *'}
            {f.type === 'select'
              ? <select value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })}><option value="">—</option>{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
              : <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step="any" value={answers[f.key] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.key]: e.target.value })} />}
          </label>
        ))}
      </div>
    </div>
  );
}
