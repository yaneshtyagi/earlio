-- M10: organisation language for notifications and summaries (English or Hindi).
alter table identity.organisations add column language text not null default 'en' check (language in ('en','hi'));
