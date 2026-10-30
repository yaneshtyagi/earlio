-- WL-1: a bank's tenant name is the first label of its portal address (kestrel → kestrel.localhost:5173 in development,
-- kestrel.<platform domain> elsewhere). `hostname` remains for a custom domain that Earlio points at a bank.
alter table identity.organisations add column tenant text unique
  check (tenant ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$');

-- Existing banks get the first word of their legal name where that is free (Aurelia Bank → aurelia).
update identity.organisations o set tenant = t.name
from (
  select id, lower(regexp_replace(split_part(legal_name, ' ', 1), '[^A-Za-z0-9-]', '', 'g')) as name,
         row_number() over (partition by lower(regexp_replace(split_part(legal_name, ' ', 1), '[^A-Za-z0-9-]', '', 'g')) order by created_at) as n
  from identity.organisations where type = 'bank'
) t
where o.id = t.id and t.n = 1 and t.name ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$';

-- The old development hostnames (bank1.localtest.me …) are replaced by tenant names.
update identity.organisations set hostname = null where hostname like '%.localtest.me';
