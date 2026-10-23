import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type { OrgType } from '../shared/nav';

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
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
    <section>
      <h2>Users</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>MFA</th></tr></thead>
        <tbody>{(q.data ?? []).map((u) => <tr key={u.userId}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.mfaEnabled ? 'on' : 'off'}</td></tr>)}</tbody>
      </table>
      <form className="panel" onSubmit={add}>
        <h3>Add a user</h3>
        <p className="hint">Give each person the role they need: the person who proposes a change cannot be the one who approves it.</p>
        {msg && <p className={msg.ok ? 'ok' : 'alert'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        <div className="grid2">
          <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
          <label>Work email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
          <label>Role<select value={role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r}>{r}</option>)}</select></label>
          <label>Starting password<input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="new-password" /></label>
        </div>
        <button>Add user</button>
      </form>
    </section>
  );
}
