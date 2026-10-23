import { createHash } from 'node:crypto';
import type { Services } from '../../services';
import type { Tx, Ctx } from '../../db/pool';
import { hashPassword } from '../../kernel/password';
import { base32Encode } from '../../kernel/totp';
import { addMember, createOrganisation, type OrgInput } from './service';
import { seedTerms } from '../terms/service';
import { ROLES_BY_ORG_TYPE, type OrgType, type Role } from './permissions';

export const DEMO_PASSWORD = 'Earlio!Demo1';
export const demoTotpSecret = (email: string) =>
  base32Encode(createHash('sha256').update('earlio-demo-' + email).digest().subarray(0, 20));

interface DemoOrg extends Omit<OrgInput, 'type'> {
  slug: string;
  type: OrgType;
}

/** The fictional cast from the POC plan section 1.1. All names are fictional. */
export const DEMO_ORGS: DemoOrg[] = [
  { slug: 'shree', type: 'supplier', legalName: 'Shree Textiles', country: 'IN', msme: true, turnoverInr: '60000000', borrowingRate: '14.0000' },
  { slug: 'kumar', type: 'supplier', legalName: 'Kumar Precision', country: 'IN', turnoverInr: '900000000', borrowingRate: '13.0000' },
  { slug: 'anand', type: 'supplier', legalName: 'Anand Handicrafts', country: 'IN', msme: true, turnoverInr: '30000000', borrowingRate: '15.0000' },
  { slug: 'deccan', type: 'supplier', legalName: 'Deccan Agro Exports', country: 'IN', turnoverInr: '4000000000', borrowingRate: '11.5000' },
  { slug: 'northwind', type: 'buyer', legalName: 'Northwind Retail Inc.', country: 'US', ratingTier: 'A' },
  { slug: 'lakeshore', type: 'buyer', legalName: 'Lakeshore Outfitters LLC', country: 'US', ratingTier: 'BBB' },
  { slug: 'merlion', type: 'buyer', legalName: 'Merlion Electronics Pte Ltd', country: 'SG', ratingTier: 'A' },
  { slug: 'kallang', type: 'buyer', legalName: 'Kallang Home Pte Ltd', country: 'SG', ratingTier: 'BBB' },
  { slug: 'aurelia', type: 'bank', legalName: 'Aurelia Bank', country: 'IN', isPartner: true, branding: { displayName: 'Aurelia Bank', primary: '#0b5d3b' } },
  { slug: 'kestrel', type: 'bank', legalName: 'Kestrel Capital', country: 'IN' },
  { slug: 'harbour', type: 'bank', legalName: 'Harbour Trust Bank', country: 'SG', dataRegion: 'SG' },
  { slug: 'zarnitsa', type: 'buyer', legalName: 'Zarnitsa Trading Ltd', country: 'CY', ratingTier: 'BBB', kycStatus: 'approved', sanctionsStatus: 'confirmed', blocked: true },
  { slug: 'exportshield', type: 'insurer', legalName: 'ExportShield', country: 'IN' },
  { slug: 'sentinel', type: 'insurer', legalName: 'Sentinel Trade Credit', country: 'SG', dataRegion: 'SG' },
  { slug: 'earlio', type: 'platform', legalName: 'Earlio Operations', country: 'IN' },
];

const ROLE_LOCALPART: Record<Role, string> = {
  Admin: 'admin', FinanceUser: 'finance', Approver: 'approver', Viewer: 'viewer', CreditOfficer: 'credit', Operations: 'ops',
  RelationshipManager: 'rm', Underwriter: 'underwriter', ClaimsHandler: 'claims', PlatformAdmin: 'admin', Auditor: 'auditor',
};

export const demoEmail = (slug: string, role: Role) => `${ROLE_LOCALPART[role]}@${slug}.demo`;

export type DemoIds = Record<string, string>;

/** Idempotent: creates the demo cast if the platform org does not exist yet. Returns slug -> org id. */
export async function seedDemo(tx: Tx, svc: Services, ctx: Ctx): Promise<DemoIds> {
  const ids: DemoIds = {};
  const hash = await hashPassword(DEMO_PASSWORD);
  for (const o of DEMO_ORGS) {
    const existing = await tx.maybe<{ id: string }>('select id from identity.organisations where legal_name = $1 and type = $2', [o.legalName, o.type]);
    if (existing) { ids[o.slug] = existing.id; continue; }
    const { slug, ...input } = o;
    const id = await createOrganisation(tx, svc, ctx, { kycStatus: 'approved', sanctionsStatus: 'clear', ...input });
    ids[slug] = id;
    for (const role of ROLES_BY_ORG_TYPE[o.type]) {
      const email = demoEmail(slug, role);
      const exists = await tx.maybe('select 1 from identity.users where email = $1', [email]);
      if (exists) continue;
      await addMember(tx, svc, ctx, {
        orgId: id, orgType: o.type, email, name: `${o.legalName} ${role}`, role,
        passwordHash: hash, mfaSecret: demoTotpSecret(email), mfaEnabled: true,
      });
    }
  }
  await seedRelationshipsAndLimits(tx, svc, ids);
  await seedTerms(tx, svc, ids);
  return ids;
}

const DEMO_RELATIONSHIPS: [string, string][] = [
  ['shree', 'northwind'], ['shree', 'lakeshore'], ['kumar', 'northwind'], ['kumar', 'merlion'],
  ['anand', 'kallang'], ['deccan', 'merlion'], ['deccan', 'northwind'],
];
const DEMO_PREFERRED: Record<string, string[]> = {
  shree: ['kestrel'], kumar: ['kestrel'], anand: ['kestrel'], deccan: ['kestrel', 'harbour'],
  northwind: ['kestrel'], lakeshore: ['kestrel'], merlion: ['harbour'], kallang: ['harbour'],
};

async function seedRelationshipsAndLimits(tx: Tx, svc: Services, ids: DemoIds) {
  const now = svc.clock.now();
  for (const [sup, buy] of DEMO_RELATIONSHIPS) {
    await tx.query(
      `insert into identity.relationships (supplier_org_id, buyer_org_id, status, proposed_by_org_id, supplier_approved_at, buyer_approved_at, created_at)
       values ($1,$2,'active',$1,$3,$3,$3) on conflict do nothing`, [ids[sup], ids[buy], now]);
  }
  const pos: [string, string, string, string, string][] = [
    ['shree', 'northwind', 'PO-NW-2201', 'USD', '120000'], ['kumar', 'merlion', 'PO-ML-0815', 'USD', '150000'],
    ['anand', 'kallang', 'PO-KH-0042', 'SGD', '60000'], ['deccan', 'northwind', 'PO-NW-3310', 'USD', '300000'],
  ];
  for (const [sup, buy, num, ccy, amt] of pos) {
    await tx.query(
      `insert into invoicing.purchase_orders (supplier_org_id, buyer_org_id, number, currency, amount, created_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [ids[sup], ids[buy], num, ccy, amt, now]);
  }
  for (const [org, banks] of Object.entries(DEMO_PREFERRED)) {
    for (const b of banks) {
      await tx.query('insert into identity.org_preferred_banks (org_id, bank_org_id, created_at) values ($1,$2,$3) on conflict do nothing', [ids[org], ids[b], now]);
    }
  }
  // Insurers: ExportShield covers the US corridor (manual underwriting), Sentinel the Singapore buyers (API gateway).
  const INSURER_FOR: Record<string, string> = { northwind: 'exportshield', lakeshore: 'exportshield', merlion: 'sentinel', kallang: 'sentinel' };
  for (const [buyer, ins] of Object.entries(INSURER_FOR)) {
    await tx.query('update identity.relationships set insurer_org_id = $1 where buyer_org_id = $2', [ids[ins], ids[buyer]]);
  }
  const expiry = new Date(now.getTime() + 365 * 86_400_000);
  const INS_LIMITS: [string, string, string, string][] = [
    ['exportshield', 'northwind', 'ES-POL-NW-001', '3000000'], ['exportshield', 'lakeshore', 'ES-POL-LS-002', '1000000'],
    ['sentinel', 'merlion', 'SN-POL-ML-101', '5000000'], ['sentinel', 'kallang', 'SN-POL-KH-102', '2000000'],
  ];
  for (const [ins, buyer, policy, lim] of INS_LIMITS) {
    await tx.query(`insert into insurance.buyer_limits (insurer_org_id, buyer_org_id, policy_number, limit_usd, expires_at, updated_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [ids[ins], ids[buyer], policy, lim, expiry, now]);
  }
  for (const [ins, gw] of [['exportshield', 'manual'], ['sentinel', 'api']]) {
    await tx.query(`insert into platform.settings (key, value, updated_at) values ($1,$2,$3) on conflict do nothing`, [`insurer_gateway:${ids[ins!]}`, JSON.stringify(gw), now]);
  }
  for (const bank of ['aurelia', 'kestrel', 'harbour']) {
    for (const [slug, kind] of [['northwind', 'buyer'], ['lakeshore', 'buyer'], ['merlion', 'buyer'], ['kallang', 'buyer'],
                                ['shree', 'supplier'], ['kumar', 'supplier'], ['anand', 'supplier'], ['deccan', 'supplier']] as const) {
      await tx.query(
        `insert into identity.bank_limits (bank_org_id, subject_org_id, kind, limit_usd, updated_at) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [ids[bank], ids[slug], kind, kind === 'buyer' ? '5000000' : '2000000', now]);
    }
  }
}
