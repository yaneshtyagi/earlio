import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, forbidden, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { transactBlockReason } from '../compliance/sanctions';

export interface Relationship {
  id: string; supplier_org_id: string; buyer_org_id: string; status: 'pending' | 'active' | 'suspended';
  proposed_by_org_id: string; proposed_by_user: string | null;
  supplier_approved_by: string | null; supplier_approved_at: Date | null; buyer_approved_by: string | null; buyer_approved_at: Date | null; created_at: Date;
}

export async function proposeRelationship(tx: Tx, svc: Services, ctx: Ctx, myOrgId: string, myType: string, counterpartyId: string) {
  const cp = await tx.elevated(() => tx.maybe<any>('select id, type, legal_name from identity.organisations where id = $1', [counterpartyId]));
  if (!cp) throw notFound('Organisation');
  const types = [myType, cp.type].sort().join('+');
  if (types !== 'buyer+supplier') throw new DomainError('bad_pair', 'A relationship links one supplier with one buyer.', 400);
  for (const id of [myOrgId, counterpartyId]) {
    const why = await transactBlockReason(tx, id);
    if (why) throw new DomainError('not_ready', why, 422);
  }
  const supplierId = myType === 'supplier' ? myOrgId : counterpartyId;
  const buyerId = myType === 'buyer' ? myOrgId : counterpartyId;
  const dup = await tx.maybe('select 1 from identity.relationships where supplier_org_id = $1 and buyer_org_id = $2', [supplierId, buyerId]);
  if (dup) throw conflict('relationship_exists', 'A relationship between these organisations already exists.');
  const now = svc.clock.now();
  const row = await tx.one<Relationship>(
    `insert into identity.relationships (supplier_org_id, buyer_org_id, proposed_by_org_id, proposed_by_user, created_at) values ($1,$2,$3,$4,$5) returning *`,
    [supplierId, buyerId, myOrgId, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'relationship.proposed', entityType: 'relationship', entityId: row.id, orgId: myOrgId, after: { supplierId, buyerId } });
  await audit(tx, ctx, now, { action: 'relationship.proposed', entityType: 'relationship', entityId: row.id, orgId: counterpartyId });
  await emit(tx, now, 'relationship.proposed', { relationshipId: row.id, supplierId, buyerId }, [supplierId, buyerId]);
  return row;
}

/** Each side's Approver approves once; the proposer cannot approve their own proposal (maker-checker). */
export async function approveRelationship(tx: Tx, svc: Services, ctx: Ctx, myOrgId: string, id: string) {
  const r = await tx.maybe<Relationship>('select * from identity.relationships where id = $1 for update', [id]);
  if (!r) throw notFound('Relationship');
  const side = r.supplier_org_id === myOrgId ? 'supplier' : r.buyer_org_id === myOrgId ? 'buyer' : null;
  if (!side) throw forbidden('This relationship does not involve your organisation.');
  if (r.status === 'suspended') throw conflict('suspended', 'This relationship is suspended.');
  if (r.proposed_by_user && r.proposed_by_user === ctx.userId) throw forbidden('You proposed this relationship; a different approver must approve it.');
  if ((side === 'supplier' ? r.supplier_approved_by : r.buyer_approved_by)) throw conflict('already_approved', 'Your side has already approved.');
  const now = svc.clock.now();
  await tx.query(`update identity.relationships set ${side}_approved_by = $2, ${side}_approved_at = $3 where id = $1`, [id, ctx.userId, now]);
  const after = await tx.one<Relationship>('select * from identity.relationships where id = $1', [id]);
  let status = after.status;
  if (after.supplier_approved_by && after.buyer_approved_by) {
    status = 'active';
    await tx.query("update identity.relationships set status = 'active' where id = $1", [id]);
    await emit(tx, now, 'relationship.activated', { relationshipId: id }, [r.supplier_org_id, r.buyer_org_id]);
  }
  await audit(tx, ctx, now, { action: 'relationship.approved', entityType: 'relationship', entityId: id, orgId: myOrgId, after: { side, status } });
  return { status };
}

export async function suspendRelationship(tx: Tx, svc: Services, ctx: Ctx, id: string, reason: string) {
  const r = await tx.maybe<Relationship>('select * from identity.relationships where id = $1 for update', [id]);
  if (!r) throw notFound('Relationship');
  const now = svc.clock.now();
  await tx.query("update identity.relationships set status = 'suspended' where id = $1", [id]);
  await audit(tx, ctx, now, { action: 'relationship.suspended', entityType: 'relationship', entityId: id, orgId: r.supplier_org_id, after: { reason } });
  await audit(tx, ctx, now, { action: 'relationship.suspended', entityType: 'relationship', entityId: id, orgId: r.buyer_org_id, after: { reason } });
}

export async function activeRelationship(tx: Tx, supplierId: string, buyerId: string): Promise<Relationship | undefined> {
  return tx.elevated(() => tx.maybe<Relationship>(
    "select * from identity.relationships where supplier_org_id = $1 and buyer_org_id = $2 and status = 'active'", [supplierId, buyerId]));
}

/** Banks to invite for an invoice: both parties' preferred banks plus the partner bank (A-13). */
export async function invitedBanks(tx: Tx, supplierId: string, buyerId: string): Promise<string[]> {
  const rows = await tx.elevated(() => tx.query<{ id: string }>(
    `select distinct b.id from identity.organisations b
      where b.type = 'bank' and b.kyc_status = 'approved' and not b.blocked and (
        b.is_partner or b.id in (select bank_org_id from identity.org_preferred_banks where org_id in ($1,$2)))`, [supplierId, buyerId]));
  return rows.map((r) => r.id);
}
