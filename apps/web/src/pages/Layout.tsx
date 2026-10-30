import { useEffect, useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Alert, AppIdentity, AppShell, Avatar, Button, Menu, initialsOf, type MenuEntry, type NavGroup } from '@yaneshtyagi/design-system';
import { setLang, type Lang } from '../i18n';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { navFor } from '../shared/nav';
import { APP_VERSION, EarlioMark, useBrand } from '../branding';
import { routerLink } from '../ui';

/** Wide tables scroll sideways on a phone; a scrollable region must be reachable from the keyboard. */
function useScrollableTables() {
  useEffect(() => {
    const mark = () => document.querySelectorAll<HTMLElement>('.bv-table-scroll').forEach((s) => {
      if (s.hasAttribute('tabindex')) return;
      s.setAttribute('tabindex', '0');
      s.setAttribute('role', 'region');
      s.setAttribute('aria-label', s.querySelector('table')?.getAttribute('aria-label') ?? 'Table');
    });
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
  const brand = useBrand();
  const nav = useNavigate();
  const loc = useLocation();
  const cfg = useQuery({ queryKey: ['config'], queryFn: async () => (await api.GET('/api/v1/system/config')).data });
  const unread = useQuery({ queryKey: ['notifications'], queryFn: async () => (await api.GET('/api/v1/notifications', { params: { query: {} } })).data, refetchInterval: 15_000 });

  const items = me?.activeOrg ? navFor(me.activeOrg.type, me.permissions) : [];
  const groups: NavGroup[] = useMemo(() => {
    const here = loc.pathname + loc.search;
    // A link that carries its own filter (the acceptance inbox) wins over the plain list it belongs to.
    const exact = items.find((i) => i.to.includes('?') && i.to === here);
    const isCurrent = (to: string) => (exact ? to === exact.to : !to.includes('?') && (to === '/' ? loc.pathname === '/' : loc.pathname === to || loc.pathname.startsWith(to + '/')));
    const order: string[] = [];
    const byGroup = new Map<string, NavGroup['items']>();
    for (const i of items) {
      if (!byGroup.has(i.group)) { byGroup.set(i.group, []); order.push(i.group); }
      byGroup.get(i.group)!.push({ id: i.to, label: t(i.label), icon: i.icon, href: i.to, current: isCurrent(i.to) });
    }
    return order.map((g) => ({ caption: t(g), items: byGroup.get(g)! }));
  }, [items.map((i) => i.to).join('|'), loc.pathname, loc.search, i18n.language]);

  if (!me?.activeOrg) return null;
  const org = me.activeOrg;
  const others = me.memberships.filter((m) => m.orgId !== org.id);

  async function switchOrg(orgId: string) {
    await api.POST('/api/v1/auth/switch-org', { body: { orgId } });
    await refresh();
    window.location.assign('/');
  }

  const menu: MenuEntry[] = [
    ...others.map((m) => ({ id: `org-${m.orgId}`, label: `${t('Switch to')} ${m.orgName} — ${m.role}`, icon: 'building-2' as const, onSelect: () => void switchOrg(m.orgId) })),
    ...(others.length ? ['separator' as const] : []),
    { id: 'lang', label: i18n.language === 'hi' ? 'English' : 'हिन्दी', icon: 'refresh-cw' as const, onSelect: () => setLang((i18n.language === 'hi' ? 'en' : 'hi') as Lang) },
    'separator',
    { id: 'signout', label: t('Sign out'), icon: 'log-out' as const, onSelect: () => void signOut() },
  ];

  return (
    <AppShell
      sidebar={{
        'aria-label': 'Main',
        productName: brand.displayName,
        subtitle: brand.whiteLabel ? 'Powered by Earlio' : 'Developed by BrainVault',
        version: APP_VERSION,
        // A bank's uploaded logo sits beside its name, as the Earlio mark does on the network.
        logo: brand.logo ? <AppIdentity name={brand.displayName} subtitle="Powered by Earlio" version={APP_VERSION} logo={<img className="brand-logo" src={brand.logo} alt="" height={28} />} />
          : brand.whiteLabel ? undefined
          : <AppIdentity name={brand.displayName} subtitle="Developed by BrainVault" version={APP_VERSION} logo={<EarlioMark size={28} />} />,
        // The design system types collapsedMark as a string but renders it as a child, so the network can show its mark.
        collapsedMark: brand.logo || brand.whiteLabel ? brand.displayName.slice(0, 2).toUpperCase()
          : (<><EarlioMark size={28} /><span className="bv-sr-only">{brand.displayName}</span></>) as unknown as string,
        groups,
        linkComponent: routerLink,
        user: { name: me.user.name, role: `${org.legalName} · ${me.role ?? org.type}` },
      }}
      topbar={{
        searchPlaceholder: t('Search invoices'),
        onSearch: (q) => nav(q.trim() ? `/invoices?q=${encodeURIComponent(q.trim())}` : '/invoices'),
        notificationCount: unread.data?.unread ?? 0,
        onNotifications: () => nav('/notifications'),
        user: (
          <Menu aria-label={t('Account')} align="end" items={menu}
            // The name starts with the initials the avatar shows, so the visible label is part of it (WCAG 2.5.3, axe label-content-name-mismatch).
            trigger={<Button variant="ghost" aria-label={`${initialsOf(me.user.name)}, ${t('Account')}: ${me.user.name}`}><Avatar name={me.user.name} size="sm" decorative /></Button>} />
        ),
      }}
    >
      {cfg.data?.simulated && (
        <Alert tone="warning" title="Simulated environment">All names, rates and FX rates are fictional or illustrative.</Alert>
      )}
      <Outlet />
    </AppShell>
  );
}
