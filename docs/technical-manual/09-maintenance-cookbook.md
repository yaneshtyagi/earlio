# 9. Maintenance cookbook

Recipes for the changes developers make most often. Each ends with the same gate: `npm run typecheck`, `npm test`, `npm test -w @earlio/web`, `npm run build -w @earlio/web`, then an entry in [`docs/progress.md`](../progress.md).

## Contents
- [9.1 Add an API endpoint](#91-add-an-api-endpoint)
- [9.2 Add a state transition](#92-add-a-state-transition)
- [9.3 Add a background job or event subscriber](#93-add-a-background-job-or-event-subscriber)
- [9.4 Add a module](#94-add-a-module)
- [9.5 Add or replace an adapter](#95-add-or-replace-an-adapter)
- [9.6 Add a web page](#96-add-a-web-page)
- [9.7 Upgrading dependencies](#97-upgrading-dependencies)
- [9.8 Change a permission or role](#98-change-a-permission-or-role)
- [9.9 Change bank or insurer behaviour](#99-change-bank-or-insurer-behaviour)
- [9.10 Code review checklist](#910-code-review-checklist)

## 9.1 Add an API endpoint

1. Add the route in the owning module's `routes.ts` with a full Zod schema (`tags`, `summary`, `params`/`querystring`/`body`, `response`). The summary becomes the OpenAPI description and the Posting request name — write it in plain language.
2. Guard it with a pre-handler from `src/http/context.ts`: `requirePerm('<permission>')`, `requireOrgType(...)`, `requireUser` or `requireSession`.
3. Do the work in a service function, inside `svc.db.tx(req.ctx, (tx) => …)` (or `platformCtx(req)` for platform staff, plus an audit event for the cross-tenant read).
4. Throw `DomainError` (or `invalid`, `notFound`, `forbidden`, `conflict` from `kernel/errors.ts`) with a message an end user understands.
5. If it moves money, accept an `Idempotency-Key` header and store the result in `platform.idempotency_keys`.
6. Regenerate the contract and the client: `npm run openapi && npm run gen:client`.
7. Add a request to `docs/posting/<tag>/`.
8. Tests: happy path, each rejection reason, a user of another organisation (404/empty), a role without the permission (403).

## 9.2 Add a state transition

1. Add the edge to the aggregate's transition table (for invoices: `TRANSITIONS` in `modules/invoicing/state.ts`). Anything not listed is illegal.
2. Perform the change through the module's transition helper, which in the **same transaction**:
   - checks the edge and throws a `DomainError` with a plain reason if illegal;
   - writes an audit event (`audit(tx, ctx, svc.clock.now(), {...})`);
   - emits an outbox event (`emit(tx, svc.clock.now(), '<topic>', payload, orgIds)`).
3. Update [`docs/workflows.md`](../workflows.md) and, if a diagram changes, `docs/bpmn/`.
4. Test both the legal transition and at least one illegal one.

## 9.3 Add a background job or event subscriber

- **Reacting to an event** from another module: add a handler to `handlersFor()` in `src/worker.ts` under the topic. Handlers run in a savepoint; a thrown error is retried on the next pass and parked after 5 attempts, so make handlers **idempotent** (check whether the work is already done).
- **Periodic job**: add a step to `runWorkOnce()` with `svc.db.system((tx) => yourJob(tx, svc, ctx))` and a named counter in the returned object. Use `svc.clock.now()` for every time comparison so tests and demos can move the clock.
- Tests move the virtual clock and call `runWorkOnce(svc)`; see `settlement.test.ts`.
- Keep the job safe to run twice at the same time (row locks, `FOR UPDATE SKIP LOCKED`, unique constraints) — it will be, once gap G1 is resolved by more than one instance.

## 9.4 Add a module

1. Create `src/modules/<name>/` with `service.ts` and `routes.ts` (`export function <name>Routes(app)`).
2. Register the routes in `src/modules/index.ts`.
3. Create the schema in a new migration and add `<name>` to `SCHEMAS` in `src/db/migrate.ts` so the app role is granted access.
4. Other modules may call your exported service functions or subscribe to your outbox topics; they must not import your `routes.ts` or write your tables (`architecture.test.ts` enforces the import rules).
5. Add RLS and isolation tests ([Database § 4.4](04-database-and-migrations.md#44-row-level-security-checklist)).
6. Add an ADR in `docs/adr/` if the module introduces a new architectural decision.

## 9.5 Add or replace an adapter

Example: an S3 object store to close gap G2.

1. Implement the interface (`ObjectStore` in `src/adapters/object-store.ts`) in a new file, e.g. `src/adapters/s3-object-store.ts`.
2. Add its configuration (bucket, region) to `Config` in `kernel/config.ts`, read from environment variables, and document it in [chapter 3](03-configuration.md).
3. Choose the implementation in `defaultAdapters()` (`src/adapters/index.ts`) based on configuration; keep the `Sim*`/local implementation as the development default.
4. Record every outbound request/response in `platform.integration_messages` as the simulators do, so the Integration inspector keeps working.
5. Tests keep using the simulator; add a contract test for the new adapter that can run against a local emulator (MinIO, LocalStack).
6. Migrating existing files: copy `OBJECT_STORE_DIR/<key>` to the bucket under the same key before switching.

## 9.6 Add a web page

1. Create or extend a file in `apps/web/src/pages/` using components from `@yaneshtyagi/design-system` and `src/ui/`.
2. Call the API **only** through `api` from `src/api/client.ts` (typed from `schema.d.ts`) with TanStack Query.
3. Add the route in `src/App.tsx` and, if it belongs in the sidebar, an entry in `NAV` in `src/shared/nav.ts` with the permission that should see it.
4. Add Hindi strings to `src/i18n/hi.json` for user-facing (non-platform) pages.
5. Check it at 375 px width and with the e2e accessibility spec (axe WCAG 2.1 A/AA); add the page to `e2e/tests/90-accessibility.spec.ts` if it is a main page.
6. Update the relevant [user manual](../user-manual/README.md) chapter and screenshot.

## 9.7 Upgrading dependencies

1. Create a branch. See what is outdated:

   ```bash
   npm outdated --workspaces
   ```

2. Upgrade in small groups (Fastify + plugins; Zod + `fastify-type-provider-zod`; React + router + query; Vite + plugin; test tooling), running the full gate after each group.
3. After upgrading Fastify, Zod or `fastify-type-provider-zod`, regenerate the contract — the generated schema may change shape.
4. After upgrading `openapi-typescript`, regenerate the client.
5. `npm audit --omit=dev --audit-level=high` must be clean (the `security` workflow enforces it).
6. **Node major version**: update `engines.node`, `.github/workflows/*.yml` (`node-version`) and the base image together.
7. **Design system**: replace the tarball in `vendor/`, update the `file:` path in `apps/web/package.json`, run `npm install`, and check the main pages visually.
8. **PostgreSQL major version**: test the migrations and full suite against the new version in CI (change the service image), then upgrade staging, then production, using the provider's in-place or blue/green upgrade.

## 9.8 Change a permission or role

1. Edit `PERMISSIONS` / `ROLES_BY_ORG_TYPE` in `modules/identity/permissions.ts`.
2. Update the snapshot (`npx -w @earlio/api vitest run test/permissions.test.ts -u`) and [`docs/permissions-matrix.md`](../permissions-matrix.md).
3. Update `NAV` permissions in `apps/web/src/shared/nav.ts` if a page's visibility changes.
4. Permission changes need a second reviewer from security or the product owner.

## 9.9 Change bank or insurer behaviour

Do **not** write code for one bank. Bank and insurer behaviour is **terms data** (JSON) edited in the Terms studio and published through maker-checker. If the rule engine cannot express what is needed:

1. Extend the terms JSON schema (`modules/terms/schema.ts`) and the evaluator (`modules/terms/evaluate.ts`, `rules.ts`) generically.
2. Add unit tests in `rules.test.ts`; keep the golden-number tests passing exactly.
3. Platform-wide limits that terms can never exceed are guardrails in `modules/terms/guardrails.ts`.

## 9.10 Code review checklist

- [ ] Time from `svc.clock.now()`; no `Date.now()`/`new Date()` in domain code.
- [ ] Money as `Decimal`/strings; rounding per charge line; no floats.
- [ ] Every query inside `db.tx(ctx, …)`; cross-tenant only through `platformCtx` and audited.
- [ ] New tenant tables have RLS + isolation tests.
- [ ] State changes write an audit event and an outbox event.
- [ ] Rejections use `DomainError` with a plain-language message.
- [ ] Money commands are idempotent.
- [ ] No per-bank code; no secrets in code.
- [ ] OpenAPI + client regenerated; Posting request added.
- [ ] Migrations backward compatible; ER diagrams updated.
- [ ] `docs/progress.md` updated, including deviations.
