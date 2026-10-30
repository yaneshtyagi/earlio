import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DataTable, FormGrid, MoneyField, SelectField, TextField, TextareaField } from '@yaneshtyagi/design-system';
import { api, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, ErrorNote, Hint, NavButton, Notice, Page, Panel, dd, noRows } from '../ui';

export function PurchaseOrdersPage() {
  const { me } = useAuth();
  const created = (useLocation().state as { created?: string } | null)?.created;
  const list = useQuery({ queryKey: ['pos'], queryFn: async () => (await api.GET('/api/v1/purchase-orders')).data?.items ?? [] });
  const isSupplier = me?.activeOrg?.type === 'supplier';
  const canCreate = isSupplier && me?.permissions.includes('invoice:create');
  const title = isSupplier ? 'Purchase orders' : 'Purchase orders from our suppliers';
  return (
    <>
      <Page title={title} description="Purchase orders back the invoices raised against them; invoices without one are flagged for review."
        actions={canCreate ? <NavButton to="/purchase-orders/new" variant="primary" icon="plus">New purchase order</NavButton> : undefined} />
      <Notice msg={created ? { ok: true, text: `Purchase order ${created} recorded.` } : null} />
      <DataTable aria-label={title} noun="purchase orders" loading={list.isLoading} rowKey={(p) => p.id} rows={list.data ?? []}
        empty={noRows('No purchase orders yet', canCreate ? 'Record one so invoices can be matched against it.' : undefined)}
        columns={[
          { id: 'number', header: 'PO number', rowHeader: true, cell: (p) => p.number },
          { id: 'party', header: isSupplier ? 'Buyer' : 'Supplier', cell: (p) => (isSupplier ? p.buyerName : p.supplierName) },
          { id: 'description', header: 'Description', cell: (p) => p.description ?? '—' },
          { id: 'recorded', header: 'Recorded', cell: (p) => dd(p.createdAt) },
          { id: 'amount', header: 'Amount', numeric: true, cell: (p) => <Amt v={p.amount} c={p.currency} /> },
        ]} />
    </>
  );
}

export function PurchaseOrderNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const buyers = useQuery({ queryKey: ['rels'], queryFn: async () => (await api.GET('/api/v1/relationships')).data?.items.filter((r) => r.status === 'active') ?? [] });
  const [f, setF] = useState({ buyerOrgId: '', number: '', currency: 'USD', amount: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function create(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const { error: err } = await api.POST('/api/v1/purchase-orders', { body: { ...f, currency: f.currency as 'USD', description: f.description.trim() || undefined } });
    setBusy(false);
    if (err) return setError(problemOf(err).message);
    await qc.invalidateQueries({ queryKey: ['pos'] });
    nav('/purchase-orders', { state: { created: f.number.trim() } });
  }

  const noBuyers = buyers.isSuccess && buyers.data.length === 0;
  return (
    <>
      <Page title="New purchase order" breadcrumbs={[{ label: 'Purchase orders', href: '/purchase-orders' }, { label: 'New purchase order' }]} />
      <ErrorNote>{error}</ErrorNote>
      <Panel title="Record a purchase order" sub="The PO number must be unique for each buyer. Invoices you raise for this buyer can then reference it.">
        {noBuyers && <Hint>You need an active relationship with a buyer before you can record a purchase order. Propose one under Relationships.</Hint>}
        <form className="stack-3" onSubmit={create}>
          <SelectField label="Buyer" value={f.buyerOrgId} onChange={set('buyerOrgId')} required>
            <option value="">Choose…</option>{(buyers.data ?? []).map((r) => <option key={r.id} value={r.buyer.id}>{r.buyer.name}</option>)}
          </SelectField>
          <TextField label="PO number" value={f.number} onChange={set('number')} maxLength={60} required />
          <FormGrid>
            <SelectField label="Currency" value={f.currency} onChange={set('currency')}><option>USD</option><option>SGD</option></SelectField>
            <MoneyField label="Amount" currency={f.currency} value={f.amount} onValueChange={(v) => setF({ ...f, amount: v })} required />
          </FormGrid>
          <TextareaField label="Description (optional)" value={f.description} onChange={set('description')} maxLength={300} rows={3} />
          <div className="row-actions">
            <Button type="submit" variant="primary" disabled={busy || noBuyers}>Record purchase order</Button>
            <NavButton to="/purchase-orders">Cancel</NavButton>
          </div>
        </form>
      </Panel>
    </>
  );
}
