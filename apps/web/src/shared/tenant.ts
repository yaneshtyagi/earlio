/** Platform host labels (app., admin. …) that are never a bank's tenant; the API refuses them as tenant names. */
const PLATFORM_LABELS = new Set(['www', 'api', 'app', 'admin', 'mail', 'static', 'assets', 'cdn', 'status', 'docs', 'help', 'support', 'login', 'auth']);

/**
 * WL-1: a bank's portal lives at its tenant name in front of the domain this SPA is served from, so the address
 * follows the environment: kestrel → http://kestrel.localhost:5173/ in development, https://kestrel.<domain>/ elsewhere.
 * `currentTenant` is the tenant of the host we are on (if any), which is stripped to find the platform domain.
 */
export function tenantUrl(tenant: string, currentTenant: string | null, loc: Pick<Location, 'protocol' | 'hostname' | 'port'> = window.location) {
  let base = loc.hostname.toLowerCase();
  const first = base.split('.')[0]!;
  // Strip the label of the host we are on: a bank's tenant, or a platform label such as app. or admin.
  if (base.includes('.') && (first === currentTenant || PLATFORM_LABELS.has(first))) base = base.slice(first.length + 1);
  // Browsers resolve *.localhost to this machine; an IP address cannot carry a tenant label.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(base) || base.startsWith('[')) base = 'localhost';
  return `${loc.protocol}//${tenant}.${base}${loc.port ? `:${loc.port}` : ''}/`;
}

/** The same rule the server applies: 2 to 32 lower-case letters, digits or hyphens, not starting or ending with a hyphen. */
export const TENANT_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
