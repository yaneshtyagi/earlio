// Small dependency-free load test: N concurrent signed-in users hammer read endpoints for a fixed time; reports throughput and latency.
// Usage: node scripts/load-test.mjs [--api http://localhost:4000] [--seconds 20] [--concurrency 20]
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const API = arg('api', 'http://localhost:4000'), SECONDS = Number(arg('seconds', 20)), CONC = Number(arg('concurrency', 20));
const PASSWORD = 'Earlio!Demo1';
const USERS = [['finance@kumar.demo', ['/api/v1/invoices', '/api/v1/dashboard', '/api/v1/notifications']], ['finance@northwind.demo', ['/api/v1/invoices', '/api/v1/dashboard']], ['credit@kestrel.demo', ['/api/v1/dashboard', '/api/v1/bank/invitations']], ['admin@earlio.demo', ['/api/v1/admin/scorecard']]];

async function login(email) {
  let cookie = '';
  const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) cookie = [...new Set([...cookie.split('; ').filter(Boolean), c.split(';')[0]])].join('; '); };
  const l = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  grab(l); const { csrfToken } = await l.json();
  const t = await fetch(`${API}/api/v1/dev/totp?email=${encodeURIComponent(email)}`, { headers: { cookie } });
  const { code } = await t.json();
  const v = await fetch(`${API}/api/v1/auth/mfa/verify`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }, body: JSON.stringify({ code }) });
  grab(v); if (!v.ok) throw new Error(`login failed for ${email}: ${v.status}`);
  return cookie;
}
const sessions = [];
for (const [email, paths] of USERS) sessions.push({ email, paths, cookie: await login(email) });

const lat = new Map(); let errors = 0, total = 0;
const end = Date.now() + SECONDS * 1000;
async function worker(i) {
  const s = sessions[i % sessions.length];
  for (let n = 0; Date.now() < end; n++) {
    const p = s.paths[n % s.paths.length], t0 = performance.now();
    try { const r = await fetch(API + p, { headers: { cookie: s.cookie } }); await r.arrayBuffer(); if (!r.ok) errors++; } catch { errors++; }
    total++; (lat.get(p) ?? lat.set(p, []).get(p)).push(performance.now() - t0);
  }
}
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
const q = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log(`concurrency ${CONC}, ${SECONDS}s: ${total} requests, ${(total / SECONDS).toFixed(0)} req/s, errors ${errors} (${((errors / total) * 100).toFixed(2)}%)`);
console.log('endpoint'.padEnd(34), 'n'.padStart(6), 'p50'.padStart(8), 'p95'.padStart(8), 'p99'.padStart(8));
for (const [p, a] of lat) console.log(p.padEnd(34), String(a.length).padStart(6), q(a, 0.5).toFixed(0).padStart(7) + 'ms', q(a, 0.95).toFixed(0).padStart(7) + 'ms', q(a, 0.99).toFixed(0).padStart(7) + 'ms');
if (errors / total > 0.01) process.exit(1);
