export type OrgType = 'supplier' | 'buyer' | 'bank' | 'insurer' | 'platform';
export interface NavItem { to: string; label: string; perm?: string }

/** Role-aware navigation per organisation type. Milestones append items as their pages land. */
const USERS = { to: '/users', label: 'Users', perm: 'org:manage_users' };
const ONBOARD = { to: '/onboarding', label: 'KYC application' };
const RELS = { to: '/relationships', label: 'Relationships' };
const INVOICES = { to: '/invoices', label: 'Invoices' };
export const NAV: Record<OrgType, NavItem[]> = {
  supplier: [{ to: '/', label: 'Home' }, INVOICES, ONBOARD, RELS, USERS],
  buyer: [{ to: '/', label: 'Home' }, { to: '/invoices?status=Submitted', label: 'Acceptance inbox' }, INVOICES, { to: '/payments', label: 'Payments due' }, ONBOARD, RELS, USERS],
  bank: [{ to: '/', label: 'Home' }, { to: '/bank/invitations', label: 'Invitations' }, { to: '/settlement', label: 'Settlement', perm: 'settlement:operate' }, ONBOARD, { to: '/limits', label: 'Exposure limits' }, USERS],
  insurer: [{ to: '/', label: 'Home' }, { to: '/insurance/requests', label: 'Cover requests' }, { to: '/insurance/limits', label: 'Buyer limits' }, ONBOARD, USERS],
  platform: [{ to: '/', label: 'Home' }, { to: '/admin/kyc', label: 'KYC queue', perm: 'kyc:review' }, { to: '/admin/sanctions', label: 'Sanctions review', perm: 'sanctions:review' },
    { to: '/admin/liens', label: 'Lien registry', perm: 'audit:read' }, { to: '/settlement', label: 'Settlement', perm: 'settlement:operate' }, { to: '/admin/control-room', label: 'Control room', perm: 'platform:admin' },
    { to: '/admin/integrations', label: 'Integration inspector', perm: 'audit:read' }, { to: '/audit', label: 'Audit log', perm: 'audit:read' }, USERS],
};

export const navFor = (type: OrgType, permissions: string[]) => NAV[type].filter((i) => !i.perm || permissions.includes(i.perm));
