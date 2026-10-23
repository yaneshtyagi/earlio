-- Invitations: a bank sees an invoice only if invited (or has bid). Policy references no other table, so invoices can reference it safely.
create table marketplace.invitations (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  bank_org_id uuid not null references identity.organisations(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  source text not null check (source in ('supplier_preferred','buyer_preferred','partner')),
  status text not null default 'invited' check (status in ('invited','bid','declined','closed')),
  decline_reason text,
  created_at timestamptz not null,
  unique (invoice_id, bank_org_id)
);
alter table marketplace.invitations enable row level security;
create policy inv_all_select on marketplace.invitations for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy inv_all_insert on marketplace.invitations for insert with check (supplier_org_id = app.org_id() or app.is_platform());
create policy inv_all_update on marketplace.invitations for update using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());

-- Banks read invoices they were invited to, plus their evidence.
drop policy inv_select on invoicing.invoices;
create policy inv_select on invoicing.invoices for select
  using (supplier_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and status not in ('Draft','Cancelled'))
         or exists (select 1 from marketplace.invitations m where m.invoice_id = invoices.id and m.bank_org_id = app.org_id()));
create policy invdoc_bank on invoicing.invoice_documents for select
  using (exists (select 1 from marketplace.invitations m where m.invoice_id = invoice_documents.invoice_id and m.bank_org_id = app.org_id()));
create policy acc_bank on invoicing.acceptances for select
  using (exists (select 1 from marketplace.invitations m where m.invoice_id = acceptances.invoice_id and m.bank_org_id = app.org_id()));
create policy hist_bank on invoicing.invoice_history for select
  using (exists (select 1 from marketplace.invitations m where m.invoice_id = invoice_history.invoice_id and m.bank_org_id = app.org_id()));
create policy cover_bank on insurance.cover_records for select
  using (exists (select 1 from marketplace.invitations m where m.invoice_id = cover_records.invoice_id and m.bank_org_id = app.org_id()));

create table marketplace.offers (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  bank_org_id uuid not null references identity.organisations(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  status text not null check (status in ('Drafted','Submitted','Selected','Rejected','Expired','Withdrawn','Superseded')),
  mode text not null default 'manual' check (mode in ('manual','api')),
  rate_pct numeric(8,4) not null,
  advance_pct numeric(8,4) not null,
  fx_spread_pct numeric(8,4) not null,
  net_cash numeric(20,2) not null,
  net_cash_inr numeric(20,2) not null,
  all_in_pct numeric(8,2) not null,
  currency text not null,
  quote jsonb not null,
  terms_version_ids jsonb not null default '[]'::jsonb,
  valid_until timestamptz not null,
  idempotency_key text,
  created_by uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  decision_note text
);
create index on marketplace.offers (invoice_id, status);
create unique index offers_idem on marketplace.offers (bank_org_id, idempotency_key) where idempotency_key is not null;
alter table marketplace.offers enable row level security;
-- The supplier sees submitted-onward offers (never a bank's drafts); the buyer sees none (rates are between supplier and bank).
create policy offer_select on marketplace.offers for select
  using (bank_org_id = app.org_id() or app.is_platform() or (supplier_org_id = app.org_id() and status <> 'Drafted'));
create policy offer_insert on marketplace.offers for insert with check (bank_org_id = app.org_id() or app.is_platform());
create policy offer_update on marketplace.offers for update
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());

create table marketplace.financing_requests (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  offer_id uuid not null references marketplace.offers(id),
  bank_org_id uuid not null references identity.organisations(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  status text not null check (status in ('Created','ConsentPending','BankConfirming','Approved','DisbursementInstructed','Funded','Declined','Cancelled','LienConflict','Failed')),
  reserved_usd numeric(20,2) not null default 0,
  consent_text text,
  consented_by uuid,
  consented_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  disbursement_ref text,
  funded_at timestamptz,
  created_by uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on marketplace.financing_requests (invoice_id, status);
-- At most one live financing request per invoice (A-19: one funding bank, one financing).
create unique index fr_one_live on marketplace.financing_requests (invoice_id)
  where status in ('Created','ConsentPending','BankConfirming','Approved','DisbursementInstructed','Funded');
alter table marketplace.financing_requests enable row level security;
create policy fr_select on marketplace.financing_requests for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy fr_insert on marketplace.financing_requests for insert with check (supplier_org_id = app.org_id() or app.is_platform());
create policy fr_update on marketplace.financing_requests for update
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());

-- Lien registry (ST-1, BR-14).
create table marketplace.liens (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  invoice_number text not null,
  financing_request_id uuid not null references marketplace.financing_requests(id),
  bank_org_id uuid not null references identity.organisations(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  status text not null check (status in ('Reserved','Active','Released')),
  assignment_ref text,
  reserved_at timestamptz not null,
  activated_at timestamptz,
  released_at timestamptz,
  release_reason text
);
-- BR-14: unique invoice id; only one lien may be Reserved or Active at a time.
create unique index lien_one_live on marketplace.liens (invoice_id) where status in ('Reserved','Active');
alter table marketplace.liens enable row level security;
create policy lien_select on marketplace.liens for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy lien_write on marketplace.liens for all using (app.is_platform()) with check (app.is_platform());

create table marketplace.lien_events (
  id bigserial primary key,
  invoice_id uuid not null,
  invoice_number text,
  lien_id uuid,
  event text not null,
  bank_org_id uuid,
  detail text,
  at timestamptz not null
);
alter table marketplace.lien_events enable row level security;
create policy lev_select on marketplace.lien_events for select using (app.is_platform());
create policy lev_insert on marketplace.lien_events for insert with check (true);

-- Assignment notice (XB-8): generated at consent, acknowledged by the buyer.
create table marketplace.assignment_notices (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references invoicing.invoices(id),
  financing_request_id uuid,
  bank_org_id uuid not null,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  reference text not null unique,
  governing_law text not null,
  body text not null,
  us_filing jsonb,
  sg_data_consent boolean,
  issued_at timestamptz not null
);
alter table marketplace.assignment_notices enable row level security;
create policy an_select on marketplace.assignment_notices for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy an_write on marketplace.assignment_notices for all using (app.is_platform() or supplier_org_id = app.org_id()) with check (app.is_platform() or supplier_org_id = app.org_id());

-- Early-payment route (FM-4).
create table marketplace.discount_schedules (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references invoicing.invoices(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  mode text not null check (mode in ('table','annual_rate')),
  entries jsonb,
  annual_rate_pct numeric(8,4),
  status text not null default 'published' check (status in ('published','withdrawn','used')),
  created_at timestamptz not null
);
alter table marketplace.discount_schedules enable row level security;
create policy ds_select on marketplace.discount_schedules for select using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy ds_write on marketplace.discount_schedules for all using (supplier_org_id = app.org_id() or app.is_platform()) with check (supplier_org_id = app.org_id() or app.is_platform());

create table marketplace.early_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references invoicing.invoices(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  pay_date date not null,
  days_early int not null,
  discount_pct numeric(8,4) not null,
  face_amount numeric(20,2) not null,
  buyer_pays numeric(20,2) not null,
  discount_amount numeric(20,2) not null,
  annualised_cost_pct numeric(8,2) not null,
  funding_source text not null check (funding_source in ('cash','bank_loan')),
  buyer_bank_org_id uuid,
  commission numeric(20,2) not null default 0,
  buyer_net_saving numeric(20,2) not null,
  payment_ref text,
  executed_by uuid,
  executed_at timestamptz not null
);
alter table marketplace.early_payments enable row level security;
create policy ep_select on marketplace.early_payments for select
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or buyer_bank_org_id = app.org_id() or app.is_platform());
create policy ep_insert on marketplace.early_payments for insert with check (buyer_org_id = app.org_id() or app.is_platform());
