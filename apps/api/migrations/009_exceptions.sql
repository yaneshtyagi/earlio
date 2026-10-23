create schema if not exists recovery;

-- ---------------------------------------------------------------- disputes (workflow, timers, thread)
alter table invoicing.disputes
  add column phase text not null default 'window' check (phase in ('window','post_acceptance','post_funding')),
  add column frozen_status text,
  add column bank_org_id uuid,
  add column response_due_at timestamptz,
  add column escalate_at timestamptz,
  add column timeout_at timestamptz,
  add column cause text,
  add column decision_note text,
  add column decided_by uuid,
  add column decided_at timestamptz,
  add column credit_amount numeric(20,2);
drop policy disp_select on invoicing.disputes;
create policy disp_select on invoicing.disputes for select
  using (supplier_org_id = app.org_id() or bank_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and exists (select 1 from invoicing.invoices i where i.id = invoice_id)));

create table invoicing.dispute_messages (
  id bigserial primary key,
  dispute_id uuid not null references invoicing.disputes(id),
  invoice_id uuid not null,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  bank_org_id uuid,
  author_org_id uuid,
  author_name text not null,
  author_user uuid,
  kind text not null check (kind in ('message','evidence','system')),
  body text not null,
  file_id uuid,
  created_at timestamptz not null
);
create index on invoicing.dispute_messages (dispute_id, id);
alter table invoicing.dispute_messages enable row level security;
create policy dm_select on invoicing.dispute_messages for select
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or bank_org_id = app.org_id() or app.is_platform());
create policy dm_insert on invoicing.dispute_messages for insert with check (true);

create table invoicing.credit_notes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  invoice_number text not null,
  number text not null unique,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  bank_org_id uuid,
  stage text not null check (stage in ('pre_funding','post_funding')),
  currency text not null,
  amount numeric(20,2) not null check (amount > 0),
  prior_amount numeric(20,2) not null,
  new_amount numeric(20,2) not null,
  supplier_owes numeric(20,2) not null default 0,
  reason text not null,
  dispute_id uuid,
  issued_by_org uuid,
  issued_by_user uuid,
  created_at timestamptz not null
);
alter table invoicing.credit_notes enable row level security;
create policy cn_select on invoicing.credit_notes for select
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or bank_org_id = app.org_id() or app.is_platform());
create policy cn_insert on invoicing.credit_notes for insert with check (true);

-- ---------------------------------------------------------------- overdue, default, claims (recovery module)
create table recovery.defaults (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique,
  invoice_number text not null,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  bank_org_id uuid not null,
  insurer_org_id uuid,
  currency text not null,
  principal numeric(20,2) not null,
  financing_rate_pct numeric(8,4) not null,
  due_date date not null,
  overdue_since date not null,
  status text not null check (status in ('Overdue','WaitingPeriod','ClaimEligible','ClaimFiled','Paid','ClaimLapsed','Recovered')),
  waiting_days int not null,
  waiting_ends_on date not null,
  claim_deadline_on date,
  insolvency boolean not null default false,
  insolvency_at timestamptz,
  dunning_level int not null default 0,
  frozen_since timestamptz,
  frozen_days numeric(10,4) not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
alter table recovery.defaults enable row level security;
create policy df_select on recovery.defaults for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or insurer_org_id = app.org_id() or app.is_platform());
create policy df_write on recovery.defaults for all using (app.is_platform()) with check (app.is_platform());

create table recovery.dunning_events (
  id bigserial primary key,
  invoice_id uuid not null,
  buyer_org_id uuid not null,
  bank_org_id uuid not null,
  level int not null,
  days_overdue int not null,
  at timestamptz not null,
  unique (invoice_id, level)
);
alter table recovery.dunning_events enable row level security;
create policy dn_select on recovery.dunning_events for select using (bank_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy dn_insert on recovery.dunning_events for insert with check (true);

create table recovery.claims (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique,
  invoice_number text not null,
  bank_org_id uuid not null,
  insurer_org_id uuid not null,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  currency text not null,
  face_amount numeric(20,2) not null,
  advance_amount numeric(20,2) not null,
  cover_pct numeric(6,2) not null,
  claimed_amount numeric(20,2) not null,
  status text not null check (status in ('Filed','UnderReview','Approved','PartiallyApproved','Rejected','Paid')),
  documents jsonb not null default '[]'::jsonb,
  exclusions jsonb not null default '[]'::jsonb,
  approved_amount numeric(20,2),
  decision_reason text,
  waterfall jsonb,
  filed_by uuid,
  decided_by uuid,
  filed_at timestamptz not null,
  decided_at timestamptz,
  paid_at timestamptz
);
alter table recovery.claims enable row level security;
create policy cl_select on recovery.claims for select
  using (bank_org_id = app.org_id() or insurer_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy cl_insert on recovery.claims for insert with check (bank_org_id = app.org_id() or app.is_platform());
create policy cl_update on recovery.claims for update using (bank_org_id = app.org_id() or insurer_org_id = app.org_id() or app.is_platform());

create table recovery.recoveries (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references recovery.claims(id),
  invoice_id uuid not null,
  bank_org_id uuid not null,
  insurer_org_id uuid not null,
  supplier_org_id uuid not null,
  currency text not null,
  gross numeric(20,2) not null,
  costs numeric(20,2) not null,
  net numeric(20,2) not null,
  shares jsonb not null,
  note text,
  recorded_by uuid,
  at timestamptz not null
);
alter table recovery.recoveries enable row level security;
create policy rc_select on recovery.recoveries for select
  using (bank_org_id = app.org_id() or insurer_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy rc_insert on recovery.recoveries for insert with check (bank_org_id = app.org_id() or app.is_platform());

-- ---------------------------------------------------------------- recourse (supplier-caused losses, credit-note differences)
create table recovery.recourse (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null,
  invoice_number text not null,
  supplier_org_id uuid not null,
  bank_org_id uuid not null,
  currency text not null,
  cause text not null,
  amount_owed numeric(20,2) not null check (amount_owed > 0),
  outstanding numeric(20,2) not null,
  small_supplier boolean not null,
  mode text not null check (mode in ('offset_20pct','plan_90d','bank_terms')),
  plan jsonb,
  status text not null default 'open' check (status in ('open','settled')),
  note text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on recovery.recourse (supplier_org_id, status);
alter table recovery.recourse enable row level security;
create policy rs_select on recovery.recourse for select using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy rs_write on recovery.recourse for all using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform()) with check (true);

create table recovery.recourse_payments (
  id bigserial primary key,
  recourse_id uuid not null references recovery.recourse(id),
  supplier_org_id uuid not null,
  bank_org_id uuid not null,
  amount numeric(20,2) not null,
  source text not null check (source in ('offset','installment','manual')),
  note text,
  at timestamptz not null
);
alter table recovery.recourse_payments enable row level security;
create policy rp_select on recovery.recourse_payments for select using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy rp_insert on recovery.recourse_payments for insert with check (true);

-- ---------------------------------------------------------------- export proceeds (XB-6)
create table settlement.export_proceeds (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique,
  invoice_number text not null,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  ad_bank_org_id uuid,
  currency text not null,
  amount_foreign numeric(20,2) not null,
  shipment_date date not null,
  realisation_deadline date not null,
  status text not null default 'Pending' check (status in ('Pending','Realised','Reported','Overdue')),
  realised_inr numeric(20,2) not null default 0,
  realised_at timestamptz,
  reported_at timestamptz,
  reported_by uuid,
  chain_broken boolean not null default false,
  chain_note text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
alter table settlement.export_proceeds enable row level security;
create policy ep_select on settlement.export_proceeds for select using (supplier_org_id = app.org_id() or ad_bank_org_id = app.org_id() or app.is_platform());
create policy ep_write on settlement.export_proceeds for all using (app.is_platform()) with check (app.is_platform());
