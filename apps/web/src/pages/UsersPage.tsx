import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DataTable, FormGrid, SelectField, TextField } from '@yaneshtyagi/design-system';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { OrgType } from '../shared/nav';
import { Notice, Page, Panel, StatusChip, noRows, type Msg } from '../ui';

const ROLES: Record<OrgType, string[]> = {
  supplier: ['Admin', 'FinanceUser', 'Approver', 'Viewer'], buyer: ['Admin', 'FinanceUser', 'Approver', 'Viewer'],
  bank: ['Admin', 'FinanceUser', 'Approver', 'Viewer', 'CreditOfficer', 'Operations', 'RelationshipManager'],
  insurer: ['Admin', 'Approver', 'Viewer', 'Underwriter', 'ClaimsHandler'], platform: ['PlatformAdmin', 'Auditor'],
};

export function UsersPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org-users'], queryFn: async () => (await api.GET('/api/v1/org/users')).data ?? [] });
  const [f, setF] = useState({ email: '', name: '', role: '', password: '' });
  const [msg, setMsg] = useState<Msg>(null);
  const roles = ROLES[me?.activeOrg?.type ?? 'supplier'];
  const role = f.role || roles[0]!;
  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      await ensureOk(await api.POST('/api/v1/org/users', { body: { email: f.email, name: f.name, role: role as any, password: f.password || undefined } }));
      setMsg({ ok: true, text: `${f.name} was added. They set up their authenticator the first time they sign in.` }); setF({ email: '', name: '', role: '', password: '' });
      await qc.invalidateQueries({ queryKey: ['org-users'] });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  }
  return (
    <>
      <Page title="Users" />
      <DataTable aria-label="Users" noun="users" loading={q.isLoading} rowKey={(u) => u.userId} rows={q.data ?? []} empty={noRows('No users yet')}
        columns={[
          { id: 'name', header: 'Name', rowHeader: true, cell: (u) => u.name },
          { id: 'email', header: 'Email', cell: (u) => u.email },
          { id: 'role', header: 'Role', cell: (u) => u.role },
          { id: 'mfa', header: 'MFA', cell: (u) => <StatusChip status={u.mfaEnabled ? 'on' : 'off'}>{u.mfaEnabled ? 'on' : 'off'}</StatusChip> },
        ]} />
      <Panel title="Add a user" sub="Give each person the role they need: the person who proposes a change cannot be the one who approves it.">
        <form className="stack-3" onSubmit={add}>
          <Notice msg={msg} />
          <FormGrid>
            <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            <TextField label="Work email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
            <SelectField label="Role" value={role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r}>{r}</option>)}</SelectField>
            <TextField label="Starting password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="new-password" />
          </FormGrid>
          <div><Button type="submit" variant="primary">Add user</Button></div>
        </form>
      </Panel>
    </>
  );
}
