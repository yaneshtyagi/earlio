# 3. Configuration reference

## Contents
- [3.1 How configuration is loaded](#31-how-configuration-is-loaded)
- [3.2 API variables](#32-api-variables)
- [3.3 Environments (`EARLIO_ENV`)](#33-environments-earlio_env)
- [3.4 Web build variables](#34-web-build-variables)
- [3.5 Scripts and test variables](#35-scripts-and-test-variables)
- [3.6 Governed settings (in the database)](#36-governed-settings-in-the-database)
- [3.7 Hard-coded limits](#37-hard-coded-limits)
- [3.8 Example production environment](#38-example-production-environment)

## 3.1 How configuration is loaded

`loadEnv()` (`src/kernel/env.ts`) reads **`apps/api/.env`** if it exists and copies every variable in it into `process.env`, **overriding** variables already set. Variables the file does not define come from the real environment. `loadConfig()` (`src/kernel/config.ts`) then builds the `Config` object once at start-up; changes need a restart.

> In deployed environments, **do not ship an `apps/api/.env` file** — it would silently override what the orchestrator injects. Configure through environment variables or a secrets manager.

Secrets go through the `SecretProvider` interface (`src/kernel/secrets.ts`). Only the environment-variable provider ships; see [Security § 8.2](08-security-and-secrets.md#82-secrets).

## 3.2 API variables

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `EARLIO_ENV` | `development` | **Yes: `production`** | Environment; see § 3.3. |
| `DATABASE_URL` | — | **Yes** | Connection string for the RLS-bound **application role** (`earlio_app`). Start-up fails without it. |
| `MIGRATE_DATABASE_URL` | `DATABASE_URL` | **Yes** | Connection string for the **owner** role that runs migrations on start. Must be able to create roles if `earlio_app` does not exist yet. |
| `PORT` | `4000` | No | HTTP port. |
| `HOST` | `0.0.0.0` | No | Bind address. |
| `CORS_ORIGINS` | `http://localhost:5173` | **Yes** | Comma-separated list of allowed browser origins (credentials allowed). Only needed when the SPA is served from a different origin than the API; set it to the public web origin(s) anyway. |
| `WEBHOOK_KEY` | `earlio-dev-webhook-key` (non-production only) | **Yes, ≥ 24 chars, not the dev value** | Master key from which each bank's secret for **inbound payment-status callbacks** (`POST /api/v1/webhooks/bank/:bankId`) is derived. Production refuses to start without a strong value. (Outbound webhooks *to* banks are signed with the bank's API-key signing secret, not this key.) |
| `METRICS_TOKEN` | — | **Yes** | Bearer token for `GET /metrics`. In production, `/metrics` returns 401 without it. |
| `OBJECT_STORE_DIR` | `.data/objects` (relative to the process working directory) | **Yes** (persistent volume) | Directory for uploaded files (local-disk object store). |
| `EARLIO_MODE` | `network` | No | Default platform mode: `network` (many banks compete) or `white-label` (one partner bank). The governed setting in the database takes precedence once set. |
| `RATE_LIMIT_MAX` | `600` | No | Global request ceiling per client address per minute (`/health` and `/ready` are exempt). |
| `LOGIN_RATE_LIMIT` | `10` | No | Login attempts per client address per minute. |
| `EARLIO_SEED_SCENARIOS` | unset | **Must be unset** | `1` seeds the pilot scenario invoices on start. Ignored in production. |
| `EARLIO_TEST_LOG` | unset | — | Tests only: `1` turns on request logging during `npm test`. |

Derived settings (not variables):

| Setting | Value |
| --- | --- |
| Secure cookies (`Secure` flag on `earlio_sid`) | on when `EARLIO_ENV=production` |
| HSTS header | sent when `EARLIO_ENV=production` |
| Simulated-environment banner | shown unless `EARLIO_ENV=production` |
| Clock | `SystemClock` in production; `VirtualClock` otherwise |
| Demo seed, dev/demo routes | only in `development` and `demo` (routes also in `test`) |
| `trustProxy` | always on: the API trusts `X-Forwarded-For`/`-Proto` from the proxy in front of it |

## 3.3 Environments (`EARLIO_ENV`)

| Value | Clock | Demo seed | Dev routes (`/dev/totp`, `/admin/clock`, `/sim/*`, demo scenarios) | Worker | Banner | Secret checks |
| --- | --- | --- | --- | --- | --- | --- |
| `development` | virtual | yes | yes | yes | yes | dev defaults allowed |
| `demo` | virtual | yes | yes | yes | yes | dev defaults allowed |
| `test` | virtual | no | yes | **no** (tests call `runWorkOnce`) | yes | dev defaults allowed |
| `production` | real | **no** | **no** (404) | yes | no | strict |

Use `demo` for a hosted sales/demo instance and `production` for anything holding real data. There is no separate `staging` value: run staging with `EARLIO_ENV=production` and its own database and secrets, so it behaves exactly like production.

## 3.4 Web build variables

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_API_URL` | Vite **dev server** only | `http://localhost:4000` | Where `npm run dev:web` proxies `/api` and `/health`. Not used by the production build: the built SPA calls `/api/...` on its own origin. |

## 3.5 Scripts and test variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `E2E_LOG_DIR` | `scripts/e2e-stack.sh` | Where API and web logs go (default `/tmp`). |
| `E2E_WEB`, `E2E_API` | `e2e/` | Base URLs (defaults `http://localhost:5173`, `http://localhost:4000`). |
| `E2E_CHROMIUM` | `e2e/` | Path to a Chromium binary if Playwright's own is not installed. |

The API test suite needs `MIGRATE_DATABASE_URL` (superuser) and `DATABASE_URL` (app role); see [chapter 5](05-build-test-ci.md).

## 3.6 Governed settings (in the database)

Business-level platform settings — fees, defaults, the platform mode, the dispute-text wording and similar — are **not** environment variables. They live in `platform.settings`, are changed through **Defaults and guardrails** in the platform console, and need a second administrator to approve (maker-checker; history in `platform.setting_changes`). Hard guardrails (limits the terms engine will never exceed) are code in `src/modules/terms/guardrails.ts`.

## 3.7 Hard-coded limits

Changing these needs a code change and a release.

| Limit | Value | Where |
| --- | --- | --- |
| Session lifetime | 8 hours | `modules/identity/routes.ts` (`SESSION_HOURS`) |
| Failed logins before lock / lock time | 5 / 15 minutes | `MAX_FAILED`, `LOCK_MINUTES` |
| Request body size | 3 MB | `app.ts` (`bodyLimit`) |
| Uploaded file size | 10 MB | `platform/files.ts` (`MAX_FILE_BYTES`) |
| DB pool size | 10 connections per process | `db/pool.ts` |
| Worker interval | 15 s | `worker.ts` (`startWorker`) |
| Outbox: batch / max attempts | 200 / 5 | `platform/outbox.ts` |
| Webhook max attempts | 5 | `modules/integration/service.ts` |
| `/ready` fails when | > 1,000 unprocessed outbox events older than 15 min | `app.ts` |
| Machine API signature window | 5 minutes; nonce single-use | integration module |
| Rotated API key grace | 24 hours | integration module |

## 3.8 Example production environment

```ini
EARLIO_ENV=production
PORT=4000
DATABASE_URL=postgres://earlio_app:<app-password>@<db-host>:5432/earlio?sslmode=require
MIGRATE_DATABASE_URL=postgres://earlio_owner:<owner-password>@<db-host>:5432/earlio?sslmode=require
CORS_ORIGINS=https://app.<your-domain>
WEBHOOK_KEY=<random 32+ chars from the secrets manager>
METRICS_TOKEN=<random 32+ chars from the secrets manager>
OBJECT_STORE_DIR=/var/lib/earlio/objects
```

Generate random secrets with:

```bash
openssl rand -base64 36
```
