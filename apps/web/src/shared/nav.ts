export type OrgType = 'supplier' | 'buyer' | 'bank' | 'insurer' | 'platform';
export interface NavItem { to: string; label: string; perm?: string }

/** Role-aware navigation per organisation type. Milestones append items as their pages land. */
export const NAV: Record<OrgType, NavItem[]> = {
  supplier: [{ to: '/', label: 'Home' }, { to: '/users', label: 'Users', perm: 'org:manage_users' }],
  buyer: [{ to: '/', label: 'Home' }, { to: '/users', label: 'Users', perm: 'org:manage_users' }],
  bank: [{ to: '/', label: 'Home' }, { to: '/users', label: 'Users', perm: 'org:manage_users' }],
  insurer: [{ to: '/', label: 'Home' }, { to: '/users', label: 'Users', perm: 'org:manage_users' }],
  platform: [{ to: '/', label: 'Home' }, { to: '/audit', label: 'Audit log', perm: 'audit:read' }, { to: '/users', label: 'Users', perm: 'org:manage_users' }],
};

export const navFor = (type: OrgType, permissions: string[]) => NAV[type].filter((i) => !i.perm || permissions.includes(i.perm));
