import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function UsersPage() {
  const q = useQuery({ queryKey: ['org-users'], queryFn: async () => (await api.GET('/api/v1/org/users')).data ?? [] });
  return (
    <section>
      <h2>Users</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>MFA</th></tr></thead>
        <tbody>{(q.data ?? []).map((u) => <tr key={u.userId}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.mfaEnabled ? 'on' : 'off'}</td></tr>)}</tbody>
      </table>
    </section>
  );
}
