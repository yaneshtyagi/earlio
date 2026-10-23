create table identity.organisations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('supplier','buyer','bank','insurer','platform')),
  legal_name text not null,
  country text not null,
  small boolean not null default false,
  msme boolean not null default false,
  turnover_inr numeric(20,2),
  rating_tier text check (rating_tier in ('AA','A','BBB')),
  data_region text not null default 'IN',
  branding jsonb not null default '{}'::jsonb,
  hostname text unique,
  is_partner boolean not null default false,
  kyc_status text not null default 'not_started',
  sanctions_status text not null default 'not_screened',
  blocked boolean not null default false,
  borrowing_rate numeric(7,4),
  created_at timestamptz not null
);
alter table identity.organisations enable row level security;
-- Counterparty names must be visible; sensitive columns are filtered by the API projection.
create policy org_select on identity.organisations for select using (true);
create policy org_insert on identity.organisations for insert with check (true);
create policy org_update on identity.organisations for update
  using (id = app.org_id() or app.is_platform()) with check (id = app.org_id() or app.is_platform());

create table identity.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  mfa_secret text,
  mfa_enabled boolean not null default false,
  recovery_codes jsonb not null default '[]'::jsonb,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null
);

create table identity.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references identity.users(id),
  org_id uuid not null references identity.organisations(id),
  role text not null check (role in ('Admin','FinanceUser','Approver','Viewer','CreditOfficer','Operations',
    'RelationshipManager','Underwriter','ClaimsHandler','PlatformAdmin','Auditor')),
  created_at timestamptz not null,
  unique (user_id, org_id)
);
alter table identity.memberships enable row level security;
create policy mem_all on identity.memberships for all
  using (org_id = app.org_id() or user_id = app.user_id() or app.is_platform())
  with check (org_id = app.org_id() or app.is_platform());

create table identity.sessions (
  id text primary key,               -- sha256 of the cookie token
  user_id uuid not null references identity.users(id),
  org_id uuid references identity.organisations(id),
  mfa_verified boolean not null default false,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null
);
