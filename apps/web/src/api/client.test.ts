import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ensureOk, uploadFile } from './client';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const call = (fetchImpl: () => Promise<Response>) =>
  api.POST('/api/v1/invoices/{id}/submit', { params: { path: { id: 'x' } }, baseUrl: 'http://test', fetch: fetchImpl } as any);

afterEach(() => { vi.unstubAllGlobals(); });

describe('API error messages', () => {
  it("shows the server's problem message, not a body-already-read error", async () => {
    const r = await call(async () => json(422, { code: 'missing_documents', message: 'Add the commercial invoice before submitting.', details: null }));
    await expect(ensureOk(r)).rejects.toThrow('Add the commercial invoice before submitting.');
  });

  it('turns a response without a problem body into a plain-language message', async () => {
    const r = await call(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect((r.error as any).message).toBe('The server could not complete this request. Please try again in a moment.');
    await expect(ensureOk(r)).rejects.toThrow('The server could not complete this request.');
    const nf = await call(async () => json(404, { message: 'Route POST:/api/v1/x not found', error: 'Not Found', statusCode: 404 }));
    expect((nf.error as any).message).toMatch(/^We could not find what you asked for/);
  });

  it('explains a network failure instead of "Failed to fetch"', async () => {
    const r = await call(async () => { throw new TypeError('Failed to fetch'); });
    await expect(ensureOk(r)).rejects.toThrow('Could not reach the server. Check your connection and try again.');
  });

  it("uploads report the server's reason, or a plain fallback for non-JSON bodies", async () => {
    const file = new File(['x'], 'a.pdf');
    vi.stubGlobal('fetch', async () => json(413, { code: 'file_too_large', message: 'Files can be at most 10 MB.', details: null }));
    await expect(uploadFile(file)).rejects.toThrow('Files can be at most 10 MB.');
    vi.stubGlobal('fetch', async () => new Response('Payload Too Large', { status: 413 }));
    await expect(uploadFile(file)).rejects.toThrow('The upload is too large.');
    vi.stubGlobal('fetch', async () => json(201, { id: 'f1' }));
    await expect(uploadFile(file)).resolves.toBe('f1');
  });
});
