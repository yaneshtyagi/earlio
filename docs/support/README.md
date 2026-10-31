# Earlio production support guide

For the **L1 service desk**, **L2 application support** and **L3 engineering on-call** who keep Earlio running for suppliers, buyers, banks, insurers and platform staff.

| # | Document | Use it to… |
| --- | --- | --- |
| 1 | [Support model](01-support-model.md) | know who does what, how to classify severity, when and how to escalate, and what to collect from a user |
| 2 | [Monitoring and daily checks](02-monitoring-and-daily-checks.md) | run the start-of-day checklist and read the health signals and admin screens |
| 3 | [Incident runbooks](03-runbooks.md) | handle a specific incident step by step (API down, outbox stuck, failed webhooks, settlement exceptions, audit chain break, …) |
| 4 | [Service requests](04-service-requests.md) | handle routine requests: locked accounts, lost MFA, new users, bank API keys, tenant domains |
| 5 | [Error message catalogue](05-error-catalogue.md) | look up an error a user reports: what it means, whether it is expected, what to do |
| 6 | [Diagnostic queries](06-diagnostic-queries.md) | run safe, read-only SQL to answer "what happened to this invoice / event / webhook?" |

## What Earlio is, in one paragraph

Earlio is a receivables-financing platform. A **supplier** (exporter) raises an invoice to a **buyer** (importer); once the buyer accepts it, **banks** offer to fund it and a **trade-credit insurer** may cover the buyer's default. The supplier chooses an offer, the bank disburses, the buyer pays the bank on the due date, and **Earlio's platform team** runs KYC, sanctions, disputes and settlement oversight. Every step is recorded in a tamper-evident **audit log**. The [user manuals](../user-manual/README.md) explain every screen; read [Getting started](../user-manual/00-getting-started.md) and the [Platform manual](../user-manual/05-platform.md) before your first shift.

## Key facts for support

| Fact | Detail |
| --- | --- |
| URLs | Platform: `https://app.<domain>`. Bank portals: `https://<tenant>.<domain>` or the bank's custom domain. |
| Sign-in | E-mail + password, then a 6-digit authenticator code (MFA is mandatory). Sessions last 8 hours. |
| Lockout | 5 wrong passwords → locked for 15 minutes, then it unlocks by itself. |
| Background jobs | Run every 15 seconds inside the API: event processing, disbursements, statement matching, expiries, reminders, webhooks, dashboards. |
| Correlation id | Every API response carries `x-correlation-id`; it finds the request in the logs. Ask users for the time and the action; engineers can find it from there. |
| Error messages | Written for end users. Most are expected business rules, not faults — check the [catalogue](05-error-catalogue.md) first. |
| External systems | In the MVP, bank payments, FX, KYC, sanctions, insurer and e-mail/SMS are **simulated**. Their traffic is visible in the **Integration inspector**. |
| Technical detail | The [technical manual](../technical-manual/README.md) (architecture, configuration, deployment, observability). |

## Golden rules

1. **Never change production data by hand** to "fix" a business outcome. Use the application, or escalate to L3 for a reviewed, audited correction.
2. **Never read or share secrets**: password hashes, MFA secrets, recovery codes, API signing secrets. The diagnostic queries avoid those columns on purpose.
3. **Never ask a user for their password or MFA code.**
4. **Treat a broken audit chain, a cross-tenant data sighting or a suspected key leak as a security incident** — P1, escalate immediately.
5. **Write down what you did**, with times, in the ticket.
