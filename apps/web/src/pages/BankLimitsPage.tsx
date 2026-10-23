import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney } from '../shared/money';

export function BankLimitsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['limits'], queryFn: async () => (await api.GET('/api/v1/bank/limits')).data?.items ?? [] });
  const canManage = me?.permissions.includes('limits:manage');
  const save = useMutation({
    mutationFn: async (a: { subjectOrgId: string; kind: 'buyer' | 'supplier'; current: string }) => {
      const v = window.prompt('New limit (USD)', a.current);
      if (!v) return;
      const r = await api.PUT('/api/v1/bank/limits', { body: { subjectOrgId: a.subjectOrgId, kind: a.kind, limitUsd: v } });
      await ensureOk(r);
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['limits'] }); }, onError: (e: Error) => setErr(e.message),
  });
  return (
    <section>
      <h2>Exposure limits (USD)</h2>
      {err && <p className="alert">{err}</p>}
      <table>
        <thead><tr><th>Name</th><th>Kind</th><th>Limit</th><th>Reserved</th><th>Used</th><th>Available</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((l) => (
            <tr key={l.subjectOrgId + l.kind}>
              <td>{l.subjectName}</td><td>{l.kind}</td><td>{formatMoney(l.limitUsd, 'USD')}</td><td>{formatMoney(l.reservedUsd, 'USD')}</td><td>{formatMoney(l.usedUsd, 'USD')}</td><td>{formatMoney(l.availableUsd, 'USD')}</td>
              <td>{canManage && <button className="link" onClick={() => save.mutate({ subjectOrgId: l.subjectOrgId, kind: l.kind, current: l.limitUsd })}>Edit</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
