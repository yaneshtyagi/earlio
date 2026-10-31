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

const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json', 'md', 'log']);
const startsWith = (data: Buffer, ...bytes: number[]) => data.length >= bytes.length && bytes.every((b, i) => data[i] === b);

/**
 * The content type to show a file in the browser as, judged from its bytes (the declared type is untrusted), or null
 * when it cannot be previewed safely. Only inert formats qualify: PDF, raster images and plain UTF-8 text. HTML, SVG
 * and anything else that can run script is never served inline.
 */
export function previewType(filename: string, data: Buffer): string | null {
  if (startsWith(data, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (startsWith(data, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (startsWith(data, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(data, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'; // GIF8
  if (startsWith(data, 0x52, 0x49, 0x46, 0x46) && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (TEXT_EXTENSIONS.has(ext) && !data.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); return 'text/plain; charset=utf-8'; } catch { return null; }
  }
  return null;
}

/** Make a file visible to other organisations (e.g. an invoice document shared with the buyer and invited banks). */
export async function shareFile(tx: Tx, fileId: string, orgIds: string[]) {
  await tx.query(
    `update platform.files set shared_with = (select array(select distinct unnest(shared_with || $2::uuid[]))) where id = $1`, [fileId, orgIds]);
}
