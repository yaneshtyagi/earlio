import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DataTable } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, ErrorNote, Page, noRows } from '../ui';

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
    <>
      <Page title="Exposure limits" description="Amounts in US dollars. A limit is reserved when an offer is chosen, used once the invoice is funded, and released on settlement." />
      <ErrorNote>{err}</ErrorNote>
      <DataTable aria-label="Exposure limits" noun="limits" loading={q.isLoading} rowKey={(l) => l.subjectOrgId + l.kind} rows={q.data ?? []} empty={noRows('No limits set')}
        columns={[
          { id: 'name', header: 'Name', rowHeader: true, cell: (l) => l.subjectName },
          { id: 'kind', header: 'Kind', cell: (l) => l.kind },
          { id: 'limit', header: 'Limit (USD)', numeric: true, cell: (l) => <Amt v={l.limitUsd} c="USD" /> },
          { id: 'reserved', header: 'Reserved (USD)', numeric: true, cell: (l) => <Amt v={l.reservedUsd} c="USD" /> },
          { id: 'used', header: 'Used (USD)', numeric: true, cell: (l) => <Amt v={l.usedUsd} c="USD" /> },
          { id: 'available', header: 'Available (USD)', numeric: true, cell: (l) => <Amt v={l.availableUsd} c="USD" /> },
          { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (l) => canManage ? <Button size="sm" variant="ghost" icon="pencil" onClick={() => save.mutate({ subjectOrgId: l.subjectOrgId, kind: l.kind, current: l.limitUsd })}>Edit</Button> : null },
        ]} />
    </>
  );
}
