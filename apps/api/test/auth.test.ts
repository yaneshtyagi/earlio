import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, login, loginAs, makeSession, type TestEnv } from './helpers';
import { demoEmail, DEMO_PASSWORD } from '../src/modules/identity/seed';
import { totpAt } from '../src/kernel/totp';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.close(); });

describe('authentication', () => {
  it('MFA cannot be skipped: a password-only session cannot reach protected routes', async () => {
    const email = demoEmail('shree', 'Admin');
    const l = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: DEMO_PASSWORD } });
    expect(l.statusCode).toBe(200);
    expect(l.json().mfaVerified).toBe(false);
    const cookie = `earlio_sid=${(l.cookies[0] as any).value}`;
    const s = makeSession(env, cookie, l.json().csrfToken);
    const org = await s.req('GET', '/api/v1/org');
    expect(org.status).toBe(401);
    expect(org.json.code).toBe('mfa_required');
    const me = await s.req('GET', '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.activeOrg).toBeNull();
    expect(me.json.permissions).toEqual([]);
  });

  it('completes sign-in with a valid TOTP and exposes role permissions', async () => {
    const s = await login(env, 'shree', 'Approver');
    const me = await s.req('GET', '/api/v1/auth/me');
    expect(me.json.activeOrg.legalName).toBe('Shree Textiles');
    expect(me.json.role).toBe('Approver');
    expect(me.json.permissions).toContain('invoice:accept');
    expect(me.json.permissions).not.toContain('invoice:create');
  });

  it('rejects a wrong TOTP code and a wrong password with a generic message', async () => {
    const email = demoEmail('shree', 'Viewer');
    const bad = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('invalid_credentials');
    const l = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: DEMO_PASSWORD } });
    const s = makeSession(env, `earlio_sid=${(l.cookies[0] as any).value}`, l.json().csrfToken);
    const v = await s.req('POST', '/api/v1/auth/mfa/verify', { code: '000000' });
    expect(v.status).toBe(401);
  });

  it('locks the account after five failed attempts', async () => {
    const email = demoEmail('kumar', 'Viewer');
    for (let i = 0; i < 5; i++) {
      const r = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'wrong-password' } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: DEMO_PASSWORD } });
    expect(locked.statusCode).toBe(423);
    env.clock.advanceHours(1); // lock expires
    const ok = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: DEMO_PASSWORD } });
    expect(ok.statusCode).toBe(200);
  });

  it('requires the CSRF token on mutating requests', async () => {
    const s = await login(env, 'shree', 'Admin');
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/switch-org', headers: { cookie: s.cookie }, payload: { orgId: env.ids.shree } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('csrf');
  });

  it('enrols MFA for a new user and issues one-time recovery codes', async () => {
    const admin = await login(env, 'shree', 'Admin');
    const created = await admin.req('POST', '/api/v1/org/users', { email: 'new.person@shree.demo', name: 'New Person', role: 'Viewer', password: 'Sup3rSecret!pw' });
    expect(created.status).toBe(201);
    const l = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'new.person@shree.demo', password: 'Sup3rSecret!pw' } });
    expect(l.json().mfaEnrolled).toBe(false);
    const s = makeSession(env, `earlio_sid=${(l.cookies[0] as any).value}`, l.json().csrfToken);
    const enroll = await s.req('POST', '/api/v1/auth/mfa/enroll');
    expect(enroll.json.otpauthUrl).toContain('otpauth://totp/');
    const verify = await s.req('POST', '/api/v1/auth/mfa/verify', { code: totpAt(enroll.json.secret, env.clock.now().getTime()) });
    expect(verify.status).toBe(200);
    expect(verify.json.recoveryCodes).toHaveLength(8);
    // A recovery code works exactly once.
    const code = verify.json.recoveryCodes[0];
    const l2 = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'new.person@shree.demo', password: 'Sup3rSecret!pw' } });
    const s2 = makeSession(env, `earlio_sid=${(l2.cookies[0] as any).value}`, l2.json().csrfToken);
    expect((await s2.req('POST', '/api/v1/auth/mfa/verify', { code })).status).toBe(200);
    const l3 = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'new.person@shree.demo', password: 'Sup3rSecret!pw' } });
    const s3 = makeSession(env, `earlio_sid=${(l3.cookies[0] as any).value}`, l3.json().csrfToken);
    expect((await s3.req('POST', '/api/v1/auth/mfa/verify', { code })).status).toBe(401);
  });

  it('enforces the password policy and role-per-organisation-type rules', async () => {
    const admin = await login(env, 'northwind', 'Admin');
    const weak = await admin.req('POST', '/api/v1/org/users', { email: 'weak@northwind.demo', name: 'Weak', role: 'Viewer', password: 'short' });
    expect(weak.status).toBe(400);
    const wrongRole = await admin.req('POST', '/api/v1/org/users', { email: 'x@northwind.demo', name: 'X', role: 'Underwriter', password: 'Sup3rSecret!pw' });
    expect(wrongRole.status).toBe(400);
    expect(wrongRole.json.message).toContain('not available for buyer');
  });

  it('a viewer cannot manage users; logout ends the session', async () => {
    const v = await login(env, 'northwind', 'Viewer');
    expect((await v.req('GET', '/api/v1/org/users')).status).toBe(403);
    expect((await v.req('POST', '/api/v1/auth/logout')).status).toBe(200);
    expect((await v.req('GET', '/api/v1/org')).status).toBe(401);
  });

  it('lets a user with two memberships switch organisation', async () => {
    const admin = await login(env, 'aurelia', 'Admin');
    // Give the Aurelia admin a membership at Kestrel too, then switch.
    await env.svc.db.system(async (tx) => {
      const u = await tx.one<any>("select id from identity.users where email = 'admin@aurelia.demo'");
      await tx.query("insert into identity.memberships (user_id, org_id, role, created_at) values ($1,$2,'Viewer',$3)", [u.id, env.ids.kestrel, env.clock.now()]);
    });
    const sw = await admin.req('POST', '/api/v1/auth/switch-org', { orgId: env.ids.kestrel });
    expect(sw.status).toBe(200);
    expect((await admin.req('GET', '/api/v1/org')).json.legalName).toBe('Kestrel Capital');
    const bad = await admin.req('POST', '/api/v1/auth/switch-org', { orgId: env.ids.shree });
    expect(bad.status).toBe(403);
  });
});
