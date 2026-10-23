import type { Ctx, Tx } from '../../db/pool';
import { audit } from '../../platform/audit';
import { DomainError, conflict, invalid } from '../../kernel/errors';
import { hashPassword, passwordPolicyError } from '../../kernel/password';
import { ROLES_BY_ORG_TYPE, type OrgType, type Role } from './permissions';
import type { Services } from '../../services';

export interface OrgInput {
  type: OrgType;
  legalName: string;
  country: string;
  small?: boolean;
  msme?: boolean;
  turnoverInr?: string | null;
  ratingTier?: 'AA' | 'A' | 'BBB' | null;
  dataRegion?: string;
  borrowingRate?: string | null;
  isPartner?: boolean;
  hostname?: string | null;
  branding?: Record<string, unknown>;
  kycStatus?: string;
  sanctionsStatus?: string;
  blocked?: boolean;
}

/** Threshold below which a supplier is "small" (BR-11). Configurable; verify real thresholds with counsel. */
export const SMALL_SUPPLIER_TURNOVER_INR = 250_000_000; // INR 25 crore

export async function createOrganisation(tx: Tx, svc: Services, ctx: Ctx, input: OrgInput) {
  const now = svc.clock.now();
  const small =
    input.type === 'supplier'
      ? (input.small ?? (!!input.msme || (input.turnoverInr != null && Number(input.turnoverInr) < SMALL_SUPPLIER_TURNOVER_INR)))
      : false;
  const row = await tx.one<{ id: string }>(
    `insert into identity.organisations
      (type, legal_name, country, small, msme, turnover_inr, rating_tier, data_region, borrowing_rate, is_partner, hostname, branding, kyc_status, sanctions_status, blocked, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [input.type, input.legalName, input.country, small, input.msme ?? false, input.turnoverInr ?? null, input.ratingTier ?? null,
     input.dataRegion ?? (input.country === 'IN' ? 'IN' : input.country), input.borrowingRate ?? null, input.isPartner ?? false,
     input.hostname ?? null, JSON.stringify(input.branding ?? {}), input.kycStatus ?? 'not_started', input.sanctionsStatus ?? 'not_screened', input.blocked ?? false, now],
  );
  await audit(tx, ctx, now, { action: 'organisation.created', entityType: 'organisation', entityId: row.id, orgId: row.id, after: { type: input.type, legalName: input.legalName } });
  return row.id;
}

export interface AddMemberInput {
  orgId: string;
  orgType: OrgType;
  email: string;
  name: string;
  role: Role;
  /** Required when the user does not exist yet. */
  password?: string;
  passwordHash?: string;
  mfaSecret?: string;
  mfaEnabled?: boolean;
}

export async function addMember(tx: Tx, svc: Services, ctx: Ctx, input: AddMemberInput) {
  if (!ROLES_BY_ORG_TYPE[input.orgType].includes(input.role)) {
    throw invalid(`The role ${input.role} is not available for ${input.orgType} organisations.`);
  }
  const now = svc.clock.now();
  const email = input.email.trim().toLowerCase();
  let user = await tx.maybe<{ id: string }>('select id from identity.users where email = $1', [email]);
  if (!user) {
    let hash = input.passwordHash;
    if (!hash) {
      if (!input.password) throw invalid('A password is required for a new user.');
      const err = passwordPolicyError(input.password);
      if (err) throw invalid(err);
      hash = await hashPassword(input.password);
    }
    user = await tx.one<{ id: string }>(
      `insert into identity.users (email, name, password_hash, mfa_secret, mfa_enabled, created_at) values ($1,$2,$3,$4,$5,$6) returning id`,
      [email, input.name, hash, input.mfaSecret ?? null, input.mfaEnabled ?? false, now],
    );
  }
  const existing = await tx.maybe('select 1 from identity.memberships where user_id = $1 and org_id = $2', [user.id, input.orgId]);
  if (existing) throw conflict('already_member', 'This user already belongs to the organisation.');
  const m = await tx.one<{ id: string }>(
    'insert into identity.memberships (user_id, org_id, role, created_at) values ($1,$2,$3,$4) returning id',
    [user.id, input.orgId, input.role, now],
  );
  await audit(tx, ctx, now, { action: 'membership.created', entityType: 'membership', entityId: m.id, orgId: input.orgId, after: { email, role: input.role } });
  return { userId: user.id, membershipId: m.id };
}

export const orgPublic = (o: any) => ({
  id: o.id as string,
  type: o.type as OrgType,
  legalName: o.legal_name as string,
  country: o.country as string,
  ratingTier: (o.rating_tier ?? null) as 'AA' | 'A' | 'BBB' | null,
  isPartner: !!o.is_partner,
});

/** Full view, only for the organisation itself and platform staff. */
export const orgPrivate = (o: any) => ({
  ...orgPublic(o),
  small: !!o.small,
  msme: !!o.msme,
  dataRegion: o.data_region as string,
  kycStatus: o.kyc_status as string,
  sanctionsStatus: o.sanctions_status as string,
  blocked: !!o.blocked,
  borrowingRate: o.borrowing_rate as string | null,
  branding: o.branding as Record<string, unknown>,
  hostname: (o.hostname ?? null) as string | null,
});

export { DomainError };
