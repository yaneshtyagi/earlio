# 5. Build, test and CI

## Contents
- [5.1 Commands at a glance](#51-commands-at-a-glance)
- [5.2 API tests](#52-api-tests)
- [5.3 Web tests and build](#53-web-tests-and-build)
- [5.4 The OpenAPI contract](#54-the-openapi-contract)
- [5.5 End-to-end tests](#55-end-to-end-tests)
- [5.6 Load test](#56-load-test)
- [5.7 Continuous integration](#57-continuous-integration)
- [5.8 Definition of done](#58-definition-of-done)
- [5.9 Reading a CI failure](#59-reading-a-ci-failure)

## 5.1 Commands at a glance

| Command (repo root) | What it does |
| --- | --- |
| `npm install` / `npm ci` | Install all workspaces (`ci` for a clean, lockfile-exact install) |
| `npm run typecheck` | `tsc --noEmit` for API and web |
| `npm test` | API test suite (vitest) against real PostgreSQL |
| `npm run test:coverage` | Same, with V8 coverage in `apps/api/coverage/` |
| `npm test -w @earlio/web` | Web unit tests (vitest) |
| `npm run build` | API typecheck + web production build (`apps/web/dist`) |
| `npm run openapi` | Regenerate `docs/openapi.json` from the route schemas |
| `npm run gen:client` | Regenerate `apps/web/src/api/schema.d.ts` from `docs/openapi.json` |
| `npm run e2e:stack` | Start a seeded API + web stack for the e2e suite |
| `npm run e2e` | Playwright journeys and accessibility checks |
| `node scripts/load-test.mjs --api <url>` | Small load test against a running stack |

## 5.2 API tests

- **Runner:** vitest 5, `pool: 'forks'`, 60 s per test, files in `apps/api/test/**/*.test.ts`.
- **Database:** the global setup (`test/global-setup.ts`) connects with `MIGRATE_DATABASE_URL` (**must be a superuser**), drops and creates `earlio_template`, applies every migration to it, and each test file clones the template into its own `earlio_t_*` database. The suite connects to those databases as `DATABASE_URL`'s role, so RLS is exercised for real. Teardown drops the template.
- **Config:** from `apps/api/.env` or the environment.
- **Clock and worker:** tests run with `EARLIO_ENV=test`, a virtual clock and no background loop; they move the clock and call `runWorkOnce()` explicitly.

What the suites cover:

| Kind | Files (examples) |
| --- | --- |
| Pure domain logic and golden numbers | `pricing.test.ts`, `rules.test.ts`, `waterfall.test.ts` |
| Integration flows | `invoicing`, `marketplace`, `settlement`, `insurance`, `exceptions`, `scenarios`, `integration` |
| Security | `tenancy.test.ts` (RLS at API and SQL level), `permissions.test.ts` (role matrix snapshot), `auth.test.ts` (CSRF, MFA, lockout) |
| Audit chain | `audit.test.ts` |
| Architecture rules | `architecture.test.ts` (module boundaries, generated client only) |
| Operations | `ops.test.ts` (health, readiness, metrics, production config refusal) |

Run one file or one test:

```bash
npx -w @earlio/api vitest run test/settlement.test.ts
```

```bash
npx -w @earlio/api vitest run -t "golden"
```

`test/__snapshots__/permissions.test.ts.snap` is the permission matrix. If you change permissions on purpose, update the snapshot (`npx -w @earlio/api vitest run test/permissions.test.ts -u`) **and** [`docs/permissions-matrix.md`](../permissions-matrix.md), and get the change reviewed.

## 5.3 Web tests and build

```bash
npm test -w @earlio/web
```

```bash
npm run build -w @earlio/web
```

The build runs `tsc --noEmit` then `vite build` and writes static files to `apps/web/dist/` (`index.html` + hashed assets). The API workspace's `build` script is only a typecheck — the API runs from TypeScript source through `tsx` (see [Deployment § 6.2](06-deployment.md#62-build-artefacts)).

## 5.4 The OpenAPI contract

The API's Zod route schemas are the source of truth. After **any** change to a route's path, parameters, body or response:

```bash
npm run openapi && npm run gen:client
```

Commit both `docs/openapi.json` and `apps/web/src/api/schema.d.ts`. CI regenerates them and fails on any difference. If you also add an endpoint, add a request to [`docs/posting/`](../posting) under its tag.

## 5.5 End-to-end tests

The Playwright suite in `e2e/` drives the real UI against a clean, seeded stack on one worker (journeys share one database and one virtual clock).

```bash
npm ci --prefix e2e && npx --prefix e2e playwright install chromium
```

```bash
npm run e2e:stack
```

Wait for `stack ready`, then in another terminal:

```bash
npm run e2e
```

| Spec | Covers |
| --- | --- |
| `00-j0-onboarding` | Registration, MFA enrolment, KYC onboarding |
| `10-pilot-data` | Read-through of the seeded pilot scenarios in every portal |
| `90-accessibility` | axe-core WCAG 2.1 A/AA on the main pages |

The HTML report is written to `e2e/report/` (CI uploads it as the `e2e-report` artifact on failure). Use a throwaway database: the stack seeds scenarios and moves the clock.

## 5.6 Load test

Dependency-free; signs in four demo users and hammers read endpoints, reporting throughput and latency per path. It uses the development TOTP helper, so it only runs against `development`/`demo` environments:

```bash
node scripts/load-test.mjs --api http://localhost:4000 --seconds 20 --concurrency 20
```

Start the API with a higher `RATE_LIMIT_MAX`, otherwise the rate limiter dominates the result.

## 5.7 Continuous integration

`.github/workflows/ci.yml` (every push and pull request):

| Job | Steps |
| --- | --- |
| `build` | `postgres:16` service → `npm ci` → typecheck → API tests → web tests → web build → regenerate OpenAPI + client and `git diff --exit-code` |
| `e2e` (after `build`) | `postgres:16` → `npm ci` → install e2e deps and Chromium → start `scripts/e2e-stack.sh` and wait for `stack ready` (max 300 s) → `npm run e2e` → upload report on failure |

`.github/workflows/security.yml` (push to `main`, pull requests, Mondays 03:17 UTC):

| Job | Fails when |
| --- | --- |
| `dependencies` | `npm audit --omit=dev --audit-level=high` finds a high or critical advisory in production dependencies |
| `codeql` | CodeQL (`javascript-typescript`, `security-extended`) reports an alert |

The database credentials in the workflows (`postgres/postgres`, `earlio_app/earlio_app`) are throwaway CI-only values.

## 5.8 Definition of done

From `AGENTS.md`: a change is done when **`npm test`, `npm run typecheck` and the web build are green**, the contract is regenerated if routes changed, and **`docs/progress.md`** records what changed, how it was verified and any deviations. Golden-number tests must pass exactly.

## 5.9 Reading a CI failure

| Failure | Usual cause | Fix |
| --- | --- | --- |
| `git diff --exit-code docs/openapi.json …` | Route schema changed without regenerating | `npm run openapi && npm run gen:client`, commit |
| `No test files found` / crash in global setup | No database reachable, or `MIGRATE_DATABASE_URL` is not a superuser | Check the `services.postgres` block and env |
| `migration 0xx failed` | SQL error in a new migration | Run `npm test` locally; fix the file (it has not been applied anywhere shared yet) |
| Permission snapshot mismatch | Role/permission change | Intended → update snapshot + matrix; otherwise fix code |
| `architecture.test.ts` | A module imported another module's routes, the kernel imported a module, or the web app called `fetch` directly | Use service functions / the outbox / the generated client |
| e2e timeout waiting for `stack ready` | API failed to start or seed | Download the run logs; `/tmp/stack.out` is printed by the step |
| e2e axe violation | New page with an accessibility issue | Fix the markup; the rule id in the report links to guidance |
| `npm audit` high/critical | New advisory in a production dependency | Upgrade the package (see [cookbook § 9.7](09-maintenance-cookbook.md#97-upgrading-dependencies)) |
