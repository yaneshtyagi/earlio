import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { TERMS_SCHEMA_VERSION, type OwnerType } from '../terms/schema';
import { resolveTerms, createVersion } from '../terms/service';
import { changeDiff, currentMode, settingChanges, SETTINGS, type SettingKey } from './settings';
import { diffJson, type Change } from './diff';

// ---------------------------------------------------------------------------------------------- approvals inbox (CT-6)
export interface ApprovalItem {
  kind: 'terms' | 'setting'; id: string; title: string; ownerName: string | null; ownerType: OwnerType | 'platform';
  maker: string | null; submittedAt: string; effectiveFrom: string | null; note: string | null;
  changes: Change[]; against: number | null; version: number | null; canApprove: boolean; reason: string | null;
}
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

/** Previous in-force version of a set, to diff a new version against. */
export async function previousVersion(tx: Tx, setId: string, before: number) {
  return tx.maybe<any>("select * from terms.terms_versions where set_id = $1 and version < $2 and status in ('active','retired') order by version desc limit 1", [setId, before]);
}

export async function versionDiff(tx: Tx, versionId: string, againstId?: string) {
  const v = await tx.maybe<any>('select * from terms.terms_versions where id = $1', [versionId]);
  if (!v) throw notFound('Terms version');
  const prev = againstId ? await tx.maybe<any>('select * from terms.terms_versions where id = $1 and set_id = $2', [againstId, v.set_id]) : await previousVersion(tx, v.set_id, v.version);
  if (againstId && !prev) throw notFound('Terms version to compare');
  return { version: v.version as number, against: (prev?.version ?? null) as number | null, changes: diffJson(prev?.body ?? {}, v.body) };
}

export async function approvalsInbox(tx: Tx, svc: Services, ctx: Ctx, auth: { orgId: string; orgType: string; role: string; userId: string }, canPublish: boolean, isAdmin: boolean): Promise<ApprovalItem[]> {
  const items: ApprovalItem[] = [];
  const rows = await tx.query<any>(
    `select v.*, s.name as set_name, s.owner_type, s.owner_org_id, o.legal_name as owner_name, u.name as maker_name
       from terms.terms_versions v join terms.terms_sets s on s.id = v.set_id
       left join identity.organisations o on o.id = s.owner_org_id left join identity.users u on u.id = coalesce(v.submitted_by, v.created_by)
      where v.status = 'pending' and (($1::text = 'platform' and s.owner_type = 'platform') or s.owner_org_id = $2) order by v.submitted_at`, [auth.orgType, auth.orgId]);
  for (const v of rows) {
    const prev = await previousVersion(tx, v.set_id, v.version);
    const mine = v.created_by === auth.userId || v.submitted_by === auth.userId;
    items.push({
      kind: 'terms', id: v.id, title: `${v.set_name} — version ${v.version}`, ownerName: v.owner_name ?? 'Earlio', ownerType: v.owner_type, maker: v.maker_name ?? null,
      submittedAt: iso(v.submitted_at) ?? iso(v.created_at)!, effectiveFrom: iso(v.effective_from), note: v.note, changes: diffJson(prev?.body ?? {}, v.body), against: prev?.version ?? null, version: v.version,
      canApprove: canPublish && !mine, reason: !canPublish ? 'Your role cannot publish terms.' : mine ? 'You prepared these terms; a different approver must publish them.' : null,
    });
  }
  if (isAdmin) {
    for (const c of await settingChanges(tx, 'pending')) {
      const mine = c.proposed_by === auth.userId;
      items.push({
        kind: 'setting', id: c.id, title: SETTINGS[c.key as SettingKey]?.label ?? c.key, ownerName: 'Earlio', ownerType: 'platform', maker: c.proposer, submittedAt: iso(c.proposed_at)!, effectiveFrom: null, note: c.note,
        changes: changeDiff(c), against: null, version: null, canApprove: !mine, reason: mine ? 'You proposed this change; a different administrator must decide it.' : null,
      });
    }
  }
  void svc; void ctx;
  return items;
}

/** Send a pending version back to its maker (also lets the maker withdraw). */
export async function rejectVersion(tx: Tx, svc: Services, ctx: Ctx, versionId: string, reason: string) {
  const v = await tx.maybe<any>('select * from terms.terms_versions where id = $1 for update', [versionId]);
  if (!v) throw notFound('Terms version');
  if (v.status !== 'pending') throw conflict('not_pending', `Only a version awaiting approval can be sent back (this one is ${v.status}).`);
  const set = await tx.one<any>('select * from terms.terms_sets where id = $1', [v.set_id]);
  if (!ctx.platform && set.owner_org_id !== ctx.orgId) throw notFound('Terms version');
  if (ctx.platform && set.owner_org_id) throw forbidden('Banks and insurers decide their own terms.');
  const now = svc.clock.now();
  await tx.query("update terms.terms_versions set status = 'draft', submitted_by = null, submitted_at = null, note = $2 where id = $1", [versionId, `Sent back: ${reason}`]);
  await audit(tx, ctx, now, { action: 'terms.version_sent_back', entityType: 'terms_version', entityId: versionId, orgId: set.owner_org_id, after: { reason } });
  await emit(tx, now, 'terms.version_sent_back', { versionId, setId: set.id, reason }, set.owner_org_id ? [set.owner_org_id] : []);
}

// ---------------------------------------------------------------------------------------------- import / export (CT-11)
export const EXPORT_FORMAT = 'earlio-terms';
export async function exportSet(tx: Tx, svc: Services, setId: string, versionId?: string) {
  const set = await tx.maybe<any>('select * from terms.terms_sets where id = $1', [setId]);
  if (!set) throw notFound('Terms set');
  const v = versionId
    ? await tx.maybe<any>('select * from terms.terms_versions where id = $1 and set_id = $2', [versionId, setId])
    : await tx.maybe<any>("select * from terms.terms_versions where set_id = $1 order by (status = 'active') desc, version desc limit 1", [setId]);
  if (!v) throw notFound('Terms version');
  return { format: EXPORT_FORMAT, schemaVersion: v.schema_version as number, ownerType: set.owner_type as OwnerType, name: set.name as string, scope: set.scope, version: v.version as number, exportedAt: svc.clock.now().toISOString(), body: v.body as Record<string, unknown> };
}
export async function importIntoSet(tx: Tx, svc: Services, ctx: Ctx, setId: string, doc: { format: string; schemaVersion: number; ownerType: string; body: Record<string, unknown> }) {
  if (doc.format !== EXPORT_FORMAT) throw invalid(`This is not an Earlio terms file (format "${doc.format}").`);
  const set = await tx.maybe<any>('select * from terms.terms_sets where id = $1', [setId]);
  if (!set) throw notFound('Terms set');
  if (doc.ownerType !== set.owner_type) throw invalid(`This file holds ${doc.ownerType} terms but the set is for a ${set.owner_type}.`);
  if (doc.schemaVersion > TERMS_SCHEMA_VERSION) throw invalid(`This file uses terms schema ${doc.schemaVersion}; this server understands up to ${TERMS_SCHEMA_VERSION}.`);
  return createVersion(tx, svc, ctx, setId, doc.body, { note: 'Imported from file' });
}

// ---------------------------------------------------------------------------------------------- branding / white-label (WL-1)
export interface Branding { displayName: string; primary: string; accent: string; logo: string | null; welcome: string | null }
export const DEFAULT_BRANDING: Branding = { displayName: 'Earlio', primary: '#0b5d3b', accent: '#c9a227', logo: null, welcome: null };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
/** WCAG contrast ratio between two #rrggbb colours. */
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };

export function cleanBranding(input: Partial<Branding>): Branding {
  const hex = /^#[0-9a-fA-F]{6}$/;
  const b: Branding = { ...DEFAULT_BRANDING, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Branding;
  if (b.displayName.trim().length < 2 || b.displayName.length > 60) throw invalid('The display name must be 2 to 60 characters.');
  if (!hex.test(b.primary) || !hex.test(b.accent)) throw invalid('Colours must look like #0b5d3b.');
  if (contrast(b.primary, '#ffffff') < 4.5) throw new DomainError('low_contrast', `White text on your primary colour has a contrast of ${contrast(b.primary, '#ffffff').toFixed(1)}:1; accessibility needs at least 4.5:1. Choose a darker colour.`, 422);
  if (b.welcome && b.welcome.length > 400) throw invalid('The welcome text is limited to 400 characters.');
  if (b.logo) {
    const ok = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(b.logo) || /^https:\/\/[^\s"'<>]+$/.test(b.logo);
    if (!ok) throw invalid('The logo must be a PNG, JPEG or SVG data URL, or an https link.');
    if (b.logo.length > 200_000) throw invalid('The logo is too large (200 KB maximum).');
  }
  return { displayName: b.displayName.trim(), primary: b.primary.toLowerCase(), accent: b.accent.toLowerCase(), logo: b.logo ?? null, welcome: b.welcome?.trim() || null };
}

/**
 * A custom domain Earlio pointed at a bank wins; otherwise the first label of the host is a bank's tenant name
 * (kestrel.localhost, kestrel.earlio.example → Kestrel).
 */
export async function brandingForHost(svc: Services, host: string | undefined) {
  return svc.db.system(async (tx) => {
    const mode = await currentMode(tx, svc);
    const h = host?.toLowerCase().replace(/:\d+$/, '') ?? '';
    const cols = 'id, legal_name, branding, hostname, tenant, is_partner';
    let org = h ? await tx.maybe<any>(`select ${cols} from identity.organisations where hostname = $1 and type = 'bank'`, [h]) : undefined;
    const label = h.includes('.') ? h.split('.')[0]! : '';
    if (!org && label) org = await tx.maybe<any>(`select ${cols} from identity.organisations where tenant = $1 and type = 'bank'`, [label]);
    let matched = !!org;
    if (!org && mode === 'white-label') org = await tx.maybe<any>(`select ${cols} from identity.organisations where type = 'bank' and is_partner order by created_at limit 1`);
    if (!org) return { mode, matched: false, orgId: null as string | null, hostname: h || null, tenant: null as string | null, ...DEFAULT_BRANDING, whiteLabel: false };
    const b = org.branding ?? {};
    return {
      mode, matched, orgId: org.id as string, hostname: (org.hostname ?? h) as string | null, tenant: (org.tenant ?? null) as string | null, whiteLabel: mode === 'white-label' || matched,
      displayName: (b.displayName ?? org.legal_name) as string, primary: (b.primary ?? DEFAULT_BRANDING.primary) as string, accent: (b.accent ?? DEFAULT_BRANDING.accent) as string,
      logo: (b.logo ?? null) as string | null, welcome: (b.welcome ?? null) as string | null,
    };
  });
}

export async function saveBranding(tx: Tx, svc: Services, ctx: Ctx, orgId: string, input: Partial<Branding>) {
  const org = await tx.elevated(() => tx.maybe<any>('select id, type, branding from identity.organisations where id = $1', [orgId]));
  if (!org || org.type !== 'bank') throw notFound('Bank');
  if (!ctx.platform && ctx.orgId !== orgId) throw forbidden('You can only change your own bank\'s branding.');
  const next = cleanBranding({ ...(org.branding ?? {}), ...input });
  const now = svc.clock.now();
  await tx.elevated(() => tx.query('update identity.organisations set branding = $2 where id = $1', [orgId, JSON.stringify(next)]));
  await audit(tx, ctx, now, { action: 'branding.updated', entityType: 'organisation', entityId: orgId, orgId, before: { ...org.branding, logo: org.branding?.logo ? '(logo)' : null }, after: { ...next, logo: next.logo ? '(logo)' : null } });
  return next;
}

export async function setHostname(tx: Tx, svc: Services, ctx: Ctx, orgId: string, hostname: string | null) {
  if (hostname !== null && !/^(?=.{4,100}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) throw invalid('That is not a valid hostname (for example finance.kestrel.com).');
  const dup = hostname ? await tx.elevated(() => tx.maybe('select 1 from identity.organisations where hostname = $1 and id <> $2', [hostname, orgId])) : undefined;
  if (dup) throw conflict('hostname_taken', 'That hostname already belongs to another organisation.');
  const r = await tx.elevated(() => tx.query("update identity.organisations set hostname = $2 where id = $1 and type = 'bank' returning id", [orgId, hostname]));
  if (!r.length) throw notFound('Bank');
  await audit(tx, ctx, svc.clock.now(), { action: 'branding.hostname_set', entityType: 'organisation', entityId: orgId, orgId, after: { hostname } });
}

/** Labels the platform keeps for itself; a bank cannot take them as its tenant name. */
const RESERVED_TENANTS = new Set(['www', 'api', 'app', 'admin', 'earlio', 'mail', 'static', 'assets', 'cdn', 'status', 'docs', 'help', 'support', 'login', 'auth', 'localhost']);

/** A bank's tenant name (the first label of its portal address). The bank itself or the platform may set it. */
export async function setTenant(tx: Tx, svc: Services, ctx: Ctx, orgId: string, tenant: string | null) {
  if (!ctx.platform && ctx.orgId !== orgId) throw forbidden('You can only change your own bank\'s tenant name.');
  const t = tenant?.trim().toLowerCase() || null;
  if (t === null && !ctx.platform) throw invalid('Your bank needs a tenant name: it is the first part of your portal address.');
  if (t !== null && !/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(t)) throw invalid('A tenant name is 2 to 32 lower-case letters, digits or hyphens, and cannot start or end with a hyphen (for example kestrel).');
  if (t && RESERVED_TENANTS.has(t)) throw invalid(`"${t}" is reserved by Earlio. Choose another tenant name.`);
  const org = await tx.elevated(() => tx.maybe<any>("select tenant from identity.organisations where id = $1 and type = 'bank'", [orgId]));
  if (!org) throw notFound('Bank');
  if (org.tenant === t) return;
  const dup = t ? await tx.elevated(() => tx.maybe('select 1 from identity.organisations where tenant = $1 and id <> $2', [t, orgId])) : undefined;
  if (dup) throw conflict('tenant_taken', `The tenant name "${t}" already belongs to another bank.`);
  try {
    await tx.elevated(() => tx.query('update identity.organisations set tenant = $2 where id = $1', [orgId, t]));
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('tenant_taken', `The tenant name "${t}" already belongs to another bank.`);
    throw e;
  }
  await audit(tx, ctx, svc.clock.now(), { action: 'branding.tenant_set', entityType: 'organisation', entityId: orgId, orgId, before: { tenant: org.tenant }, after: { tenant: t } });
}

// ---------------------------------------------------------------------------------------------- requirements (CT-10)
export async function financingRequirements(tx: Tx, svc: Services, frId: string) {
  const fr = await tx.maybe<any>('select * from marketplace.financing_requests where id = $1', [frId]);
  if (!fr) throw notFound('Financing request');
  const terms = (await resolveTerms(tx, svc.clock.now(), 'bank', fr.bank_org_id, {})).terms;
  const have = await tx.query<{ doc_type: string }>('select distinct doc_type from invoicing.invoice_documents where invoice_id = $1', [fr.invoice_id]);
  const required: string[] = terms.requiredDocuments ?? [];
  return {
    bankOrgId: fr.bank_org_id as string, customFields: ((terms.customFields ?? []) as any[]).filter((f) => f.appliesTo === 'financing_request'),
    requiredDocuments: required, missingDocuments: required.filter((d) => !have.some((h) => h.doc_type === d)), answers: fr.extra ?? {},
  };
}
