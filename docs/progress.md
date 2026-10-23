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
