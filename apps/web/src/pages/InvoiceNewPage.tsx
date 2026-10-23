import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ensureOk, problemOf } from '../api/client';

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
    <section>
      <h2>New invoice</h2>
      {error && <p className="alert">{error}</p>}
      <div className="row">
        <form className="panel" onSubmit={create}>
          <h3>Enter an invoice</h3>
          <label>Buyer
            <select style={{ width: '100%' }} value={f.buyerOrgId} onChange={set('buyerOrgId')} required>
              <option value="">Choose…</option>{(buyers.data ?? []).map((r) => <option key={r.id} value={r.buyer.id}>{r.buyer.name}</option>)}
            </select>
          </label>
          <label>Invoice number<input value={f.number} onChange={set('number')} required /></label>
          <label>Purchase order
            <select style={{ width: '100%' }} value={f.poNumber} onChange={set('poNumber')}>
              <option value="">None (flagged)</option>{buyerPos.map((p) => <option key={p.id} value={p.number}>{p.number}</option>)}
            </select>
          </label>
          <div className="row">
            <label>Currency<select style={{ width: '100%' }} value={f.currency} onChange={set('currency')}><option>USD</option><option>SGD</option></select></label>
            <label>Amount<input value={f.amount} onChange={set('amount')} inputMode="decimal" required /></label>
          </div>
          <div className="row">
            <label>Issue date<input type="date" value={f.issueDate} onChange={set('issueDate')} required /></label>
            <label>Due date<input type="date" value={f.dueDate} onChange={set('dueDate')} required /></label>
          </div>
          <button type="submit">Create draft</button>
        </form>
        <div className="panel">
          <h3>Import</h3>
          <p className="hint">Paste CSV (columns: buyer, number, currency, amount, issueDate, dueDate, poNumber). Valid rows are created; bad rows are listed.</p>
          <textarea value={csv} onChange={(e) => setCsv(e.target.value)} />
          <p><button onClick={importCsv}>Import CSV</button> <button className="secondary" onClick={importErp}>Import from ERP / e-invoice portal</button></p>
          {report && (
            <>
              <p className="ok">{report.created.length} invoice(s) created: {report.created.map((c) => c.humanId).join(', ') || '—'}</p>
              {report.errors.map((e) => <p className="alert" key={e.row}>Row {e.row}: {e.message}</p>)}
              <Link to="/invoices?status=Draft">View drafts</Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
