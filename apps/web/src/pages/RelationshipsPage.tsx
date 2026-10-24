import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, DataTable, SearchInput } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ErrorNote, Page, Panel, StatusChip, noRows } from '../ui';

export function RelationshipsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const rels = useQuery({ queryKey: ['rels'], queryFn: async () => (await api.GET('/api/v1/relationships')).data?.items ?? [] });
  const dir = useQuery({
    queryKey: ['dir', term], enabled: term.length >= 2,
    queryFn: async () => (await api.GET('/api/v1/directory/organisations', { params: { query: { q: term } } })).data?.items ?? [],
  });
  const banks = useQuery({ queryKey: ['pref-banks'], queryFn: async () => (await api.GET('/api/v1/org/preferred-banks')).data });
  const canPropose = me?.permissions.includes('relationship:propose');
  const canApprove = me?.permissions.includes('relationship:approve');
  const myOrg = me?.activeOrg?.id;

  const propose = useMutation({
    mutationFn: async (counterpartyId: string) => { const r = await api.POST('/api/v1/relationships', { body: { counterpartyId } }); await ensureOk(r); },
    onSuccess: () => { setMsg(null); setTerm(''); qc.invalidateQueries({ queryKey: ['rels'] }); }, onError: (e: Error) => setMsg(e.message),
  });
  const approve = useMutation({
    mutationFn: async (id: string) => { const r = await api.POST('/api/v1/relationships/{id}/approve', { params: { path: { id } } }); await ensureOk(r); },
    onSuccess: () => { setMsg(null); qc.invalidateQueries({ queryKey: ['rels'] }); }, onError: (e: Error) => setMsg(e.message),
  });
  const savePref = useMutation({
    mutationFn: async (bankIds: string[]) => { await api.PUT('/api/v1/org/preferred-banks', { body: { bankIds } }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pref-banks'] }),
  });
  const chosen = new Set((banks.data?.banks ?? []).map((b) => b.id));

  return (
    <>
      <Page title="Relationships" description="A supplier and a buyer can trade on Earlio once both sides have approved the link." />
      <ErrorNote>{msg}</ErrorNote>
      <DataTable aria-label="Relationships" noun="relationships" loading={rels.isLoading} rowKey={(r) => r.id} rows={rels.data ?? []} empty={noRows('No relationships yet', 'Link with a counterparty below to start trading.')}
        columns={[
          { id: 'supplier', header: 'Supplier', rowHeader: true, cell: (r) => r.supplier.name },
          { id: 'buyer', header: 'Buyer', cell: (r) => r.buyer.name },
          { id: 'status', header: 'Status', cell: (r) => <StatusChip status={r.status} /> },
          { id: 'approvals', header: 'Approvals', cell: (r) => `Supplier: ${r.supplierApproved ? 'approved' : 'waiting'} · Buyer: ${r.buyerApproved ? 'approved' : 'waiting'}` },
          { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (r) => {
            const mineApproved = r.supplier.id === myOrg ? r.supplierApproved : r.buyerApproved;
            return canApprove && r.status === 'pending' && !mineApproved ? <Button size="sm" onClick={() => approve.mutate(r.id)}>Approve</Button> : null;
          } },
        ]} />
      {canPropose && (
        <Panel title="Link with a counterparty">
          <SearchInput aria-label="Search organisations" placeholder="Search by name (KYC-approved organisations)" value={term} onChange={(e) => setTerm(e.target.value)} />
          {term.length >= 2 && (
            <DataTable aria-label="Matching organisations" noun="organisations" loading={dir.isLoading} rowKey={(o) => o.id} rows={(dir.data ?? []).filter((o) => o.type !== 'bank')} empty={noRows('No match', 'Only KYC-approved suppliers and buyers can be linked.')}
              columns={[
                { id: 'name', header: 'Organisation', rowHeader: true, cell: (o) => o.legalName },
                { id: 'type', header: 'Type', cell: (o) => o.type },
                { id: 'country', header: 'Country', cell: (o) => o.country },
                { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (o) => <Button size="sm" onClick={() => propose.mutate(o.id)}>Propose</Button> },
              ]} />
          )}
        </Panel>
      )}
      {banks.data && (
        <Panel title="Preferred banks" sub="Preferred banks and the partner bank are invited to bid on your invoices.">
          {banks.data.available.map((b) => (
            <Checkbox key={b.id} label={<>{b.name}{b.isPartner && ' (partner)'}</>} checked={chosen.has(b.id)} disabled={!me?.permissions.includes('org:settings')}
              onChange={(e) => { const next = new Set(chosen); e.target.checked ? next.add(b.id) : next.delete(b.id); savePref.mutate([...next]); }} />
          ))}
        </Panel>
      )}
    </>
  );
}
