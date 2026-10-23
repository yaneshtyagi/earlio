-- M10: read models for dashboards (CR-3). Projection rows refreshed by the worker; each row belongs to one organisation (or the platform).
create schema if not exists analytics;
create table analytics.snapshots (
  key text primary key,
  kind text not null,
  org_id uuid,
  data jsonb not null,
  computed_at timestamptz not null
);
alter table analytics.snapshots enable row level security;
create policy snap_select on analytics.snapshots for select using (org_id = app.org_id() or app.is_platform());
create policy snap_write on analytics.snapshots for all using (app.is_platform()) with check (app.is_platform());
