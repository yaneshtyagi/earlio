# ADR-000: Node/TypeScript backend instead of ASP.NET

**Status:** accepted, 23 Oct 2026

The implementation plan originally specified ASP.NET (.NET 10). The cloud build environment cannot install the .NET SDK or restore NuGet packages (hosts blocked), and has no Docker daemon. The backend is therefore built in **Node 22 + TypeScript (Fastify)** with **PostgreSQL**, keeping the same architecture (modular monolith, RLS tenancy, outbox, adapters, rule engine as data) and the same API-first decoupling from the React frontend.

Consequences: C#-specific items in the plan map as follows — NetArchTest → import-boundary test; EF Core migrations → plain SQL migrations; MediatR pipeline → `audit()` called from services; Testcontainers → an embedded real PostgreSQL started by the test global setup; FsCheck → property tests with plain vitest. Nothing in the domain design depends on the language; a .NET port remains possible because the contract is `docs/openapi.json` and the rules are JSON.
