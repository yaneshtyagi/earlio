import { describe, expect, it } from 'vitest';
import { tenantUrl } from './tenant';

const at = (href: string) => { const u = new URL(href); return { protocol: u.protocol, hostname: u.hostname, port: u.port }; };

describe('tenant portal address', () => {
  it('puts the tenant name in front of the domain the SPA is served from', () => {
    expect(tenantUrl('kestrel', null, at('http://localhost:5173/bank/console'))).toBe('http://kestrel.localhost:5173/');
    expect(tenantUrl('kestrel', null, at('https://earlio.example.com/'))).toBe('https://kestrel.earlio.example.com/');
  });

  it('replaces the tenant of the current host instead of stacking a second one', () => {
    expect(tenantUrl('kestrel-trade', 'kestrel', at('http://kestrel.localhost:5173/'))).toBe('http://kestrel-trade.localhost:5173/');
  });

  it('strips a platform label such as app. or admin. so the tenant takes its place', () => {
    expect(tenantUrl('aurelia', null, at('https://app.earlio.example.com/admin/tenants'))).toBe('https://aurelia.earlio.example.com/');
    expect(tenantUrl('aurelia', null, at('http://admin.localhost:5173/'))).toBe('http://aurelia.localhost:5173/');
  });

  it('falls back to localhost when the SPA is opened by IP address', () => {
    expect(tenantUrl('aurelia', null, at('http://127.0.0.1:5173/'))).toBe('http://aurelia.localhost:5173/');
  });
});
