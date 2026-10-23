import { useAuth } from '../auth/AuthContext';

export function HomePage() {
  const { me } = useAuth();
  if (!me?.activeOrg) return null;
  return (
    <section>
      <h2>Welcome, {me.user.name}</h2>
      <p>You are signed in to <strong>{me.activeOrg.legalName}</strong> as <strong>{me.role}</strong>.</p>
      <h3>What your role can do</h3>
      <ul>{me.permissions.map((p) => <li key={p}><code>{p}</code></li>)}</ul>
    </section>
  );
}
