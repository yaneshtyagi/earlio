-- Append-only, hash-chained audit log (PRD CR-5, section 7).
create table audit.events (
  seq bigserial primary key,
  id uuid not null default gen_random_uuid(),
  org_id uuid,
  actor_user_id uuid,
  actor_label text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  correlation_id text,
  occurred_at timestamptz not null,
  prev_hash text not null,
  hash text not null
);
create index on audit.events (org_id, seq);
create index on audit.events (entity_type, entity_id);
alter table audit.events enable row level security;
create policy audit_select on audit.events for select using (org_id = app.org_id() or app.is_platform());
create policy audit_insert on audit.events for insert with check (true);

-- Single-row head used as the serialisation point for appends.
create table audit.chain_head (
  id int primary key check (id = 1),
  head_hash text not null,
  last_seq bigint not null default 0
);
insert into audit.chain_head values (1, repeat('0', 64), 0);

create table audit.anchors (
  id bigserial primary key,
  anchored_at timestamptz not null,
  head_hash text not null,
  last_seq bigint not null,
  token text not null
);

-- Transactional outbox (ADR-003) and platform settings.
create table platform.outbox (
  id bigserial primary key,
  topic text not null,
  payload jsonb not null,
  org_ids uuid[] not null default '{}',
  created_at timestamptz not null,
  processed_at timestamptz,
  attempts int not null default 0
);
create index on platform.outbox (processed_at) where processed_at is null;

create table platform.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null
);

create table platform.idempotency_keys (
  key text not null,
  scope text not null,
  response jsonb,
  created_at timestamptz not null,
  primary key (scope, key)
);

-- Integration messages: payload log for the integration inspector (SH-07).
create table platform.integration_messages (
  id bigserial primary key,
  adapter text not null,
  direction text not null check (direction in ('request','response','callback')),
  reference text,
  payload jsonb not null,
  created_at timestamptz not null
);
