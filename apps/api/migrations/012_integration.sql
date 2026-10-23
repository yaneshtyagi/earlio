-- M10: bank integration surface (BNK-13): API keys with rotation, webhooks and file-drop batches.
create schema if not exists integration;
create table integration.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  label text not null,
  key_prefix text not null,
  secret_hash text not null,
  signing_secret text not null,
  status text not null default 'active' check (status in ('active','rotating','revoked')),
  expires_at timestamptz,
  created_at timestamptz not null,
  created_by uuid,
  last_used_at timestamptz
);
create unique index on integration.api_keys (key_prefix);
create table integration.webhooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  url text not null,
  events text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null
);
create table integration.webhook_deliveries (
  id bigserial primary key,
  webhook_id uuid not null references integration.webhooks(id),
  org_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivered','failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null
);
create table integration.file_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  kind text not null check (kind in ('offers_in','statement_in','instructions_out')),
  filename text not null,
  rows_total int not null default 0,
  rows_ok int not null default 0,
  errors jsonb not null default '[]',
  content text,
  created_at timestamptz not null
);
do $$ declare t text; begin
  foreach t in array array['api_keys','webhooks','webhook_deliveries','file_batches'] loop
    execute format('alter table integration.%I enable row level security', t);
    execute format('create policy %I on integration.%I for all using (org_id = app.org_id() or app.is_platform()) with check (org_id = app.org_id() or app.is_platform())', t||'_rls', t);
  end loop;
end $$;
