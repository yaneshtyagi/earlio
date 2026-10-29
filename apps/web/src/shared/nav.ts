export type OrgType = 'supplier' | 'buyer' | 'bank' | 'insurer' | 'platform';
export type NavIcon = 'layout-dashboard' | 'file-text' | 'inbox' | 'wallet' | 'banknote' | 'landmark' | 'shield-check' | 'users' | 'link' | 'settings' | 'clipboard-check' | 'history'
  | 'triangle-alert' | 'arrow-left-right' | 'sliders-horizontal' | 'trending-up' | 'receipt' | 'send' | 'file-check' | 'lock' | 'building-2' | 'chart-column' | 'refresh-cw' | 'search';
export interface NavItem { to: string; label: string; perm?: string; icon: NavIcon; group: string }

/** Role-aware navigation per organisation type. Milestones append items as their pages land. */
const USERS = { to: '/users', label: 'Users', perm: 'org:manage_users', icon: 'users', group: 'Account' } as const;
const ONBOARD = { to: '/onboarding', label: 'KYC application', icon: 'clipboard-check', group: 'Account' } as const;
const RELS = { to: '/relationships', label: 'Relationships', icon: 'link', group: 'Account' } as const;
const HOME = { to: '/', label: 'Home', icon: 'layout-dashboard', group: 'Overview' } as const;
const INVOICES = { to: '/invoices', label: 'Invoices', icon: 'file-text', group: 'Work' } as const;
const DISPUTES = { to: '/disputes', label: 'Disputes', icon: 'triangle-alert', group: 'Work' } as const;
export const NAV: Record<OrgType, NavItem[]> = {
  supplier: [HOME, INVOICES, DISPUTES, { to: '/recourse', label: 'What I owe', icon: 'wallet', group: 'Money' }, { to: '/export-proceeds', label: 'Export proceeds', icon: 'banknote', group: 'Money' }, ONBOARD, RELS, USERS],
  buyer: [HOME, { to: '/invoices?status=Submitted', label: 'Acceptance inbox', icon: 'inbox', group: 'Work' }, INVOICES, DISPUTES, { to: '/payments', label: 'Payments due', icon: 'wallet', group: 'Money' }, ONBOARD, RELS, USERS],
  bank: [HOME, { to: '/bank/invitations', label: 'Invitations', icon: 'inbox', group: 'Work' }, DISPUTES,
    { to: '/settlement', label: 'Settlement', perm: 'settlement:operate', icon: 'arrow-left-right', group: 'Money' }, { to: '/recovery', label: 'Overdue and defaults', icon: 'triangle-alert', group: 'Money' }, { to: '/claims', label: 'Claims', icon: 'shield-check', group: 'Money' },
    { to: '/recourse', label: 'Recourse', icon: 'wallet', group: 'Money' }, { to: '/export-proceeds', label: 'Export proceeds', icon: 'banknote', group: 'Money' },
    { to: '/limits', label: 'Exposure limits', icon: 'sliders-horizontal', group: 'Controls' }, { to: '/terms', label: 'Terms studio', perm: 'terms:edit', icon: 'settings', group: 'Controls' }, { to: '/approvals', label: 'Approvals', perm: 'terms:publish', icon: 'clipboard-check', group: 'Controls' },
    { to: '/bank/console', label: 'Bank console', perm: 'org:settings', icon: 'building-2', group: 'Controls' }, { to: '/bank/integration', label: 'API and files', icon: 'send', group: 'Controls' }, ONBOARD, USERS],
  insurer: [HOME, { to: '/insurance/requests', label: 'Cover requests', icon: 'inbox', group: 'Work' }, { to: '/claims', label: 'Claims desk', perm: 'claim:decide', icon: 'shield-check', group: 'Work' },
    { to: '/insurance/limits', label: 'Buyer limits', icon: 'sliders-horizontal', group: 'Controls' }, { to: '/terms', label: 'Terms studio', perm: 'terms:edit', icon: 'settings', group: 'Controls' }, { to: '/approvals', label: 'Approvals', perm: 'terms:publish', icon: 'clipboard-check', group: 'Controls' }, ONBOARD, USERS],
  platform: [HOME, { to: '/admin/kyc', label: 'KYC queue', perm: 'kyc:review', icon: 'clipboard-check', group: 'Review' }, { to: '/admin/sanctions', label: 'Sanctions review', perm: 'sanctions:review', icon: 'shield-check', group: 'Review' },
    { to: '/disputes', label: 'Dispute queue', perm: 'dispute:decide', icon: 'triangle-alert', group: 'Review' }, { to: '/settlement', label: 'Settlement', perm: 'settlement:operate', icon: 'arrow-left-right', group: 'Review' },
    { to: '/admin/liens', label: 'Lien registry', perm: 'audit:read', icon: 'lock', group: 'Platform' }, { to: '/terms', label: 'Platform terms', perm: 'terms:edit', icon: 'settings', group: 'Platform' }, { to: '/approvals', label: 'Approvals', perm: 'platform:admin', icon: 'clipboard-check', group: 'Platform' },
    { to: '/admin/guardrails', label: 'Defaults and guardrails', perm: 'platform:admin', icon: 'sliders-horizontal', group: 'Platform' }, { to: '/admin/scorecard', label: 'Pilot scorecard', perm: 'audit:read', icon: 'chart-column', group: 'Insight' },
    { to: '/admin/network', label: 'Network map', perm: 'audit:read', icon: 'link', group: 'Insight' },
    { to: '/admin/control-room', label: 'Control room', perm: 'platform:admin', icon: 'refresh-cw', group: 'Insight' }, { to: '/admin/integrations', label: 'Integration inspector', perm: 'audit:read', icon: 'search', group: 'Insight' }, { to: '/audit', label: 'Audit log', perm: 'audit:read', icon: 'history', group: 'Insight' }, USERS],
};

export const navFor = (type: OrgType, permissions: string[]) => NAV[type].filter((i) => !i.perm || permissions.includes(i.perm));
