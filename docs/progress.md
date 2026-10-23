# Progress log

## Environment note
The build runs in a Node-only cloud workspace (no .NET SDK, no Docker daemon). Backend stack changed from ASP.NET to Node/TypeScript — see ADR-000. Postgres is an npm-provided real PostgreSQL 18 binary started by the test global setup.

## M0 + M1 — done (23 Oct 2026)
- Monorepo (npm workspaces), Fastify API, SQL migrations with a non-owner app role, OpenAPI generated from Zod schemas, typed web client, React shell (login, MFA enrolment, role-aware navigation, org switcher, users, audit viewer).
- Identity: organisations, users, memberships, sessions (hashed tokens, CSRF), scrypt passwords, lockout after 5 failures, mandatory TOTP MFA with recovery codes, permission matrix (snapshot test), role-per-org-type rules.
- Tenancy: RLS on tenant tables, tested at raw-SQL level under the application role and through the API.
- Audit: append-only hash chain with verifier, tamper and deletion detection, concurrency test (40 parallel writers), anchor with simulated timestamp authority, audited cross-tenant reads.
- Tests: 26 API tests + 3 web unit tests green; typecheck green; web build green.
- Deviation: shadcn/ui and Tailwind not used in M0 (hand-written CSS) to keep the shell small; can be added without API impact. Postgres 18 instead of 16.

## M2 — Onboarding, KYC, sanctions, relationships, limits
- Migration 003: files, KYC cases/documents, screening results (platform-only), sanctions whitelist, relationships, preferred banks, bank limits.
- Adapters: object store + virus scan simulator, Jaro-Winkler sanctions provider (with deliberate false-positive demo), KYC simulator.
- API: self-registration, KYC document upload/submit, admin KYC queue and decisions, sanctions review (false positive / confirmed → org blocked), relationship propose + two-sided approval (maker-checker), counterparty directory, preferred banks, bank exposure limits with atomic reserve/consume/release.
- Web: register, KYC application, relationships + preferred banks, admin KYC queue, sanctions review, bank limits.
- Tests: 39 API tests green (incl. 12 parallel reservations → exactly 10 succeed, file RLS, whitelist behaviour).

## M3 — Invoicing and acceptance
- Migration 004: purchase orders, invoices (human id INV-xxxx + UUID, fingerprint duplicate guard), versioned/hashed documents, acceptances, disputes, status history. RLS: supplier sees own; buyer sees only submitted-onward invoices addressed to it (never drafts); bank access arrives with invitations in M6.
- Explicit state machine (`modules/invoicing/state.ts`): full table from the POC plan; a single `transition()` writes compare-and-set status, history, audit (both parties) and outbox. Test enumerates every from/to pair.
- Create, CSV import (row-by-row with savepoints, per-row errors), simulated ERP source and GST e-invoice (deterministic IRN), documents (commercial invoice + delivery proof required to submit), submit with sanctions screening and document sharing to the buyer.
- Buyer: accept / part-accept (remainder recorded as non-freezing dispute) / reject (reason required); undertaking text + timestamp + approver stored; assignment-notice acknowledgement; 24 h dispute window (platform minimum 24 h); disputes freeze the invoice. Reminders at 1 and 3 days; no deemed acceptance.
- Web: invoice list with chips and filters, create/import (CSV + ERP), invoice detail with timeline, documents, buyer review/decision, dispute.
- Tests: 28 new (67 total). Deviation: dispute resolution is left to M8 as planned.

## M4 — Terms engine and pricing
- Pure calculators (`modules/pricing`): early payment (fixed table and pro-rata annual rate modes, buyer return, bank commission, warnings), financing (discount-to-yield upfront, actual/365, per-line 2 dp rounding, platform fee payer bank/supplier, premium payer), FX (`mid × (1 − spread)`, INR amounts, USD equivalents via INR crosses), calendar hook (tenor, weekday calendar; real calendars in M7). `SimFxRateProvider` with quote validity window; daily movement is opt-in (off by default so demo numbers are stable).
- **All golden numbers are named, passing tests** (`test/pricing.test.ts`): 6.14%, 12.41%, 99,000 / 200 / 800, 865.48 / 100 / 27 / 180 / 1,172.48 / 88,827.52 / 8.03%, bank-pays-fee 1,145.48 / 88,854.52 / 7.84%, 88.1348, ₹87,25,345. Loss cases A/B/C land in M8.
- Rule engine (`terms/rules.ts`): pure condition tree (in/nin/eq/neq/lt/lte/gt/gte/exists, all/any/not) with plain-language reasons (e.g. "Tenor of 135 days is above this bank's maximum of 120 days."), the BR-8 JSON verbatim, and fast-check property tests for composition (AND/OR, De Morgan, double negation, ordering).
- Terms: JSON schemas (zod, `TERMS_SCHEMA_VERSION = 1`) for platform, bank (CT-1) and insurer (CT-2) terms; sets + versions (draft → pending → active → retired); DB trigger makes active versions immutable for every role; maker-checker enforced now (submit / approve by a different user; M9 adds the studio UI and review notes); future-dated effective versions; layer resolution in the exact BR-9 order with ties by effective date, priority, version, plus a per-parameter explanation; guardrails (min dispute window, assignment notice, sanctions block, FX spread cap, small-supplier cost cap) named in the error. Seeds: platform defaults, 3 bank and 2 insurer term sets exactly per BR-6/BR-7.
- Offer evaluation (`terms/evaluate.ts`, `POST /invoices/:id/eligibility`): gates 5–7, plain reasons, quote with net cash, all-in cost, INR amount at the bank's rate, terms version ids, saving vs. the supplier's borrowing rate. Small suppliers' advance is **capped at the insured cover** (BR-11.6) and the cap is reported (deviation from "block": clamping keeps the offer useful).
- Simulator: `POST /terms/simulate` runs a draft bank body against 20 deterministic sample invoices and diffs against the active terms.
- Tests: 65 new (132 total). Decision recorded: premium = rate × insured amount × number of started 90-day periods (matches the 180.00 golden for a 60-day tenor).
