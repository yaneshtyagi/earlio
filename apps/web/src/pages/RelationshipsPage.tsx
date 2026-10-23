import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';

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
    <section>
      <h2>Relationships</h2>
      {msg && <p className="alert">{msg}</p>}
      <table>
        <thead><tr><th>Supplier</th><th>Buyer</th><th>Status</th><th>Approvals</th><th /></tr></thead>
        <tbody>
          {(rels.data ?? []).map((r) => {
            const mineApproved = r.supplier.id === myOrg ? r.supplierApproved : r.buyerApproved;
            return (
              <tr key={r.id}>
                <td>{r.supplier.name}</td><td>{r.buyer.name}</td><td>{r.status}</td>
                <td>{r.supplierApproved ? '✓' : '·'} supplier / {r.buyerApproved ? '✓' : '·'} buyer</td>
                <td>{canApprove && r.status === 'pending' && !mineApproved && <button className="link" onClick={() => approve.mutate(r.id)}>Approve</button>}</td>
              </tr>
            );
          })}
          {rels.data?.length === 0 && <tr><td colSpan={5} className="muted">No relationships yet.</td></tr>}
        </tbody>
      </table>
      {canPropose && (
        <>
          <h3>Link with a counterparty</h3>
          <input placeholder="Search by name (KYC-approved organisations)" value={term} onChange={(e) => setTerm(e.target.value)} />
          <table><tbody>
            {(dir.data ?? []).filter((o) => o.type !== 'bank').map((o) => (
              <tr key={o.id}><td>{o.legalName}</td><td>{o.type}</td><td>{o.country}</td><td><button className="link" onClick={() => propose.mutate(o.id)}>Propose</button></td></tr>
            ))}
          </tbody></table>
        </>
      )}
      {banks.data && (
        <>
          <h3>Preferred banks</h3>
          <p className="hint">Preferred banks and the partner bank are invited to bid on your invoices.</p>
          {banks.data.available.map((b) => (
            <label key={b.id}>
              <input type="checkbox" style={{ width: 'auto' }} checked={chosen.has(b.id)} disabled={!me?.permissions.includes('org:settings')}
                onChange={(e) => { const next = new Set(chosen); e.target.checked ? next.add(b.id) : next.delete(b.id); savePref.mutate([...next]); }} /> {b.name}{b.isPartner && ' (partner)'}
            </label>
          ))}
        </>
      )}
    </section>
  );
}
