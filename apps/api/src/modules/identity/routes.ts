import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { requireSession, requireUser, requirePerm, type AuthInfo } from '../../http/context';
import { DomainError, conflict, forbidden, invalid } from '../../kernel/errors';
import { hashPassword, hashToken, newToken, verifyPassword } from '../../kernel/password';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../../kernel/totp';
import { audit } from '../../platform/audit';
import { PERMISSIONS, ROLES, ORG_TYPES } from './permissions';
import { addMember, orgPrivate, orgPublic } from './service';
import { demoTotpSecret } from './seed';
import { isDevLike } from '../../kernel/config';

const SESSION_HOURS = 8;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const orgPublicSchema = z.object({
  id: z.string(), type: z.enum(ORG_TYPES), legalName: z.string(), country: z.string(),
  ratingTier: z.enum(['AA', 'A', 'BBB']).nullable(), isPartner: z.boolean(),
});
const orgPrivateSchema = orgPublicSchema.extend({
  small: z.boolean(), msme: z.boolean(), dataRegion: z.string(), kycStatus: z.string(), sanctionsStatus: z.string(),
  blocked: z.boolean(), borrowingRate: z.string().nullable(), branding: z.record(z.string(), z.unknown()), hostname: z.string().nullable(),
});
const meSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  mfaEnabled: z.boolean(),
  mfaVerified: z.boolean(),
  csrfToken: z.string(),
  activeOrg: orgPublicSchema.nullable(),
  role: z.enum(ROLES).nullable(),
  permissions: z.array(z.string()),
  memberships: z.array(z.object({ orgId: z.string(), orgName: z.string(), orgType: z.enum(ORG_TYPES), role: z.enum(ROLES) })),
});

export function identityRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const loginLimit = svc.config.env === 'test' ? 10_000 : Number(process.env.LOGIN_RATE_LIMIT ?? 10);

  async function loadMe(userId: string, auth: AuthInfo) {
    return svc.db.tx({ userId, correlationId: 'me' }, async (tx) => {
      const ms = await tx.query<any>(
        `select m.org_id, m.role, o.legal_name, o.type from identity.memberships m join identity.organisations o on o.id = m.org_id where m.user_id = $1 order by m.created_at`, [userId]);
      const active = auth.orgId ? await tx.maybe<any>('select * from identity.organisations where id = $1', [auth.orgId]) : undefined;
      return { ms, active };
    });
  }

  r.post('/api/v1/auth/login', {
    config: { rateLimit: { max: loginLimit, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'], summary: 'Password login (step 1; MFA follows)',
      body: z.object({ email: z.string().email(), password: z.string().min(1) }),
      response: { 200: z.object({ mfaEnrolled: z.boolean(), mfaVerified: z.literal(false), csrfToken: z.string() }) },
    },
  }, async (req, reply) => {
    const now = svc.clock.now();
    const email = req.body.email.trim().toLowerCase();
    const result = await svc.db.tx({ correlationId: req.id }, async (tx) => {
      const user = await tx.maybe<any>('select * from identity.users where email = $1 for update', [email]);
      const bad = () => new DomainError('invalid_credentials', 'Email or password is incorrect.', 401);
      if (!user) throw bad();
      if (user.locked_until && new Date(user.locked_until) > now) {
        throw new DomainError('locked', 'This account is temporarily locked after repeated failed attempts. Try again later.', 423);
      }
      const ok = await verifyPassword(req.body.password, user.password_hash);
      // The failed-attempt counter must survive the rollback, so it is recorded in the catch below.
      if (!ok) throw Object.assign(bad(), { persist: true });
      await tx.query('update identity.users set failed_attempts = 0, locked_until = null where id = $1', [user.id]);
      const token = newToken();
      const csrf = randomBytes(24).toString('base64url');
      await tx.query(
        'insert into identity.sessions (id, user_id, org_id, mfa_verified, csrf_token, expires_at, created_at) values ($1,$2,null,false,$3,$4,$5)',
        [hashToken(token), user.id, csrf, new Date(now.getTime() + SESSION_HOURS * 3_600_000), now]);
      await audit(tx, { userId: user.id, correlationId: req.id }, now, { action: 'auth.login_password_ok', entityType: 'user', entityId: user.id, orgId: null });
      return { token, csrf, mfaEnrolled: !!user.mfa_enabled };
    }).catch(async (e) => {
      if ((e as any).persist) {
        // The failed-attempt counter must survive the rollback: redo it in its own transaction.
        await svc.db.tx({ correlationId: req.id }, async (tx) => {
          const u = await tx.maybe<any>('select id, failed_attempts from identity.users where email = $1 for update', [email]);
          if (u) {
            const attempts = u.failed_attempts + 1;
            const lock = attempts >= MAX_FAILED ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;
            await tx.query('update identity.users set failed_attempts = $2, locked_until = $3 where id = $1', [u.id, lock ? 0 : attempts, lock]);
            await audit(tx, { userId: u.id, correlationId: req.id }, now, { action: 'auth.login_failed', entityType: 'user', entityId: u.id, orgId: null, after: { attempts, locked: !!lock } });
          }
        });
      }
      throw e;
    });
    reply.setCookie('earlio_sid', result.token, {
      httpOnly: true, sameSite: 'lax', secure: svc.config.cookieSecure, path: '/', maxAge: SESSION_HOURS * 3600,
    });
    return { mfaEnrolled: result.mfaEnrolled, mfaVerified: false as const, csrfToken: result.csrf };
  });

  r.post('/api/v1/auth/mfa/enroll', {
    preHandler: requireSession,
    schema: {
      tags: ['auth'], summary: 'Start TOTP enrolment (returns the secret once)',
      response: { 200: z.object({ secret: z.string(), otpauthUrl: z.string() }) },
    },
  }, async (req) => {
    const a = req.auth!;
    if (a.mfaEnabled) throw conflict('mfa_already_enrolled', 'MFA is already enrolled for this user.');
    const secret = newTotpSecret();
    await svc.db.system((tx) => tx.query('update identity.users set mfa_secret = $2 where id = $1', [a.userId, secret]));
    return { secret, otpauthUrl: otpauthUrl(secret, a.email) };
  });

  r.post('/api/v1/auth/mfa/verify', {
    preHandler: requireSession,
    config: { rateLimit: { max: loginLimit, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'], summary: 'Verify a TOTP code or a recovery code; completes sign-in',
      body: z.object({ code: z.string().min(6).max(32) }),
      response: { 200: z.object({ mfaVerified: z.literal(true), recoveryCodes: z.array(z.string()).nullable(), activeOrgId: z.string().nullable() }) },
    },
  }, async (req) => {
    const a = req.auth!;
    const now = svc.clock.now();
    return svc.db.tx({ userId: a.userId, correlationId: req.id }, async (tx) => {
      const u = await tx.one<any>('select * from identity.users where id = $1 for update', [a.userId]);
      if (!u.mfa_secret) throw invalid('Start MFA enrolment first.');
      let ok = verifyTotp(u.mfa_secret, req.body.code, now.getTime());
      let newCodes: string[] | null = null;
      if (!ok && u.mfa_enabled) {
        const hashes: string[] = u.recovery_codes;
        const h = hashToken(req.body.code);
        if (hashes.includes(h)) {
          ok = true;
          await tx.query('update identity.users set recovery_codes = $2 where id = $1', [u.id, JSON.stringify(hashes.filter((x) => x !== h))]);
        }
      }
      if (!ok) {
        await audit(tx, { userId: u.id, correlationId: req.id }, now, { action: 'auth.mfa_failed', entityType: 'user', entityId: u.id, orgId: null });
        throw new DomainError('invalid_code', 'That code is not valid.', 401);
      }
      if (!u.mfa_enabled) {
        newCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
        await tx.query('update identity.users set mfa_enabled = true, recovery_codes = $2 where id = $1', [u.id, JSON.stringify(newCodes.map(hashToken))]);
      }
      const first = await tx.maybe<{ org_id: string }>('select org_id from identity.memberships where user_id = $1 order by created_at limit 1', [u.id]);
      await tx.query('update identity.sessions set mfa_verified = true, org_id = coalesce(org_id, $2) where id = $1', [a.sessionId, first?.org_id ?? null]);
      await audit(tx, { userId: u.id, orgId: first?.org_id, correlationId: req.id }, now, { action: 'auth.login_complete', entityType: 'user', entityId: u.id, orgId: first?.org_id ?? null });
      return { mfaVerified: true as const, recoveryCodes: newCodes, activeOrgId: a.orgId ?? first?.org_id ?? null };
    });
  });

  r.get('/api/v1/auth/me', {
    preHandler: requireSession,
    schema: { tags: ['auth'], summary: 'Current session, memberships and permissions', response: { 200: meSchema } },
  }, async (req) => {
    const a = req.auth!;
    const { ms, active } = await loadMe(a.userId, a);
    return {
      user: { id: a.userId, email: a.email, name: a.userName },
      mfaEnabled: a.mfaEnabled, mfaVerified: a.mfaVerified, csrfToken: a.csrfToken,
      activeOrg: a.mfaVerified && active ? orgPublic(active) : null,
      role: a.mfaVerified ? a.role : null,
      permissions: a.mfaVerified && a.role ? [...PERMISSIONS[a.role]] : [],
      memberships: a.mfaVerified ? ms.map((m: any) => ({ orgId: m.org_id, orgName: m.legal_name, orgType: m.type, role: m.role })) : [],
    };
  });

  r.post('/api/v1/auth/switch-org', {
    preHandler: requireUser,
    schema: { tags: ['auth'], summary: 'Switch the active organisation', body: z.object({ orgId: z.string().uuid() }), response: { 200: z.object({ activeOrgId: z.string() }) } },
  }, async (req) => {
    const a = req.auth!;
    const now = svc.clock.now();
    await svc.db.tx({ userId: a.userId, correlationId: req.id }, async (tx) => {
      const m = await tx.maybe('select 1 from identity.memberships where user_id = $1 and org_id = $2', [a.userId, req.body.orgId]);
      if (!m) throw forbidden('You are not a member of that organisation.');
      await tx.query('update identity.sessions set org_id = $2 where id = $1', [a.sessionId, req.body.orgId]);
      await audit(tx, { userId: a.userId, orgId: req.body.orgId, correlationId: req.id }, now, { action: 'auth.switch_org', entityType: 'user', entityId: a.userId, orgId: req.body.orgId });
    });
    return { activeOrgId: req.body.orgId };
  });

  r.post('/api/v1/auth/logout', {
    preHandler: requireSession,
    schema: { tags: ['auth'], summary: 'End the session', response: { 200: z.object({ ok: z.literal(true) }) } },
  }, async (req, reply) => {
    await svc.db.system((tx) => tx.query('delete from identity.sessions where id = $1', [req.auth!.sessionId]));
    reply.clearCookie('earlio_sid', { path: '/' });
    return { ok: true as const };
  });

  r.get('/api/v1/org', {
    preHandler: requireUser,
    schema: { tags: ['organisation'], summary: 'The active organisation (full view)', response: { 200: orgPrivateSchema } },
  }, async (req) => {
    const row = await svc.db.tx(req.ctx, (tx) => tx.one('select * from identity.organisations where id = $1', [req.auth!.orgId]));
    return orgPrivate(row);
  });

  r.get('/api/v1/org/users', {
    preHandler: requirePerm('org:manage_users'),
    schema: { tags: ['organisation'], summary: 'Members of the active organisation',
      response: { 200: z.array(z.object({ userId: z.string(), email: z.string(), name: z.string(), role: z.enum(ROLES), mfaEnabled: z.boolean() })) } },
  }, async (req) => {
    const rows = await svc.db.tx(req.ctx, (tx) => tx.query<any>(
      `select u.id, u.email, u.name, u.mfa_enabled, m.role from identity.memberships m join identity.users u on u.id = m.user_id where m.org_id = $1 order by u.email`, [req.auth!.orgId]));
    return rows.map((x) => ({ userId: x.id, email: x.email, name: x.name, role: x.role, mfaEnabled: x.mfa_enabled }));
  });

  r.post('/api/v1/org/users', {
    preHandler: requirePerm('org:manage_users'),
    schema: { tags: ['organisation'], summary: 'Add a user (or an existing user) to the active organisation',
      body: z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(ROLES), password: z.string().optional() }),
      response: { 201: z.object({ userId: z.string(), membershipId: z.string() }) } },
  }, async (req, reply) => {
    const a = req.auth!;
    const out = await svc.db.tx(req.ctx, (tx) => addMember(tx, svc, req.ctx, { orgId: a.orgId!, orgType: a.orgType!, ...req.body }));
    reply.code(201);
    return out;
  });

  // Dev/demo helper so a demo user can be completed without an authenticator app.
  if (isDevLike(svc.config)) {
    r.get('/api/v1/dev/totp', {
      schema: { tags: ['dev'], summary: 'Current demo TOTP code for a seeded user (development only)',
        querystring: z.object({ email: z.string().email() }), response: { 200: z.object({ code: z.string() }) } },
    }, async (req) => {
      const { totpAt } = await import('../../kernel/totp');
      const u = await svc.db.system((tx) => tx.maybe<any>('select mfa_secret from identity.users where email = $1', [req.query.email.toLowerCase()]));
      const secret = u?.mfa_secret ?? demoTotpSecret(req.query.email.toLowerCase());
      return { code: totpAt(secret, svc.clock.now().getTime()) };
    });
  }
}
