-- M9: maker-checker for platform settings, custom-field answers on financing requests and claims.
create table platform.setting_changes (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  before jsonb,
  after jsonb not null,
  status text not null default 'pending' check (status in ('pending','applied','rejected','withdrawn')),
  note text,
  proposed_by uuid not null,
  proposed_at timestamptz not null,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  check (decided_by is null or status = 'withdrawn' or decided_by <> proposed_by)
);
create index on platform.setting_changes (status, proposed_at);

alter table marketplace.financing_requests add column extra jsonb not null default '{}'::jsonb;
alter table recovery.claims add column extra jsonb not null default '{}'::jsonb;
