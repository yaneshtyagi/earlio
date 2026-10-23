import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk, problemOf } from '../api/client';

export function AdminKycPage() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['kyc-queue'], queryFn: async () => (await api.GET('/api/v1/admin/kyc/cases')).data?.items ?? [] });
  const decide = useMutation({
    mutationFn: async (a: { id: string; decision: 'approve' | 'reject' }) => {
      const reason = window.prompt(a.decision === 'approve' ? 'Reason for approval' : 'Reason for rejection');
      if (!reason) return;
      const r = await api.POST('/api/v1/admin/kyc/cases/{id}/decision', { params: { path: { id: a.id } }, body: { decision: a.decision, reason } });
      await ensureOk(r);
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['kyc-queue'] }); }, onError: (e: Error) => setErr(e.message),
  });
  return (
    <section>
      <h2>KYC queue</h2>
      {err && <p className="alert">{err}</p>}
      <table>
        <thead><tr><th>Organisation</th><th>Type</th><th>Country</th><th>Status</th><th>Sanctions</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((k) => (
            <tr key={k.id}>
              <td>{k.orgName}</td><td>{k.orgType}</td><td>{k.country}</td><td>{k.status}</td><td>{k.sanctionsStatus}</td>
              <td>{['in_review', 'referred'].includes(k.status) && <><button className="link" onClick={() => decide.mutate({ id: k.id, decision: 'approve' })}>Approve</button>
                <button className="link" onClick={() => decide.mutate({ id: k.id, decision: 'reject' })}>Reject</button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AdminSanctionsPage() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['screenings'], queryFn: async () => (await api.GET('/api/v1/admin/sanctions/screenings')).data?.items ?? [] });
  const decide = useMutation({
    mutationFn: async (a: { id: string; decision: 'false_positive' | 'confirmed' }) => {
      const reason = window.prompt('Reason (recorded in the audit log)');
      if (!reason) return;
      const r = await api.POST('/api/v1/admin/sanctions/screenings/{id}/decision', { params: { path: { id: a.id } }, body: { decision: a.decision, reason } });
      await ensureOk(r);
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['screenings'] }); }, onError: (e: Error) => setErr(e.message),
  });
  return (
    <section>
      <h2>Sanctions review</h2>
      {err && <p className="alert">{err}</p>}
      <table>
        <thead><tr><th>Name screened</th><th>Outcome</th><th>Closest match</th><th>Score</th><th /></tr></thead>
        <tbody>
          {(q.data ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.subjectName}</td><td>{s.outcome}</td><td>{s.matches[0]?.entry ?? '—'} <span className="hint">{s.matches[0]?.list}</span></td><td>{Number(s.topScore).toFixed(3)}</td>
              <td>{s.outcome === 'hit' && <><button className="link" onClick={() => decide.mutate({ id: s.id, decision: 'false_positive' })}>False positive</button>
                <button className="link" onClick={() => decide.mutate({ id: s.id, decision: 'confirmed' })}>Confirm</button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
