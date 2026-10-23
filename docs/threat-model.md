# Threat model (STRIDE summary)

Scope: the Earlio web app, API, worker, Postgres and object store. Simulated rails (bank, insurer, FX, KYC) are out of scope until real adapters are plugged in.

## Assets
Invoices and receivable data · bank terms and prices · KYC records · documents · the append-only audit trail · API keys and signing secrets · session cookies.

## Trust boundaries
Browser ⇄ API (cookie session + CSRF) · bank/ERP ⇄ machine API (API key + HMAC) · API ⇄ Postgres (non-owner role, RLS) · worker ⇄ adapters.

| Threat | Example | Control in place | Residual / action |
|---|---|---|---|
| **Spoofing** | Stolen password | Argon-class hashing, TOTP MFA required for every business session, session expiry, rate-limited login | Add WebAuthn, device binding (post-MVP) |
| Spoofing | Forged bank callback | HMAC over timestamp.nonce.body, 5-minute window, nonce replay table, per-bank secrets | Rotate `WEBHOOK_KEY` in the vault on a schedule |
| Spoofing | Stolen API key | Hashed at rest, shown once, rotation with 24 h grace, instant revoke, signing required for writes | IP allow-listing per key (gap G-4) |
| **Tampering** | Edit audit history | `audit.events` is append-only for the app role, hash-chained, periodic anchors, tamper test | Ship anchors to external WORM storage |
| Tampering | Change a funded invoice's terms | Terms versions are immutable (trigger); invoices pin their version | – |
| Tampering | Self-approval of settings/terms | Maker-checker enforced in the database and service | – |
| **Repudiation** | "I never consented" | Consent, acceptance and assignment events audited with user, time, IP hash and terms version | – |
| **Information disclosure** | Tenant A reads tenant B | Row-level security on every tenant table; non-owner role; cross-tenant tests; `elevated` only in services | Penetration test before pilot |
| Disclosure | Secrets in logs | Cookie and Authorization redacted; no secrets in responses after creation | Log scrubbing review for new fields |
| Disclosure | Spreadsheet formula injection | CSV export neutralises formula prefixes | – |
| **Denial of service** | Request floods | Global rate limit per client address, tighter limits on auth, 3 MB body cap, file row caps | Edge WAF/CDN in production |
| DoS | Webhook sink slowness | 5 s timeout, bounded retries | Per-bank delivery concurrency cap |
| **Elevation of privilege** | Role bypass | Permission checks in route pre-handlers; platform roles separate; maker-checker; org-type checks | Periodic access review |
| EoP | SSRF via webhook URL | https only, private ranges refused outside development | Resolve and pin DNS at send time |
| Supply chain | Vulnerable dependency | `npm audit` and CodeQL in CI; lockfile | Add SBOM and provenance |

## Abuse cases worth testing before a pilot
Replay a signed call · use a rotated key after 24 h · mass-download documents across tenants · approve own change with a second account on the same device · upload an HTML/SVG file as a "PDF".
