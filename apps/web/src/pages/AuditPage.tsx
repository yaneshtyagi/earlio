import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';

export function AuditPage() {
  const [result, setResult] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['audit'], queryFn: async () => (await api.GET('/api/v1/audit/events', { params: { query: { limit: 100 } } })).data ?? [] });
  async function verify() {
    const { data } = await api.GET('/api/v1/audit/verify');
    if (!data) return setResult('Verification failed to run.');
    setResult(data.ok ? `Chain intact: ${data.checked} events verified.` : `TAMPERING DETECTED at event ${data.firstBrokenSeq}: ${data.reason}`);
  }
  return (
    <section>
      <h2>Audit log</h2>
      <button onClick={verify}>Verify chain</button>
      {result && <div className={result.startsWith('Chain intact') ? 'ok' : 'alert'} role="status">{result}</div>}
      <table>
        <thead><tr><th>#</th><th>When</th><th>Action</th><th>Entity</th><th>Hash</th></tr></thead>
        <tbody>{(q.data ?? []).map((e) => (
          <tr key={e.seq}><td>{e.seq}</td><td>{e.occurredAt}</td><td>{e.action}</td><td>{e.entityType}</td><td><code>{e.hash.slice(0, 12)}…</code></td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}
