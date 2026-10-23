import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { navFor } from '../shared/nav';
import { NotificationBell } from './SettlementPages';

export function Layout() {
  const { me, signOut, refresh } = useAuth();
  const cfg = useQuery({ queryKey: ['config'], queryFn: async () => (await api.GET('/api/v1/system/config')).data });
  if (!me?.activeOrg) return null;
  const items = navFor(me.activeOrg.type, me.permissions);

  async function switchOrg(orgId: string) {
    await api.POST('/api/v1/auth/switch-org', { body: { orgId } });
    await refresh();
    window.location.assign('/');
  }

  return (
    <div className="shell">
      {cfg.data?.simulated && <div className="ribbon">Simulated environment — all names, rates and FX rates are fictional or illustrative</div>}
      <header>
        <strong>Earlio</strong>
        <span className="org">{me.activeOrg.legalName} <small>({me.activeOrg.type}, {me.role})</small></span>
        <span className="spacer" />
        <NotificationBell />
        {me.memberships.length > 1 && (
          <select aria-label="Switch organisation" value={me.activeOrg.id} onChange={(e) => switchOrg(e.target.value)}>
            {me.memberships.map((m) => <option key={m.orgId} value={m.orgId}>{m.orgName} — {m.role}</option>)}
          </select>
        )}
        <button className="link" onClick={signOut}>Sign out</button>
      </header>
      <div className="body">
        <nav aria-label="Main">
          {items.map((i) => <NavLink key={i.to} to={i.to} end={i.to === '/'}>{i.label}</NavLink>)}
        </nav>
        <main><Outlet /></main>
      </div>
    </div>
  );
}
