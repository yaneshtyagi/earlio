# 5. Error message catalogue

Every error from the API has the shape `{ "code": "...", "message": "...", "details": ... }`, and the web app shows the `message` to the user. Most messages are **business rules working as designed** — explain the rule and the next step. The *Kind* column says whether it is **Rule** (expected), **User** (fix on the user's side), **Config** or **Fault** (escalate).

Search this page for the words the user quotes.

## Contents
- [5.1 Sign-in and session](#51-sign-in-and-session)
- [5.2 Permissions and access](#52-permissions-and-access)
- [5.3 Files and documents](#53-files-and-documents)
- [5.4 Onboarding, KYC and relationships](#54-onboarding-kyc-and-relationships)
- [5.5 Invoices, disputes and credit notes](#55-invoices-disputes-and-credit-notes)
- [5.6 Offers, funding and early payment](#56-offers-funding-and-early-payment)
- [5.7 Insurance](#57-insurance)
- [5.8 Settlement, recovery and recourse](#58-settlement-recovery-and-recourse)
- [5.9 Bank integration (machine API)](#59-bank-integration-machine-api)
- [5.10 Generic and system errors](#510-generic-and-system-errors)

## 5.1 Sign-in and session

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 401 | `invalid_credentials` | Email or password is incorrect. | User | Check the e-mail address; retry. After 5 failures the account locks for 15 min. [S2](04-service-requests.md#s2-password-reset) for a reset. |
| 423 | `locked` | This account is temporarily locked after repeated failed attempts. Try again later. | Rule | Wait 15 minutes. [S1](04-service-requests.md#s1-unlock-an-account). |
| 401 | `invalid_code` | That code is not valid. | User | Phone time must be automatic; use the newest code or a recovery code. [S3](04-service-requests.md#s3-lost-mfa-device). |
| 401 | `mfa_required` | Multi-factor verification is required. | Rule | Complete the code step. |
| 409 | `mfa_already_enrolled` | MFA is already enrolled for this user. | Rule | Sign in with the existing authenticator. |
| 401 | `unauthenticated` | Please sign in. | Rule | Session expired (8 h) — sign in again. |
| 403 | `csrf` | Your session security token is missing or out of date. Reload the page and try again. | User | Reload the page. If it affects everyone after a release → [R12](03-runbooks.md#r12-users-cannot-sign-in). |
| 403 | `no_org` | No active organisation for this session. | User/Config | Pick an organisation in the user menu; if none, the user has no membership ([S4](04-service-requests.md#s4-add-a-user-or-change-a-role)). |
| 429 | `rate_limited` | Too many requests. Please wait and try again. | Rule | Wait a minute. Many users behind one office address may share the limit — L3 if persistent. |

## 5.2 Permissions and access

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 403 | `forbidden` | Your role (`<role>`) cannot do this (`<permission>`). | Rule | The user needs a different role; their org Admin changes it ([permissions matrix](../permissions-matrix.md)). |
| 403 | `forbidden` | This action is for `<type>` organisations. | Rule | Wrong portal/organisation for the action. |
| 403 | `forbidden` | Only platform staff can access cross-tenant data. | Rule | Expected for non-platform users. |
| 404 | `not_found` | `<Thing>` was not found. | Rule/User | Wrong link, or it belongs to another organisation (Earlio answers *not found* rather than revealing it exists). |

## 5.3 Files and documents

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 413 | `file_too_large` | Files can be at most 10 MB. | Rule | Compress or split. |
| 400 | `empty_file` | The file is empty. | User | Re-export. |
| 422 | `infected_file` | This file was rejected by the virus scan. | Rule | Obtain a clean file; never bypass. |
| 415 | `not_previewable` | This file type cannot be previewed. Download it to open it on your device. | Rule | Use Download. |
| 415 | `bad_upload` | Send the file as application/octet-stream. | Fault (client) | API clients only; L3 if seen in the web app. |
| 403 | `no_org` | An active organisation is required to upload files. | User | Select an organisation. |
| 409 | `case_locked` | Documents can only be added while the application is in draft. | Rule | KYC already submitted; platform reviewer can refer it back. |

## 5.4 Onboarding, KYC and relationships

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 409 | `not_draft` | There is no draft application to submit. | Rule | Already submitted. |
| 409 | `not_reviewable` | This application is not awaiting a decision. / Only open hits can be reviewed. | Rule | Someone already decided; refresh. |
| 409 | `relationship_exists` | A relationship between these organisations already exists. | Rule | Use the existing one. |
| 400 | `bad_pair` | A relationship links one supplier with one buyer. | User | Choose a supplier and a buyer. |
| 409 | `already_approved` | Your side has already approved. | Rule | Waiting for the other side. |
| 409 | `suspended` | This relationship is suspended. | Rule | Platform suspended it ([S11](04-service-requests.md#s11-suspend-a-supplierbuyer-relationship)); refer to compliance. |
| 422 | `no_relationship` | You need an active relationship with this buyer before you can invoice them. / The relationship with this buyer is no longer active. | Rule | Create/approve the relationship (both sides). |
| 409 | `already_member` | This user already belongs to the organisation. | Rule | — |

## 5.5 Invoices, disputes and credit notes

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 409 | `not_accepted` | The invoice has not been accepted. | Rule | Buyer must accept first. |
| 409 | `window_closed` | The dispute window for this invoice has closed. | Rule | Explain; disputes on funded/overdue invoices follow a different path. |
| 409 | `closed` | This dispute is resolved; the thread is read-only. | Rule | — |
| 409 | `already_acknowledged` | The assignment notice was already acknowledged. | Rule | — |
| 409 | `early_payment` | This invoice was paid early; there is nothing to credit against. | Rule | — |
| 400 | `invalid` / `validation` | Some details are missing or not valid: `<fields>`. | User | Correct the named fields. |
| 409 | `illegal_transition` | Invoice `<INV-…>` cannot move from `<A>` to `<B>`. | Rule | The invoice is not in a state that allows the action; check its timeline ([R14](03-runbooks.md#r14-an-invoice-is-stuck)). |
| 409 | `stale_state` | Invoice `<INV-…>` changed while you were working. Reload and try again. | Rule | Someone else acted on it; reload. |

## 5.6 Offers, funding and early payment

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 409 | `not_open` | The invoice is no longer open for offers. | Rule | Funding route already chosen or invoice changed state. |
| 409 | `not_invited` | You have no open invitation for this invoice. | Rule | Bank not invited / invitation closed. |
| 409 | `declined` | You declined this invitation. | Rule | — |
| 409 | `offer_expired` | This offer has expired. Ask the bank for a new one. / The offer expired before you consented. Cancel and choose again. | Rule | Supplier asks the bank for a new offer. |
| 422 | `outside_terms` | The rate must be between 0% and 60% a year. / Offers can be valid for 1 to 168 hours. / The FX spread cannot be negative. | Rule | Bank corrects the offer. |
| 409 | `assignment_unacknowledged` | The buyer has not yet acknowledged the assignment notice, so funding cannot start. | Rule | Buyer acknowledges the notice. |
| 409 | `route_locked` | A funding route has already been chosen for this invoice. / … already paid early. / A bank financing is in progress … | Rule | Only one route (bank financing *or* early payment) per invoice. |
| 409 | `no_schedule` | The supplier has not published a discount schedule for this invoice. | Rule | Supplier publishes a schedule. |
| 409 | `already_paid` | This invoice was already paid early. | Rule | — |
| 409 | `not_ready` | The payment instructions for this invoice are not ready yet; try again shortly. | Rule | Retry in a minute; if it persists > 15 min, check the outbox ([R4](03-runbooks.md#r4-outbox-backlog-growing-background-work-stuck)). |

## 5.7 Insurance

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 422 | `no_limit` | You have not set a limit for this buyer. Set one before approving cover, or decline. | Rule | Insurer sets a buyer limit. |
| 422 | `no_headroom` | The buyer limit is fully used. Decline this request or raise the limit. | Rule | Insurer decision. |
| 422 | `limit_expired` | The buyer limit has expired. Renew it before approving cover, or decline. | Rule | Insurer renews. |
| 409 | `limit_busy` | The buyer limit changed while you were deciding. Try again. | Rule | Retry (concurrency protection). |
| 409 | `uninsured` | This invoice has no insurance cover, so there is nothing to claim. | Rule | — |
| 500 | `limit_state` | Insurer limit bookkeeping error. | **Fault** | Escalate to L3 with the invoice and insurer. |

## 5.8 Settlement, recovery and recourse

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 409 | `already_resolved` | This exception is already resolved. | Rule | Someone else resolved it; refresh. |
| 400 | `invalid` | A `<Type>` exception can be resolved with: `<actions>`. | User | Use an allowed action ([R8](03-runbooks.md#r8-settlement-exceptions)). |
| 409 | `settled` | This invoice has already been paid. / This recourse is already settled. | Rule | — |
| 409 | `not_small` | The repayment options are for small suppliers; your bank's terms apply to this recourse. | Rule | Explain; bank's terms apply. |
| 409 | `wrong_state` | Recoveries are recorded after a claim is paid or rejected. | Rule | Wait for the claim decision. |

## 5.9 Bank integration (machine API)

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 401 | `bad_api_key` | The API key is missing, wrong, expired or revoked. | User/Config | [R9](03-runbooks.md#r9-bank-machine-api-calls-rejected), [S6](04-service-requests.md#s6-bank-api-key-create-rotate-revoke). |
| 401 | `bad_signature` | Missing signature headers. / The timestamp is outside the allowed window. / The signature does not match. | User | Bank checks signing and clock ([integration guide](../integration-guide.md)). |
| 409 | `replay` | This request was already received (replay rejected). / This callback was already received (replay rejected). | Rule | New nonce per request. |
| 409 | `hostname_taken` | That hostname already belongs to another organisation. | Rule | Choose another / investigate ownership. |

## 5.10 Generic and system errors

| HTTP | Code | Message | Kind | What to do |
| --- | --- | --- | --- | --- |
| 500 | `internal` | Internal error. | **Fault** | Collect time, user, action → L2 finds the log entry (`unhandled error`) → L3. |
| 4xx | `bad_request` | (framework message) | Fault (client) | Usually a malformed API call; L2. |
| 409 | `clock_fixed` | This environment runs on real time. | Config | Only in demo tooling; should never appear in production. |
| 409 | `no_change` | That is already the current value. | Rule | — |
| — | — | Could not reach the server… (web app) | Fault/Network | User's network, or the API is down ([R1](03-runbooks.md#r1-api-unavailable-or-not-ready)). |
