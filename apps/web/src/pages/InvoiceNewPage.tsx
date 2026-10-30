import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, DatePicker, FormGrid, MoneyField, SelectField, TextField, TextareaField } from '@yaneshtyagi/design-system';
import { api, ensureOk, problemOf } from '../api/client';
import { ErrorNote, Hint, Page, Panel } from '../ui';

type Report = { created: { row: number; humanId: string }[]; errors: { row: number; message: string }[] };

export function InvoiceNewPage() {
  const nav = useNavigate();
  const buyers = useQuery({ queryKey: ['rels'], queryFn: async () => (await api.GET('/api/v1/relationships')).data?.items.filter((r) => r.status === 'active') ?? [] });
  const pos = useQuery({ queryKey: ['pos'], queryFn: async () => (await api.GET('/api/v1/purchase-orders')).data?.items ?? [] });
  const [f, setF] = useState({ buyerOrgId: '', number: '', currency: 'USD', amount: '', issueDate: '', dueDate: '', poNumber: '' });
  const [error, setError] = useState<string | null>(null);
  const [csv, setCsv] = useState('buyer,number,currency,amount,issueDate,dueDate,poNumber\n');
  const [report, setReport] = useState<Report | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function create(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const { data, error: err } = await api.POST('/api/v1/invoices', { body: { ...f, currency: f.currency as 'USD', poNumber: f.poNumber || null } });
    if (err || !data) return setError(problemOf(err).message);
    nav(`/invoices/${data.humanId}`);
  }
  async function importCsv() {
    setError(null); setReport(null);
    const { data, error: err } = await api.POST('/api/v1/invoices/import/csv', { body: { csv } });
    if (err || !data) return setError(problemOf(err).message);
    setReport(data);
  }
  async function importErp() {
    setError(null); setReport(null);
    const r = await api.POST('/api/v1/invoices/import/erp');
    try { await ensureOk(r); } catch (e) { return setError((e as Error).message); }
    setReport(r.data ?? null);
  }
  const buyerPos = (pos.data ?? []).filter((p) => p.buyerOrgId === f.buyerOrgId);

  return (
    <>
      <Page title="New invoice" breadcrumbs={[{ label: 'Invoices', href: '/invoices' }, { label: 'New invoice' }]} />
      <ErrorNote>{error}</ErrorNote>
      <div className="split">
        <Panel title="Enter an invoice">
          <form className="stack-3" onSubmit={create}>
            <SelectField label="Buyer" value={f.buyerOrgId} onChange={set('buyerOrgId')} required>
              <option value="">Choose…</option>{(buyers.data ?? []).map((r) => <option key={r.id} value={r.buyer.id}>{r.buyer.name}</option>)}
            </SelectField>
            <TextField label="Invoice number" value={f.number} onChange={set('number')} required />
            <SelectField label="Purchase order" value={f.poNumber} onChange={set('poNumber')}>
              <option value="">None (flagged)</option>{buyerPos.map((p) => <option key={p.id} value={p.number}>{p.number}</option>)}
            </SelectField>
            <Hint>Missing a PO? <Link to="/purchase-orders/new">Record a purchase order</Link> first.</Hint>
            <FormGrid>
              <SelectField label="Currency" value={f.currency} onChange={set('currency')}><option>USD</option><option>SGD</option></SelectField>
              <MoneyField label="Amount" currency={f.currency} value={f.amount} onValueChange={(v) => setF({ ...f, amount: v })} required />
              <DatePicker label="Issue date" value={f.issueDate || null} onChange={(v) => setF({ ...f, issueDate: v ?? '' })} required />
              <DatePicker label="Due date" value={f.dueDate || null} onChange={(v) => setF({ ...f, dueDate: v ?? '' })} min={f.issueDate || undefined} required />
            </FormGrid>
            <div><Button type="submit" variant="primary">Create draft</Button></div>
          </form>
        </Panel>
        <Panel title="Import" sub="Paste CSV (columns: buyer, number, currency, amount, issueDate, dueDate, poNumber). Valid rows are created; bad rows are listed.">
          <TextareaField label="CSV" value={csv} onChange={(e) => setCsv(e.target.value)} className="mono" rows={6} />
          <div className="row-actions">
            <Button variant="primary" onClick={importCsv}>Import CSV</Button>
            <Button onClick={importErp}>Import from ERP / e-invoice portal</Button>
          </div>
          {report && (
            <>
              <Alert tone="success" title={`${report.created.length} invoice(s) created: ${report.created.map((c) => c.humanId).join(', ') || '—'}`} />
              {report.errors.map((e) => <Alert key={e.row} tone="danger" title={`Row ${e.row}: ${e.message}`} />)}
              <Link to="/invoices?status=Draft">View drafts</Link>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
