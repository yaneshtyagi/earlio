Reading the permission table and the routes that enforce each permission, to see what each one actually allows per org type.

Most routes check what they need in a gate on the route. About 40 do the check inside the handler instead, so I'm reading those too.

The system has 11 roles. Each organisation type allows a fixed subset, and what a role can do depends on its permissions and on its organisation's type. The source is [permissions.ts](apps/api/src/modules/identity/permissions.ts); I checked every route's gates against it.

## Which roles each organisation type allows

| Role                | Supplier | Buyer | Bank | Insurer | Platform |
| ------------------- | :------: | :---: | :--: | :-----: | :------: |
| Admin               |    ✓     |   ✓   |  ✓   |    ✓    |          |
| FinanceUser         |    ✓     |   ✓   |  ✓   |         |          |
| Approver            |    ✓     |   ✓   |  ✓   |    ✓    |          |
| Viewer              |    ✓     |   ✓   |  ✓   |    ✓    |          |
| CreditOfficer       |          |       |  ✓   |         |          |
| Operations          |          |       |  ✓   |         |          |
| RelationshipManager |          |       |  ✓   |         |          |
| Underwriter         |          |       |      |    ✓    |          |
| ClaimsHandler       |          |       |      |    ✓    |          |
| PlatformAdmin       |          |       |      |         |    ✓     |
| Auditor             |          |       |      |         |    ✓     |

Every role has `read`: its own organisation's dashboard, invoices, notifications, disputes and claims. Every role must sign in with MFA. The tables below list only what each role adds to that.

## Supplier

| Role            | Functions                                                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**       | Manage users; set the notification language; choose preferred banks; upload and submit KYC; propose buyer relationships                                                                                                                                                                                                           |
| **FinanceUser** | Create invoices (by hand, CSV, or the simulated ERP import); record purchase orders; attach documents, submit and cancel drafts; request funding (runs the funding gates); choose an offer; publish or withdraw a discount schedule; cancel financing during cooling-off; raise and withdraw disputes; KYC; propose relationships |
| **Approver**    | Consent to financing (the assignment and terms); cancel financing during cooling-off; approve relationships (not ones they proposed); choose the repayment mode for recourse; raise disputes                                                                                                                                      |
| **Viewer**      | Read only                                                                                                                                                                                                                                                                                                                         |

## Buyer

| Role            | Functions                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**       | Manage users; set the notification language; choose preferred banks; KYC; propose supplier relationships                                                                                 |
| **FinanceUser** | KYC; propose relationships; raise and withdraw disputes; issue credit notes                                                                                                              |
| **Approver**    | Accept, part-accept or reject invoices; acknowledge assignment notices; get early-payment quotes and confirm early payment; approve relationships; raise disputes and issue credit notes |
| **Viewer**      | Read only (including payments due and early-payment quotes)                                                                                                                              |

## Bank

| Role                    | Functions                                                                                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**               | Manage users; manage API keys (create, rotate, revoke) and webhooks; edit branding; KYC                                                                                                                                                   |
| **FinanceUser**         | KYC only (see the note below)                                                                                                                                                                                                             |
| **Approver**            | Approve and publish bank terms as the checker; must be a different person from whoever drafted them                                                                                                                                       |
| **CreditOfficer**       | See the invitations inbox; preview, send and withdraw offers or decline invitations; upload offers as a CSV file; confirm or decline financing; file insurance claims; record recoveries and recourse repayments; report buyer insolvency |
| **Operations**          | Settlement: expected payments, transactions, the exceptions queue and resolving exceptions; import statements; statement and instruction file drops; report export-proceeds realisation                                                   |
| **RelationshipManager** | Draft terms, import them, simulate them and submit them for approval; set buyer and supplier exposure limits; edit branding                                                                                                               |
| **Viewer**              | Read only                                                                                                                                                                                                                                 |

## Insurer

| Role              | Functions                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**         | Manage users; KYC                                                                                                                                        |
| **Approver**      | Approve and publish insurer terms (checker)                                                                                                              |
| **Underwriter**   | Approve (optionally with lower cover) or decline cover requests, including CSV export and import; set per-buyer insured limits; draft and simulate terms |
| **ClaimsHandler** | Review claims, approve in full, approve less or reject them, and record payouts (the payment order pays the bank first)                                  |
| **Viewer**        | Read only                                                                                                                                                |

## Platform (Earlio staff)

| Role              | Functions                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PlatformAdmin** | KYC queue and decisions; sanctions review; decide disputes; suspend relationships; propose and approve governed settings (a second admin must approve); platform terms; bank hostnames; settlement operations; report insolvency; audit log, chain check and anchoring; scorecard, network map and lien registry; integration messages; manage users. In dev and demo only: the virtual clock, simulated payments and fault injection |
| **Auditor**       | Read-only cross-tenant views: audit log and chain check, scorecard, network map, lien registry, integration messages. Each cross-tenant read is itself audited                                                                                                                                                                                                                                                                        |

## What the code shows

- **Some roles hold permissions their org type can't use.** The routes also check the organisation type, so some permissions have no effect:
  - A buyer's FinanceUser has `invoice:create` and `discount:manage`, but those routes are supplier-only.
  - A bank's FinanceUser has the same permissions as a supplier's, so in practice it can only submit KYC.
  - Approvers at a supplier or buyer have `terms:publish`, but those org types have no terms to publish.

  These permissions are harmless but misleading. Splitting the table by org type would fix it, if you want that.

- **Maker-checker rules sit on top of roles.** The proposer of a relationship can't approve it, the person who drafted terms can't publish them, and one PlatformAdmin can't approve their own settings change.
- **Users and roles are per organisation.** One user can belong to several organisations with a different role in each, and switches between them with `switch-org`.

I can also put this matrix on a page you can share.
