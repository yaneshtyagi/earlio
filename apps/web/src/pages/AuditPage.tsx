import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, DataTable } from '@yaneshtyagi/design-system';
import { api } from '../api/client';
import { Page, dt, noRows } from '../ui';

export function AuditPage() {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const q = useQuery({ queryKey: ['audit'], queryFn: async () => (await api.GET('/api/v1/audit/events', { params: { query: { limit: 100 } } })).data ?? [] });
  async function verify() {
    const { data } = await api.GET('/api/v1/audit/verify');
    if (!data) return setResult({ ok: false, text: 'Verification failed to run.' });
    setResult(data.ok ? { ok: true, text: `Chain intact: ${data.checked} events verified.` } : { ok: false, text: `Tampering detected at event ${data.firstBrokenSeq}: ${data.reason}` });
  }
  return (
    <>
      <Page title="Audit log" description="Every change is chained to the one before it, so an edited or removed entry shows up when the chain is verified."
        actions={<Button variant="primary" icon="shield-check" onClick={verify}>Verify chain</Button>} />
      {result && <Alert tone={result.ok ? 'success' : 'danger'} title={result.text} />}
      <DataTable aria-label="Audit events" noun="events" density="compact" loading={q.isLoading} rowKey={(e) => e.seq} rows={q.data ?? []} empty={noRows('No audit events yet')}
        columns={[
          { id: 'seq', header: '#', numeric: true, cell: (e) => e.seq },
          { id: 'when', header: 'When', cell: (e) => dt(e.occurredAt) },
          { id: 'action', header: 'Action', cell: (e) => e.action },
          { id: 'entity', header: 'Entity', cell: (e) => e.entityType },
          { id: 'hash', header: 'Hash', cell: (e) => <span className="mono">{e.hash.slice(0, 12)}…</span> },
        ]} />
    </>
  );
}
