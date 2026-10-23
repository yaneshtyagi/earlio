# Pilot readiness

Status of Earlio against the pilot goals, what to run before going live, and what is deliberately not done.

## Before the first real user

| Check | How | Owner |
|---|---|---|
| Production config refuses defaults | Start with `EARLIO_ENV=production` and the default `WEBHOOK_KEY`: it must exit | Engineering |
| Secrets in a secrets manager | Implement the `kernel/secrets.ts` provider for your platform | Engineering |
| Managed Postgres with PITR | RPO < 15 min, RTO < 4 h; run the restore drill in `docs/runbook.md` | Operations |
| `METRICS_TOKEN` set, alerts on `/ready` and error rate | `docs/runbook.md` | Operations |
| Demo-only routes off | `/api/v1/dev/*` and the demo scenario routes are not registered, and the clock refuses to move (409), outside development; check with a request to each | Engineering |
| Dependency audit and CodeQL green | `.github/workflows/security.yml` | Engineering |
| Full suite green | `npm test`, `npm run e2e` | Engineering |
| Load check on the real environment | `node scripts/load-test.mjs --api <url>` | Engineering |
| Admin MFA enforced, recovery codes stored | Platform onboarding | Operations |

## Success metrics (pilot scorecard)

The platform scorecard (`/admin/scorecard`) shows the six PRD metrics from live data. Agree targets with the pilot bank before launch.

## Needs counsel (not decided by software)

- RBI and TReDS interplay: whether the platform's role needs registration or a TReDS partnership, and the bank's own obligations.
- Perfection of the assignment of receivables for US buyers (state-by-state UCC treatment) and the Singapore equivalent.
- Singapore PDPA and India DPDP Act: consent, notices, cross-border transfer, breach notification.
- Export proceeds realisation rules (FEMA) and the bank AD's reporting duties.
- Insurer licensing and the distribution of cover through the platform.
- Retention period for the audit log and KYC documents (the runbook assumes 8 years; confirm).
- Governing law and dispute text shown to users (a governed setting; counsel should approve the wording).
- Sanctions screening: the seeded list is a stand-in; a licensed list provider is needed.

## Known limitations

- White-label branding does not restrict login to the partner bank's customers.
- Logos are stored inline (200 KB cap) rather than in object storage.
- Insurer terms overrides are by corridor only.
- SFTP file drop is HTTPS upload only.
- Payments, FX and KYC/sanctions providers are simulated by adapters; production providers are needed.
- Email and SMS delivery are simulated; wire a provider behind the notification outbox.
- Browser click-through tests cover onboarding, the pilot read-through and accessibility; the remaining journeys are covered by API integration tests.
- The Users page can add members but cannot yet email an invitation or reset a password.

## Demo script (15 minutes)

1. Start the seeded stack: `npm run e2e:stack`. Sign in as `finance@kumar.demo` (password `Earlio!Demo1`, use the demo code button).
2. Supplier: invoices in every state; open INV-1005 and compare three bank offers.
3. Buyer (`finance@northwind.demo`): funded invoices, payments due.
4. Bank (`credit@kestrel.demo`): invitations, offers, API and files console.
5. Insurer (`underwriter@sentinel.demo`): cover requests and claim on INV-1011.
6. Platform (`admin@earlio.demo`): KYC queue, dispute on INV-1009, audit chain verification, pilot scorecard.
7. Switch language to Hindi from the header; open the terms preview.
