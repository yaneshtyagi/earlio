import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatMoney } from '../shared/money';

const FILTERS = [['', 'All'], ['Draft', 'Draft'], ['Submitted', 'Awaiting acceptance'], ['Accepted', 'Accepted'], ['Rejected', 'Rejected'], ['Disputed', 'Disputed']] as const;

export function InvoicesPage() {
  const { me } = useAuth();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const q = sp.get('q') ?? '';
  const list = useQuery({
    queryKey: ['invoices', status, q],
    queryFn: async () => (await api.GET('/api/v1/invoices', { params: { query: { ...(status ? { status } : {}), ...(q ? { q } : {}) } } })).data?.items ?? [],
  });
  const isSupplier = me?.activeOrg?.type === 'supplier';
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(sp); v ? n.set(k, v) : n.delete(k); setSp(n); };
  return (
    <section>
      <h2>{isSupplier ? 'Invoices' : status === 'Submitted' ? 'Acceptance inbox' : 'Invoices addressed to us'}</h2>
      <div className="filters">
        {FILTERS.filter(([v]) => isSupplier || v !== 'Draft').map(([v, label]) => <button key={v} className={status === v ? 'on' : ''} onClick={() => setParam('status', v)}>{label}</button>)}
        <input style={{ maxWidth: 240 }} placeholder="Search number or party" defaultValue={q} onKeyDown={(e) => { if (e.key === 'Enter') setParam('q', (e.target as HTMLInputElement).value); }} />
        <span className="spacer" />
        {isSupplier && me?.permissions.includes('invoice:create') && <Link to="/invoices/new"><button>New / import invoice</button></Link>}
      </div>
      <table>
        <thead><tr><th>Invoice</th><th>{isSupplier ? 'Buyer' : 'Supplier'}</th><th>Issued</th><th>Due</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {(list.data ?? []).map((i) => (
            <tr key={i.id}>
              <td><Link to={`/invoices/${i.humanId}`}>{i.humanId}</Link> <span className="hint">{i.number}</span>{i.warnings.length > 0 && ' ⚠'}</td>
              <td>{isSupplier ? i.buyer.name : i.supplier.name}</td><td>{i.issueDate}</td><td>{i.dueDate}</td>
              <td className="num">{formatMoney(i.acceptedAmount ?? i.grossAmount, i.currency as 'USD')}</td>
              <td><span className={`chip ${i.status}`}>{i.status}</span></td>
            </tr>
          ))}
          {list.data?.length === 0 && <tr><td colSpan={6} className="muted">No invoices here.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
