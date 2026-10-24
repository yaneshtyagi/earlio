import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, DataTable, FilterChip, SearchInput } from '@yaneshtyagi/design-system';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Amt, NavButton, Page, StatusChip, dd, noRows } from '../ui';

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
  const title = isSupplier ? 'Invoices' : status === 'Submitted' ? 'Acceptance inbox' : 'Invoices addressed to us';
  const canCreate = isSupplier && me?.permissions.includes('invoice:create');
  return (
    <>
      <Page title={title} actions={canCreate ? <NavButton to="/invoices/new" variant="primary" icon="plus">New / import invoice</NavButton> : undefined} />
      <DataTable aria-label={title} noun="invoices" loading={list.isLoading} rowKey={(i) => i.id} rows={list.data ?? []}
        empty={noRows('No invoices here', status || q ? 'Nothing matches these filters. Choose All to see every invoice.' : undefined)}
        toolbar={<>
          {FILTERS.filter(([v]) => isSupplier || v !== 'Draft').map(([v, l]) => <FilterChip key={v} pressed={status === v} onClick={() => setParam('status', v)}>{l}</FilterChip>)}
          <span className="bv-table-toolbar__spacer" />
          <SearchInput key={q} aria-label="Search invoices" placeholder="Search number or party" defaultValue={q} onKeyDown={(e) => { if (e.key === 'Enter') setParam('q', (e.target as HTMLInputElement).value); }} />
        </>}
        columns={[
          { id: 'invoice', header: 'Invoice', rowHeader: true, cell: (i) => <><Link to={`/invoices/${i.humanId}`}>{i.humanId}</Link> <span className="hint">{i.number}</span>{i.warnings.length > 0 && <> <Badge tone="warning" icon="triangle-alert">Check</Badge></>}</> },
          { id: 'party', header: isSupplier ? 'Buyer' : 'Supplier', cell: (i) => (isSupplier ? i.buyer.name : i.supplier.name) },
          { id: 'issued', header: 'Issued', cell: (i) => dd(i.issueDate) },
          { id: 'due', header: 'Due', cell: (i) => dd(i.dueDate) },
          { id: 'amount', header: 'Amount', numeric: true, cell: (i) => <Amt v={i.acceptedAmount ?? i.grossAmount} c={i.currency} /> },
          { id: 'status', header: 'Status', cell: (i) => <StatusChip status={i.status} /> },
        ]} />
    </>
  );
}
