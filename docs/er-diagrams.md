# Earlio — database ER diagrams

Derived from `apps/api/migrations/000_base.sql` … `013_language.sql`. Update this file when a migration adds or changes a table.

## Conventions

- One PostgreSQL database, one schema per module: `identity`, `audit`, `platform`, `compliance`, `invoicing`, `terms`, `insurance`, `marketplace`, `settlement`, `recovery`, `notify`, `integration`, `analytics` (plus `app` for the RLS helper functions `app.org_id()`, `app.user_id()`, `app.is_platform()`).
- **Solid line** = a real foreign-key constraint. **Dashed line** = a logical reference (a `uuid` column with no FK, usually a cross-module link or a denormalised copy kept for RLS).
- Almost every tenant table carries denormalised `supplier_org_id` / `buyer_org_id` / `bank_org_id` / `insurer_org_id` columns so RLS can filter without joins. Links from those columns to `identity.organisations` are drawn only where a FK exists, to keep diagrams readable.
- Money columns are `numeric(20,2)`; rates `numeric(8,4)`; status columns are `text` with a `check` constraint (values listed in the comment).
- `PK` primary key, `FK` foreign key (enforced), `UK` unique. Columns marked `"-> x"` are logical references without a FK.

## 1. Overview — main aggregates across modules

```mermaid
erDiagram
    organisations ||--o{ memberships : has
    users ||--o{ memberships : has
    organisations ||--o{ relationships : "supplier / buyer"
    organisations ||--o{ invoices : "supplier / buyer"
    relationships ||..o{ invoices : "governs (logical)"
    invoices ||--o{ invoice_documents : has
    invoices ||--o{ acceptances : "buyer decision"
    invoices ||--o{ disputes : has
    invoices ||--o| cover_records : "credit insurance"
    terms_sets ||--o{ terms_versions : versions
    terms_versions ||..o{ offers : "priced by (logical)"
    invoices ||--o{ invitations : "banks invited"
    invoices ||--o{ offers : receives
    offers ||--o{ financing_requests : "selected into"
    financing_requests ||--o{ liens : secures
    financing_requests ||--o| disbursements : funds
    invoices ||--o| expectations : "buyer repayment"
    expectations ||--o{ bank_transactions : "matched to"
    invoices ||..o| defaults : "if overdue"
    invoices ||..o| claims : "insurance claim"
    claims ||--o{ recoveries : has
    invoices ||--o| early_payments : "or buyer pays early"
```

## 2. Identity, relationships and limits (`identity`)

```mermaid
erDiagram
    organisations {
        uuid id PK
        text type "supplier, buyer, bank, insurer, platform"
        text legal_name
        text country
        boolean small
        boolean msme
        numeric turnover_inr
        text rating_tier "AA, A, BBB"
        text data_region
        jsonb branding
        text hostname UK
        boolean is_partner
        text kyc_status
        text sanctions_status
        boolean blocked
        numeric borrowing_rate
        text language "en, hi"
        timestamptz created_at
    }
    users {
        uuid id PK
        text email UK
        text name
        text password_hash
        text mfa_secret
        boolean mfa_enabled
        jsonb recovery_codes
        int failed_attempts
        timestamptz locked_until
        timestamptz created_at
    }
    memberships {
        uuid id PK
        uuid user_id FK
        uuid org_id FK
        text role "Admin, FinanceUser, Approver, Viewer, CreditOfficer, ..."
        timestamptz created_at
    }
    sessions {
        text id PK "sha256 of cookie token"
        uuid user_id FK
        uuid org_id FK
        boolean mfa_verified
        text csrf_token
        timestamptz expires_at
        timestamptz created_at
    }
    relationships {
        uuid id PK
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        uuid insurer_org_id FK
        text status "pending, active, suspended"
        uuid proposed_by_org_id FK
        uuid proposed_by_user
        uuid supplier_approved_by
        timestamptz supplier_approved_at
        uuid buyer_approved_by
        timestamptz buyer_approved_at
        timestamptz created_at
    }
    org_preferred_banks {
        uuid org_id PK, FK
        uuid bank_org_id PK, FK
        timestamptz created_at
    }
    bank_limits {
        uuid id PK
        uuid bank_org_id FK
        uuid subject_org_id FK
        text kind "buyer, supplier"
        numeric limit_usd
        numeric reserved_usd
        numeric used_usd "reserved + used <= limit"
        timestamptz updated_at
    }

    users ||--o{ memberships : "belongs via"
    organisations ||--o{ memberships : "has members"
    users ||--o{ sessions : opens
    organisations |o--o{ sessions : "active org"
    organisations ||--o{ relationships : "as supplier"
    organisations ||--o{ relationships : "as buyer"
    organisations |o--o{ relationships : "as insurer"
    organisations ||--o{ org_preferred_banks : prefers
    organisations ||--o{ org_preferred_banks : "is preferred bank"
    organisations ||--o{ bank_limits : "bank grants"
    organisations ||--o{ bank_limits : "subject of"
```

Unique: `memberships (user_id, org_id)`, `relationships (supplier_org_id, buyer_org_id)`, `bank_limits (bank_org_id, subject_org_id, kind)`.

## 3. Compliance and files (`compliance`, `platform.files`)

```mermaid
erDiagram
    organisations {
        uuid id PK
    }
    files {
        uuid id PK
        uuid org_id FK
        text filename
        text content_type
        bigint size
        text sha256
        text storage_key
        text scan_status "clean, infected, pending"
        uuid uploaded_by
        uuid_array shared_with "org ids with read access"
        timestamptz created_at
    }
    kyc_cases {
        uuid id PK
        uuid org_id FK
        text status "draft, submitted, in_review, referred, approved, rejected"
        timestamptz submitted_at
        timestamptz decided_at
        uuid decided_by
        text decision_reason
        jsonb provider_result
        timestamptz created_at
    }
    kyc_documents {
        uuid id PK
        uuid case_id FK
        uuid org_id FK
        text doc_type
        uuid file_id FK
        timestamptz created_at
    }
    screening_results {
        uuid id PK
        uuid subject_org_id FK
        text subject_name
        uuid invoice_id "-> invoicing.invoices"
        text list_version
        jsonb matches
        numeric top_score
        text outcome "clear, hit, false_positive, confirmed"
        uuid reviewed_by
        timestamptz reviewed_at
        text review_reason
        timestamptz created_at
    }
    sanctions_whitelist {
        uuid org_id PK, FK
        text entry PK
        text reason
        timestamptz created_at
    }

    organisations ||--o{ files : owns
    organisations ||--o{ kyc_cases : "undergoes (one open at a time)"
    kyc_cases ||--o{ kyc_documents : contains
    files ||--o{ kyc_documents : "stored as"
    organisations |o--o{ screening_results : "screened"
    organisations ||--o{ sanctions_whitelist : has
```

## 4. Invoicing (`invoicing`)

```mermaid
erDiagram
    organisations {
        uuid id PK
    }
    files {
        uuid id PK
    }
    purchase_orders {
        uuid id PK
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        text number
        text currency "USD, SGD"
        numeric amount
        text description
        timestamptz created_at
    }
    invoices {
        uuid id PK
        text human_id UK
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        uuid po_id FK
        text number
        text currency "USD, SGD"
        numeric gross_amount
        numeric accepted_amount
        date issue_date
        date due_date
        date shipment_date
        text status "Draft ... Funded, Settled, Disputed, Overdue, Defaulted, Closed, Cancelled"
        text status_before_dispute
        text route "financing, early_payment"
        text irn
        text cover_status
        text screening_status
        boolean dispute_flag
        jsonb warnings
        text fingerprint "unique while not Cancelled"
        timestamptz submitted_at
        timestamptz accepted_at
        timestamptz dispute_window_ends_at
        int reminder_count
        uuid created_by
        timestamptz created_at
        timestamptz updated_at
    }
    invoice_documents {
        uuid id PK
        uuid invoice_id FK
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        text doc_type "commercial_invoice, packing_list, shipping_bill, ..."
        int version
        uuid file_id FK
        text filename
        text sha256
        uuid uploaded_by
        timestamptz created_at
    }
    acceptances {
        uuid id PK
        uuid invoice_id FK
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        text decision "accepted, partial, rejected"
        numeric accepted_amount
        text reason
        text undertaking_text
        timestamptz undertaking_signed_at
        uuid decided_by
        timestamptz decided_at
        timestamptz assignment_ack_at
        uuid assignment_ack_by
    }
    disputes {
        uuid id PK
        uuid invoice_id FK
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        uuid bank_org_id
        text kind "dispute, partial_remainder"
        text phase "window, post_acceptance, post_funding"
        boolean freezes
        text frozen_status
        uuid raised_by_org
        uuid raised_by_user
        text reason
        text status "Open, UnderReview, ResolvedForBuyer, ResolvedForSupplier, Escalated, TimedOut"
        text attributable_party
        text outcome
        text cause
        numeric amount
        numeric credit_amount
        timestamptz response_due_at
        timestamptz escalate_at
        timestamptz timeout_at
        text decision_note
        uuid decided_by
        timestamptz decided_at
        timestamptz created_at
        timestamptz resolved_at
    }
    dispute_messages {
        bigserial id PK
        uuid dispute_id FK
        uuid invoice_id
        uuid supplier_org_id
        uuid buyer_org_id
        uuid bank_org_id
        uuid author_org_id
        text author_name
        uuid author_user
        text kind "message, evidence, system"
        text body
        uuid file_id "-> platform.files"
        timestamptz created_at
    }
    credit_notes {
        uuid id PK
        uuid invoice_id FK
        text invoice_number
        text number UK
        uuid supplier_org_id
        uuid buyer_org_id
        uuid bank_org_id
        text stage "pre_funding, post_funding"
        text currency
        numeric amount
        numeric prior_amount
        numeric new_amount
        numeric supplier_owes
        text reason
        uuid dispute_id "-> disputes"
        uuid issued_by_org
        uuid issued_by_user
        timestamptz created_at
    }
    invoice_history {
        bigserial id PK
        uuid invoice_id FK
        uuid supplier_org_id
        uuid buyer_org_id
        text from_status
        text to_status
        uuid actor_user
        uuid actor_org
        text note
        timestamptz at
    }

    organisations ||--o{ purchase_orders : "supplier / buyer"
    organisations ||--o{ invoices : "supplier / buyer"
    purchase_orders |o--o{ invoices : "billed by"
    invoices ||--o{ invoice_documents : has
    files ||--o{ invoice_documents : "stored as"
    invoices ||--o{ acceptances : "decided by buyer"
    invoices ||--o{ disputes : has
    disputes ||--o{ dispute_messages : thread
    files |o..o{ dispute_messages : evidence
    invoices ||--o{ credit_notes : adjusts
    disputes |o..o{ credit_notes : "resolved by"
    invoices ||--o{ invoice_history : "state transitions"
```

Unique: `purchase_orders (supplier_org_id, buyer_org_id, number)`, `invoice_documents (invoice_id, doc_type, version)`.

## 5. Terms and insurance (`terms`, `insurance`)

```mermaid
erDiagram
    organisations {
        uuid id PK
    }
    invoices {
        uuid id PK
    }
    terms_sets {
        uuid id PK
        text owner_type "platform, bank, insurer"
        uuid owner_org_id FK "null iff platform"
        text name
        jsonb scope
        text layer
        int priority
        uuid created_by
        timestamptz created_at
    }
    terms_versions {
        uuid id PK
        uuid set_id FK
        int version
        text status "draft, pending, active, retired"
        timestamptz effective_from
        timestamptz effective_to
        jsonb body "rule-engine JSON"
        int schema_version
        text note
        uuid created_by
        uuid submitted_by
        uuid approved_by "maker-checker: != created_by"
        timestamptz created_at
        timestamptz submitted_at
        timestamptz approved_at
    }
    buyer_limits {
        uuid id PK
        uuid insurer_org_id FK
        uuid buyer_org_id FK
        text policy_number
        numeric limit_usd
        numeric reserved_usd
        numeric used_usd "reserved + used <= limit"
        timestamptz expires_at
        timestamptz updated_at
    }
    cover_records {
        uuid id PK
        uuid invoice_id FK, UK
        text invoice_number
        uuid supplier_org_id FK
        uuid buyer_org_id FK
        uuid insurer_org_id FK
        text policy_number
        text status "requested, approved, partial, declined, expired, uninsured"
        text gateway "manual, api, file"
        text currency
        numeric invoice_amount
        numeric requested_cover_pct
        numeric cover_pct
        numeric insured_amount
        numeric reserved_usd
        numeric consumed_usd
        text buyer_tier
        text decision_reason
        uuid decided_by
        timestamptz decided_at
        timestamptz requested_at
        timestamptz sla_due_at
        timestamptz valid_until
        text gateway_ref
        text claim_status
        timestamptz created_at
    }

    organisations |o--o{ terms_sets : owns
    terms_sets ||--o{ terms_versions : "versioned (immutable once active)"
    organisations ||--o{ buyer_limits : "insurer grants"
    organisations ||--o{ buyer_limits : "buyer covered"
    invoices ||--o| cover_records : "cover for"
    organisations |o--o{ cover_records : "insurer decides"
```

Unique: `terms_versions (set_id, version)`, `buyer_limits (insurer_org_id, buyer_org_id)`. Triggers `terms_versions_guard` / `terms_versions_nodelete` block edits and deletes of active or retired versions.

## 6. Marketplace — offers, financing, liens, early payment (`marketplace`)

```mermaid
erDiagram
    organisations {
        uuid id PK
    }
    invoices {
        uuid id PK
    }
    invitations {
        uuid id PK
        uuid invoice_id FK
        uuid bank_org_id FK
        uuid supplier_org_id
        uuid buyer_org_id
        text source "supplier_preferred, buyer_preferred, partner"
        text status "invited, bid, declined, closed"
        text decline_reason
        timestamptz created_at
    }
    offers {
        uuid id PK
        uuid invoice_id FK
        uuid bank_org_id FK
        uuid supplier_org_id
        uuid buyer_org_id
        text status "Drafted, Submitted, Selected, Rejected, Expired, Withdrawn, Superseded"
        text mode "manual, api"
        numeric rate_pct
        numeric advance_pct
        numeric fx_spread_pct
        numeric net_cash
        numeric net_cash_inr
        numeric all_in_pct
        text currency
        jsonb quote
        jsonb terms_version_ids "-> terms.terms_versions"
        timestamptz valid_until
        text idempotency_key "unique per bank"
        uuid created_by
        timestamptz created_at
        timestamptz updated_at
        text decision_note
    }
    financing_requests {
        uuid id PK
        uuid invoice_id FK "one live per invoice"
        uuid offer_id FK
        uuid bank_org_id FK
        uuid supplier_org_id
        uuid buyer_org_id
        text status "Created, ConsentPending, BankConfirming, Approved, DisbursementInstructed, Funded, Declined, ..."
        numeric reserved_usd
        text consent_text
        uuid consented_by
        timestamptz consented_at
        uuid decided_by
        timestamptz decided_at
        text decision_reason
        text disbursement_ref
        timestamptz funded_at
        jsonb extra
        uuid created_by
        timestamptz created_at
        timestamptz updated_at
    }
    liens {
        uuid id PK
        uuid invoice_id FK "one Reserved/Active per invoice"
        text invoice_number
        uuid financing_request_id FK
        uuid bank_org_id FK
        uuid supplier_org_id
        uuid buyer_org_id
        text status "Reserved, Active, Released"
        text assignment_ref
        timestamptz reserved_at
        timestamptz activated_at
        timestamptz released_at
        text release_reason
    }
    lien_events {
        bigserial id PK
        uuid invoice_id "-> invoices"
        text invoice_number
        uuid lien_id "-> liens"
        text event
        uuid bank_org_id
        text detail
        timestamptz at
    }
    assignment_notices {
        uuid id PK
        uuid invoice_id FK, UK
        uuid financing_request_id "-> financing_requests"
        uuid bank_org_id
        uuid supplier_org_id
        uuid buyer_org_id
        text reference UK
        text governing_law
        text body
        jsonb us_filing
        boolean sg_data_consent
        timestamptz issued_at
    }
    discount_schedules {
        uuid id PK
        uuid invoice_id FK, UK
        uuid supplier_org_id
        uuid buyer_org_id
        text mode "table, annual_rate"
        jsonb entries
        numeric annual_rate_pct
        text status "published, withdrawn, used"
        timestamptz created_at
    }
    early_payments {
        uuid id PK
        uuid invoice_id FK, UK
        uuid supplier_org_id
        uuid buyer_org_id
        date pay_date
        int days_early
        numeric discount_pct
        numeric face_amount
        numeric buyer_pays
        numeric discount_amount
        numeric annualised_cost_pct
        text funding_source "cash, bank_loan"
        uuid buyer_bank_org_id
        numeric commission
        numeric buyer_net_saving
        text payment_ref
        uuid executed_by
        timestamptz executed_at
        timestamptz settled_at
    }

    invoices ||--o{ invitations : "banks invited"
    organisations ||--o{ invitations : "bank"
    invoices ||--o{ offers : receives
    organisations ||--o{ offers : "bank quotes"
    invoices ||--o{ financing_requests : "financed via"
    offers ||--o{ financing_requests : "accepted as"
    organisations ||--o{ financing_requests : "bank"
    financing_requests ||--o{ liens : "secured by"
    invoices ||--o{ liens : "encumbered by"
    organisations ||--o{ liens : "bank holds"
    liens |o..o{ lien_events : "log"
    invoices ||--o| assignment_notices : "assigned by"
    financing_requests |o..o| assignment_notices : "issues"
    invoices ||--o| discount_schedules : "buyer offers"
    invoices ||--o| early_payments : "paid early"
```

Unique: `invitations (invoice_id, bank_org_id)`. Partial unique indexes enforce at most one live `financing_requests` row and one `Reserved`/`Active` lien per invoice.

## 7. Settlement — disbursement, collection, reconciliation (`settlement`)

```mermaid
erDiagram
    organisations {
        uuid id PK
    }
    invoices {
        uuid id PK
    }
    financing_requests {
        uuid id PK
    }
    collection_accounts {
        uuid id PK
        uuid bank_org_id FK
        text currency "USD, SGD"
        text account_number
        text account_name
        text swift
    }
    disbursements {
        uuid id PK
        uuid financing_request_id FK, UK
        uuid invoice_id FK
        text invoice_number
        uuid bank_org_id
        uuid supplier_org_id
        text reference UK
        text status "Instructed, FXBooked, QueuedForValueDate, Sent, Credited, Failed, Retry, Reversed, Returned"
        text currency
        numeric amount_foreign
        text fx_pair
        numeric fx_mid
        numeric fx_spread_pct
        numeric fx_rate
        numeric amount_inr
        date value_date
        boolean cutoff_missed
        int attempts
        text gateway_ref
        text failure_reason
        timestamptz instructed_at
        timestamptz sent_at
        timestamptz credited_at
        timestamptz updated_at
    }
    disbursement_events {
        bigserial id PK
        uuid disbursement_id FK
        uuid bank_org_id
        uuid supplier_org_id
        text status
        text note
        timestamptz at
    }
    expectations {
        uuid id PK
        uuid invoice_id FK, UK
        text invoice_number
        text reference UK
        uuid bank_org_id
        uuid supplier_org_id
        uuid buyer_org_id
        uuid collection_account_id FK
        text currency
        numeric expected_amount
        numeric advance_amount
        numeric retention_amount
        numeric fx_spread_pct
        numeric platform_fee_note
        date due_date
        text status "Expected, PartiallyReceived, Received, Matched, Distributed, Reconciled, Exception"
        numeric received_amount
        timestamptz received_at
        boolean late
        timestamptz created_at
        timestamptz updated_at
    }
    bank_transactions {
        uuid id PK
        uuid bank_org_id
        text source "callback, statement"
        text bank_txn_id
        text reference
        text currency
        numeric amount
        date value_date
        text payer
        uuid expectation_id FK
        text match_status "unmatched, matched, exception"
        timestamptz created_at
    }
    ledger_entries {
        bigserial id PK
        uuid invoice_id "-> invoices"
        text invoice_number
        uuid bank_org_id
        uuid supplier_org_id
        uuid buyer_org_id
        text kind
        text party
        text currency
        numeric amount
        numeric amount_inr
        numeric fx_rate
        text note
        timestamptz at
    }
    exceptions {
        uuid id PK
        text type "Unmatched, ShortPaid, OverPaid, Late, AmountMismatch, DisbursementFailed, DisbursementReturned"
        uuid bank_org_id
        uuid invoice_id "-> invoices"
        text invoice_number
        uuid expectation_id "-> expectations"
        uuid bank_txn_id "-> bank_transactions"
        uuid disbursement_id "-> disbursements"
        numeric amount
        text currency
        text detail
        text status "open, resolved"
        text resolution
        uuid resolved_by
        timestamptz resolved_at
        timestamptz created_at
    }
    export_proceeds {
        uuid id PK
        uuid invoice_id UK "-> invoices"
        text invoice_number
        uuid supplier_org_id
        uuid buyer_org_id
        uuid ad_bank_org_id
        text currency
        numeric amount_foreign
        date shipment_date
        date realisation_deadline
        text status "Pending, Realised, Reported, Overdue"
        numeric realised_inr
        timestamptz realised_at
        timestamptz reported_at
        uuid reported_by
        boolean chain_broken
        text chain_note
        timestamptz created_at
        timestamptz updated_at
    }
    sim_bank_feed {
        bigserial id PK
        uuid bank_org_id
        text bank_txn_id UK
        text reference
        text currency
        numeric amount
        date value_date
        text payer
        timestamptz created_at
    }

    organisations ||--o{ collection_accounts : "bank operates"
    financing_requests ||--o| disbursements : "paid out by"
    invoices ||--o{ disbursements : "advance for"
    disbursements ||--o{ disbursement_events : "status log"
    invoices ||--o| expectations : "repayment due"
    collection_accounts ||--o{ expectations : "collects into"
    expectations |o--o{ bank_transactions : "matched"
    invoices ||..o{ ledger_entries : "money movements"
    expectations |o..o{ exceptions : raises
    bank_transactions |o..o{ exceptions : raises
    disbursements |o..o{ exceptions : raises
    invoices ||..o| export_proceeds : "FEMA realisation"
```

Unique: `collection_accounts (bank_org_id, currency)`, `bank_transactions (bank_org_id, source, bank_txn_id)`. `sim_bank_feed` is the simulated bank statement source read by the `Sim*` adapter; it has no links.

## 8. Recovery — defaults, claims, recourse (`recovery`)

All invoice/org references in this schema are logical (no FKs); only the two child tables are constrained.

```mermaid
erDiagram
    invoices {
        uuid id PK
    }
    defaults {
        uuid id PK
        uuid invoice_id UK "-> invoices"
        text invoice_number
        uuid supplier_org_id
        uuid buyer_org_id
        uuid bank_org_id
        uuid insurer_org_id
        text currency
        numeric principal
        numeric financing_rate_pct
        date due_date
        date overdue_since
        text status "Overdue, WaitingPeriod, ClaimEligible, ClaimFiled, Paid, ClaimLapsed, Recovered"
        int waiting_days
        date waiting_ends_on
        date claim_deadline_on
        boolean insolvency
        timestamptz insolvency_at
        int dunning_level
        timestamptz frozen_since
        numeric frozen_days
        timestamptz created_at
        timestamptz updated_at
    }
    dunning_events {
        bigserial id PK
        uuid invoice_id "-> invoices"
        uuid buyer_org_id
        uuid bank_org_id
        int level
        int days_overdue
        timestamptz at
    }
    claims {
        uuid id PK
        uuid invoice_id UK "-> invoices"
        text invoice_number
        uuid bank_org_id
        uuid insurer_org_id
        uuid supplier_org_id
        uuid buyer_org_id
        text currency
        numeric face_amount
        numeric advance_amount
        numeric cover_pct
        numeric claimed_amount
        text status "Filed, UnderReview, Approved, PartiallyApproved, Rejected, Paid"
        jsonb documents
        jsonb exclusions
        numeric approved_amount
        text decision_reason
        jsonb waterfall
        jsonb extra
        uuid filed_by
        uuid decided_by
        timestamptz filed_at
        timestamptz decided_at
        timestamptz paid_at
    }
    recoveries {
        uuid id PK
        uuid claim_id FK
        uuid invoice_id
        uuid bank_org_id
        uuid insurer_org_id
        uuid supplier_org_id
        text currency
        numeric gross
        numeric costs
        numeric net
        jsonb shares
        text note
        uuid recorded_by
        timestamptz at
    }
    recourse {
        uuid id PK
        uuid invoice_id "-> invoices"
        text invoice_number
        uuid supplier_org_id
        uuid bank_org_id
        text currency
        text cause
        numeric amount_owed
        numeric outstanding
        boolean small_supplier
        text mode "offset_20pct, plan_90d, bank_terms"
        jsonb plan
        text status "open, settled"
        text note
        timestamptz created_at
        timestamptz updated_at
    }
    recourse_payments {
        bigserial id PK
        uuid recourse_id FK
        uuid supplier_org_id
        uuid bank_org_id
        numeric amount
        text source "offset, installment, manual"
        text note
        timestamptz at
    }

    invoices ||..o| defaults : "goes overdue"
    invoices ||..o{ dunning_events : "reminders (one per level)"
    invoices ||..o| claims : "insured loss"
    claims ||--o{ recoveries : "post-claim recoveries"
    invoices ||..o{ recourse : "supplier owes bank"
    recourse ||--o{ recourse_payments : "repaid by"
```

Unique: `dunning_events (invoice_id, level)`.

## 9. Platform, audit, notifications, integration, analytics

```mermaid
erDiagram
    organisations {
        uuid id PK
    }
    audit_events {
        bigserial seq PK
        uuid id
        uuid org_id
        uuid actor_user_id
        text actor_label
        text action
        text entity_type
        text entity_id
        jsonb before
        jsonb after
        text correlation_id
        timestamptz occurred_at
        text prev_hash
        text hash "hash chain"
    }
    audit_chain_head {
        int id PK "always 1"
        text head_hash
        bigint last_seq
    }
    audit_anchors {
        bigserial id PK
        timestamptz anchored_at
        text head_hash
        bigint last_seq
        text token
    }
    outbox {
        bigserial id PK
        text topic
        jsonb payload
        uuid_array org_ids
        timestamptz created_at
        timestamptz processed_at
        int attempts
        text last_error
    }
    notifications {
        uuid id PK
        uuid recipient_org_id
        text topic
        text channel "in_app, email, sms, whatsapp"
        text status "queued, sent, delivered, failed"
        text lang
        text subject
        text body
        jsonb payload
        bigint outbox_id "-> outbox"
        timestamptz created_at
        timestamptz read_at
    }
    settings {
        text key PK
        jsonb value
        timestamptz updated_at
    }
    setting_changes {
        uuid id PK
        text key "-> settings"
        jsonb before
        jsonb after
        text status "pending, applied, rejected, withdrawn"
        text note
        uuid proposed_by
        timestamptz proposed_at
        uuid decided_by "maker-checker: != proposed_by"
        timestamptz decided_at
        text decision_note
    }
    idempotency_keys {
        text scope PK
        text key PK
        jsonb response
        timestamptz created_at
    }
    integration_messages {
        bigserial id PK
        text adapter
        text direction "request, response, callback"
        text reference
        jsonb payload
        timestamptz created_at
    }
    webhook_nonces {
        text nonce PK
        uuid bank_org_id
        timestamptz received_at
    }
    api_keys {
        uuid id PK
        uuid org_id
        text label
        text key_prefix UK
        text secret_hash
        text signing_secret
        text status "active, rotating, revoked"
        timestamptz expires_at
        timestamptz created_at
        uuid created_by
        timestamptz last_used_at
    }
    webhooks {
        uuid id PK
        uuid org_id
        text url
        text_array events
        boolean active
        timestamptz created_at
    }
    webhook_deliveries {
        bigserial id PK
        uuid webhook_id FK
        uuid org_id
        text event_type
        jsonb payload
        text status "pending, delivered, failed"
        int attempts
        text last_error
        timestamptz created_at
    }
    file_batches {
        uuid id PK
        uuid org_id
        text kind "offers_in, statement_in, instructions_out"
        text filename
        int rows_total
        int rows_ok
        jsonb errors
        text content
        timestamptz created_at
    }
    snapshots {
        text key PK
        text kind
        uuid org_id
        jsonb data
        timestamptz computed_at
    }

    audit_chain_head ||..|| audit_events : "points at last"
    audit_anchors }o..|| audit_events : "anchors up to seq"
    organisations ||..o{ audit_events : "scoped to"
    outbox ||..o{ notifications : "fans out to"
    organisations ||..o{ notifications : receives
    settings ||..o{ setting_changes : "changed via"
    organisations ||..o{ api_keys : owns
    organisations ||..o{ webhooks : registers
    webhooks ||--o{ webhook_deliveries : delivers
    organisations ||..o{ file_batches : uploads
```

Schemas: `audit_events`, `audit_chain_head`, `audit_anchors` are `audit.events`, `audit.chain_head`, `audit.anchors`. `outbox`, `settings`, `setting_changes`, `idempotency_keys`, `integration_messages`, `webhook_nonces` are in `platform`. `notifications` is `notify.notifications` (unique on `outbox_id, recipient_org_id, channel`). `api_keys`, `webhooks`, `webhook_deliveries`, `file_batches` are in `integration`; `snapshots` is `analytics.snapshots`.
