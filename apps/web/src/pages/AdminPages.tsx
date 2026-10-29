import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DataTable } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { ErrorNote, Page, StatusChip, label, noRows } from '../ui';

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
    <>
      <Page title="KYC queue" />
      <ErrorNote>{err}</ErrorNote>
      <DataTable aria-label="KYC cases" noun="cases" loading={q.isLoading} rowKey={(k) => k.id} rows={q.data ?? []} empty={noRows('Nothing to review', 'Applications appear here once an organisation submits its documents.')}
        columns={[
          { id: 'org', header: 'Organisation', rowHeader: true, cell: (k) => k.orgName },
          { id: 'type', header: 'Type', cell: (k) => k.orgType },
          { id: 'country', header: 'Country', cell: (k) => k.country },
          { id: 'status', header: 'Status', cell: (k) => <StatusChip status={k.status} /> },
          { id: 'sanctions', header: 'Sanctions', cell: (k) => <StatusChip status={k.sanctionsStatus} /> },
          { id: 'act', header: <span className="bv-sr-only">Actions</span>, cell: (k) => ['in_review', 'referred'].includes(k.status) ? (
            <div className="row-actions">
              <Button size="sm" onClick={() => decide.mutate({ id: k.id, decision: 'approve' })}>Approve</Button>
              <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: k.id, decision: 'reject' })}>Reject</Button>
            </div>
          ) : null },
        ]} />
    </>
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
    <>
      <Page title="Sanctions review" description="A name that closely matches a watch-list entry stops funding until someone decides it is a false positive or a confirmed match." />
      <ErrorNote>{err}</ErrorNote>
      <DataTable aria-label="Sanctions screenings" noun="screenings" loading={q.isLoading} rowKey={(s) => s.id} rows={q.data ?? []} empty={noRows('No screenings yet')}
        columns={[
          { id: 'name', header: 'Name screened', rowHeader: true, cell: (s) => s.subjectName },
          { id: 'outcome', header: 'Outcome', cell: (s) => <StatusChip status={s.outcome}>{label(s.outcome)}</StatusChip> },
          { id: 'match', header: 'Closest match', cell: (s) => <>{s.matches[0]?.entry ?? '—'} <span className="hint">{s.matches[0]?.list}</span></> },
          { id: 'score', header: 'Score', numeric: true, cell: (s) => Number(s.topScore).toFixed(3) },
          { id: 'act', header: <span className="bv-sr-only">Actions</span>, cell: (s) => s.outcome === 'hit' ? (
            <div className="row-actions">
              <Button size="sm" onClick={() => decide.mutate({ id: s.id, decision: 'false_positive' })}>False positive</Button>
              <Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: s.id, decision: 'confirmed' })}>Confirm</Button>
            </div>
          ) : null },
        ]} />
    </>
  );
}
