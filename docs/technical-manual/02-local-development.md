# 2. Local development

## Contents
- [2.1 Prerequisites](#21-prerequisites)
- [2.2 First-time setup](#22-first-time-setup)
- [2.3 Running the stack](#23-running-the-stack)
- [2.4 Signing in as the demo cast](#24-signing-in-as-the-demo-cast)
- [2.5 The virtual clock and the control room](#25-the-virtual-clock-and-the-control-room)
- [2.6 Bank portals on tenant subdomains](#26-bank-portals-on-tenant-subdomains)
- [2.7 Exploring the API](#27-exploring-the-api)
- [2.8 Resetting your database](#28-resetting-your-database)
- [2.9 Troubleshooting the dev stack](#29-troubleshooting-the-dev-stack)

## 2.1 Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | **22 or newer** (`engines.node >= 22`) | CI uses 22. |
| npm | the one bundled with Node | Workspaces are used; do not use yarn/pnpm. |
| PostgreSQL | **16** (CI image `postgres:16`) | Needs a superuser for migrations and tests. |
| Git | any recent | |
| Chrome/Chromium | optional | Only for the Playwright e2e suite. |

PostgreSQL on macOS with Homebrew:

```bash
brew install postgresql@16
```

```bash
brew services start postgresql@16
```

Or in Docker (throwaway, development only):

```bash
docker run -d --name earlio-pg -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=earlio -p 5432:5432 postgres:16
```

## 2.2 First-time setup

1. Clone and install (installs every workspace, including the vendored design system):

   ```bash
   npm install
   ```

2. Create the database if your server does not have one yet:

   ```bash
   createdb -U postgres earlio
   ```

3. Create `apps/api/.env` (it is git-ignored):

   ```ini
   # Application role: created by the first migration if it does not exist (development password earlio_app).
   DATABASE_URL=postgres://earlio_app:earlio_app@localhost:5432/earlio
   # Owner/superuser: runs migrations; the test suite also creates and drops databases with it.
   MIGRATE_DATABASE_URL=postgres://postgres:postgres@localhost:5432/earlio
   ```

   Values in `apps/api/.env` **override** variables already set in your shell. Every other setting has a development default; see [chapter 3](03-configuration.md).

## 2.3 Running the stack

Two terminals:

```bash
npm run dev:api
```

```bash
npm run dev:web
```

| What | URL |
| --- | --- |
| Web app | http://localhost:5173 |
| API | http://localhost:4000 |
| Liveness | http://localhost:4000/health |
| Readiness | http://localhost:4000/ready |
| OpenAPI document | http://localhost:4000/openapi.json |
| Metrics | http://localhost:4000/metrics |

`dev:api` runs `tsx watch src/server.ts`: it restarts on file changes, applies any new migration on start, and seeds the demo cast if it is missing (the seed is idempotent).

**Seeded pilot scenarios.** For a database populated with invoices in every state (INV-1001 … INV-1013), start the stack the way the e2e suite does. Point `DATABASE_URL`/`MIGRATE_DATABASE_URL` at a throwaway database first — the scenarios assume a fresh one:

```bash
npm run e2e:stack
```

It starts the API with `EARLIO_SEED_SCENARIOS=1` and relaxed rate limits plus the web app, writes logs to `/tmp/earlio-api.log` and `/tmp/earlio-web.log` (override with `E2E_LOG_DIR`) and prints `stack ready` when seeding is finished.

## 2.4 Signing in as the demo cast

Every seeded user is `<role>@<org>.demo` with password `Earlio!Demo1`. On the MFA step in development, **Use demo code** fills the current TOTP code (it calls the development-only `GET /api/v1/dev/totp?email=`).

| Organisation (`<org>`) | Type | Useful logins |
| --- | --- | --- |
| `shree`, `kumar`, `anand`, `deccan` | Supplier | `admin@`, `finance@`, `approver@`, `viewer@` |
| `northwind`, `lakeshore`, `merlion`, `kallang` | Buyer | `admin@`, `finance@`, `approver@`, `viewer@` |
| `zarnitsa` | Buyer (sanctioned, blocked) | same roles; used to demonstrate sanctions |
| `aurelia` (partner), `kestrel`, `harbour` | Bank | `admin@`, `finance@`, `approver@`, `viewer@`, `credit@`, `ops@`, `rm@` |
| `exportshield`, `sentinel` | Insurer | `admin@`, `approver@`, `viewer@`, `underwriter@`, `claims@` |
| `earlio` | Platform | `admin@` (PlatformAdmin), `auditor@` |

Role local-parts: Admin `admin`, FinanceUser `finance`, Approver `approver`, Viewer `viewer`, CreditOfficer `credit`, Operations `ops`, RelationshipManager `rm`, Underwriter `underwriter`, ClaimsHandler `claims`, PlatformAdmin `admin`, Auditor `auditor`. What each role may do is in [`docs/permissions-matrix.md`](../permissions-matrix.md).

![Sign-in page](../user-manual/images/common/sign-in.webp)
*Figure 2-1 — Sign-in page (development shows the Simulated environment banner).*

> Five wrong passwords lock an account for 15 minutes. In development, restart nothing — just wait, or clear `identity.users.locked_until` for that user (see [support diagnostics](../support/06-diagnostic-queries.md)).

## 2.5 The virtual clock and the control room

Outside production the API uses a **virtual clock**, so you can move time forward to trigger expiries, due dates, defaults and dispute timers without waiting. The worker runs on the same clock.

Sign in as `admin@earlio.demo` and open **Control room** (Insight group). It lets you advance or set the clock, run the worker pass immediately, simulate buyer payments and adjust simulator settings.

![Control room](images/control-room.webp)
*Figure 2-2 — Control room (development, demo and test only).*

The same controls exist as API calls (platform admin session): `GET/POST /api/v1/admin/clock`, `POST /api/v1/sim/pay`, `GET/PUT /api/v1/admin/sim-settings`. These routes, like `/api/v1/dev/totp`, are registered only in `development`, `demo` and `test`; in production they return 404.

## 2.6 Bank portals on tenant subdomains

Browsers resolve `*.localhost` to your machine, so the white-label portals work without DNS:

- http://aurelia.localhost:5173
- http://kestrel.localhost:5173
- http://harbour.localhost:5173

The Vite proxy forwards the browser's host as `x-forwarded-host`, which the API uses to pick the bank's branding.

## 2.7 Exploring the API

- **OpenAPI**: `http://localhost:4000/openapi.json` (live) or [`docs/openapi.json`](../openapi.json) (committed). Import either into Postman, Insomnia or Bruno.
- **Posting collection**: [`docs/posting/`](../posting) has one ready-made request per endpoint, grouped by tag, with `local.posting.env` for the local URLs.
- **Calling with curl**: sign in, then send the cookie and the CSRF token on writes.

  ```bash
  curl -s -c /tmp/jar -H 'content-type: application/json' -d '{"email":"admin@earlio.demo","password":"Earlio!Demo1"}' http://localhost:4000/api/v1/auth/login
  ```

  The response holds `csrfToken`. Then fetch the demo MFA code and verify it:

  ```bash
  CODE=$(curl -s -b /tmp/jar 'http://localhost:4000/api/v1/dev/totp?email=admin@earlio.demo' | sed -E 's/.*"code":"?([0-9]+).*/\1/'); curl -s -b /tmp/jar -c /tmp/jar -H 'content-type: application/json' -H "x-csrf-token: <csrfToken>" -d "{\"code\":\"$CODE\"}" http://localhost:4000/api/v1/auth/mfa/verify
  ```

## 2.8 Resetting your database

The seed only creates what is missing; it does not repair data you changed. To start clean, drop and recreate the database (the application role survives because roles are cluster-wide):

```bash
dropdb -U postgres --force earlio && createdb -U postgres earlio
```

Then restart `npm run dev:api`. Re-seeding is also how you pick up seed changes recorded in `docs/progress.md` (for example real PDF demo documents, or the audit-hash fix of 30 Oct 2026).

Uploaded files live in `apps/api/.data/objects` by default (git-ignored); delete the folder when you reset the database.

## 2.9 Troubleshooting the dev stack

| Symptom | Cause and fix |
| --- | --- |
| `DATABASE_URL is not set` on start | `apps/api/.env` missing or empty. Create it (§ 2.2). |
| `migration 0xx_… failed: …` | The database has partly applied or hand-edited objects. Reset it (§ 2.8). Never edit an applied migration — add a new one. |
| `password authentication failed for user "earlio_app"` | The role exists with another password. Use that password in `DATABASE_URL`, or `ALTER ROLE earlio_app PASSWORD 'earlio_app'` as superuser. |
| Web shows "Could not reach the server" | API not running or not on :4000. Set `VITE_API_URL` if it runs elsewhere. |
| Every write fails with "Your session security token is missing or out of date" | Stale CSRF token after an API restart or a new login in another tab: reload the page. |
| 429 "Too many requests" while scripting | Global limit 600/min, login 10/min. Raise `RATE_LIMIT_MAX`/`LOGIN_RATE_LIMIT` locally. |
| Bank portal shows Earlio branding | You opened `localhost:5173` instead of `<tenant>.localhost:5173`, or the bank has no tenant name set. |
| **Verify chain** reports a break in an old dev database | Databases seeded before 30 Oct 2026 contain entries hashed by a fixed bug. Reset the database. |
