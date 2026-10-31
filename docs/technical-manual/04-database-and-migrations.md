# 4. Database and migrations

## Contents
- [4.1 Roles and privileges](#41-roles-and-privileges)
- [4.2 How migrations run](#42-how-migrations-run)
- [4.3 Writing a migration](#43-writing-a-migration)
- [4.4 Row-level security checklist](#44-row-level-security-checklist)
- [4.5 Append-only and concurrency-sensitive tables](#45-append-only-and-concurrency-sensitive-tables)
- [4.6 Rolling back a schema change](#46-rolling-back-a-schema-change)
- [4.7 Preparing a production database](#47-preparing-a-production-database)
- [4.8 Data retention and growth](#48-data-retention-and-growth)

## 4.1 Roles and privileges

| Role | Connection | Can | Cannot |
| --- | --- | --- | --- |
| **Owner** (e.g. `postgres` locally, `earlio_owner` in production) | `MIGRATE_DATABASE_URL` | Create schemas, tables, functions, policies; grant | — (never used by request handling) |
| **`earlio_app`** | `DATABASE_URL` | `select/insert/update/delete` on every module schema; `usage/select` on sequences; execute `app.*` functions; `select` on `public.schema_migrations` | Bypass RLS; `update/delete/truncate` on `audit.events` and `audit.anchors`; `delete/truncate` on `audit.chain_head` |

The migration runner re-applies the grants **on every start**, so new tables in existing schemas are granted automatically. A **new schema** must be added to the `SCHEMAS` list in `src/db/migrate.ts`, otherwise `earlio_app` cannot see it.

## 4.2 How migrations run

`migrate()` in `src/db/migrate.ts` runs at every API start (in `bootstrap()`), connected as the owner:

1. Creates role `earlio_app` **if it does not exist** (with the development password `earlio_app` — see § 4.7).
2. Creates `public.schema_migrations(name, applied_at)` if missing.
3. Applies each `apps/api/migrations/*.sql` file not yet recorded, **in file-name order**, each in **its own transaction**, then records it. A failure rolls back that file and stops start-up with `migration <file> failed: <reason>`.
4. Re-applies grants and the append-only revokes.

You can also run migrations on their own (for a release job, or before starting the API):

```bash
cd apps/api && npx tsx src/db/migrate.ts
```

It prints `applied: <files>` or `applied: none`.

There is **no down-migration** mechanism and no checksum check: an applied file is identified by name only. Never edit or rename a migration that has reached any shared environment.

## 4.3 Writing a migration

1. Add the next file: `apps/api/migrations/015_<short_name>.sql` (three-digit prefix, snake case).
2. Write plain PostgreSQL. The file runs in one transaction, so do not use statements that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE` before PG 12 semantics, `VACUUM`).
3. Keep it **backward compatible** with the previous release of the code (expand → migrate → contract), because the new schema is applied before the new code takes traffic and the old code may still be running during a rolling restart:
   - add nullable columns or columns with defaults; backfill in the same file if cheap;
   - add new tables and indexes;
   - drop or rename columns only in a later release, after no code reads them.
4. Add RLS for every tenant table (§ 4.4).
5. Store money as `numeric(20,2)` (or the precision the domain needs), never `float`; timestamps as `timestamptz`; amounts are passed from code as strings.
6. Update [`docs/er-diagrams.md`](../er-diagrams.md).
7. Run `npm test` — the global setup builds a fresh template database from all migrations, so a broken file fails immediately.

Large tables: an `ALTER TABLE` that rewrites the table or a non-concurrent index build locks writes. For tables that have grown (audit, outbox, ledger, notifications) run those changes in a maintenance window or as a separate manual step, and keep the migration file idempotent (`if not exists`) so it is a no-op when the runner reaches it.

## 4.4 Row-level security checklist

For each table that holds tenant data:

```sql
alter table <schema>.<table> enable row level security;
create policy <t>_select on <schema>.<table> for select
  using (<org column> = app.org_id() or app.is_platform());
create policy <t>_insert on <schema>.<table> for insert
  with check (<org column> = app.org_id() or app.is_platform());
-- update/delete policies as the domain needs
```

- Use the existing tables of the same module as the pattern (e.g. `invoicing.dispute_messages` lets every party read).
- Add an isolation test at **API level** and at **raw-SQL level** (see `test/tenancy.test.ts`): a user of another organisation must get 404/empty, and a raw query as `earlio_app` with another `app.org_id` must return no rows.

## 4.5 Append-only and concurrency-sensitive tables

| Table(s) | Invariant | Enforced by |
| --- | --- | --- |
| `audit.events`, `audit.anchors`, `audit.chain_head` | Append-only hash chain; no edits or deletes | Privileges (revokes) + verification endpoint |
| `marketplace.liens`, `marketplace.lien_events` | One active lien per invoice | Database constraints + parallel tests |
| `identity.bank_limits`, `insurance.buyer_limits` | Exposure never above limit | Row locks in the service + parallel tests |
| `platform.idempotency_keys` | A money command runs once per key | Primary key `(key, scope)` |
| `platform.webhook_nonces` | A machine-API nonce is accepted once | Unique key |
| `settlement.bank_transactions` | A `bankTxnId` is booked once | Unique key |

Do not "fix" data in these tables by hand in shared environments. Production data corrections go through the application (or a reviewed script that also writes audit events) — see [support runbooks](../support/03-runbooks.md).

## 4.6 Rolling back a schema change

Because there are no down-migrations:

- **Preferred:** roll forward. Ship a new migration that reverses or repairs the change.
- **Code rollback** after a backward-compatible migration needs nothing: the old code ignores new columns and tables.
- **Destructive mistake** (dropped data): restore from point-in-time recovery to a new instance and copy the affected data back ([Operations § 7.6](07-operations-and-observability.md#76-backup-and-restore)).
- To make the runner re-apply a file during development only, delete its row from `public.schema_migrations` after undoing its effects by hand.

## 4.7 Preparing a production database

1. Provision managed PostgreSQL 16 with TLS, encryption at rest, automated backups and point-in-time recovery.
2. Create the database and an **owner** role (not a cluster superuser if your provider allows it; it needs `CREATEROLE` only if you let the runner create `earlio_app`).
3. **Create `earlio_app` yourself with a strong password before the first start**, so the runner does not create it with the development password:

   ```sql
   create role earlio_app login password '<strong password from the secrets manager>';
   grant connect on database earlio to earlio_app;
   ```

4. Make sure `earlio_app` is **not** a superuser, does not own any objects and does not have `BYPASSRLS`:

   ```sql
   select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'earlio_app';
   ```

5. The base migration runs `create extension if not exists pgcrypto`. If your provider restricts extension creation to an administrator role, create `pgcrypto` in the database before the first start.
6. Set `DATABASE_URL`/`MIGRATE_DATABASE_URL` with `sslmode=require` (or `verify-full` with the provider's CA).

## 4.8 Data retention and growth

| Table | Growth | Retention guidance |
| --- | --- | --- |
| `audit.events` | Every state change and every login | **Never delete** from the application. Keep ≥ 8 years (assumption; *needs counsel*). After verifying the chain, partitions older than 2 years may move to cold storage. |
| `platform.outbox` | Every domain event | Processed rows can be archived after 90 days (keep parked rows with `last_error` until investigated). |
| `platform.integration_messages` | Every simulated external call | Archive after 90 days. |
| `identity.sessions` | Every login | Expired sessions can be deleted (they are already unusable after 8 h). |
| `notify.notifications`, `integration.webhook_deliveries` | Per event | Archive after 1 year. |
| Object store | Every upload | Same retention as the business record it belongs to (KYC: *needs counsel*). |

> **Gap:** there is no archiving job yet. Add one (or a scheduled SQL job) before tables grow large; the indexes on `processed_at` and `created_at` support it.
