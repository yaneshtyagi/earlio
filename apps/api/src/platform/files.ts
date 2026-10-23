import { createHash, randomUUID } from 'node:crypto';
import type { Ctx, Tx } from '../db/pool';
import type { Services } from '../services';
import { DomainError, notFound } from '../kernel/errors';
import { audit } from './audit';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function storeFile(tx: Tx, svc: Services, ctx: Ctx, input: { filename: string; contentType: string; data: Buffer }) {
  if (!ctx.orgId) throw new DomainError('no_org', 'An active organisation is required to upload files.', 403);
  if (input.data.length === 0) throw new DomainError('empty_file', 'The file is empty.', 400);
  if (input.data.length > MAX_FILE_BYTES) throw new DomainError('file_too_large', 'Files can be at most 10 MB.', 413);
  const safeName = input.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'file';
  const scan = await svc.adapters.fileScanner.scan(safeName, input.data);
  if (scan !== 'clean') throw new DomainError('infected_file', 'This file was rejected by the virus scan.', 422);
  const sha256 = createHash('sha256').update(input.data).digest('hex');
  const id = randomUUID();
  const key = `${ctx.orgId}/${id}`;
  await svc.adapters.objectStore.put(key, input.data);
  const now = svc.clock.now();
  await tx.query(
    `insert into platform.files (id, org_id, filename, content_type, size, sha256, storage_key, scan_status, uploaded_by, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,'clean',$8,$9)`,
    [id, ctx.orgId, safeName, input.contentType, input.data.length, sha256, key, ctx.userId ?? null, now]);
  await audit(tx, ctx, now, { action: 'file.uploaded', entityType: 'file', entityId: id, after: { filename: safeName, sha256, size: input.data.length } });
  return { id, filename: safeName, sha256, size: input.data.length };
}

export async function readFile(tx: Tx, svc: Services, id: string) {
  const f = await tx.maybe<any>('select * from platform.files where id = $1', [id]); // RLS decides visibility
  if (!f) throw notFound('File');
  const data = await svc.adapters.objectStore.get(f.storage_key);
  return { meta: f, data };
}

/** Make a file visible to other organisations (e.g. an invoice document shared with the buyer and invited banks). */
export async function shareFile(tx: Tx, fileId: string, orgIds: string[]) {
  await tx.query(
    `update platform.files set shared_with = (select array(select distinct unnest(shared_with || $2::uuid[]))) where id = $1`, [fileId, orgIds]);
}
