import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import { demoEmail, demoTotpSecret, DEMO_PASSWORD } from '../modules/identity/seed';
import { totpAt } from '../kernel/totp';
import { VirtualClock } from '../kernel/clock';
import { runWorkOnce } from '../worker';
import type { Role } from '../modules/identity/permissions';

export interface Sess { cookie: string; csrf: string; req: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => Promise<{ status: number; json: any }> }

/** Drives the real HTTP API in-process, exactly as the web app would; used by the scenario seeder. Sessions are re-created whenever the clock moves. */
export class Driver {
  private sessions = new Map<string, Sess>();
  private n = 0;
  constructor(readonly app: FastifyInstance, readonly svc: Services) {
    if (!(svc.clock instanceof VirtualClock)) throw new Error('Scenario seeding needs the virtual clock (development or demo mode).');
  }
  get clock() { return this.svc.clock as VirtualClock; }
  now() { return this.clock.now(); }
  setTo(iso: string) { this.clock.setTo(new Date(iso)); this.sessions.clear(); }
  advanceHours(h: number) { this.clock.advanceHours(h); this.sessions.clear(); }
  work() { return runWorkOnce(this.svc); }

  async as(slug: string, role: Role): Promise<Sess> {
    const key = `${slug}/${role}`;
    const hit = this.sessions.get(key); if (hit) return hit;
    const email = demoEmail(slug, role);
    const l = await this.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: `10.${(this.n >> 8) & 255}.${this.n++ & 255}.7`, payload: { email, password: DEMO_PASSWORD } });
    if (l.statusCode !== 200) throw new Error(`login ${email}: ${l.statusCode} ${l.body}`);
    const cookie = `earlio_sid=${(l.cookies.find((c) => c.name === 'earlio_sid') as any).value}`; const csrf = l.json().csrfToken as string;
    const v = await this.app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', remoteAddress: `10.${(this.n >> 8) & 255}.${this.n & 255}.8`, headers: { cookie, 'x-csrf-token': csrf }, payload: { code: totpAt(demoTotpSecret(email), this.now().getTime()) } });
    if (v.statusCode !== 200) throw new Error(`mfa ${email}: ${v.statusCode} ${v.body}`);
    const s: Sess = { cookie, csrf, req: async (method, url, body) => {
      const res = await this.app.inject({ method, url, headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: body === undefined ? undefined : JSON.stringify(body) });
      let json: any = null; try { json = res.json(); } catch { json = res.body; }
      return { status: res.statusCode, json };
    } };
    this.sessions.set(key, s); return s;
  }
  /** A call that must succeed; the message names what was being done. */
  async ok(what: string, r: Promise<{ status: number; json: any }>, ...allowed: number[]) {
    const x = await r; if (x.status >= 300 && !allowed.includes(x.status)) throw new Error(`${what}: ${x.status} ${JSON.stringify(x.json)}`);
    return x.json;
  }
  async upload(s: Sess, name: string) {
    const res = await this.app.inject({ method: 'POST', url: `/api/v1/files?filename=${name}`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/octet-stream' }, payload: Buffer.from(`${name}:${Math.random()}`) });
    if (res.statusCode >= 300) throw new Error(`upload ${name}: ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  }
}
