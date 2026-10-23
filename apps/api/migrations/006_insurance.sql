alter table platform.outbox add column if not exists last_error text;
alter table identity.relationships add column if not exists insurer_org_id uuid references identity.organisations(id);

create table insurance.buyer_limits (
  id uuid primary key default gen_random_uuid(),
  insurer_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  policy_number text not null,
  limit_usd numeric(20,2) not null check (limit_usd >= 0),
  reserved_usd numeric(20,2) not null default 0 check (reserved_usd >= 0),
  used_usd numeric(20,2) not null default 0 check (used_usd >= 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null,
  unique (insurer_org_id, buyer_org_id),
  check (reserved_usd + used_usd <= limit_usd)
);
alter table insurance.buyer_limits enable row level security;
create policy blim_all on insurance.buyer_limits for all
  using (insurer_org_id = app.org_id() or app.is_platform()) with check (insurer_org_id = app.org_id() or app.is_platform());

create table insurance.cover_records (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references invoicing.invoices(id),
  invoice_number text not null,
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  insurer_org_id uuid references identity.organisations(id),
  policy_number text,
  status text not null check (status in ('requested','approved','partial','declined','expired','uninsured')),
  gateway text not null default 'manual' check (gateway in ('manual','api','file')),
  currency text not null,
  invoice_amount numeric(20,2) not null,
  requested_cover_pct numeric(6,3),
  cover_pct numeric(6,3),
  insured_amount numeric(20,2),
  reserved_usd numeric(20,2) not null default 0,
  consumed_usd numeric(20,2) not null default 0,
  buyer_tier text,
  decision_reason text,
  decided_by uuid,
  decided_at timestamptz,
  requested_at timestamptz not null,
  sla_due_at timestamptz,
  valid_until timestamptz,
  gateway_ref text,
  claim_status text not null default 'none',
  created_at timestamptz not null
);
create index on insurance.cover_records (insurer_org_id, status);
alter table insurance.cover_records enable row level security;
create policy cover_select on insurance.cover_records for select
  using (insurer_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy cover_insert on insurance.cover_records for insert with check (app.is_platform());
create policy cover_update on insurance.cover_records for update using (insurer_org_id = app.org_id() or app.is_platform());
