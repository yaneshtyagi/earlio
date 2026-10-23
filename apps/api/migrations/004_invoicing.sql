create table invoicing.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  number text not null,
  currency text not null check (currency in ('USD','SGD')),
  amount numeric(20,2) not null check (amount > 0),
  description text,
  created_at timestamptz not null,
  unique (supplier_org_id, buyer_org_id, number)
);
alter table invoicing.purchase_orders enable row level security;
create policy po_select on invoicing.purchase_orders for select
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy po_insert on invoicing.purchase_orders for insert with check (supplier_org_id = app.org_id() or app.is_platform());

create sequence invoicing.invoice_seq start 1014;

create table invoicing.invoices (
  id uuid primary key default gen_random_uuid(),
  human_id text not null unique,
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  po_id uuid references invoicing.purchase_orders(id),
  number text not null,
  currency text not null check (currency in ('USD','SGD')),
  gross_amount numeric(20,2) not null check (gross_amount > 0),
  accepted_amount numeric(20,2),
  issue_date date not null,
  due_date date not null check (due_date > issue_date),
  shipment_date date,
  status text not null default 'Draft' check (status in
    ('Draft','Submitted','Rejected','Accepted','NotEligible','OpenForFunding','OffersReceived','Funded','Settled','Disputed','Overdue','Defaulted','Closed','Cancelled')),
  status_before_dispute text,
  route text check (route in ('financing','early_payment')),
  irn text,
  cover_status text not null default 'none',
  screening_status text not null default 'not_screened',
  dispute_flag boolean not null default false,
  warnings jsonb not null default '[]'::jsonb,
  fingerprint text not null,
  submitted_at timestamptz,
  accepted_at timestamptz,
  dispute_window_ends_at timestamptz,
  reminder_count int not null default 0,
  created_by uuid,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (supplier_org_id <> buyer_org_id)
);
-- Duplicate detection (IN-1): same supplier, number, amount and issue date.
create unique index invoices_fingerprint on invoicing.invoices (fingerprint) where status <> 'Cancelled';
create index on invoicing.invoices (supplier_org_id, status);
create index on invoicing.invoices (buyer_org_id, status);
alter table invoicing.invoices enable row level security;
-- Banks get read access in M6 through invitations; until then only the two parties and platform staff.
-- The buyer never sees a supplier's drafts or cancelled drafts.
create policy inv_select on invoicing.invoices for select
  using (supplier_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and status not in ('Draft','Cancelled')));
create policy inv_insert on invoicing.invoices for insert with check (supplier_org_id = app.org_id() or app.is_platform());
create policy inv_update on invoicing.invoices for update
  using (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());

create table invoicing.invoice_documents (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  doc_type text not null check (doc_type in ('commercial_invoice','packing_list','shipping_bill','transport_document','delivery_proof','credit_note')),
  version int not null,
  file_id uuid not null references platform.files(id),
  filename text not null,
  sha256 text not null,
  uploaded_by uuid,
  created_at timestamptz not null,
  unique (invoice_id, doc_type, version)
);
alter table invoicing.invoice_documents enable row level security;
create policy invdoc_select on invoicing.invoice_documents for select
  using (supplier_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and exists (select 1 from invoicing.invoices i where i.id = invoice_id)));
create policy invdoc_insert on invoicing.invoice_documents for insert with check (supplier_org_id = app.org_id() or app.is_platform());

create table invoicing.acceptances (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  decision text not null check (decision in ('accepted','partial','rejected')),
  accepted_amount numeric(20,2),
  reason text,
  undertaking_text text,
  undertaking_signed_at timestamptz,
  decided_by uuid not null,
  decided_at timestamptz not null,
  assignment_ack_at timestamptz,
  assignment_ack_by uuid
);
alter table invoicing.acceptances enable row level security;
create policy acc_select on invoicing.acceptances for select
  using (supplier_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and exists (select 1 from invoicing.invoices i where i.id = invoice_id)));
create policy acc_insert on invoicing.acceptances for insert with check (buyer_org_id = app.org_id() or app.is_platform());
create policy acc_update on invoicing.acceptances for update using (buyer_org_id = app.org_id() or app.is_platform());

create table invoicing.disputes (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoicing.invoices(id),
  supplier_org_id uuid not null references identity.organisations(id),
  buyer_org_id uuid not null references identity.organisations(id),
  kind text not null default 'dispute' check (kind in ('dispute','partial_remainder')),
  freezes boolean not null default true,
  raised_by_org uuid not null,
  raised_by_user uuid,
  reason text not null,
  status text not null default 'Open' check (status in ('Open','UnderReview','ResolvedForBuyer','ResolvedForSupplier','Escalated','TimedOut')),
  attributable_party text,
  outcome text,
  amount numeric(20,2),
  created_at timestamptz not null,
  resolved_at timestamptz
);
alter table invoicing.disputes enable row level security;
create policy disp_select on invoicing.disputes for select
  using (supplier_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and exists (select 1 from invoicing.invoices i where i.id = invoice_id)));
create policy disp_insert on invoicing.disputes for insert
  with check (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy disp_update on invoicing.disputes for update using (app.is_platform());

-- Status history: powers the invoice timeline (SH-04).
create table invoicing.invoice_history (
  id bigserial primary key,
  invoice_id uuid not null references invoicing.invoices(id),
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  from_status text,
  to_status text not null,
  actor_user uuid,
  actor_org uuid,
  note text,
  at timestamptz not null
);
create index on invoicing.invoice_history (invoice_id, id);
alter table invoicing.invoice_history enable row level security;
create policy hist_select on invoicing.invoice_history for select
  using (supplier_org_id = app.org_id() or app.is_platform()
         or (buyer_org_id = app.org_id() and exists (select 1 from invoicing.invoices i where i.id = invoice_id)));
create policy hist_insert on invoicing.invoice_history for insert
  with check (supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
