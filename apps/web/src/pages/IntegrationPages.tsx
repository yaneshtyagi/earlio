import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : '—');

/** BNK-13: API keys, webhooks and CSV file drop for banks. */
export function BankIntegrationPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState<{ apiKey: string; signingSecret: string; label: string } | null>(null);
  const [label, setLabel] = useState('');
  const [hook, setHook] = useState({ url: '', events: '' });
  const [file, setFile] = useState<{ kind: 'offers' | 'statements'; name: string; content: string } | null>(null);
  const can = (p: string) => !!me?.permissions.includes(p);
  const keys = useQuery({ queryKey: ['api-keys'], enabled: can('org:manage_users'), queryFn: async () => (await api.GET('/api/v1/bank/api-keys')).data?.items ?? [] });
  const hooks = useQuery({ queryKey: ['webhooks'], enabled: can('org:manage_users'), queryFn: async () => (await api.GET('/api/v1/bank/webhooks')).data });
  const batches = useQuery({ queryKey: ['batches'], enabled: can('settlement:operate'), queryFn: async () => (await api.GET('/api/v1/bank/file-batches')).data?.items ?? [] });
  const run = async (fn: () => Promise<{ response: Response; data?: any }>, ok: string) => {
    setMsg(null);
    try { const r = await fn(); await ensureOk(r as any); setMsg({ ok: true, text: ok }); await qc.invalidateQueries(); return r.data; } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const reveal = async (r: Promise<any>, lbl: string) => { const d = await r; if (d?.apiKey) setSecret({ apiKey: d.apiKey, signingSecret: d.signingSecret, label: lbl }); };
  const upload = async () => {
    if (!file) return;
    const body = { filename: file.name, content: file.content };
    const d = await run(() => file.kind === 'offers' ? api.POST('/api/v1/bank/files/offers', { body }) : api.POST('/api/v1/bank/files/statements', { body }), 'File processed.');
    if (d) setMsg({ ok: d.errors.length === 0, text: `${d.rowsOk} of ${d.rowsTotal} rows imported.${d.errors.length ? ' Problems: ' + d.errors.map((e: any) => `row ${e.row}: ${e.message}`).join('; ') : ''}` });
  };
  return (
    <section>
      <h2>API and file console</h2>
      <p className="hint">Connect your core banking or ERP systems: signed API calls, webhooks, or CSV files. See the integration guide for the signature scheme and file formats.</p>
      {msg && <p className={msg.ok ? 'ok' : 'alert'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}

      {can('org:manage_users') && <>
        <div className="panel"><h3>API keys</h3>
          {secret && <div className="alert" role="alert"><strong>Copy these now — they are shown only once.</strong>
            <p>Key for “{secret.label}”: <code data-testid="new-key">{secret.apiKey}</code></p><p>Signing secret: <code data-testid="new-secret">{secret.signingSecret}</code></p>
            <button className="secondary" onClick={() => setSecret(null)}>I have saved them</button></div>}
          <table><thead><tr><th>Name</th><th>Key</th><th>Status</th><th>Valid until</th><th>Last used</th><th /></tr></thead>
            <tbody>{(keys.data ?? []).map((k) => (
              <tr key={k.id}><td>{k.label}</td><td><code>ek_{k.prefix}_…</code></td><td><span className={`chip ${k.status}`}>{k.status}</span></td><td>{when(k.expiresAt)}</td><td>{when(k.lastUsedAt)}</td>
                <td className="filters">
                  {k.status === 'active' && <button className="secondary" onClick={() => reveal(run(() => api.POST('/api/v1/bank/api-keys/{id}/rotate', { params: { path: { id: k.id } } }), 'New key issued. The old one works for 24 more hours.'), k.label)}>Rotate</button>}
                  {k.status !== 'revoked' && <button className="secondary" onClick={() => run(() => api.POST('/api/v1/bank/api-keys/{id}/revoke', { params: { path: { id: k.id } } }), 'Key revoked.')}>Revoke</button>}
                </td></tr>))}</tbody></table>
          {!keys.data?.length && <p className="hint">No keys yet.</p>}
          <p className="filters"><label>Name<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. core-banking" /></label>
            <button disabled={!label.trim()} onClick={() => reveal(run(() => api.POST('/api/v1/bank/api-keys', { body: { label } }), 'Key created.'), label).then(() => setLabel(''))}>Create key</button></p>
        </div>

        <div className="panel"><h3>Webhooks</h3>
          <table><thead><tr><th>Endpoint</th><th>Events</th><th /></tr></thead>
            <tbody>{(hooks.data?.items ?? []).map((w) => <tr key={w.id}><td><code>{w.url}</code></td><td>{w.events.length ? w.events.join(', ') : 'all'}</td><td><button className="secondary" onClick={() => run(() => api.DELETE('/api/v1/bank/webhooks/{id}', { params: { path: { id: w.id } } }), 'Webhook removed.')}>Remove</button></td></tr>)}</tbody></table>
          <p className="filters"><label>URL<input value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://…" /></label>
            <label>Events (comma-separated, blank = all)<input value={hook.events} onChange={(e) => setHook({ ...hook, events: e.target.value })} placeholder="offer.submitted, financing.approved" /></label>
            <button disabled={!hook.url} onClick={() => run(() => api.POST('/api/v1/bank/webhooks', { body: { url: hook.url, events: hook.events.split(',').map((x) => x.trim()).filter(Boolean) } }), 'Webhook added.').then(() => setHook({ url: '', events: '' }))}>Add webhook</button></p>
          <h4>Recent deliveries</h4>
          <table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th><th>When</th></tr></thead>
            <tbody>{(hooks.data?.deliveries ?? []).slice(0, 10).map((d) => <tr key={d.id}><td>{d.eventType}</td><td><span className={`chip ${d.status}`}>{d.status}</span></td><td>{d.attempts}</td><td>{d.lastError ?? '—'}</td><td>{when(d.createdAt)}</td></tr>)}</tbody></table>
        </div>
      </>}

      {(can('settlement:operate') || can('offer:submit')) && <div className="panel"><h3>File drop (CSV)</h3>
        <div className="row">
          <div>
            <h4>Files in</h4>
            <label>Type<select value={file?.kind ?? 'offers'} onChange={(e) => setFile({ kind: e.target.value as any, name: file?.name ?? '', content: file?.content ?? '' })}><option value="offers">Offers (invoice, ratePct, advancePct, fxSpreadPct, validityHours)</option><option value="statements">Statement (bankTxnId, reference, currency, amount, valueDate, payer)</option></select></label>
            <label>CSV file<input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setFile({ kind: file?.kind ?? 'offers', name: f.name, content: await f.text() }); }} /></label>
            <button disabled={!file?.content} onClick={upload}>Upload</button>
          </div>
          <div>
            <h4>File out</h4>
            <p className="hint">Payment instructions that are waiting for your bank.</p>
            <a className="button" href="/api/v1/bank/files/instructions" download="instructions.csv">Download instructions.csv</a>
          </div>
        </div>
        <h4>History</h4>
        <table><thead><tr><th>When</th><th>Kind</th><th>File</th><th className="num">Rows</th><th className="num">OK</th><th>Problems</th></tr></thead>
          <tbody>{(batches.data ?? []).map((b) => <tr key={b.id}><td>{when(b.createdAt)}</td><td>{b.kind.replace('_', ' ')}</td><td>{b.filename}</td><td className="num">{b.rowsTotal}</td><td className="num">{b.rowsOk}</td><td>{b.errors.length ? b.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join('; ') : '—'}</td></tr>)}</tbody></table>
      </div>}
    </section>
  );
}
