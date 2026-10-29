# Earlio

Tri-party receivables financing platform: suppliers get cash within days of buyer acceptance, banks compete to fund invoices against the buyer's credit, trade-credit insurers cover default, and the platform provides the rails, rules and audit. **Simulated environment** — all organisations, rates and FX are fictional.

- `apps/api` — Node/TypeScript API (Fastify, PostgreSQL). `apps/web` — React SPA. They are decoupled; the contract is `docs/openapi.json`.
- Docs: `docs/PRD.pdf`, `docs/earlio-mvp-implementation-plan.md`, `docs/progress.md`, `docs/adr/`. Agent rules: `AGENTS.md`.

```
npm install
npm run dev:api      # http://localhost:4000  (needs Postgres per apps/api/.env; seeded demo cast)
npm run dev:web      # http://localhost:5173
npm test             # API tests against the Postgres in apps/api/.env
```
Demo login: `admin@shree.demo` / `Earlio!Demo1` (use "Use demo code" on the MFA step in development).
