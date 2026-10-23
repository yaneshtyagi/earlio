create table terms.terms_sets (
  id uuid primary key default gen_random_uuid(),
  owner_type text not null check (owner_type in ('platform','bank','insurer')),
  owner_org_id uuid references identity.organisations(id),
  name text not null,
  scope jsonb not null default '{}'::jsonb,
  layer text not null,
  priority int not null default 0,
  created_by uuid,
  created_at timestamptz not null,
  check ((owner_type = 'platform') = (owner_org_id is null))
);
create index on terms.terms_sets (owner_org_id);
alter table terms.terms_sets enable row level security;
-- Platform sets and each owner's default sets are readable by all; scoped overrides (per buyer / supplier) only by the owner.
create policy sets_select on terms.terms_sets for select
  using (owner_org_id = app.org_id() or owner_type = 'platform' or scope = '{}'::jsonb or app.is_platform());
create policy sets_insert on terms.terms_sets for insert with check (owner_org_id = app.org_id() or app.is_platform());
create policy sets_update on terms.terms_sets for update using (owner_org_id = app.org_id() or app.is_platform());

create table terms.terms_versions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references terms.terms_sets(id),
  version int not null,
  status text not null default 'draft' check (status in ('draft','pending','active','retired')),
  effective_from timestamptz,
  effective_to timestamptz,
  body jsonb not null,
  schema_version int not null,
  note text,
  created_by uuid,
  submitted_by uuid,
  approved_by uuid,
  created_at timestamptz not null,
  submitted_at timestamptz,
  approved_at timestamptz,
  unique (set_id, version),
  check (status in ('draft','pending') or effective_from is not null),
  check (approved_by is null or approved_by is distinct from created_by or created_by is null)
);
alter table terms.terms_versions enable row level security;
create policy ver_select on terms.terms_versions for select using (
  exists (select 1 from terms.terms_sets s where s.id = set_id)
  and (status in ('active','retired') or app.is_platform()
       or exists (select 1 from terms.terms_sets s where s.id = set_id and s.owner_org_id = app.org_id())));
create policy ver_insert on terms.terms_versions for insert with check (
  app.is_platform() or exists (select 1 from terms.terms_sets s where s.id = set_id and s.owner_org_id = app.org_id()));
create policy ver_update on terms.terms_versions for update using (
  app.is_platform() or exists (select 1 from terms.terms_sets s where s.id = set_id and s.owner_org_id = app.org_id()));

-- Immutability (CT-5): once Active, the body, version and effective_from never change. Only effective_to may be set
-- (when a newer version takes over) and status may move to retired. Applies to every role, including the owner.
create function terms.guard_version_update() returns trigger language plpgsql as $$
begin
  if old.status in ('active','retired') then
    if new.body is distinct from old.body or new.version <> old.version or new.set_id <> old.set_id
       or new.effective_from is distinct from old.effective_from or new.schema_version <> old.schema_version
       or new.created_by is distinct from old.created_by then
      raise exception 'terms version % is immutable once active', old.id using errcode = '55000';
    end if;
    if old.status = 'retired' and new.status <> 'retired' then
      raise exception 'a retired terms version cannot be reactivated' using errcode = '55000';
    end if;
    if new.status in ('draft','pending') then
      raise exception 'an active terms version cannot return to draft' using errcode = '55000';
    end if;
  end if;
  return new;
end $$;
create trigger terms_versions_guard before update on terms.terms_versions for each row execute function terms.guard_version_update();
create function terms.guard_version_delete() returns trigger language plpgsql as $$
begin
  if old.status in ('active','retired') then raise exception 'terms version % is immutable once active', old.id using errcode = '55000'; end if;
  return old;
end $$;
create trigger terms_versions_nodelete before delete on terms.terms_versions for each row execute function terms.guard_version_delete();
