# Earlio MVP: Implementation Plan and Coding-Agent Prompts

**Stack:** ASP.NET Core (.NET 10, C#) backend, TypeScript + React frontend, PostgreSQL
**Date:** 23 Oct 2026
**Inputs:** PRD (22 Oct 2026, decisions of 23 Oct), `earlio-poc-plan.md`, the HTML/JS concept POC and demo video
**Scope:** PRD roadmap Phase 1 (MVP): all P0 requirements, white-label for one partner bank, USD/SGD to INR, both routes (early payment and invoice financing).

---

## 0. How to use this document

1. Put this file, the PRD and `earlio-poc-plan.md` in `bv-pay/docs/`. The agent must read them.
2. Run **Prompt 0** once. It creates the repo, `AGENTS.md` (or `CLAUDE.md`) and CI.
3. Run milestone prompts **in order**, one per agent session. Each prompt is self-contained and ends with acceptance criteria. Do not start the next milestone until the previous one is green.
4. After each milestone: review the diff, run the demo script for that milestone, tag the repo (`m1`, `m2`, ...).
5. Reuse the POC as the behavioural spec. The HTML/JS mockup shows the screens and the numbers; the backend must reproduce its seeded numbers exactly (golden tests).

### Decisions I have assumed (override before Prompt 0 if you disagree)

| # | Decision | Assumed |
|---|---|---|
| D1 | Architecture | Modular monolith (one deployable, strict module boundaries). Not microservices. |
| D2 | Tenancy | Shared database, `org_id` on every tenant row, enforced by Postgres Row-Level Security plus an EF Core query filter. |
| D3 | Auth | ASP.NET Core Identity, cookie-based session for the SPA (BFF style, same site), TOTP MFA mandatory. Option: swap for Keycloak or Entra later via the same interface. |
| D4 | Async work | Transactional outbox in Postgres plus a hosted background worker. No broker in MVP. |
| D5 | Integrations | Every external system is behind an adapter interface. MVP ships **sandbox/simulated adapters** (carried over from the POC Sim Hub) and the contract for real ones. Real bank/insurer/KYC connections are per-partner work after the partner is chosen. |
| D6 | Files | S3-compatible object storage (MinIO locally), hash stored in DB. |
| D7 | Money | `decimal` only, a `Money(amount, currency)` value type, explicit rounding (banker's rounding off; use away-from-zero at 2 dp, applied at defined points only). Day count actual/365. |
| D8 | Frontend | Vite + React + TypeScript, TanStack Query, React Router, Tailwind + shadcn/ui, react-hook-form + zod, i18next (English, Hindi), API client generated from OpenAPI. |
| D9 | Modes | Network mode (3 banks) and white-label mode (1 partner bank) via configuration, as in POC assumption A-3. |
| D10 | Open decisions carried from POC plan | A-1, A-2, A-8, A-9, A-10 adopted as written in the POC plan. Confirm with the partner bank/insurer later; they are configuration, not code. |

Anything in the PRD §5 non-functional table that needs infrastructure (99.9% uptime, RPO/RTO, pen test) is addressed in M10 as deployment and hardening work, not application logic.

---

## 1. Target architecture

### 1.1 Repo layout (monorepo)

```
bv-pay/
  docs/                      PRD, POC plan, this plan, ADRs, openapi snapshots
  poc/                       existing HTML/JS concept (untouched, reference only)
  src/
    backend/
      Earlio.sln
      src/
        Earlio.Api/                  ASP.NET Core host, endpoints, auth, OpenAPI
        Earlio.Worker/               hosted services: outbox, schedulers, simulators
        Earlio.SharedKernel/         Money, Result, clock, ids, domain events, audit contract
        Earlio.Modules.Identity/     orgs, users, roles, MFA, relationships
        Earlio.Modules.Compliance/   KYC, sanctions screening, onboarding
        Earlio.Modules.Invoicing/    POs, invoices, documents, acceptance, disputes, credit notes
        Earlio.Modules.Terms/        TermsSet, layers, versions, rule engine, guardrails, simulator
        Earlio.Modules.Pricing/      early-payment and financing calculators, FX
        Earlio.Modules.Insurance/    cover records, limits, claims, recoveries
        Earlio.Modules.Marketplace/  offers, financing request, early-payment route, lien registry
        Earlio.Modules.Settlement/   disbursement, collection ledger, reconciliation, calendars
        Earlio.Modules.Notifications/ templates, channels, delivery state
        Earlio.Modules.Audit/        hash-chained audit log, anchoring
        Earlio.Modules.Reporting/    dashboards, scorecard queries
        Earlio.Integrations.*/       adapters (Sim* implementations + contracts)
      tests/
        Earlio.UnitTests/ Earlio.ModuleTests/ Earlio.IntegrationTests/ (Testcontainers) Earlio.ArchTests/
    web/
      package.json  vite.config.ts
      src/ app/ features/ (one folder per persona) shared/ api/ i18n/
  deploy/ docker-compose.yml, Dockerfiles, helm or bicep placeholders
  AGENTS.md
```

Each module owns its schema (`identity`, `invoicing`, ...) in the same Postgres database. Modules talk through public interfaces and domain events only. Architecture tests (NetArchTest) fail the build on cross-module references to internals.

### 1.2 Cross-cutting rules (go into AGENTS.md)

- **Rules are data.** No bank- or insurer-specific `if`. Terms are JSON validated by schema and interpreted by the engine.
- **State machines are explicit.** Each aggregate has a transition table (the POC plan section 3.2); illegal transitions throw; every transition emits an event, an audit row and notifications.
- **Time comes from `IClock`.** Never `DateTime.UtcNow`. A virtual clock is allowed only in Development/Demo environments.
- **Every command is idempotent** where it moves money or changes state externally (idempotency key header, stored result).
- **Every response that shows an offer includes** annualised cost, net cash, FX rate (PRD §1, FM-3, XB-1, CT-8).
- **Tenant safety:** a test must prove that a supplier cannot read another supplier's invoice and a bank cannot read an invoice it was not invited to (API and DB level).
- **No secrets in code.** User-secrets locally, vault in deployment.
- **Plain-language reasons** for every rejection (eligibility, guardrails).
- **Golden numbers** (must pass exactly, see section 2).

### 1.3 Main data model (summary)

Same entities as POC plan section 3.1. Persisted tables, by module:

- identity: `organisations`, `users`, `memberships(role)`, `relationships`, `org_preferred_banks`
- compliance: `kyc_cases`, `kyc_documents`, `screening_results`
- invoicing: `purchase_orders`, `invoices`, `invoice_documents`, `acceptances`, `disputes`, `credit_notes`
- terms: `terms_sets`, `terms_versions`, `terms_approvals`
- insurance: `cover_records`, `buyer_limits`, `claims`, `recoveries`
- marketplace: `discount_schedules`, `early_payments`, `financing_offers`, `financing_requests`, `financings`, `liens`, `lien_history`, `assignment_notices`
- settlement: `collection_accounts`, `ledger_entries`, `disbursements`, `settlement_instructions`, `settlements`, `reconciliation_items`, `calendars`, `fx_quotes`
- cross-cutting: `outbox_messages`, `idempotency_keys`, `notifications`, `audit_events`, `export_proceeds`

---

## 2. Golden test numbers (copy into the pricing tests)

All from POC plan BR-2, BR-3, BR-5, BR-10.

| Case | Input | Expected |
|---|---|---|
| Annualised cost of discount | 1%, 60 days early | 6.14% |
| Annualised cost of discount | 2%, 60 days early | 12.41% |
| Early payment example | USD 100,000, due +75 days, pay day 15 (60 days early), 1.00% | Buyer pays 99,000; annualised 6.14%; commission 200 (20%); buyer net saving 800 |
| Financing example | USD 100,000, t = 60, advance 90%, rate 5.85% (4.10% + 1.75%) | Discount 865.48; processing 100.00; platform fee 27.00 (pass-through case); premium 180.00; total charges 1,172.48; net cash 88,827.52; all-in 8.03% |
| Same, platform fee paid by bank (default) | as above | Charges 1,145.48; net cash 88,854.52; all-in 7.84% |
| FX | USD/INR mid 88.40, spread 0.30% | Rate 88.1348 |
| Loss sharing case A | F 100,000; A 90%; cover 90% | Payout 90,000; bank whole; supplier keeps advance, loses 10,000 retention |
| Loss sharing case B | cover 70% | Payout 70,000; bank shortfall 20,000 |
| Loss sharing case C | claim rejected, supplier-caused dispute | Payout 0; recourse triggered, capped at 20% of future payouts or 90-day plan |
| Indian grouping | 8725345 INR | ₹87,25,345 |

Note: the POC plan arithmetic rounds each charge to 2 dp and sums the rounded values. Do the same (round each line, then sum).

---

## 3. Milestones at a glance

| # | Milestone | Delivers | PRD IDs | Demo exit |
|---|---|---|---|---|
| M0 | Foundations | Repo, CI, Docker, skeleton API + SPA, SharedKernel, AGENTS.md | n/a | `docker compose up` shows login page and health check |
| M1 | Identity, tenancy, audit | Orgs, users, roles, TOTP MFA, RLS, audit hash chain | ON-2, CR-5, §5 isolation/security | Isolation tests green; tamper test detected |
| M2 | Onboarding and compliance | KYC adapter, sanctions screening, relationships, bank limits, admin queue | ON-1, ON-3, ON-4, XB-2 | A new supplier onboarded; sanctions hit blocks |
| M3 | Invoicing | PO, invoice, documents, acceptance (full/part/reject), dispute window, unique ID, IRN stub | IN-1 to IN-4, XB-6 (docs) | Supplier submits, buyer accepts |
| M4 | Terms engine and pricing | TermsSet, layering, versions, rule engine, guardrails, calculators, FX | CT-1, CT-3 to CT-5, CT-7, XB-1 | Golden numbers pass |
| M5 | Insurance | Insurer workspace, buyer limits, cover requests, cover per invoice, non-recourse flag | XB-3, XB-4, CT-2, XB-7 (flag) | Partial cover approved, advance capped |
| M6 | Marketplace | Invitations, offers, comparison, financing request, lien registry, early-payment route | FM-1 to FM-4, ST-1, XB-8 | J-S1 and J-S2 end to end to Funded |
| M7 | Settlement | Disbursement, collection ledger, reconciliation, calendars, notifications | ST-2 to ST-4, XB-9, CR-1 | Funded to Settled with zero manual breaks |
| M8 | Exceptions | Disputes, credit notes, overdue, default, claims, recoveries, recourse, export proceeds | ST-5, XB-6, XB-7, CR-4 (dispute queue) | Default to claim to recovery matches loss cases |
| M9 | Terms studio, white-label, admin | Terms studio UI, maker-checker, simulator, branding, fees and guardrails console | CT-6, CT-8 to CT-11, WL-1, CR-4 | Change a term; new invoices use it; old ones keep version |
| M10 | Dashboards, Hindi, hardening | Dashboards, scorecard, i18n, accessibility, security, perf, observability, pilot runbook | CR-3, §5, §6 metrics | Pilot-ready checklist |

Do M0 to M8 as the critical path. M9 and M10 can overlap with partner discussions.

---

## 4. Prompts

Conventions for every prompt: the agent should (a) read `AGENTS.md`, the PRD and the POC plan first, (b) plan before coding, (c) write tests with the code, (d) run all tests before finishing, (e) update `docs/progress.md` with what was done and any deviation, (f) not touch modules outside the milestone unless needed, and say so if it does.

---

### Prompt 0: Foundations (M0)

```
You are building Earlio, a tri-party receivables financing platform (supplier, buyer,
bank, insurer, platform admin). Read docs/PRD.pdf and docs/earlio-poc-plan.md fully
before doing anything. The folder poc/ contains a working HTML/JS concept; treat it as
a behavioural reference only, do not modify it.

GOAL OF THIS TASK: create the repository skeleton so later milestones can be added
quickly and safely. No business features yet.

Tech: .NET 10 / ASP.NET Core, C#, EF Core + Npgsql, PostgreSQL 16, React + Vite +
TypeScript, Tailwind + shadcn/ui, TanStack Query, React Router, react-hook-form + zod.

Do the following:
1. Create the monorepo layout from docs/earlio-mvp-implementation-plan.md section 1.1
   (modules may be empty projects with a README). Use Directory.Build.props for shared
   settings (nullable enabled, warnings as errors, analyzers, central package
   management).
2. Earlio.SharedKernel: Money value type (decimal + ISO currency, no arithmetic across
   currencies, explicit rounding helper), Result<T>/Error types, IClock (+ SystemClock
   and a VirtualClock usable only when Environment is Development or Demo), strongly
   typed ids, IDomainEvent, Entity/AggregateRoot base with domain events.
3. Earlio.Api: minimal host with health endpoints, ProblemDetails error handling,
   OpenAPI generation (Swashbuckle or built-in), Serilog structured logging with
   correlation id, API versioning prefix /api/v1, CORS for the SPA dev server.
4. Earlio.Worker: host project with a placeholder hosted service.
5. Postgres: docker-compose.yml with postgres, MinIO, Mailpit (for email), and the api,
   worker, web services. EF Core migrations setup per module schema (one DbContext per
   module is fine; document the choice in an ADR).
6. Web: Vite React TS app with routing shell, layout, a "Simulated environment" ribbon
   driven by config, login placeholder, OpenAPI client generation script (orval or
   openapi-typescript) wired to the API.
7. Tests: xUnit projects; a Testcontainers-based integration test base class starting
   Postgres; NetArchTest tests that forbid a module referencing another module's
   internals (only its .Contracts namespace/project).
8. CI (GitHub Actions or the repo's CI): build, test, lint (dotnet format, eslint),
   OpenAPI snapshot check, web build.
9. Write AGENTS.md containing: architecture summary, the cross-cutting rules (rules are
   data; explicit state machines; IClock only; idempotent money commands; tenant safety;
   plain-language reasons; golden numbers; money is decimal with defined rounding), how
   to run everything, the testing strategy, and the rule "every milestone ends with
   tests green and docs/progress.md updated".
10. Add docs/adr/ with ADR-001 (modular monolith), ADR-002 (RLS tenancy), ADR-003
    (outbox), ADR-004 (adapters and simulators).

ACCEPTANCE: `docker compose up` starts everything; GET /health returns 200; the SPA
loads and shows the ribbon; `dotnet test` and `npm test` pass; the architecture test
fails if I deliberately add an illegal cross-module reference.
Ask me nothing; make reasonable choices and record them in the ADRs.
```

---

### Prompt 1: Identity, tenancy, RBAC, MFA, audit chain (M1)

```
Context: read AGENTS.md, docs/PRD.pdf sections 4.1, 4.5, 5, 7 and
docs/earlio-poc-plan.md sections 1.1, 3.1 (Organisation, User, AuditEvent), A-22.

Implement modules Identity and Audit.

IDENTITY
- Organisation: id, type (Supplier, Buyer, Bank, Insurer, Platform), legal name,
  country, size class (small flag), buyer rating tier (A, AA, BBB), data region,
  branding fields (logo, colours, display name), KYC and sanctions status fields
  (populated later), supplier "current borrowing rate" (optional, for the savings metric).
- User + Membership: a user belongs to one or more organisations with one role per
  membership: Admin, FinanceUser, Approver, Viewer. Persona sub-roles for Bank
  (CreditOfficer, Operations, RelationshipManager), Insurer (Underwriter, ClaimsHandler),
  Platform (PlatformAdmin, Auditor). Permissions are policy-based (ASP.NET Core
  authorization policies from a permission matrix stored as code constants and covered
  by a test). Per A-22: Admin manages users and settings; FinanceUser creates/views;
  Approver accepts, consents, publishes; Viewer reads only.
- Authentication: ASP.NET Core Identity with cookie auth (HttpOnly, SameSite=Lax,
  Secure), password policy, lockout, TOTP MFA mandatory for every user (enrolment flow
  with QR, recovery codes). Endpoint /api/v1/auth/* (login, mfa, logout, me, switch
  organisation). CSRF protection for the SPA.
- Tenancy: every tenant table has org_id. Implement Postgres Row-Level Security using
  a per-request session variable (SET LOCAL app.current_org / app.current_role set in a
  DbConnection interceptor) PLUS an EF Core global query filter. Provide a clear,
  tested way for the platform admin to read across tenants (explicit, audited).
  Bank visibility rules (only invoices invited to or bid on) will be added in M6, but
  design the policy hook now.
- Seed script for Development: the fictional cast from the POC plan section 1.1 and
  Appendix A (organisations and users only; invoices later), with a fixed demo password
  and TOTP secret known in dev.

AUDIT
- Append-only audit_events table: actor, org, action, entity type/id, before/after JSON,
  correlation id, occurred_at (from IClock), prev_hash, hash = SHA-256(prev_hash +
  canonical JSON of the row). Revoke UPDATE/DELETE on the table for the app role
  (migration + test). Serialise appends safely under concurrency (advisory lock or a
  single-writer sequence) and prove it with a concurrency test.
- IAuditWriter contract in SharedKernel used by all modules; an MediatR/pipeline-style
  behaviour (or equivalent) that audits every command automatically.
- Verification endpoint and worker job: recompute the chain, report the first broken
  link. A daily job writes an "anchor" record (hash + timestamp token from an
  ITimestampAuthority adapter; ship SimTimestampAuthority).
- A test that mutates one row via raw SQL as a superuser and asserts the verifier
  detects it.

WEB
- Login, MFA enrolment and verification screens, organisation switcher, role-aware
  navigation shell for the five personas, "me" context, and a minimal Audit log viewer
  for the platform admin with a "Verify chain" button.

ACCEPTANCE
- Integration tests: a supplier user cannot read another supplier org's rows through
  the API or through direct SQL under the app role (RLS); self-approval is blocked
  (placeholder rule to be used in M9); MFA cannot be skipped.
- Tamper test passes. All tests green. OpenAPI snapshot updated. docs/progress.md updated.
```

---

### Prompt 2: Onboarding, KYC, sanctions, relationships, limits (M2)

```
Context: read AGENTS.md, PRD sections 4.1, 4.6 (XB-2), 5 and POC plan sections 3.1,
4 (BR-12), 5.2 (KYC, Sanctions), screens SH-08, SH-09, ADM-02, ADM-03, BNK-06.

Implement module Compliance and the relationship/limits parts of Identity.

1. Onboarding (ON-1): self-service wizard backend for Supplier, Buyer, Bank, Insurer.
   KycCase with required documents per org type (config-driven list), document upload
   to S3/MinIO via pre-signed URLs, file hash stored, virus-scan adapter stub
   (IFileScanner, SimFileScanner). States: Draft, Submitted, InReview, Referred,
   Approved, Rejected. Platform admin queue to approve or reject with reasons.
2. KYC adapter: IKycProvider { Submit(case) -> result(pass | refer | fail, reasons) }
   with SimKycProvider driven by a seeded rule table and a configurable delay.
   Results are stored as raw payloads (for the integration inspector later).
3. Sanctions (XB-2): ISanctionsScreeningProvider { Screen(subject) -> matches[score] }.
   SimSanctionsProvider uses a seeded fictional watch list (include "Zarnitsa Trading
   Ltd") with fuzzy matching (normalised Jaro-Winkler or trigram, threshold
   configurable). Outcomes: Clear, Hit (needs review), Falsepositive, Confirmed.
   Screening runs at onboarding (all org types) and is callable per invoice (used in M3
   and M6). A confirmed hit sets organisation status Blocked, which blocks funding.
   Admin review screen with decision, reason, audit.
4. Relationship linking (ON-3): supplier proposes a link to a buyer (or vice versa);
   both sides' Approver role must approve; status Pending, Active, Suspended. Each org
   keeps a preferred-bank list; the partner bank is always invited (A-13).
5. Bank limits (ON-4): per-buyer and per-supplier exposure limits for each bank with
   used, reserved and available amounts (A-26: reserved on offer selection, consumed on
   funding, released on settlement; implement the ledger and operations now, usage
   wired in M6/M7). Concurrency-safe reserve/release with tests.
6. Supplier onboarding captures optional "current borrowing rate" (A-21) and the small
   supplier flag rules: turnover below a configurable threshold OR MSME registration
   (seed threshold INR 25 crore, make it config and mark it "verify with counsel").
7. Web: onboarding wizard (SH-08), relationship linking (SH-09), admin KYC queue
   (ADM-02), sanctions review (ADM-03), bank limits manager (BNK-06 basic).
8. Dev seed: onboarded cast with active relationships; Zarnitsa appears as a buyer
   that screens as a hit.

ACCEPTANCE: new supplier completes onboarding and is approved by admin; a name close
to a watch-list entry produces a Hit and blocks until reviewed; a confirmed hit blocks
further steps (assert a "FundingBlocked" query used later); relationship needs both
approvals; reserve/release of limits is race-safe (parallel test). Tests green,
progress.md updated.
```

---

### Prompt 3: Invoicing and acceptance (M3)

```
Context: read AGENTS.md, PRD sections 3 (lifecycle), 4.2, XB-6, and POC plan sections
3.1 (Invoice, Document, Acceptance, PurchaseOrder), 3.2 (Invoice lifecycle table),
BR-1, BR-12, BR-13, A-2, A-15, A-16, A-17, screens SUP-02..04, BUY-02..04.

Implement module Invoicing.

1. PurchaseOrder: seeded, minimal create/list. Invoice may be created without a PO
   with a flagged warning (A-15).
2. Invoice aggregate with the full state machine from the POC plan (Draft, Submitted,
   Rejected, Accepted, NotEligible, OpenForFunding, OffersReceived, Funded, Settled,
   Disputed, Overdue, Defaulted, Closed, Cancelled). Implement transitions up to
   Accepted/Rejected/Disputed now with the guard + side-effect table; later milestones
   add the rest through the same aggregate. Illegal transition = domain error.
3. Create/import (IN-1, IN-2): form API, CSV import (validate row-by-row, report
   errors), and an IErpInvoiceSource adapter with SimErpInvoiceSource loading a seeded
   JSON batch. Validation: mandatory fields, currency in {USD, SGD}, due date after
   issue date, duplicate detection (supplier + number + amount + date), unique
   invoice id (human readable INV-xxxx plus UUID). Simulated GST e-invoice IRN via
   IEInvoiceService/SimEInvoiceService (plausible format, deterministic).
4. Documents (IN-3, XB-6): commercial invoice, packing list, shipping bill, transport
   document, delivery proof; versioned, hashed, stored in S3. Submitted requires
   delivery proof + commercial invoice. Document version history.
5. Submission: screens parties via the Compliance module; notify buyer; record
   evidence; starts acceptance SLA timers (reminders at 1 and 3 days, no deemed
   acceptance, A-16).
6. Acceptance (IN-4): accept, reject (reason required), partial accept (accepted
   amount becomes the invoice amount; remainder becomes a dispute or credit note,
   A-17). Records the irrevocable payment undertaking text + timestamp + approver,
   and the assignment notice acknowledgement placeholder. On accept: locks amount,
   starts a dispute window (default 24h, platform-guardrail minimum 24h), emits
   InvoiceAccepted. Only Approver role can accept.
7. Disputes (basic): any party can raise a dispute during the window; this
   freezes progression. Resolution comes in M8 but the aggregate and the freeze
   must exist now.
8. Outbox events for all transitions. Notification triggers will be consumed in M7.
9. Visibility: supplier sees own invoices; buyer sees invoices addressed to it
   (RLS + policies), proven by tests.
10. Web: supplier invoice list with status chips and filters, create/import screens,
    document upload, buyer acceptance inbox and review screen with delivery proof
    viewer, accept/reject/part-accept, payment undertaking signing.

ACCEPTANCE: J-S1 steps 1 to 3 and J-B1 work in the UI; state machine tests cover every
row of the transition table including illegal ones; duplicate invoice rejected;
partial accept recalculates the amount; no deemed acceptance on silence. Tests green,
progress.md updated.
```

---

### Prompt 4: Terms engine and pricing (M4)

```
Context: read AGENTS.md, PRD 4.7 (CT-1, CT-3, CT-4, CT-5, CT-7), XB-1, and POC plan
BR-1 to BR-5, BR-6 to BR-9, BR-11 and sections 2 (golden numbers) of
docs/earlio-mvp-implementation-plan.md. This milestone is pure domain logic plus a
thin API; build it test-first.

Implement modules Terms and Pricing.

TERMS
1. TermsSet aggregate: owner (platform, bank, insurer), version, effective_from/to,
   layer (PlatformDefault, OwnerDefault, Corridor, Supplier, Buyer, and the combined
   specificity levels in BR-9), status (Draft, Pending, Active, Retired), JSON body.
   Version rows are immutable once Active. Evaluating terms for an invoice picks the
   version effective at the (virtual) clock time and records the exact version ids on
   the invoice/financing (CT-5).
2. JSON schema for bank terms (every CT-1 parameter: advance %, pricing = fixed or
   benchmark + spread by buyer tier, fees with minimums, size limits, max tenor,
   currencies, buyer countries, goods, offer validity, cut-off with timezone,
   settlement days, FX spread) and insurer terms (CT-2: cover %, insured events,
   waiting period, exclusions, claim documents and deadline, premium basis and payer,
   per-buyer and portfolio limits). Validate with a JSON Schema library; version the
   schema.
3. Rule engine: a pure, deterministic library (no DB, no clock) that evaluates the
   eligibility condition tree (fields, in, eq, lte, gte, all, any) from BR-8 against a
   context (buyer, supplier, corridor, invoice). It returns pass/fail AND a
   plain-language reason (reasonIfFalse, plus the failed leaf rendered like "Tenor of
   135 days is above this bank's maximum of 120 days"). Include a property-based test
   suite (FsCheck) for and/or composition.
4. Layer resolution (CT-4): most specific wins in the exact order in BR-9; ties by
   later effective date then explicit priority; return an "explanation" showing which
   layer supplied each parameter (used by the plain-language UI).
5. Guardrails (CT-7), non-overridable: sanctions hit blocks funding; assignment notice
   mandatory; dispute window >= 24h; max all-in annualised cost for small suppliers
   (default 18%); max FX spread (1.00%); advance % cannot exceed cover % for small
   suppliers. A save of a TermsSet that breaks a guardrail fails with the guardrail named.
6. Seed the three bank term sets and two insurer term sets exactly as in BR-6 and BR-7.
   (Maker-checker, studio UI and simulator UI come in M9, but expose a domain
   service Simulate(draftTerms, sampleInvoices) now, since the engine owns it.)

PRICING
7. Pure calculators with decimal math and defined rounding:
   - Early payment (BR-2): annualised cost d/(1-d)*365/n, fixed-percentage schedule
     mode and annual-rate pro-rata mode, buyer return, bank commission share, warnings
     when annualised cost exceeds the supplier's borrowing rate or the guardrail.
   - Financing (BR-3): advance, retention, discount-to-yield upfront with actual/365,
     rate fixed or benchmark + spread by tier, processing fee with minimum, platform
     fee (bps), insurance premium and payer, net cash, total charges, all-in annualised
     cost on net cash. Support the "platform fee paid by bank" default and the
     "passed through to supplier" case.
   - FX (BR-5): IFxRateProvider (SimFxRateProvider: seeded daily table with small
     deterministic movement, quote validity window), bank rate = mid x (1 - spread),
     INR amounts, Indian digit grouping formatter (shared with the web as a tested
     helper too).
   - Calendars hook: tenor days computed with a calendar interface (real calendars in M7).
8. Offer evaluation service: given invoice + bank + buyer + supplier + terms +
   cover, return Eligible/NotEligible with reasons (BR-1 gates 5 to 7 only; the rest
   run at funding time) and, if eligible, an OfferQuote (all numbers + the terms
   version ids). The same service backs the bank's offer composer defaults.

ACCEPTANCE: every row in section 2 "Golden test numbers" is a named unit test that
passes exactly; eligibility examples including the BR-8 JSON behave correctly;
a guardrail-breaking terms save is rejected naming the guardrail; resolution order
tests cover each precedence level; mutation of a published version is rejected.
Tests green, progress.md updated.
```

---

### Prompt 5: Insurance and cover (M5)

```
Context: read AGENTS.md, PRD 4.6 (XB-3, XB-4, XB-5, XB-7), CT-2, and POC plan sections
3.1 (CoverRecord, Claim), 3.2 (Default and recovery), BR-1, BR-7, BR-10, BR-11, A-1,
A-14, screens INS-02, INS-03.

Implement module Insurance (cover and limits; claims come in M8).

1. Insurer organisations with Underwriter and ClaimsHandler roles. BuyerLimit per
   insurer + buyer: limit, utilised, reserved, available, expiry, tier. Concurrency-safe
   reserve/consume/release with tests.
2. CoverRecord per invoice: insurer, policy number, cover %, insured amount (capped by
   remaining buyer limit), status (Requested, Approved, Partial, Declined, Expired),
   claim status. Auto-request on InvoiceAccepted (A-1): choose the insurer from the
   relationship/portfolio config; if none configured, mark "uninsured" and flag
   that financing route may be unavailable per bank minimum cover.
3. Manual insurer workflow (XB-4): request queue; underwriter approves in full, in
   part (changes cover %) or declines with a reason; SLA timer; all audited.
   Decision events feed the invoice (gate 5 in BR-1).
4. IInsurerGateway adapter: SimInsurerApi (auto-decides after a seeded delay, used to
   demonstrate XB-5) and a CSV file-exchange stub (export requests, import decisions).
   Manual workflow remains the default.
5. Premium calculation from insurer terms (basis, payer) exposed to Pricing.
6. "Non-recourse" and "insured" flags exposed on the invoice read model (XB-7, CT-8).
7. Gate service: given an invoice, return whether cover exists and meets the funding
   bank's minimum cover; enforce "advance % cannot exceed cover % for small suppliers".
8. Web: insurer queue and decision form (INS-02), buyer limits and policy manager
   (INS-03), cover badge on invoice detail.

ACCEPTANCE: J-I1 works (partial cover approved; the offer composer then caps advance for
a small supplier); declined cover leaves early-payment route available; limits are not
over-consumed under parallel requests; tests green; progress.md updated.
```

---

### Prompt 6: Marketplace, liens, early payment (M6)

```
Context: read AGENTS.md, PRD section 3 (both routes), FM-1..FM-4, ST-1, XB-8, and POC
plan sections 3.2 (Discount offer, Financing offer, Financing request, Invoice
lifecycle), BR-1 to BR-5, BR-9, BR-14, A-3, A-5, A-13, A-19, A-26, A-29, screens SUP-05,
SUP-06, SUP-07, BUY-04, BUY-05, BNK-02..04, ADM-05, SH-04, SH-06.

Implement module Marketplace and finish the Invoice lifecycle states OpenForFunding,
OffersReceived, Funded (disbursement itself is stubbed until M7; Funded here means
"financing request approved and lien active", then M7 plugs real disbursement into
the DisbursementInstructed step).

1. Funding gates (BR-1) as an ordered pipeline with plain-language reasons. When all
   gates pass, move Accepted -> OpenForFunding and invite the supplier's and buyer's
   preferred banks plus the partner bank (FM-1). Network mode vs white-label mode
   (config): in white-label only the partner bank is invited.
2. Bank visibility: a bank sees an invoice only if invited or has bid (RLS policy +
   tests). Dispute window runs in parallel with bidding but no funding before it ends.
3. Offers (FM-2, FM-3): bank composes an offer (rate, advance %, fees, validity, FX
   rate and spread) validated against its active terms and platform guardrails; state
   machine Invited, Drafted, Submitted, Selected, Rejected, Expired, Withdrawn,
   Superseded. Expiry handled by a worker job using IClock. Optional "manual offer"
   (bank enters) and "API offer" (POST endpoint, signed, idempotent). Every offer is
   normalised to net cash in INR and all-in annualised cost (A-7) via Pricing.
4. Offer comparison read model: bank offers and the early-payment option side by
   side, annualised cost, net cash INR, FX rate, "insured, non-recourse" flag, cost
   vs the supplier's own borrowing rate.
5. Financing request machine (Created, ConsentPending, BankConfirming, Approved,
   DisbursementInstructed, Funded, Declined, Cancelled, LienConflict, Failed). Supplier
   consent screen shows plain-language terms and the assignment; cooling-off: supplier
   can cancel until disbursement is instructed. Bank re-checks limits, sanctions and
   cover at BankConfirming. Limits: reserve on selection, consume on funding (using M2).
6. Lien registry (ST-1, BR-14): unique constraint on active/reserved lien per invoice;
   Reserved at BankConfirming, Active at Funded, Released on settlement; transfer of
   rights history with assignment notice reference. A second financing request fails
   with LienConflict and an audit entry. Test it under concurrency (two parallel
   selects: exactly one wins).
7. Assignment notice (XB-8): generated at consent with governing law from a contract
   template setting, buyer acknowledgement required before funding (BUY-04). US buyers:
   store a "filing reference" stub with state field. Singapore: data-consent flag.
8. Early-payment route (FM-4, BR-2): supplier builds a discount schedule (dates to
   discount, or annual rate); buyer picks a date and confirms funding source (cash or
   bank loan); on confirm, executes via the payment adapter stub and marks the invoice
   Funded with route=EarlyPayment (shown as "Paid early", A-29). Commission share to
   the buyer's bank per config. One route per invoice (A-5): confirming one withdraws
   the other; withdraw all other offers on confirm.
9. Web: supplier offer comparison, discount schedule builder, funding confirmation;
   buyer early-payment screen; bank invitations inbox, credit view, offer composer;
   admin lien registry; invoice detail with timeline and "Explain this cost" panel.

ACCEPTANCE: J-S1 (to Funded) and J-S2 run in the UI with the golden numbers visible
(8.03% financing vs 6.14% early payment); route lock works; two parallel financings
on one invoice yield exactly one success; a bank not invited cannot read the invoice
(API and DB); cooling-off cancel works. Tests green, progress.md updated.
```

---

### Prompt 7: Settlement, disbursement, reconciliation, notifications (M7)

```
Context: read AGENTS.md, PRD 4.4 (ST-2..ST-4), XB-9, CR-1, section 5 Integration, and
POC plan sections 3.2 (Disbursement, Settlement), BR-5, BR-12 (calendars), BR-15, 5.1,
5.2, screens BNK-10, BUY-07, SH-03, SH-07, ADM-08, ADM-09.

Implement module Settlement and module Notifications. The platform never holds funds:
model collection accounts as bank-held accounts abstracted behind adapters (A-12).

1. Adapter contracts and simulators: IPaymentGateway (instruct payment, query status,
   statement fetch, callback), SimBankGateway producing realistic payloads and a bank
   statement CSV; fault injection (timeout, rejection, mismatched amount, return) driven
   by admin settings and a seeded RNG; signed webhooks (HMAC) from gateway to API with
   replay protection. Keep the payload log in an integration_messages table for the
   inspector (SH-07).
2. Calendars and cut-offs (XB-9): holiday lists for India, US, Singapore (seed years
   2026-2027, loaded from JSON, marked "verify"), per-bank cut-off in its own time zone.
   Due-date and value-date logic business-day aware; instructions after cut-off or on
   a holiday go to QueuedForValueDate.
3. Disbursement machine: Instructed, FXBooked (cross-currency), QueuedForValueDate,
   Sent, Credited, Failed->Retry, Reversed, Returned. FX at disbursement at the bank's
   rate (A-10); the rate is stored with the quote. Idempotent instruction with a unique
   reference. Hooks the Marketplace DisbursementInstructed step to Funded when Credited.
4. Settlement: one unique payment reference per invoice (ST-2) issued to buyer and its
   bank; collection ledger entries; auto-match by reference and amount from callbacks
   or statement files (ST-4); distribution lines (principal and charges to bank,
   retention release to supplier converted at settlement FX, platform fee noted);
   exceptions Unmatched, ShortPaid, OverPaid, Late with an operations queue and
   resolution actions; Reconciled closes the lien and moves the invoice Settled then
   Closed. Late marks Overdue (M8 continues from there).
5. Early-payment settlement: buyer pays the discounted amount; supplier credited;
   commission booked.
6. Notifications (CR-1): subscribe to outbox events, one notification per state change
   to the right parties; channels email (SMTP to Mailpit in dev), SMS and WhatsApp via
   INotificationChannel with Sim implementations and delivery states; templates in
   English now with placeholders for Hindi; quiet hours not required. In-app
   notification centre feed.
7. Virtual clock admin controls in Development/Demo only: advance days, jump to due
   date; the worker's schedulers must obey IClock.
8. Web: bank operations settlement and reconciliation console (BNK-10), buyer payments
   due (BUY-07) with the payment reference, notification centre, integration inspector,
   admin integration control room and calendars.

ACCEPTANCE: J-S1 completes through INR landing, buyer payment at maturity, retention
release; J-K3 shows auto-match and a short-payment exception resolved by ops; a
disbursement requested after cut-off is queued to the next business day; webhook replay
is rejected; funded-to-settled run produces zero manual breaks on the happy path (an
automated E2E test). Tests green, progress.md updated.
```

---

### Prompt 8: Exceptions: disputes, overdue, claims, recourse, export proceeds (M8)

```
Context: read AGENTS.md, PRD 4.4 (ST-5), XB-6, XB-7, CR-4, and POC plan sections 3.2
(Dispute, Default and recovery), BR-10, BR-11, BR-13, A-8, A-9, A-14, screens SH-05,
SUP-08, SUP-09, BUY-06, BNK-11, INS-05, ADM-04.

Implement dispute, claim and recourse flows and the export-proceeds tracker.

1. Disputes: full workflow Open, UnderReview, ResolvedForBuyer, ResolvedForSupplier,
   Escalated, TimedOut with configurable timers (admin console). Freeze/unfreeze of
   financing steps, late interest and dunning. Evidence upload and per-invoice message
   thread visible to the involved parties (SH-05). Platform admin dispute queue and case
   view with timers (ADM-04) and a decision that is applied to the financing.
2. Credit notes (BR-13): before funding they reduce the invoice amount; after funding
   they reduce exposure, and the supplier owes the bank the difference in advance
   (capped for small suppliers). Offers become invalid when the invoice changes.
3. Overdue and default: scheduler on IClock; dunning at day 1, 7, 30 (configurable);
   late interest at rate + 2% charged to the buyer, not the funded supplier; waiting
   period from insurer terms; insolvency event skips the wait (A-14); ClaimEligible
   with deadline countdown; states Overdue, Defaulted per POC plan.
4. Claims (XB-7): bank files a claim with documents; insurer claims desk reviews
   documents and exclusions (disputes, documentation defects, shipment before limit,
   sanctions breach), approves full or partial, or rejects; payout recorded; payout
   waterfall (BR-10): bank principal plus accrued charges first, remainder to supplier
   retention. Recoveries net of costs shared pro rata to losses borne. Implement as a
   pure, tested domain service.
5. Recourse (BR-11, A-9): triggered only when the platform admin adjudicates a
   supplier-caused dispute (list of causes configurable: non-delivery, quality
   failure, wrong documents, misrepresentation). For small suppliers: offset of at
   most 20% of each future payout or a 90-day plan, no penalty interest. Non-small
   suppliers: bank terms apply. Supplier sees plainly what they owe (SUP-09).
6. Export proceeds (XB-6, BR-12): realisation deadline per invoice (9 months from
   shipment as a config, "confirm with counsel"), proceeds record, reporting status via
   the authorised-dealer-bank role, and a flag when financing breaks the realisation
   chain (SUP-08).
7. Web: supplier dispute and recourse view, buyer credit note form, bank recovery
   workbench, insurer claims desk, admin dispute queue.

ACCEPTANCE: automated scenario tests reproduce BR-10 cases A, B and C to the cent;
J-S3, J-B3, J-I3, J-A2 run in the UI; a dispute freezes late interest; a funded
credit note adjusts exposure; small-supplier repayment respects the 20% cap; the
default path runs overdue -> waiting period -> claim -> payout -> recovery. Tests green,
progress.md updated.
```

---

### Prompt 9: Terms studio, maker-checker, white-label, admin console (M9)

```
Context: read AGENTS.md, PRD 4.6 (WL-1) and 4.7 (CT-6, CT-8..CT-11), CR-4, and POC plan
BR-4, BR-9, 2.4 (BNK-07..09, BNK-12), 2.5 (INS-04), 2.6 (ADM-07).

The engine, schemas and guardrails exist from M4. Build the management layer on top.

1. Maker-checker (CT-6): maker saves a draft; a different user with Approver role
   publishes with an effective date; self-approval blocked server-side; full audit
   trail with before/after diffs. Pending changes shown in an approvals inbox.
2. Terms studio UI for banks and insurers: templates, form-driven editor plus a
   JSON editor with schema validation, eligibility rule builder (visual AND/OR tree),
   layered overrides per buyer, supplier or corridor, versions with effective dates,
   diff viewer, plain-language preview of what suppliers and buyers will see (CT-8),
   JSON import/export (CT-11), custom required fields and documents per bank or
   insurer (CT-10; capture the field definitions in terms JSON and render them on the
   relevant forms).
3. Simulator (CT-9): UI over the existing Simulate service: runs a draft against 20
   seeded sample invoices; shows eligibility, price, net cash, and delta vs the active
   version.
4. Guardrail console for platform admin (ADM-07): view/edit platform defaults and
   guardrail values, fee configuration (BR-4, free tier for small suppliers),
   dispute timers; all changes maker-checker and audited.
5. White-label (WL-1): per-bank branding (logo, colours, display name, welcome text),
   resolved by tenant hostname (local dev: kestrel.localhost:5173), CSS variable theming in
   the SPA, bank-only admin console, bank own fee and limit configuration. Network
   mode vs white-label mode switch in platform config.
6. Verify that funded invoices keep their stored terms version while new invoices use
   the new one (integration test).

ACCEPTANCE: J-K2 and J-I2 run end to end; self-approval is blocked; a term save that
breaks a guardrail is rejected naming it; an old funded invoice shows its old terms
version while a new invoice uses the new one; switching hostname flips branding. Tests
green, progress.md updated.
```

---

### Prompt 10: Dashboards, Hindi, hardening, pilot readiness (M10)

```
Context: read AGENTS.md, PRD sections 4.5 (CR-3), 5, 6 (metrics, roadmap exit gate),
7, and POC plan screens SUP-01, BUY-01, BNK-01, INS-01, ADM-01, BNK-13, SH-08.

1. Dashboards (CR-3) with read-model queries (materialised views or projection
   tables, refreshed by the worker): supplier (aging, financed volume, savings vs own
   borrowing rate), buyer (payables, acceptance SLA, discount income, supplier
   stability), bank (pipeline, funded volume, exposure by buyer/supplier/corridor),
   insurer (utilisation, claims), admin pilot scorecard with the six PRD §6 metrics:
   median days acceptance to cash, average cost vs own borrowing, offers per accepted
   invoice, share accepted in 3 days, default/dispute rate, monthly financed volume.
2. Bank file and API console (BNK-13): signed REST endpoints and webhooks for bank and
   ERP integration, API key management with rotation, SFTP/CSV file drop fallback
   (offers in, statements in, instructions out), documented in OpenAPI and in
   docs/integration-guide.md.
3. Internationalisation: all UI strings via i18next, Hindi translations for the
   supplier-facing screens, offer summary, consent and notifications; Hindi summary of
   terms generated from templates; Indian number grouping everywhere INR appears.
   Mobile-friendly layouts for supplier and buyer flows.
4. Accessibility: WCAG 2.1 AA pass on key flows (axe in Playwright).
5. Security hardening: security headers, rate limiting, input validation review,
   encryption at rest (database and object storage configuration docs), secrets from
   a vault abstraction, dependency scanning and SAST in CI, threat model in docs,
   signed API calls verified, audit log retention policy, data-residency configuration
   (region per organisation enforced at deployment level, documented).
6. Reliability and performance: structured logging, OpenTelemetry traces and metrics,
   health checks, backup/restore runbook with RPO < 15 min and RTO < 4 h targets,
   k6 load test showing acceptance to offers visible within 1 minute and p95 page loads
   under 3 s on seeded volume.
7. Playwright end-to-end suite covering all 15 journeys from the POC plan
   (J-S1..J-S3, J-B1..J-B3, J-K1..J-K3, J-I1..J-I3, J-A1..J-A3) from a clean seed, plus
   J-0 onboarding.
8. Pilot kit: demo data seeder, runbook, "known limitations and legal checklist" doc
   (RBI/TReDS, assignment perfection by US state, Singapore PDPA, export proceeds, data
   transfers; each marked "needs counsel").

ACCEPTANCE: all journeys pass from a clean database; scorecard shows the six metrics
from seeded data; k6 thresholds met; accessibility checks pass; pilot-readiness
checklist in docs/pilot-readiness.md is complete or lists explicit gaps. Tests green,
progress.md updated.
```

---

## 5. Test and quality strategy (applies to all milestones)

- **Pyramid:** unit (domain, pricing, rules) first; module tests with Testcontainers; API integration tests; Playwright E2E per milestone demo.
- **Property-based tests** for the rule engine and money allocation (allocations always sum to the original).
- **Golden tests** for all numbers in section 2. A change to a golden value needs an explicit note in `docs/progress.md`.
- **Security tests:** isolation (RLS), role permission matrix, self-approval block, replay rejection.
- **Concurrency tests:** limits, lien registry, audit chain, idempotency keys.
- **Architecture tests:** module boundaries.

## 6. Risks and how this plan handles them

| Risk | Handling |
|---|---|
| Rules leak into code per bank | Engine reads JSON only; architecture and review rule in AGENTS.md; seeded banks differ only by JSON |
| Money rounding drift | Single pricing module, golden tests, rounding per line then sum |
| Double financing | DB unique constraint on active lien plus concurrency test |
| Tenant data leak | RLS plus query filter plus isolation tests in CI |
| Real integrations not available early | Adapter contracts and simulators from day one; swap per partner |
| Legal assumptions baked in | Thresholds (MSME, realisation period, holidays) are configuration marked "verify with counsel" |
| Scope creep from P1/P2 | Reverse auction, standing rules, term extension, order financing are excluded from the MVP; add after M10 |

## 7. After the MVP

Phase 2 of the PRD roadmap: bank and ERP APIs (replace simulators), auto-accept rules (FM-5), reverse auction (FM-6), more buyers and banks. Term extension (FM-7) and order-stage financing are Phase 3.

## 8. Things I need from you

1. Confirm or change D1 to D10 above (especially D3 auth and D5 simulated integrations).
2. Confirm that the POC plan's open decisions (A-1, A-2, A-3, A-8, A-9, A-10) are adopted as written.
3. Which repo host and CI you use, so Prompt 0 can generate the right pipeline.
4. Whether the agent can use Docker locally (Testcontainers needs it).
