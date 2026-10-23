import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../db/pool';
import type { Services } from '../services';
import { can, isPlatformRole, type OrgType, type Permission, type Role } from '../modules/identity/permissions';
import { DomainError, forbidden } from '../kernel/errors';

export interface AuthInfo {
  sessionId: string;
  userId: string;
  email: string;
  userName: string;
  orgId: string | null;
  orgType: OrgType | null;
  orgName: string | null;
  role: Role | null;
  mfaVerified: boolean;
  mfaEnabled: boolean;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    svc: Services;
  }
  interface FastifyRequest {
    auth?: AuthInfo;
    ctx: Ctx;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Any logged-in session (password stage is enough, e.g. for MFA enrolment). */
export async function requireSession(req: FastifyRequest, _reply: FastifyReply) {
  if (!req.auth) throw new DomainError('unauthenticated', 'Please sign in.', 401);
  if (MUTATING.has(req.method) && req.headers['x-csrf-token'] !== req.auth.csrfToken) {
    throw new DomainError('csrf', 'Missing or invalid CSRF token.', 403);
  }
}

/** Fully authenticated: password + MFA, with an active organisation. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  await requireSession(req, reply);
  if (!req.auth!.mfaVerified) throw new DomainError('mfa_required', 'Multi-factor verification is required.', 401);
  if (!req.auth!.orgId || !req.auth!.role) throw new DomainError('no_org', 'No active organisation for this session.', 403);
}

export const requirePerm = (perm: Permission) => async (req: FastifyRequest, reply: FastifyReply) => {
  await requireUser(req, reply);
  if (!can(req.auth!.role!, perm)) throw forbidden(`Your role (${req.auth!.role}) cannot do this (${perm}).`);
};

export const requireOrgType = (...types: OrgType[]) => async (req: FastifyRequest, reply: FastifyReply) => {
  await requireUser(req, reply);
  if (!types.includes(req.auth!.orgType!)) throw forbidden(`This action is for ${types.join(' / ')} organisations.`);
};

/** Build the cross-tenant context for platform staff. Callers must audit what they do with it. */
export function platformCtx(req: FastifyRequest): Ctx {
  if (!isPlatformRole(req.auth?.role ?? undefined)) throw forbidden('Only platform staff can access cross-tenant data.');
  return { ...req.ctx, platform: true };
}
