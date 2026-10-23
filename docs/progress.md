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
