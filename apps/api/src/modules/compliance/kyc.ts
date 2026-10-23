import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { REQUIRED_KYC_DOCS } from '../../adapters/kyc';
import { screenName } from './sanctions';

export async function getOrCreateOpenCase(tx: Tx, svc: Services, ctx: Ctx, orgId: string) {
  const existing = await tx.maybe<any>(
    `select * from compliance.kyc_cases where org_id = $1 order by created_at desc limit 1`, [orgId]);
  if (existing && ['draft', 'submitted', 'in_review', 'referred', 'approved'].includes(existing.status)) return existing;
  const now = svc.clock.now();
  const row = await tx.one<any>('insert into compliance.kyc_cases (org_id, status, created_at) values ($1,$2,$3) returning *', [orgId, 'draft', now]);
  await audit(tx, ctx, now, { action: 'kyc.case_opened', entityType: 'kyc_case', entityId: row.id, orgId });
  return row;
}

export async function caseView(tx: Tx, orgId: string) {
  const kase = await tx.maybe<any>('select * from compliance.kyc_cases where org_id = $1 order by created_at desc limit 1', [orgId]);
  const org = await tx.one<any>('select type, kyc_status, sanctions_status, blocked from identity.organisations where id = $1', [orgId]);
  const docs = kase ? await tx.query<any>(
    `select d.id, d.doc_type, d.file_id, f.filename, f.sha256, d.created_at from compliance.kyc_documents d join platform.files f on f.id = d.file_id where d.case_id = $1 order by d.created_at`, [kase.id]) : [];
  return { kase, docs, org, required: REQUIRED_KYC_DOCS[org.type] ?? [] };
}

export async function attachDocument(tx: Tx, svc: Services, ctx: Ctx, orgId: string, docType: string, fileId: string) {
  const kase = await getOrCreateOpenCase(tx, svc, ctx, orgId);
  if (kase.status !== 'draft') throw conflict('case_locked', 'Documents can only be added while the application is in draft.');
  const org = await tx.one<any>('select type from identity.organisations where id = $1', [orgId]);
  if (!(REQUIRED_KYC_DOCS[org.type] ?? []).includes(docType)) throw new DomainError('bad_doc_type', `"${docType}" is not a document type for ${org.type} organisations.`, 400);
  const file = await tx.maybe('select 1 from platform.files where id = $1 and org_id = $2', [fileId, orgId]);
  if (!file) throw notFound('File');
  const now = svc.clock.now();
  await tx.query('delete from compliance.kyc_documents where case_id = $1 and doc_type = $2', [kase.id, docType]); // latest version wins
  const row = await tx.one<any>('insert into compliance.kyc_documents (case_id, org_id, doc_type, file_id, created_at) values ($1,$2,$3,$4,$5) returning id', [kase.id, orgId, docType, fileId, now]);
  await audit(tx, ctx, now, { action: 'kyc.document_attached', entityType: 'kyc_case', entityId: kase.id, orgId, after: { docType, fileId } });
  return row.id as string;
}

/** Submit for review: runs the KYC provider and sanctions screening. */
export async function submitCase(tx: Tx, svc: Services, ctx: Ctx, orgId: string) {
  const { kase, docs, org } = await caseView(tx, orgId);
  if (!kase || kase.status !== 'draft') throw conflict('not_draft', 'There is no draft application to submit.');
  const orgFull = await tx.one<any>('select legal_name, country, type from identity.organisations where id = $1', [orgId]);
  const required = REQUIRED_KYC_DOCS[orgFull.type] ?? [];
  const now = svc.clock.now();
  const result = await svc.adapters.kyc.submit({
    orgName: orgFull.legal_name, orgType: orgFull.type, country: orgFull.country, requiredDocTypes: required,
    documents: docs.map((d: any) => ({ docType: d.doc_type, filename: d.filename })),
  });
  await tx.query(`insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ('kyc','response',$1,$2,$3)`, [result.reference, JSON.stringify(result), now]);
  const screening = await screenName(tx, svc, ctx, { name: orgFull.legal_name, orgId });
  const status = result.outcome === 'fail' ? 'rejected' : result.outcome === 'refer' ? 'referred' : 'in_review';
  const rejected = status === 'rejected';
  await tx.query(
    'update compliance.kyc_cases set status = $2, submitted_at = $3, provider_result = $4, decided_at = $5, decision_reason = $6 where id = $1',
    [kase.id, status, now, JSON.stringify({ ...result, sanctions: screening.outcome }), rejected ? now : null, rejected ? result.reasons.join('; ') : null]);
  await tx.query('update identity.organisations set kyc_status = $2 where id = $1', [orgId, status === 'rejected' ? 'rejected' : 'submitted']);
  await audit(tx, ctx, now, { action: 'kyc.submitted', entityType: 'kyc_case', entityId: kase.id, orgId, after: { status, provider: result.outcome, sanctions: screening.outcome } });
  await emit(tx, now, 'kyc.submitted', { caseId: kase.id, orgId, status }, [orgId]);
  return { status, result, sanctions: screening.outcome };
}

/** Platform decision. Approval requires screening to be clear (or cleared as a false positive). */
export async function decideCase(tx: Tx, svc: Services, ctx: Ctx, caseId: string, decision: 'approve' | 'reject', reason: string) {
  const k = await tx.maybe<any>('select * from compliance.kyc_cases where id = $1 for update', [caseId]);
  if (!k) throw notFound('KYC case');
  if (!['in_review', 'referred'].includes(k.status)) throw conflict('not_reviewable', 'This application is not awaiting a decision.');
  const org = await tx.one<any>('select legal_name, sanctions_status, blocked from identity.organisations where id = $1', [k.org_id]);
  if (decision === 'approve') {
    if (org.blocked || org.sanctions_status === 'confirmed') throw new DomainError('sanctions_blocked', `${org.legal_name} cannot be approved: confirmed sanctions hit.`, 422);
    if (org.sanctions_status === 'review') throw new DomainError('sanctions_open', `${org.legal_name} has an open sanctions hit. Resolve it before approving.`, 422);
  }
  const now = svc.clock.now();
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await tx.query('update compliance.kyc_cases set status = $2, decided_at = $3, decided_by = $4, decision_reason = $5 where id = $1', [caseId, status, now, ctx.userId ?? null, reason]);
  await tx.query('update identity.organisations set kyc_status = $2 where id = $1', [k.org_id, status]);
  await audit(tx, ctx, now, { action: `kyc.${status}`, entityType: 'kyc_case', entityId: caseId, orgId: k.org_id, before: { status: k.status }, after: { status, reason } });
  await emit(tx, now, `kyc.${status}`, { caseId, orgId: k.org_id }, [k.org_id]);
}
