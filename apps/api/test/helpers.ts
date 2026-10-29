import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../src/app';
import { Db } from '../src/db/pool';
import { loadConfig } from '../src/kernel/config';
import { VirtualClock } from '../src/kernel/clock';
import { defaultAdapters } from '../src/adapters';
import type { Services } from '../src/services';
import { demoTotpSecret, seedDemo, demoEmail, DEMO_PASSWORD, type DemoIds } from '../src/modules/identity/seed';
import { totpAt } from '../src/kernel/totp';
import { runWorkOnce } from '../src/worker';
import type { Role } from '../src/modules/identity/permissions';

const adminBase = () => process.env.EARLIO_TEST_ADMIN_URL!;
const appBase = () => process.env.EARLIO_TEST_APP_URL!;
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = '/' + db; return u.toString(); };

export interface TestEnv {
  app: FastifyInstance;
  svc: Services;
  clock: VirtualClock;
  ids: DemoIds;
  /** Superuser connection string for this test database (tamper tests, raw checks). */
  adminUrl: string;
  /** Application-role connection string (RLS applies). */
  appUrl: string;
  /** Run one pass of every background job (outbox, reminders, insurer API, expiry). */
  work: () => Promise<Record<string, number>>;
  close: () => Promise<void>;
}

export async function createTestEnv(opts: { seed?: boolean } = {}): Promise<TestEnv> {
  const name = 'earlio_t_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: withDb(adminBase(), 'postgres') });
  await admin.connect();
  await admin.query(`create database ${name} template earlio_template`);
  await admin.end();
  const adminUrl = withDb(adminBase(), name);
  const appUrl = withDb(appBase(), name);
  const clock = new VirtualClock();
  clock.setTo(new Date('2026-11-02T04:00:00.000Z')); // fixed: deterministic runs
  const config = loadConfig({ env: 'test', databaseUrl: appUrl, migrateDatabaseUrl: adminUrl });
  const db = new Db(appUrl, 20);
  const svc: Services = { config, db, clock, adapters: defaultAdapters(config) };
  const ids = opts.seed === false ? {} : await db.system((tx) => seedDemo(tx, svc, { platform: true, correlationId: 'seed' }));
  const app = await buildApp(svc);
  await app.ready();
  return {
    app, svc, clock, ids, adminUrl, appUrl,
    work: () => runWorkOnce(svc),
    close: async () => {
      await app.close();
      await db.close();
      const a = new pg.Client({ connectionString: withDb(adminBase(), 'postgres') });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export interface Session {
  cookie: string;
  csrf: string;
  /** Authenticated request helper. */
  req: (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => Promise<{ status: number; json: any }>;
}

/** Full password + MFA login for a seeded demo user. */
export async function login(env: TestEnv, slug: string, role: Role): Promise<Session> {
  const email = demoEmail(slug, role);
  return loginAs(env, email);
}

export async function loginAs(env: TestEnv, email: string, password = DEMO_PASSWORD, secret = demoTotpSecret(email)): Promise<Session> {
  const l = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (l.statusCode !== 200) throw new Error(`login failed ${l.statusCode}: ${l.body}`);
  const cookie = `earlio_sid=${(l.cookies.find((c) => c.name === 'earlio_sid') as any).value}`;
  const csrf = l.json().csrfToken as string;
  const v = await env.app.inject({
    method: 'POST', url: '/api/v1/auth/mfa/verify', headers: { cookie, 'x-csrf-token': csrf },
    payload: { code: totpAt(secret, env.clock.now().getTime()) },
  });
  if (v.statusCode !== 200) throw new Error(`mfa failed ${v.statusCode}: ${v.body}`);
  return makeSession(env, cookie, csrf);
}

export function makeSession(env: TestEnv, cookie: string, csrf: string): Session {
  return {
    cookie, csrf,
    req: async (method, url, body) => {
      const res = await env.app.inject({
        method, url, headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      let json: any = null;
      try { json = res.json(); } catch { json = res.body; }
      return { status: res.statusCode, json };
    },
  };
}
