# Operations runbook

## Run it
`npm run start -w @earlio/api` (API + worker) and `npm run build -w @earlio/web` (static files behind any CDN/reverse proxy). Configuration is by environment variable: `DATABASE_URL` (application role), `MIGRATE_DATABASE_URL` (owner, migrations only), `EARLIO_ENV`, `CORS_ORIGINS`, `WEBHOOK_KEY` (production requires a 24+ character secret), `METRICS_TOKEN`.

## Health
| Endpoint | Meaning |
|---|---|
| `/health` | Process is up and the database answers |
| `/ready` | Migrations applied and the outbox is not stuck (backlog older than 15 min under 1,000). Use it for load-balancer readiness. |
| `/metrics` | Prometheus text: request counts and latency by route, `earlio_outbox_pending`, pool gauges. In production it needs `Authorization: Bearer $METRICS_TOKEN`. |

Logs are structured JSON (pino) with a correlation id on every line (`x-correlation-id` is accepted and echoed). Alert on: `/ready` failing for 2 min · p95 latency over 3 s · `earlio_outbox_pending` growing for 15 min · failed webhook deliveries · exceptions queue older than 1 business day.

## Backup and restore (targets: RPO < 15 min, RTO < 4 h)
* **Continuous archiving.** Enable WAL archiving (`archive_mode=on`, ship WAL at least every 5 minutes, or use a managed service's point-in-time recovery). Take a full base backup nightly. Retain 35 days.
* **Object store** (documents): versioned bucket with cross-region replication; same retention.
* **Restore drill (quarterly):** 1) create a new instance from the latest base backup and replay WAL to the chosen time; 2) run migrations (they are idempotent); 3) point a staging API at it; 4) verify `GET /ready`, the audit hash chain (`GET /api/v1/audit/verify`) and a sample of invoices; 5) record the elapsed time. Switch production DNS/connection string only for a real incident.
* **Evidence.** Keep the drill record; the time between the last WAL segment and the incident is the achieved RPO.

## Routine
* Worker runs every pass: outbox, reminders, insurer API, offer/cover expiry, disbursements, collections, overdue/default, dispute timers, webhooks, dashboards. If it stops, `/ready` degrades through the outbox backlog.
* **Exceptions queue** (settlement): review daily; each item names its allowed actions.
* **Key rotation:** API keys per bank (console); `WEBHOOK_KEY` by changing the secret and re-deriving per-bank secrets (coordinate with the bank).
* **Audit retention:** audit events are never deleted by the application. Keep at least 8 years (assumed to align with record-keeping obligations; **needs counsel**), moving partitions older than 2 years to cold storage after verifying the hash chain.

## Incident basics
1. Declare, assign an incident lead, open a channel. 2. Contain (revoke keys, disable a bank's hostname, switch the platform to read-only by stopping the worker). 3. Preserve evidence (audit trail, logs by correlation id). 4. Notify affected parties as required by law (**needs counsel**: breach-notification duties differ for India, US and Singapore). 5. Post-incident review within 5 working days.

## Encryption and secrets
Database and object storage must use provider-managed encryption at rest (AES-256) with customer-managed keys where the cloud offers them; TLS 1.2+ everywhere in transit. Secrets are read through `SecretProvider` (`src/kernel/secrets.ts`); plug a vault (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault) in behind that interface. Production refuses to start with a missing or development secret.

## Data residency
Each organisation has a region. Residency is enforced at **deployment level**: run one deployment (database, object store, worker) per residency zone and route organisations to it. The MVP is single-region; cross-border transfers (e.g. India-originated KYC data processed in the US) are listed in the legal checklist as **needs counsel**.
