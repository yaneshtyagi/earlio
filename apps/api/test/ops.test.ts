import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './helpers';
import { requireSecret } from '../src/kernel/secrets';
import { toCsv, parseCsv } from '../src/modules/integration/csv';

let env: TestEnv;
beforeAll(async () => { env = await createTestEnv(); });
afterAll(async () => { await env.close(); });

describe('operations endpoints and hardening', () => {
  it('serves security headers on every response, including errors', async () => {
    for (const url of ['/health', '/api/v1/me', '/nope']) {
      const r = await env.app.inject({ url });
      expect(r.headers['x-content-type-options']).toBe('nosniff'); expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'"); expect(r.headers['cache-control']).toBe('no-store');
    }
  });
  it('/ready reports migrations and backlog; /metrics exposes request counters and queue gauges', async () => {
    const ready = await env.app.inject({ url: '/ready' }); expect(ready.statusCode).toBe(200); expect(ready.json().migrations).toBeGreaterThan(10);
    await env.app.inject({ url: '/health' });
    const m = await env.app.inject({ url: '/metrics' }); expect(m.statusCode).toBe(200);
    expect(m.body).toMatch(/earlio_http_requests_total\{method="GET",route="\/health",status="200"\} \d+/);
    expect(m.body).toContain('earlio_outbox_pending'); expect(m.body).toContain('earlio_http_request_duration_seconds_count');
  });
  it('production refuses a missing or default secret', () => {
    const p = (v?: string) => ({ get: () => v });
    expect(() => requireSecret(p(), 'WEBHOOK_KEY', 'production')).toThrow();
    expect(() => requireSecret(p('earlio-dev-webhook-key'), 'WEBHOOK_KEY', 'production')).toThrow();
    expect(() => requireSecret(p('short'), 'WEBHOOK_KEY', 'production')).toThrow();
    expect(requireSecret(p('x'.repeat(32)), 'WEBHOOK_KEY', 'production')).toHaveLength(32);
    expect(requireSecret(p(), 'WEBHOOK_KEY', 'development')).toBeTruthy();
  });
  it('csv: round-trips quoted cells and neutralises spreadsheet formulas', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n')).toEqual([{ a: 'x,1', b: 'he said "hi"' }]);
    expect(toCsv(['n'], [{ n: '=SUM(A1)' }, { n: '-12.50' }])).toBe("n\r\n'=SUM(A1)\r\n-12.50\r\n");
  });
});
