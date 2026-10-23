-- Replay protection for signed bank webhooks.
create table platform.webhook_nonces (
  nonce text primary key,
  bank_org_id uuid not null,
  received_at timestamptz not null
);

-- Collection accounts are bank-held; the platform shows instructions and ledgers only (A-12).
create table settlement.collection_accounts (
  id uuid primary key default gen_random_uuid(),
  bank_org_id uuid not null references identity.organisations(id),
  currency text not null check (currency in ('USD','SGD')),
  account_number text not null,
  account_name text not null,
  swift text not null,
  unique (bank_org_id, currency)
);
alter table settlement.collection_accounts enable row level security;
create policy ca_select on settlement.collection_accounts for select using (true);
create policy ca_write on settlement.collection_accounts for all using (app.is_platform()) with check (app.is_platform());

create table settlement.disbursements (
  id uuid primary key default gen_random_uuid(),
  financing_request_id uuid not null unique references marketplace.financing_requests(id),
  invoice_id uuid not null references invoicing.invoices(id),
  invoice_number text not null,
  bank_org_id uuid not null,
  supplier_org_id uuid not null,
  reference text not null unique,
  status text not null check (status in ('Instructed','FXBooked','QueuedForValueDate','Sent','Credited','Failed','Retry','Reversed','Returned')),
  currency text not null,
  amount_foreign numeric(20,2) not null,
  fx_pair text not null,
  fx_mid numeric(12,4) not null,
  fx_spread_pct numeric(8,4) not null,
  fx_rate numeric(12,4) not null,
  amount_inr numeric(20,2) not null,
  value_date date not null,
  cutoff_missed boolean not null default false,
  attempts int not null default 0,
  gateway_ref text,
  failure_reason text,
  instructed_at timestamptz not null,
  sent_at timestamptz,
  credited_at timestamptz,
  updated_at timestamptz not null
);
create index on settlement.disbursements (status);
alter table settlement.disbursements enable row level security;
create policy disb_select on settlement.disbursements for select using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy disb_write on settlement.disbursements for all using (bank_org_id = app.org_id() or app.is_platform()) with check (bank_org_id = app.org_id() or app.is_platform());

create table settlement.disbursement_events (
  id bigserial primary key,
  disbursement_id uuid not null references settlement.disbursements(id),
  bank_org_id uuid not null,
  supplier_org_id uuid not null,
  status text not null,
  note text,
  at timestamptz not null
);
alter table settlement.disbursement_events enable row level security;
create policy de_select on settlement.disbursement_events for select using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or app.is_platform());
create policy de_insert on settlement.disbursement_events for insert with check (true);

-- One payment reference per invoice (ST-2), issued to the buyer and its bank.
create table settlement.expectations (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references invoicing.invoices(id),
  invoice_number text not null,
  reference text not null unique,
  bank_org_id uuid not null,
  supplier_org_id uuid not null,
  buyer_org_id uuid not null,
  collection_account_id uuid not null references settlement.collection_accounts(id),
  currency text not null,
  expected_amount numeric(20,2) not null,
  advance_amount numeric(20,2) not null,
  retention_amount numeric(20,2) not null,
  fx_spread_pct numeric(8,4) not null,
  platform_fee_note numeric(20,2) not null default 0,
  due_date date not null,
  status text not null default 'Expected' check (status in ('Expected','PartiallyReceived','Received','Matched','Distributed','Reconciled','Exception')),
  received_amount numeric(20,2) not null default 0,
  received_at timestamptz,
  late boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index on settlement.expectations (status);
alter table settlement.expectations enable row level security;
create policy exp_select on settlement.expectations for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy exp_write on settlement.expectations for all using (bank_org_id = app.org_id() or app.is_platform()) with check (bank_org_id = app.org_id() or app.is_platform());

-- Raw bank movements from callbacks and statement files.
create table settlement.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  bank_org_id uuid not null,
  source text not null check (source in ('callback','statement')),
  bank_txn_id text not null,
  reference text,
  currency text not null,
  amount numeric(20,2) not null,
  value_date date not null,
  payer text,
  expectation_id uuid references settlement.expectations(id),
  match_status text not null default 'unmatched' check (match_status in ('unmatched','matched','exception')),
  created_at timestamptz not null,
  unique (bank_org_id, source, bank_txn_id)
);
alter table settlement.bank_transactions enable row level security;
create policy bt_select on settlement.bank_transactions for select using (bank_org_id = app.org_id() or app.is_platform());
create policy bt_write on settlement.bank_transactions for all using (bank_org_id = app.org_id() or app.is_platform()) with check (bank_org_id = app.org_id() or app.is_platform());

create table settlement.ledger_entries (
  id bigserial primary key,
  invoice_id uuid not null,
  invoice_number text not null,
  bank_org_id uuid,
  supplier_org_id uuid,
  buyer_org_id uuid,
  kind text not null,
  party text not null,
  currency text not null,
  amount numeric(20,2) not null,
  amount_inr numeric(20,2),
  fx_rate numeric(12,4),
  note text,
  at timestamptz not null
);
create index on settlement.ledger_entries (invoice_id, id);
alter table settlement.ledger_entries enable row level security;
create policy le_select on settlement.ledger_entries for select
  using (bank_org_id = app.org_id() or supplier_org_id = app.org_id() or buyer_org_id = app.org_id() or app.is_platform());
create policy le_insert on settlement.ledger_entries for insert with check (true);

create table settlement.exceptions (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('Unmatched','ShortPaid','OverPaid','Late','AmountMismatch','DisbursementFailed','DisbursementReturned')),
  bank_org_id uuid not null,
  invoice_id uuid,
  invoice_number text,
  expectation_id uuid,
  bank_txn_id uuid,
  disbursement_id uuid,
  amount numeric(20,2),
  currency text,
  detail text not null,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null
);
create index on settlement.exceptions (status);
alter table settlement.exceptions enable row level security;
create policy ex_select on settlement.exceptions for select using (bank_org_id = app.org_id() or app.is_platform());
create policy ex_write on settlement.exceptions for all using (bank_org_id = app.org_id() or app.is_platform()) with check (bank_org_id = app.org_id() or app.is_platform());

alter table marketplace.early_payments add column if not exists settled_at timestamptz;

-- Notifications (CR-1): one row per recipient organisation and channel, with a delivery state.
create table notify.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_org_id uuid not null,
  topic text not null,
  channel text not null check (channel in ('in_app','email','sms','whatsapp')),
  status text not null check (status in ('queued','sent','delivered','failed')),
  lang text not null default 'en',
  subject text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  outbox_id bigint,
  created_at timestamptz not null,
  read_at timestamptz,
  unique (outbox_id, recipient_org_id, channel)
);
create index on notify.notifications (recipient_org_id, created_at desc);
alter table notify.notifications enable row level security;
create policy nt_select on notify.notifications for select using (recipient_org_id = app.org_id() or app.is_platform());
create policy nt_update on notify.notifications for update using (recipient_org_id = app.org_id() or app.is_platform());
create policy nt_insert on notify.notifications for insert with check (true);

-- Simulator state (not product data): what the simulated banks have actually received, used to produce statement files.
create table settlement.sim_bank_feed (
  id bigserial primary key,
  bank_org_id uuid not null,
  bank_txn_id text not null unique,
  reference text,
  currency text not null,
  amount numeric(20,2) not null,
  value_date date not null,
  payer text,
  created_at timestamptz not null
);
