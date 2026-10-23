-- Module schemas (one per module; same database).
create extension if not exists pgcrypto;
create schema if not exists app;
create schema if not exists identity;
create schema if not exists audit;
create schema if not exists platform;
create schema if not exists compliance;
create schema if not exists invoicing;
create schema if not exists terms;
create schema if not exists insurance;
create schema if not exists marketplace;
create schema if not exists settlement;
create schema if not exists notify;

-- Request-scoped context, set per transaction by the API (SET LOCAL semantics).
create function app.org_id() returns uuid language sql stable as
  $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;
create function app.user_id() returns uuid language sql stable as
  $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;
create function app.is_platform() returns boolean language sql stable as
  $$ select coalesce(current_setting('app.is_platform', true), '') = 'on' $$;
