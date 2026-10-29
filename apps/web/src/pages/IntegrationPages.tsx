import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, DataTable, LinkButton, SelectField, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Hint, Notice, Page, Panel, Section, StatusChip, dt, noRows, type Msg } from '../ui';

/** BNK-13: API keys, webhooks and CSV file drop for banks. */
export function BankIntegrationPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<Msg>(null);
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
    <>
      <Page title="API and file console" description="Connect your core banking or ERP systems: signed API calls, webhooks, or CSV files. See the integration guide for the signature scheme and file formats." />
      <Notice msg={msg} />

      {can('org:manage_users') && <>
        <Panel title="API keys">
          {secret && (
            <Alert tone="warning" title="Copy these now — they are shown only once."
              actions={<Button onClick={() => setSecret(null)}>I have saved them</Button>}>
              <p>Key for “{secret.label}”: <span className="mono" data-testid="new-key">{secret.apiKey}</span></p>
              <p>Signing secret: <span className="mono" data-testid="new-secret">{secret.signingSecret}</span></p>
            </Alert>
          )}
          <DataTable aria-label="API keys" noun="keys" rowKey={(k) => k.id} rows={keys.data ?? []} empty={noRows('No keys yet')}
            columns={[
              { id: 'name', header: 'Name', rowHeader: true, cell: (k) => k.label },
              { id: 'key', header: 'Key', cell: (k) => <span className="mono">ek_{k.prefix}_…</span> },
              { id: 'status', header: 'Status', cell: (k) => <StatusChip status={k.status} /> },
              { id: 'valid', header: 'Valid until', cell: (k) => dt(k.expiresAt) },
              { id: 'used', header: 'Last used', cell: (k) => dt(k.lastUsedAt) },
              { id: 'act', header: <span className="bv-sr-only">Actions</span>, cell: (k) => (
                <div className="row-actions">
                  {k.status === 'active' && <Button size="sm" onClick={() => reveal(run(() => api.POST('/api/v1/bank/api-keys/{id}/rotate', { params: { path: { id: k.id } } }), 'New key issued. The old one works for 24 more hours.'), k.label)}>Rotate</Button>}
                  {k.status !== 'revoked' && <Button size="sm" onClick={() => run(() => api.POST('/api/v1/bank/api-keys/{id}/revoke', { params: { path: { id: k.id } } }), 'Key revoked.')}>Revoke</Button>}
                </div>) },
            ]} />
          <div className="toolbar-fields">
            <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. core-banking" />
            <Button variant="primary" disabled={!label.trim()} onClick={() => reveal(run(() => api.POST('/api/v1/bank/api-keys', { body: { label } }), 'Key created.'), label).then(() => setLabel(''))}>Create key</Button>
          </div>
        </Panel>

        <Panel title="Webhooks">
          <DataTable aria-label="Webhooks" noun="webhooks" rowKey={(w) => w.id} rows={hooks.data?.items ?? []} empty={noRows('No webhooks yet')}
            columns={[
              { id: 'url', header: 'Endpoint', rowHeader: true, cell: (w) => <span className="mono">{w.url}</span> },
              { id: 'events', header: 'Events', cell: (w) => (w.events.length ? w.events.join(', ') : 'all') },
              { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (w) => <Button size="sm" onClick={() => run(() => api.DELETE('/api/v1/bank/webhooks/{id}', { params: { path: { id: w.id } } }), 'Webhook removed.')}>Remove</Button> },
            ]} />
          <div className="toolbar-fields">
            <TextField label="URL" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} placeholder="https://…" />
            <TextField label="Events (comma-separated, blank = all)" value={hook.events} onChange={(e) => setHook({ ...hook, events: e.target.value })} placeholder="offer.submitted, financing.approved" />
            <Button variant="primary" disabled={!hook.url} onClick={() => run(() => api.POST('/api/v1/bank/webhooks', { body: { url: hook.url, events: hook.events.split(',').map((x) => x.trim()).filter(Boolean) } }), 'Webhook added.').then(() => setHook({ url: '', events: '' }))}>Add webhook</Button>
          </div>
          <Section title="Recent deliveries" level={4}>
            <DataTable aria-label="Recent webhook deliveries" noun="deliveries" density="compact" rowKey={(d) => d.id} rows={(hooks.data?.deliveries ?? []).slice(0, 10)} empty={noRows('No deliveries yet')}
              columns={[
                { id: 'event', header: 'Event', rowHeader: true, cell: (d) => d.eventType },
                { id: 'status', header: 'Status', cell: (d) => <StatusChip status={d.status} /> },
                { id: 'attempts', header: 'Attempts', numeric: true, cell: (d) => d.attempts },
                { id: 'error', header: 'Last error', cell: (d) => d.lastError ?? '—' },
                { id: 'when', header: 'When', cell: (d) => dt(d.createdAt) },
              ]} />
          </Section>
        </Panel>
      </>}

      {(can('settlement:operate') || can('offer:submit')) && (
        <Panel title="File drop (CSV)">
          <div className="split">
            <Section title="Files in" level={4}>
              <SelectField label="Type" value={file?.kind ?? 'offers'} onChange={(e) => setFile({ kind: e.target.value as any, name: file?.name ?? '', content: file?.content ?? '' })}>
                <option value="offers">Offers (invoice, ratePct, advancePct, fxSpreadPct, validityHours)</option>
                <option value="statements">Statement (bankTxnId, reference, currency, amount, valueDate, payer)</option>
              </SelectField>
              <TextField label="CSV file" type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setFile({ kind: file?.kind ?? 'offers', name: f.name, content: await f.text() }); }} />
              <div><Button variant="primary" icon="upload" disabled={!file?.content} onClick={upload}>Upload</Button></div>
            </Section>
            <Section title="File out" level={4}>
              <Hint>Payment instructions that are waiting for your bank.</Hint>
              <div><LinkButton href="/api/v1/bank/files/instructions" download="instructions.csv" icon="download">Download instructions.csv</LinkButton></div>
            </Section>
          </div>
          <Section title="History" level={4}>
            <DataTable aria-label="File history" noun="files" density="compact" rowKey={(b) => b.id} rows={batches.data ?? []} empty={noRows('No files yet')}
              columns={[
                { id: 'when', header: 'When', rowHeader: true, cell: (b) => dt(b.createdAt) },
                { id: 'kind', header: 'Kind', cell: (b) => b.kind.replace('_', ' ') },
                { id: 'file', header: 'File', cell: (b) => b.filename },
                { id: 'rows', header: 'Rows', numeric: true, cell: (b) => b.rowsTotal },
                { id: 'ok', header: 'OK', numeric: true, cell: (b) => b.rowsOk },
                { id: 'problems', header: 'Problems', cell: (b) => (b.errors.length ? b.errors.slice(0, 3).map((e) => `row ${e.row}: ${e.message}`).join('; ') : '—') },
              ]} />
          </Section>
        </Panel>
      )}
    </>
  );
}
