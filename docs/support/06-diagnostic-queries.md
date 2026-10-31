# 6. Diagnostic queries

Read-only SQL for L2 and L3. Run them on a **read replica** where one exists, with a **read-only** support role ([technical manual § 8.5](../technical-manual/08-security-and-secrets.md#85-access-to-production)).

## How to run them safely

Tenant tables are protected by row-level security. Open every session like this, so the queries see all organisations **and** cannot change anything:

```sql
begin transaction read only;
select set_config('app.is_platform', 'on', true);  -- cross-tenant visibility for this transaction only
-- … run queries …
rollback;
```

Rules:
- **Never select** `identity.users.password_hash`, `mfa_secret`, `recovery_codes`, `integration.api_keys.secret_hash` or `signing_secret`. The queries below avoid them.
- Never run `update`, `delete`, `insert` or DDL against production from a support session. Data corrections are L3 changes with review and an audit event.
- Replace `:placeholders` with values. Invoice numbers look like `INV-1005` (`invoicing.invoices.human_id`).
- Times are stored in UTC (`timestamptz`).

## Contents
| # | Question |
| --- | --- |
| Q1 | [Outbox health](#q1-outbox-health) |
| Q2 | [Pending events by topic and error](#q2-pending-events-by-topic-and-error) |
| Q3 | [Invoice overview](#q3-invoice-overview) |
| Q4 | [Parked outbox events](#q4-parked-outbox-events) |
| Q5 | [Files for an invoice or organisation](#q5-files-for-an-invoice-or-organisation) |
| Q6 | [Disbursements for an invoice](#q6-disbursements-for-an-invoice) |
| Q7 | [Open settlement exceptions by age](#q7-open-settlement-exceptions-by-age) |
| Q8 | [Webhook deliveries](#q8-webhook-deliveries) |
| Q9 | [Bank API keys](#q9-bank-api-keys) |
| Q10 | [Audit trail for an entity](#q10-audit-trail-for-an-entity) |
| Q11 | [A user's sign-in history](#q11-a-users-sign-in-history) |
| Q12 | [Long-running queries and locks](#q12-long-running-queries-and-locks) |
| Q13 | [Organisation and memberships](#q13-organisation-and-memberships) |
| Q14 | [Integration messages for a reference](#q14-integration-messages-for-a-reference) |
| Q15 | [Applied migrations](#q15-applied-migrations) |

---

## Q1. Outbox health

```sql
select
  count(*) filter (where processed_at is null)                                   as pending,
  min(created_at) filter (where processed_at is null)                            as oldest_pending,
  count(*) filter (where processed_at is null and created_at < now() - interval '15 minutes') as pending_over_15m,
  count(*) filter (where processed_at > now() - interval '5 minutes')            as processed_last_5m,
  count(*) filter (where processed_at > now() - interval '24 hours' and last_error is not null) as parked_last_24h
from platform.outbox;
```

Healthy: `pending` small, `processed_last_5m` > 0 when the platform is in use, `parked_last_24h` = 0.

## Q2. Pending events by topic and error

```sql
select topic, count(*) as pending, max(attempts) as max_attempts, min(created_at) as oldest,
       (array_agg(last_error order by id desc) filter (where last_error is not null))[1] as latest_error
from platform.outbox
where processed_at is null
group by topic
order by pending desc;
```

## Q3. Invoice overview

```sql
select i.human_id, i.number, i.status, i.route, i.cover_status, i.screening_status, i.dispute_flag,
       i.currency, i.gross_amount, i.accepted_amount, i.issue_date, i.due_date,
       s.legal_name as supplier, b.legal_name as buyer,
       i.submitted_at, i.accepted_at, i.dispute_window_ends_at, i.updated_at, i.warnings
from invoicing.invoices i
join identity.organisations s on s.id = i.supplier_org_id
join identity.organisations b on b.id = i.buyer_org_id
where i.human_id = :invoice_human_id;     -- e.g. 'INV-1005'
```

Status history: `select * from invoicing.invoice_history where invoice_id = (select id from invoicing.invoices where human_id = :invoice_human_id) order by 1;`

## Q4. Parked outbox events

Events that failed 5 times and were set aside (their follow-on work did not happen — [R5](03-runbooks.md#r5-parked-failed-outbox-events)).

```sql
select id, topic, created_at, processed_at as parked_at, attempts, last_error, payload
from platform.outbox
where processed_at is not null and last_error is not null
  and processed_at > now() - interval '7 days'
order by id desc;
```

## Q5. Files for an invoice or organisation

```sql
-- documents attached to an invoice
select d.doc_type, d.version, d.filename, f.content_type, f.size, f.scan_status, f.created_at, f.storage_key
from invoicing.invoice_documents d
join platform.files f on f.id = d.file_id
where d.invoice_id = (select id from invoicing.invoices where human_id = :invoice_human_id)
order by d.doc_type, d.version;

-- recent uploads by an organisation
select f.id, f.filename, f.content_type, f.size, f.scan_status, f.created_at
from platform.files f
where f.org_id = :org_id
order by f.created_at desc
limit 50;
```

`storage_key` is the file's path under the object store; L3 uses it to check the file exists in storage.

## Q6. Disbursements for an invoice

```sql
select d.reference, d.status, d.currency, d.amount_foreign, d.fx_rate, d.amount_inr, d.value_date,
       d.cutoff_missed, d.attempts, d.gateway_ref, d.failure_reason,
       d.instructed_at, d.sent_at, d.credited_at, bk.legal_name as bank
from settlement.disbursements d
join identity.organisations bk on bk.id = d.bank_org_id
where d.invoice_number = :invoice_human_id or d.invoice_id = (select id from invoicing.invoices where human_id = :invoice_human_id);

select e.at, e.status, e.note
from settlement.disbursement_events e
join settlement.disbursements d on d.id = e.disbursement_id
where d.invoice_id = (select id from invoicing.invoices where human_id = :invoice_human_id)
order by e.at;
```

## Q7. Open settlement exceptions by age

```sql
select x.created_at, now() - x.created_at as age, x.type, x.invoice_number, x.currency, x.amount,
       bk.legal_name as bank, x.detail
from settlement.exceptions x
join identity.organisations bk on bk.id = x.bank_org_id
where x.status = 'open'
order by x.created_at;
```

## Q8. Webhook deliveries

```sql
-- failures and retries in the last 7 days, by bank
select o.legal_name as bank, w.url, d.status, count(*) as deliveries, max(d.attempts) as max_attempts,
       (array_agg(d.last_error order by d.id desc) filter (where d.last_error is not null))[1] as latest_error,
       max(d.created_at) as latest
from integration.webhook_deliveries d
join integration.webhooks w on w.id = d.webhook_id
join identity.organisations o on o.id = d.org_id
where d.created_at > now() - interval '7 days' and d.status <> 'delivered'
group by o.legal_name, w.url, d.status
order by latest desc;
```

## Q9. Bank API keys

```sql
select o.legal_name as bank, k.label, k.key_prefix, k.status, k.created_at, k.expires_at, k.last_used_at
from integration.api_keys k
join identity.organisations o on o.id = k.org_id
where o.legal_name ilike :bank_name     -- e.g. '%Kestrel%'
order by k.created_at desc;
```

`key_prefix` (`ek_<8 hex>`) is safe to compare with what the bank sees; never ask for or look up the full key.

## Q10. Audit trail for an entity

```sql
-- by entity (invoice id, user id, exception id, …)
select seq, occurred_at, action, entity_type, entity_id, actor_label, actor_user_id, org_id, correlation_id, before, after
from audit.events
where entity_id = :entity_id
order by seq;

-- everything one request did, by correlation id (from the x-correlation-id header or a log line)
select seq, occurred_at, action, entity_type, entity_id, actor_label
from audit.events
where correlation_id = :correlation_id
order by seq;
```

For an invoice, get its id first: `select id from invoicing.invoices where human_id = :invoice_human_id;`.

## Q11. A user's sign-in history

```sql
select e.occurred_at, e.action, e.after, e.correlation_id
from audit.events e
where e.entity_type = 'user'
  and e.entity_id = (select id::text from identity.users where email = lower(:email))
  and e.action like 'auth.%'
order by e.seq desc
limit 50;

select email, name, mfa_enabled, failed_attempts, locked_until, created_at
from identity.users
where email = lower(:email);
```

Actions: `auth.login_password_ok`, `auth.login_failed` (with attempts/locked), `auth.mfa_failed`, `auth.login_complete`, `auth.switch_org`.

## Q12. Long-running queries and locks

Needs `pg_read_all_stats` or equivalent.

```sql
select pid, usename, application_name, state, now() - query_start as running_for, wait_event_type, wait_event,
       left(query, 200) as query
from pg_stat_activity
where datname = current_database() and state <> 'idle' and now() - query_start > interval '30 seconds'
order by running_for desc;

select blocked.pid as blocked_pid, blocking.pid as blocking_pid, left(blocked.query, 120) as blocked_query, left(blocking.query, 120) as blocking_query
from pg_stat_activity blocked
join pg_stat_activity blocking on blocking.pid = any(pg_blocking_pids(blocked.pid));

select usename, state, count(*) from pg_stat_activity where datname = current_database() group by 1, 2 order by 3 desc;
```

## Q13. Organisation and memberships

```sql
select id, type, legal_name, country, data_region, kyc_status, sanctions_status, blocked, is_partner, hostname, created_at
from identity.organisations
where legal_name ilike :org_name;

select u.email, u.name, m.role, m.created_at, u.mfa_enabled, u.locked_until
from identity.memberships m
join identity.users u on u.id = m.user_id
where m.org_id = :org_id
order by m.role, u.email;
```

## Q14. Integration messages for a reference

What Earlio sent to and received from a (simulated) external system for a disbursement reference, KYC case or notification.

```sql
select created_at, adapter, direction, reference, payload
from platform.integration_messages
where reference = :reference
   or payload::text ilike '%' || :reference || '%'
order by id;
```

The `ilike` scan is slow on a large table — always add a time filter (`and created_at > now() - interval '7 days'`).

## Q15. Applied migrations

```sql
select name, applied_at from public.schema_migrations order by name;
```

The count must equal `migrations` in `/ready` and match the release notes.
