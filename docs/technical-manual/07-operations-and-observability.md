# 7. Operations and observability

## Contents
- [7.1 Health endpoints](#71-health-endpoints)
- [7.2 Metrics](#72-metrics)
- [7.3 Logs](#73-logs)
- [7.4 Alerts](#74-alerts)
- [7.5 Routine operations](#75-routine-operations)
- [7.6 Backup and restore](#76-backup-and-restore)
- [7.7 Capacity and performance](#77-capacity-and-performance)

Day-to-day incident handling is in the [production support guide](../support/README.md); this chapter is about wiring and maintaining the monitoring.

## 7.1 Health endpoints

| Endpoint | Auth | Healthy response | Unhealthy | Use for |
| --- | --- | --- | --- | --- |
| `GET /health` | none | `200 {"status":"ok","db":true,"time":"…"}` | 500 (database query failed) | Container liveness / restart |
| `GET /ready` | none | `200 {"ready":true,"migrations":15,"outboxBacklog":0}` | `503 {"ready":false,"reason":"outbox backlog 1234"}` or the database error | Load balancer readiness, uptime monitor |
| `GET /api/v1/system/config` | none | `{"env":"production","simulated":false,"mode":"network","apiVersion":"0.1.0"}` | — | Confirm what is deployed |
| `GET /metrics` | `Authorization: Bearer $METRICS_TOKEN` in production | Prometheus text | 401 without token | Scraping |

`migrations` is the number of rows in `public.schema_migrations` (15 for migrations `000`–`014`). `outboxBacklog` counts unprocessed outbox events **older than 15 minutes**; above 1,000 the instance reports not ready. `/health` and `/ready` are exempt from rate limiting.

Check by hand:

```bash
curl -s https://app.<domain>/ready
```

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://<api-host>:4000/metrics | grep -E '^earlio_(outbox|db_pool)'
```

## 7.2 Metrics

The API renders Prometheus text without a client library (`src/kernel/metrics.ts`). Counters are **per process** and reset on restart.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `earlio_http_requests_total` | counter | `method`, `route` (route pattern, e.g. `/api/v1/invoices/:id`), `status` | Requests served |
| `earlio_http_request_duration_seconds` | histogram (buckets 0.01 … 5 s) | `method`, `route` | Latency |
| `earlio_outbox_pending` | gauge | — | All unprocessed outbox events (any age) |
| `earlio_db_pool_waiting` | gauge | — | Requests waiting for a database connection |
| `earlio_db_pool_total` | gauge | — | Open connections in the pool (max 10) |

Useful PromQL:

```promql
# error rate (5xx) over 5 minutes
sum(rate(earlio_http_requests_total{status=~"5.."}[5m])) / sum(rate(earlio_http_requests_total[5m]))

# p95 latency per route
histogram_quantile(0.95, sum by (le, route) (rate(earlio_http_request_duration_seconds_bucket[5m])))

# outbox growing for 15 minutes
deriv(earlio_outbox_pending[15m]) > 0 and earlio_outbox_pending > 100
```

Prometheus scrape job (reference):

```yaml
- job_name: earlio-api
  metrics_path: /metrics
  authorization: { type: Bearer, credentials_file: /etc/prometheus/earlio_metrics_token }
  static_configs: [{ targets: ['earlio-api:4000'] }]
```

## 7.3 Logs

- Fastify's logger (pino) writes **one JSON object per line to stdout** at level `info`.
- Each line carries `reqId` — the **correlation id**. It is taken from the incoming `x-correlation-id` header or generated, and returned in the `x-correlation-id` response header. Give it to support; they search logs by it.
- `cookie` and `authorization` request headers are redacted.
- Unhandled errors are logged as `"msg":"unhandled error"` with the stack in `err`; response-schema mismatches as `"response does not match schema"`. Domain errors (4xx with a plain-language reason) are *not* logged as errors.
- The worker logs `worker error: <message>` to stderr when a whole pass fails. Individual outbox handler failures are not logged; they are stored in `platform.outbox.last_error`.
- Audit events are in the database (`audit.events`), not in the logs.

Ship stdout/stderr to your log platform (CloudWatch, Loki, ELK, Datadog). Keep at least 90 days hot. Useful queries:

| Want | Filter |
| --- | --- |
| Everything for one request | `reqId = "<correlation id>"` |
| Server errors | `level >= 50` or `msg = "unhandled error"` |
| Slow requests | `responseTime > 3000` |
| Worker failures | `worker error` |

## 7.4 Alerts

| Alert | Condition | Severity | First response |
| --- | --- | --- | --- |
| API not ready | `/ready` failing for 2 minutes | P1 | [Support runbooks R1](../support/03-runbooks.md#r1-api-unavailable-or-not-ready) / [R3](../support/03-runbooks.md#r3-database-unavailable-or-saturated) |
| Error rate | 5xx > 2 % for 5 minutes | P1/P2 | Logs by `unhandled error` |
| Latency | p95 > 3 s for 10 minutes | P2 | DB load, pool waiting |
| Pool saturation | `earlio_db_pool_waiting > 0` for 5 minutes | P2 | DB slow queries; scale DB |
| Outbox growing | `earlio_outbox_pending` rising for 15 minutes | P2 | Worker stuck? [R4](../support/03-runbooks.md#r4-outbox-backlog-growing-background-work-stuck) |
| Parked outbox events | any `platform.outbox` row with `last_error` and `processed_at` set in the last day | P3 | [R5](../support/03-runbooks.md#r5-parked-failed-outbox-events) |
| Webhook failures | any `integration.webhook_deliveries.status = 'failed'` | P3 | [R7](../support/03-runbooks.md#r7-bank-webhook-deliveries-failing) |
| Settlement exceptions ageing | open `settlement.exceptions` older than 1 business day | P3 | [R8](../support/03-runbooks.md#r8-settlement-exceptions) |
| Audit chain | daily scheduled **Verify chain** reports a break | P1 (security) | [R10](../support/03-runbooks.md#r10-audit-chain-verification-fails) |
| Certificate expiry | < 21 days | P3 | Renew |
| Backup | last successful base backup > 26 h; WAL archive lag > 10 min | P2 | Provider console |

The SQL-based alerts can run as a scheduled job with the queries in [support diagnostic queries](../support/06-diagnostic-queries.md).

## 7.5 Routine operations

| Frequency | Task | How |
| --- | --- | --- |
| Daily | Review the settlement **exceptions** queue | Platform/bank **Settlement → Exceptions** |
| Daily | Verify the audit chain | Platform **Audit log → Verify chain**, or `GET /api/v1/audit/verify` as an auditor |
| Daily | Check parked outbox events and failed webhooks | [Diagnostic queries](../support/06-diagnostic-queries.md) |
| Weekly | Anchor the audit chain head | `POST /api/v1/audit/anchor` (platform admin) |
| Weekly | Review the `security` workflow results (npm audit, CodeQL) | GitHub Actions / Security tab |
| Monthly | Review unused bank API keys, inactive users | Bank console; `identity.users` |
| Monthly | Dependency upgrades | [Cookbook § 9.7](09-maintenance-cookbook.md#97-upgrading-dependencies) |
| Quarterly | Restore drill | § 7.6 |
| Quarterly | Rotate `METRICS_TOKEN`; review access to production | [Security § 8.3](08-security-and-secrets.md#83-rotation) |
| Yearly | Rotate `WEBHOOK_KEY` (coordinate with banks), database passwords | [Security § 8.3](08-security-and-secrets.md#83-rotation) |

## 7.6 Backup and restore

Targets: **RPO < 15 minutes, RTO < 4 hours.**

**Database**
- Continuous WAL archiving (or the managed service's PITR) shipping at least every 5 minutes; nightly full base backup; retain 35 days.
- Point-in-time recovery always restores to a **new** instance; never overwrite the running database.

**Object store**
- Back up the `OBJECT_STORE_DIR` volume with snapshots at least hourly and retain 35 days (until gap G2 replaces it with a versioned, replicated bucket).
- Files are referenced from `platform.files`; restore the volume to a time at or after the database restore point so no referenced file is missing.

**Restore drill (quarterly, recorded)**
1. Restore the database to a new instance at a chosen time.
2. Restore the object-store snapshot taken just after that time to a new volume.
3. Start a staging API against them with `EARLIO_ENV=production` and staging secrets (it applies any missing migrations; they are idempotent by name).
4. Verify: `GET /ready`; **Verify chain** reports "Chain intact"; open 5 sample invoices and their documents; compare row counts of key tables with production at the restore time.
5. Record start/end times (achieved RTO) and the time of the last recovered transaction (achieved RPO) in the drill log.

## 7.7 Capacity and performance

- One API process holds **10 database connections**; leave headroom on the server for admin tools and the migration connection.
- The worker processes up to 200 outbox events per drain and drains up to six times per pass; a 15-second interval gives roughly 4,800 events/minute at most.
- Run `scripts/load-test.mjs` against a `demo` environment of the same size before a pilot; raise `RATE_LIMIT_MAX` for the test only.
- Watch `earlio_db_pool_waiting`: sustained waiting means the database or a slow query is the bottleneck, not the Node process.
