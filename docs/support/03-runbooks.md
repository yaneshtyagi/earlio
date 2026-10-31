# 3. Incident runbooks

Each runbook gives the **symptoms**, a default **severity**, **diagnosis** steps, the **fix**, and when to **escalate**. Steps marked **L3** need infrastructure access. Queries `Qn` are in [diagnostic queries](06-diagnostic-queries.md).

## Contents
| # | Runbook | Default severity |
| --- | --- | --- |
| R1 | [API unavailable or not ready](#r1-api-unavailable-or-not-ready) | P1 |
| R2 | [Errors or slow responses](#r2-errors-or-slow-responses) | P1/P2 |
| R3 | [Database unavailable or saturated](#r3-database-unavailable-or-saturated) | P1 |
| R4 | [Outbox backlog growing (background work stuck)](#r4-outbox-backlog-growing-background-work-stuck) | P2 |
| R5 | [Parked (failed) outbox events](#r5-parked-failed-outbox-events) | P3 |
| R6 | [Disbursement not received by the supplier](#r6-disbursement-not-received-by-the-supplier) | P2 |
| R7 | [Bank webhook deliveries failing](#r7-bank-webhook-deliveries-failing) | P3 |
| R8 | [Settlement exceptions](#r8-settlement-exceptions) | P3 |
| R9 | [Bank machine API calls rejected](#r9-bank-machine-api-calls-rejected) | P2/P3 |
| R10 | [Audit chain verification fails](#r10-audit-chain-verification-fails) | P1 (security) |
| R11 | [A bank portal shows the wrong branding or does not load](#r11-a-bank-portal-shows-the-wrong-branding-or-does-not-load) | P3 |
| R12 | [Users cannot sign in](#r12-users-cannot-sign-in) | P1 (many) / P3 (one) |
| R13 | [File upload or preview problems](#r13-file-upload-or-preview-problems) | P3 |
| R14 | [An invoice is "stuck"](#r14-an-invoice-is-stuck) | P3 |
| R15 | [Notifications or e-mails not received](#r15-notifications-or-e-mails-not-received) | P3 |
| R16 | [Suspected cross-tenant data exposure](#r16-suspected-cross-tenant-data-exposure) | P1 (security) |
| R17 | [Failed deployment](#r17-failed-deployment) | P1 |

---

## R1. API unavailable or not ready

**Symptoms:** users see "Could not reach the server" or a proxy error page; `/health` or `/ready` fails; *API not ready* alert.

**Diagnosis**
1. `curl -s https://app.<domain>/health` and `/ready`.
   - No response / 502 / 504 → the API process is down or unreachable (step 2).
   - `/health` OK, `/ready` 503 with `outbox backlog …` → [R4](#r4-outbox-backlog-growing-background-work-stuck).
   - `/ready` 503 with a database error, or `/health` 500 → [R3](#r3-database-unavailable-or-saturated).
2. **L3:** check the API container/process status and its last log lines.
   - `migration <file> failed: …` → a release just failed → [R17](#r17-failed-deployment).
   - `WEBHOOK_KEY must be set to a strong secret…` → configuration/secret missing after a change → restore the secret, restart.
   - `DATABASE_URL is not set` → configuration missing → restore, restart.
   - Out-of-memory kill / crash loop → capture logs, restart, escalate to engineering.
3. Check the proxy/load balancer: target healthy? TLS certificate valid?

**Fix:** restore configuration or restart the API (**L3**). After recovery, confirm `/ready`, sign in, and run **Verify chain**.

**Escalate:** immediately to L3 on-call; open an incident; send the *incident opened* message if down > 15 minutes.

---

## R2. Errors or slow responses

**Symptoms:** users see "Internal error." or pages that load slowly; high error rate or latency alert.

**Diagnosis**
1. Dashboard: is it all routes or one? (`route` label on `earlio_http_requests_total` and the latency histogram.)
2. Logs: filter `msg = "unhandled error"` for the time window; group by route and error message. A user's correlation id (`x-correlation-id`) finds their exact request.
3. `earlio_db_pool_waiting > 0` → the database is the bottleneck → [R3](#r3-database-unavailable-or-saturated).
4. Did a release happen just before? → consider rollback ([R17](#r17-failed-deployment)).
5. `response does not match schema` in the logs → a code defect (the API produced data its own contract does not allow) → L3.

**Fix:** depends on cause — roll back a bad release, relieve database load, or hand the error with correlation ids to L3.

**Note:** `4xx` responses with a plain-language message are business rules, not faults. Check the [error catalogue](05-error-catalogue.md) before raising an incident about one.

---

## R3. Database unavailable or saturated

**Symptoms:** `/ready` reports a connection error; `/health` 500; slow pages; `earlio_db_pool_waiting` above zero.

**Diagnosis (L2 with read-only DB access, L3 for the provider console)**
1. Provider console: instance up? CPU, memory, storage, connections, replication/failover events.
2. Long-running queries and locks — [Q12](06-diagnostic-queries.md#q12-long-running-queries-and-locks).
3. Storage full → writes fail everywhere; increase storage (**L3**).
4. Too many connections → each API instance uses up to 10; check for other clients (reporting tools, ad-hoc sessions).

**Fix (L3)**
- Cancel a runaway query: `select pg_cancel_backend(<pid>);` (terminate only if cancel fails, and record it).
- Fail over / scale the instance per the provider's procedure.
- After a database restart, the API reconnects automatically (idle clients are replaced); confirm `/ready`.

**Escalate:** P1 to L3 and the database provider if the instance is down.

---

## R4. Outbox backlog growing (background work stuck)

**What it is:** every business event (invoice accepted, financing approved, …) is written to the *outbox* and processed by the background worker every 15 seconds. The worker also sends disbursements, matches statements, expires offers, delivers webhooks and notifications. If it stops, nothing breaks immediately on screen, but follow-on steps stop happening: no insurer cover requests, no disbursements, no notifications.

**Symptoms:** *outbox growing* alert; `/ready` → `outbox backlog N`; users report "I accepted the invoice but nothing happened", missing notifications, offers not expiring.

**Diagnosis**
1. [Q1](06-diagnostic-queries.md#q1-outbox-health) — pending count, oldest pending event, recent processing rate.
2. Is the oldest pending event moving? Re-run Q1 after one minute.
   - **Processed count rising, backlog falling** → it is catching up after a burst; monitor.
   - **Nothing processed in the last few minutes** → the worker is not running or every pass fails.
3. Logs: search `worker error:` — a whole pass failing (often a database error) is logged there.
4. [Q2](06-diagnostic-queries.md#q2-pending-events-by-topic-and-error) — events retrying with `last_error`: one topic failing repeatedly?

**Fix**
- Worker not running (no `worker error` lines, no processing) → **L3** restarts the API (the worker runs inside it).
- A pass fails on a database error → fix the database ([R3](#r3-database-unavailable-or-saturated)).
- One topic failing → the handler has a defect or bad data; events will park after 5 attempts ([R5](#r5-parked-failed-outbox-events)) and the rest of the queue continues. Escalate to L3 with the `last_error`.

**Escalate:** L3 if not catching up within 15 minutes.

---

## R5. Parked (failed) outbox events

**What it is:** an event whose handler failed 5 times is marked processed with `last_error` set, so it does not block the queue. **The follow-on work for that event did not happen.**

**Diagnosis**
1. [Q4](06-diagnostic-queries.md#q4-parked-outbox-events) — parked events with topic, payload and error.
2. Work out what was missed from the topic:

| Topic | Follow-on work that did not happen |
| --- | --- |
| `invoice.accepted` | Insurance cover request; export-proceeds tracking |
| `financing.approved` | Disbursement instruction to the bank |
| `financing.funded` | Collection expectation (the buyer's payment will not match automatically) |
| `invoice.overdue` | Default case opening |
| any | In-app/e-mail notifications and bank webhooks for that event |

3. Check whether the work happened anyway (e.g. [Q6](06-diagnostic-queries.md#q6-disbursements-for-an-invoice) for a disbursement).

**Fix:** **L3** — after the defect or data problem is fixed, re-queue the event (reset `processed_at`, `attempts` and `last_error` for that event id) through a reviewed change, and confirm the follow-on work happened. Do not re-queue without understanding the error: a handler that partly succeeded could repeat work. Tell affected users if a notification was missed.

---

## R6. Disbursement not received by the supplier

**Symptoms:** supplier says the invoice shows *Funded* (or *financing approved*) but no money arrived.

**Diagnosis**
1. [Q6](06-diagnostic-queries.md#q6-disbursements-for-an-invoice) — disbursement status and events for the invoice.

| Status | Meaning | Action |
| --- | --- | --- |
| *(no row)* | Instruction never created | Check for a parked `financing.approved` event ([R5](#r5-parked-failed-outbox-events)); check the buyer acknowledged the assignment notice |
| `Instructed`, `FXBooked`, `QueuedForValueDate` | Waiting for the value date (bank holidays shift it) | Explain the value date to the supplier |
| `Sent` | Sent to the bank; waiting for confirmation | Ask the bank to trace the payment with the reference |
| `Retry` | A send failed and will be retried automatically | Monitor; see the reason in the events |
| `Failed` | Failed after all retries → a `DisbursementFailed` exception exists | [R8](#r8-settlement-exceptions); bank to correct and resend |
| `Returned` | The supplier's bank returned the funds → `DisbursementReturned` exception | Supplier to confirm account details; bank to resend |
| `Credited` | Money was credited | Ask the supplier to check with their bank using the reference |

2. **Integration inspector** → adapter `payments` → find the reference: what was sent and what came back.

**Escalate:** to the funding bank's operations contact with the invoice number, amount, reference and status; L3 if the status does not match the bank's records.

---

## R7. Bank webhook deliveries failing

**Symptoms:** a bank says it stopped receiving event notifications; *webhook failures* alert; the bank's **API and files → Recent deliveries** shows `failed` with a *Last error*.

**Diagnosis**
1. [Q8](06-diagnostic-queries.md#q8-webhook-deliveries) — deliveries by status for the bank, with `last_error`.
2. Read the error:

| Error looks like | Cause | Owner |
| --- | --- | --- |
| `HTTP 4xx` (e.g. 401, 403, 404) | Their endpoint rejects us (wrong path, auth, or signature check failing) | Bank |
| `HTTP 5xx` | Their endpoint is erroring | Bank |
| timeout / `ECONNREFUSED` / DNS error | Their endpoint is unreachable from the internet | Bank (firewall/allow-list) or our egress (L3) |

3. If **all** banks fail at once, the problem is ours (egress, DNS) → L3.
4. If the bank says our deliveries arrive but **fail its signature check**: webhooks are signed with the bank's newest active API-key signing secret. After the bank rotates or creates a key, its receiver must use the new key's signing secret. A bank with no active key receives deliveries with an empty signature.

**Fix:** the bank fixes its endpoint. Deliveries retry up to 5 times, then stay `failed`; failed deliveries are **not** resent automatically. Ask the bank to reconcile missed events through the machine API (e.g. `GET /api/v1/machine/invitations`, `/instructions`) or the console. L3 can re-queue failed deliveries after the bank confirms the fix.

**Bank payment callbacks rejected (inbound):** a bank's payment system posting status callbacks to `/api/v1/webhooks/bank/:bankId` gets `401 bad_signature` when its derived secret is wrong or after `WEBHOOK_KEY` was rotated ([technical manual § 8.3](../technical-manual/08-security-and-secrets.md#83-rotation)) → L3.

---

## R8. Settlement exceptions

**What it is:** when an incoming payment cannot be matched to an expected buyer payment, or a disbursement fails, an **exception** is raised for the bank's operations team and platform settlement staff. Open them from **Settlement → Exceptions**; each row offers only the actions allowed for its type.

| Type | Meaning | Allowed actions | Typical handling |
| --- | --- | --- | --- |
| `Unmatched` | Money arrived with a reference that matches no expected payment | `assign` (to an invoice number) | Identify the invoice from the payer and amount; assign |
| `ShortPaid` | Less than expected was paid | `wait`, `accept_short` | Wait for the balance, or accept the short payment (recourse/claims rules then apply) |
| `OverPaid` | More than expected was paid | `refund` | Refund the excess to the payer |
| `Late` | Paid after the due date | `acknowledge` | Late interest rules apply automatically |
| `AmountMismatch` | Amount differs (e.g. a credit note) | `accept_credit`, `acknowledge` | Accept the credit if a credit note explains it |
| `DisbursementFailed` | Payment to the supplier failed after retries | `acknowledge` | Bank corrects and resends; then acknowledge |
| `DisbursementReturned` | Supplier's bank returned the funds | `acknowledge` | Confirm account details; bank resends; then acknowledge |

**Rules**
- Resolve exceptions only with evidence (bank statement line, payer confirmation). Write the evidence in the note.
- Resolution is a money decision: the bank's operations user or platform settlement staff perform it, not L1.
- Every resolution is audited (`settlement.exception_resolved`).
- Ageing: none older than 1 business day without an owner and a note. [Q7](06-diagnostic-queries.md#q7-open-settlement-exceptions-by-age) lists them by age.

---

## R9. Bank machine API calls rejected

**Symptoms:** a bank's system reports `401`, `409` or `422` from `/api/v1/machine/*`.

| Response | Cause | Fix |
| --- | --- | --- |
| `401 bad_api_key` "The API key is missing, wrong, expired or revoked." | Wrong key, revoked key, or a rotated key past its 24-hour grace | Bank admin checks **API keys** status; creates or rotates a key ([service request S6](04-service-requests.md#s6-bank-api-key-create-rotate-revoke)) |
| `401` signature / timestamp error | Signature computed over the wrong string, wrong secret, or clock skew > 5 minutes | Bank checks HMAC over `<timestamp>.<nonce>.<raw body>` and NTP sync ([integration guide](../integration-guide.md)) |
| `409 replay` | Nonce reused | Bank must send a new nonce per request |
| `422 outside_terms` | Offer outside guardrails (rate 0–60 %, validity 1–168 h, non-negative FX spread) | Bank corrects its offer |
| `409` `not_open` / `not_invited` | Invoice no longer open for offers, or not invited | Expected business rule |
| `429` | Rate limit (600/min per address) | Bank slows down / batches |

Ask the bank for the request time, endpoint, status and `x-correlation-id`; never for the key or secret. L2 can find the request in the logs by correlation id; [Q9](06-diagnostic-queries.md#q9-bank-api-keys) shows key status and last use.

---

## R10. Audit chain verification fails

**Symptoms:** **Verify chain** shows a failure naming the first broken event; the scheduled verification alert fires.

**Treat as a security incident (P1)** until proven otherwise: the application role cannot update or delete audit rows, so a break means a privileged change, a restore inconsistency or a software defect.

1. **Do not** attempt to repair the chain.
2. Record the reported sequence number and time; take a screenshot.
3. Page L3 and the incident lead; restrict production database access to the incident team.
4. **L3:** compare the event at that sequence with backups and with the latest anchor (`audit.anchors`); review database logs for privileged sessions; check whether a restore or migration happened around that time.
5. Known non-malicious cause: databases created before 30 Oct 2026 contain events hashed by a since-fixed defect (typed payloads in terms submissions) — relevant to development and demo databases only.

---

## R11. A bank portal shows the wrong branding or does not load

**Symptoms:** `https://<tenant>.<domain>` shows Earlio branding, another bank's branding, or a certificate/DNS error.

1. **Tenant domains** screen: is the tenant name correct? Is a custom domain set?
2. Certificate/DNS error → the wildcard DNS record or certificate does not cover the host, or the bank's custom domain CNAME is wrong → L3 / the bank's DNS team.
3. Correct host but default branding → the proxy is not forwarding `X-Forwarded-Host` (all portals affected; L3), or the tenant name was changed/cleared (audit action `branding.tenant_set`).
4. Tenant names can be changed by the bank administrator on its **Bank console** or by platform staff ([service request S7](04-service-requests.md#s7-tenant-name-or-custom-domain)).

Note: branding does not restrict who can sign in; any user can sign in on any portal.

---

## R12. Users cannot sign in

| Scope | Likely cause | Action |
| --- | --- | --- |
| **Everyone** | API or database down | [R1](#r1-api-unavailable-or-not-ready) |
| Everyone, error "Your session security token is missing or out of date" | CSRF token stale after a deployment | Users reload the page |
| Everyone's MFA codes rejected | Server clock drift (TOTP depends on time) | L3: check NTP on the API host |
| One user, "Email or password is incorrect." | Wrong password or wrong e-mail address | User retries; no self-service reset yet → [S2](04-service-requests.md#s2-password-reset) |
| One user, "This account is temporarily locked…" | 5 failed attempts | Unlocks after 15 minutes; or [S1](04-service-requests.md#s1-unlock-an-account) |
| One user, "That code is not valid." | Phone clock wrong, wrong authenticator entry, or code expired | Check phone time is automatic; use a recovery code; else [S3](04-service-requests.md#s3-lost-mfa-device) |
| One user, signed in but "No active organisation for this session." | User has no membership, or it was removed | Org admin adds the user ([S4](04-service-requests.md#s4-add-a-user-or-change-a-role)) |
| One user, signed out every few hours | Sessions last 8 hours | Expected |

[Q11](06-diagnostic-queries.md#q11-a-users-sign-in-history) shows a user's recent sign-in events.

---

## R13. File upload or preview problems

| Message | Cause | Action |
| --- | --- | --- |
| "Files can be at most 10 MB." | Size limit | Compress or split the document |
| "The file is empty." | Zero-byte file | Re-export the document |
| "This file was rejected by the virus scan." | Antivirus flagged it | User scans their machine and obtains a clean copy; do not bypass |
| "This file type cannot be previewed. Download it to open it on your device." | Only PDF, PNG, JPEG, GIF, WebP and plain text preview in the browser | Download instead; expected |
| "An active organisation is required to upload files." | Session without organisation | Sign out and in; check membership |
| Upload fails at exactly ~3–12 MB with a proxy error | Proxy body-size limit lower than the API's | L3: proxy `client_max_body_size` |
| Download returns 404 | File belongs to another organisation and was not shared, or the file is missing from storage | Check [Q5](06-diagnostic-queries.md#q5-files-for-an-invoice-or-organisation); missing from storage → L3 (object store) |

---

## R14. An invoice is "stuck"

1. Find it: [Q3](06-diagnostic-queries.md#q3-invoice-overview) — status, route, cover status, dispute flag, timestamps.
2. Its history: **Invoice detail → timeline**, or [Q10](06-diagnostic-queries.md#q10-audit-trail-for-an-entity).
3. Compare with what should happen next:

| Status | Waiting for | Common blocker |
| --- | --- | --- |
| `Submitted` | Buyer to accept/reject | Buyer not acting (reminders are sent automatically) |
| `Accepted` / `NotEligible` | Eligibility, cover, KYC | Supplier/buyer KYC incomplete; sanctions hit; no insurance limit; relationship suspended |
| `OpenForFunding` | Bank offers | No invited bank has offered; offers expired |
| `OffersReceived` | Supplier to choose and consent | Offer expired before consent ("The offer expired before you consented…") |
| *(financing approved)* | Buyer's assignment acknowledgement, then disbursement | "The buyer has not yet acknowledged the assignment notice…" |
| `Funded` | Buyer payment on due date | — |
| `Disputed` | Platform dispute decision | Dispute queue |
| `Overdue` | Payment or default processing | Default timers |

4. If the business step happened but the status did not change → check the outbox ([R4](#r4-outbox-backlog-growing-background-work-stuck), [R5](#r5-parked-failed-outbox-events)) and escalate to L3.

Never change an invoice's status in the database.

---

## R15. Notifications or e-mails not received

1. The user's **bell** (in-app notifications) — present? Then generation worked.
2. **Integration inspector → adapter `notify`** — was a message sent for that topic and channel?
3. Outbox healthy? ([R4](#r4-outbox-backlog-growing-background-work-stuck)) Notifications are created by the worker from events.
4. In the MVP, e-mail, SMS and WhatsApp delivery is **simulated**: messages appear in the inspector but are not actually delivered. Once a real provider is connected, check the provider's delivery logs for the address.

---

## R16. Suspected cross-tenant data exposure

**Symptoms:** a user reports seeing another organisation's invoice, document, offer or name where they should not.

1. **P1 security incident.** Page L3 and the incident lead immediately.
2. Collect: the user, their organisation, the exact page/URL, what they saw (screenshot), the time.
3. Do **not** reproduce it by browsing other tenants' data yourself.
4. **L3:** find the requests by user and time; check the route's permission and RLS policy; confirm whether data actually crossed tenants or was legitimately shared (e.g. the buyer sees the supplier's invoice to it; a funding bank sees the invoice it funds; documents can be shared with parties).
5. Contain (disable the route or roll back), preserve evidence, and follow [technical manual § 8.6](../technical-manual/08-security-and-secrets.md#86-security-incidents). Compliance decides on notifications.

---

## R17. Failed deployment

**Symptoms:** after a release, the API does not become ready, errors spike, or a key journey breaks.

1. Check the API log for `migration <file> failed: <reason>` — that file was rolled back; nothing from it is committed.
2. **L3:** redeploy the previous version ([technical manual § 6.8](../technical-manual/06-deployment.md#68-rolling-back)). Backward-compatible migrations already applied are safe with the old code.
3. If data was damaged by the release, stop the API and plan a point-in-time restore with the incident lead.
4. Run the release smoke test after rolling back; record the incident.
