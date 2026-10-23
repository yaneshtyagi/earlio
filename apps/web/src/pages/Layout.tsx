import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setLang, type Lang } from '../i18n';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { navFor } from '../shared/nav';
import { BrandMark } from '../branding';
import { NotificationBell } from './SettlementPages';

/** Wide tables scroll sideways on a phone; a scrollable region must be reachable from the keyboard. */
function useScrollableTables() {
  useEffect(() => {
    const mark = () => document.querySelectorAll('table').forEach((t) => { if (!t.hasAttribute('tabindex')) { t.setAttribute('tabindex', '0'); t.setAttribute('role', 'table'); } });
    mark();
    const mo = new MutationObserver(mark);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
}

export function Layout() {
  useScrollableTables();
  const { me, signOut, refresh } = useAuth();
  const { t, i18n } = useTranslation();
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
        <BrandMark />
        <span className="org">{me.activeOrg.legalName} <small>({me.activeOrg.type}, {me.role})</small></span>
        <span className="spacer" />
        <NotificationBell />
        {me.memberships.length > 1 && (
          <select aria-label="Switch organisation" value={me.activeOrg.id} onChange={(e) => switchOrg(e.target.value)}>
            {me.memberships.map((m) => <option key={m.orgId} value={m.orgId}>{m.orgName} — {m.role}</option>)}
          </select>
        )}
        <label className="lang"><span className="sr-only">{t('Language')}</span><select aria-label={t('Language')} value={i18n.language} onChange={(e) => setLang(e.target.value as Lang)}><option value="en">English</option><option value="hi">हिन्दी</option></select></label>
        <button className="link" onClick={signOut}>{t('Sign out')}</button>
      </header>
      <div className="body">
        <nav aria-label="Main">
          {items.map((i) => <NavLink key={i.to} to={i.to} end={i.to === '/'}>{t(i.label)}</NavLink>)}
        </nav>
        <main><Outlet /></main>
      </div>
    </div>
  );
}
