export const ROLES = [
  'Admin', 'FinanceUser', 'Approver', 'Viewer',
  'CreditOfficer', 'Operations', 'RelationshipManager',
  'Underwriter', 'ClaimsHandler',
  'PlatformAdmin', 'Auditor',
] as const;
export type Role = (typeof ROLES)[number];

export const ORG_TYPES = ['supplier', 'buyer', 'bank', 'insurer', 'platform'] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export type Permission =
  | 'read' | 'org:manage_users' | 'org:settings'
  | 'kyc:submit' | 'kyc:review' | 'sanctions:review'
  | 'relationship:propose' | 'relationship:approve'
  | 'limits:manage'
  | 'invoice:create' | 'invoice:accept' | 'discount:manage' | 'dispute:raise' | 'dispute:decide'
  | 'financing:consent' | 'offer:submit'
  | 'cover:decide' | 'claim:file' | 'claim:decide'
  | 'terms:edit' | 'terms:publish'
  | 'settlement:operate' | 'audit:read' | 'platform:admin';

/** Permission matrix (POC plan A-22). Covered by a test so changes are deliberate. */
export const PERMISSIONS: Record<Role, readonly Permission[]> = {
  Admin: ['read', 'org:manage_users', 'org:settings', 'kyc:submit', 'relationship:propose'],
  FinanceUser: ['read', 'invoice:create', 'kyc:submit', 'relationship:propose', 'discount:manage', 'dispute:raise'],
  Approver: ['read', 'invoice:accept', 'financing:consent', 'relationship:approve', 'terms:publish', 'dispute:raise'],
  Viewer: ['read'],
  CreditOfficer: ['read', 'offer:submit', 'claim:file'],
  Operations: ['read', 'settlement:operate'],
  RelationshipManager: ['read', 'terms:edit', 'limits:manage', 'org:settings', 'relationship:propose'],
  Underwriter: ['read', 'cover:decide', 'terms:edit', 'limits:manage'],
  ClaimsHandler: ['read', 'claim:decide'],
  PlatformAdmin: ['read', 'org:manage_users', 'kyc:review', 'sanctions:review', 'dispute:decide', 'audit:read', 'platform:admin', 'terms:publish', 'terms:edit', 'settlement:operate'],
  Auditor: ['read', 'audit:read'],
};

export const ROLES_BY_ORG_TYPE: Record<OrgType, readonly Role[]> = {
  supplier: ['Admin', 'FinanceUser', 'Approver', 'Viewer'],
  buyer: ['Admin', 'FinanceUser', 'Approver', 'Viewer'],
  bank: ['Admin', 'FinanceUser', 'Approver', 'Viewer', 'CreditOfficer', 'Operations', 'RelationshipManager'],
  insurer: ['Admin', 'Approver', 'Viewer', 'Underwriter', 'ClaimsHandler'],
  platform: ['PlatformAdmin', 'Auditor'],
};

export const can = (role: Role | undefined, perm: Permission) => !!role && PERMISSIONS[role].includes(perm);
export const isPlatformRole = (role: Role | undefined) => role === 'PlatformAdmin' || role === 'Auditor';
