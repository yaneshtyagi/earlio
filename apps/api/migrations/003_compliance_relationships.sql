-- Files (object metadata). Bytes live in the object store adapter.
create table platform.files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references identity.organisations(id),
  filename text not null,
  content_type text not null,
  size bigint not null,
  sha256 text not null,
  storage_key text not null,
  scan_status text not null default 'clean' check (scan_status in ('clean','infected','pending')),
  uploaded_by uuid,
  shared_with uuid[] not null default '{}',
  created_at timestamptz not null
);
alter table platform.files enable row level security;
create policy files_select on platform.files for select
  using (org_id = app.org_id() or app.org_id() = any(shared_with) or app.is_platform());
create policy files_insert on platform.files for insert with check (org_id = app.org_id() or app.is_platform());
create policy files_update on platform.files for update using (org_id = app.org_id() or app.is_platform());

create table compliance.kyc_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references identity.organisations(id),
  status text not null default 'draft' check (status in ('draft','submitted','in_review','referred','approved','rejected')),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid,
  decision_reason text,
  provider_result jsonb,
  created_at timestamptz not null
);
create unique index kyc_one_open_case on compliance.kyc_cases (org_id) where status in ('draft','submitted','in_review','referred');
alter table compliance.kyc_cases enable row level security;
create policy kyc_all on compliance.kyc_cases for all
  using (org_id = app.org_id() or app.is_platform()) with check (org_id = app.org_id() or app.is_platform());

create table compliance.kyc_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references compliance.kyc_cases(id),
  org_id uuid not null references identity.organisations(id),
  doc_type text not null,
  file_id uuid not null references platform.files(id),
  created_at timestamptz not null
);
alter table compliance.kyc_documents enable row level security;
create policy kycdoc_all on compliance.kyc_documents for all
  using (org_id = app.org_id() or app.is_platform()) with check (org_id = app.org_id() or app.is_platform());

create table compliance.screening_results (
  id uuid primary key default gen_random_uuid(),
  subject_org_id uuid references identity.organisations(id),
  subject_name text not null,
  invoice_id uuid,
  list_version text not null,
  matches jsonb not null default '[]'::jsonb,
  top_score numeric(5,4) not null default 0,
  outcome text not null check (outcome in ('clear','hit','false_positive','confirmed')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null
);
create index on compliance.screening_results (subject_org_id);
alter table compliance.screening_results enable row level security;
-- Screening detail is platform-only; organisations see only their status flags.
create policy screening_platform on compliance.screening_results for all using (app.is_platform()) with check (true);
create policy screening_insert_any on compliance.screening_results for insert with check (true);

create table compliance.sanctions_whitelist (
  org_id uuid not null references identity.organisations(id),
  entry text not null,
  reason text not null,
  created_at timestamptz not null,
  primary key (org_id, entry)
);
alter table compliance.sanctions_whitelist enable row level security;
create policy wl_platform on compliance.sanctions_whitelist for all using (app.is_platform()) with check (app.is_platform());
create policy wl_read on compliance.sanctions_whitelist for select using (true);

-- Supplier-buyer relationships (ON-3): both sides' approvers must approve.
create table identity.relationships (
  id uuid primary key default gen_random_uuid(),
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  status text not null default 'pending' check (status in ('pending','active','suspended')),
  proposed_by_org_id uuid not null references identity.organisations(id),
  proposed_by_user uuid,
  supplier_approved_by uuid,
  supplier_approved_at timestamptz,
  buyer_approved_by uuid,
  buyer_approved_at timestamptz,
  created_at timestamptz not null,
  unique (supplier_org_id, buyer_org_id)
);
alter table identity.relationships enable row level security;
create policy rel_select on identity.relationships for select
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy rel_insert on identity.relationships for insert
  with check (proposed_by_org_id = app.org_id() or app.is_platform());
create policy rel_update on identity.relationships for update
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());

create table identity.org_preferred_banks (
  org_id uuid not null references identity.organisations(id),
  bank_org_id uuid not null references identity.organisations(id),
  created_at timestamptz not null,
  primary key (org_id, bank_org_id)
);
alter table identity.org_preferred_banks enable row level security;
-- Banks need to know who prefers them (to be invited), and orgs manage their own list.
create policy pref_select on identity.org_preferred_banks for select using (true);
create policy pref_write on identity.org_preferred_banks for all
  using (org_id = app.org_id() or app.is_platform()) with check (org_id = app.org_id() or app.is_platform());

-- Bank exposure limits (ON-4). Amounts are USD-equivalent. reserved on selection, used on funding.
create table identity.bank_limits (
  id uuid primary key default gen_random_uuid(),
  bank_org_id uuid not null references identity.organisations(id),
  subject_org_id uuid not null references identity.organisations(id),
  kind text not null check (kind in ('buyer','supplier')),
  limit_usd numeric(20,2) not null check (limit_usd >= 0),
  reserved_usd numeric(20,2) not null default 0 check (reserved_usd >= 0),
  used_usd numeric(20,2) not null default 0 check (used_usd >= 0),
  updated_at timestamptz not null,
  unique (bank_org_id, subject_org_id, kind),
  check (reserved_usd + used_usd <= limit_usd)
);
alter table identity.bank_limits enable row level security;
create policy limits_all on identity.bank_limits for all
  using (bank_org_id = app.org_id() or app.is_platform()) with check (bank_org_id = app.org_id() or app.is_platform());
