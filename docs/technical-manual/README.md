# Earlio technical manual

For **developers** who change Earlio and **DevOps engineers** who build, deploy and run it. Production support teams have their own guide in [`docs/support/`](../support/README.md); business users have the [user manuals](../user-manual/README.md).

| # | Chapter | Read it when you need to… |
| --- | --- | --- |
| 1 | [Architecture](01-architecture.md) | understand how the pieces fit: API, worker, web app, database, adapters |
| 2 | [Local development](02-local-development.md) | set up a workstation, run the stack, sign in as the demo cast |
| 3 | [Configuration reference](03-configuration.md) | set an environment variable or understand what one does |
| 4 | [Database and migrations](04-database-and-migrations.md) | add a migration, understand roles, RLS and the append-only tables |
| 5 | [Build, test and CI](05-build-test-ci.md) | run the test suites, keep the OpenAPI contract fresh, read a CI failure |
| 6 | [Deployment](06-deployment.md) | stand up an environment, release a version, roll back |
| 7 | [Operations and observability](07-operations-and-observability.md) | wire health checks, metrics, logs and alerts; back up and restore |
| 8 | [Security and secrets](08-security-and-secrets.md) | handle secrets, rotate keys, harden a production deployment |
| 9 | [Maintenance cookbook](09-maintenance-cookbook.md) | add a module, an endpoint, an adapter or a page; upgrade dependencies |

## Related documents

| Document | What it holds |
| --- | --- |
| [`AGENTS.md`](../../AGENTS.md) | The non-negotiable architecture rules (also binding on humans) |
| [`docs/adr/`](../adr) | Architecture decision records ADR-000 … ADR-005 |
| [`docs/earlio-mvp-implementation-plan.md`](../earlio-mvp-implementation-plan.md) | Milestones M0–M10 and the golden numbers the pricing tests must hit |
| [`docs/progress.md`](../progress.md) | What changed in each milestone and the known deviations |
| [`docs/er-diagrams.md`](../er-diagrams.md) | Entity-relationship diagrams per schema |
| [`docs/workflows.md`](../workflows.md) | State machines and end-to-end flows |
| [`docs/permissions-matrix.md`](../permissions-matrix.md) | Roles × permissions |
| [`docs/integration-guide.md`](../integration-guide.md) | Machine API, signing, webhooks and CSV file drops for banks |
| [`docs/threat-model.md`](../threat-model.md) | STRIDE summary and residual risks |
| [`docs/runbook.md`](../runbook.md), [`docs/pilot-readiness.md`](../pilot-readiness.md) | The original short runbook and go-live checklist (this manual expands both) |
| [`docs/openapi.json`](../openapi.json) | The API contract (generated) |
| [`docs/posting/`](../posting) | Ready-made HTTP requests for every endpoint (Posting collection) |

## Conventions in this manual

- Commands run from the repository root unless a `cd` is shown.
- `<angle brackets>` are placeholders. Nothing in this manual is a real secret; demo credentials exist only in the development seed.
- **Gap** marks something the MVP does not do yet that a production deployment must address. All gaps are collected in [Deployment § 6.9](06-deployment.md#69-production-gaps-to-close).
- Screenshots come from the local demo stack (version 0.1, virtual clock). Production pages do not show the yellow *Simulated environment* banner.
