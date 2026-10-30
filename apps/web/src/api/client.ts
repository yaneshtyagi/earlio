import createClient from 'openapi-fetch';
import type { paths } from './schema';

let csrf = '';
export const setCsrfToken = (t: string) => { csrf = t; };

export interface ApiProblem { code: string; message: string; details?: unknown }

const isProblem = (e: unknown): e is ApiProblem =>
  !!e && typeof e === 'object' && typeof (e as ApiProblem).code === 'string' && typeof (e as ApiProblem).message === 'string';

/** Plain-language fallback when an error response carries no problem body (proxy errors, framework 404s, empty bodies). */
export function statusMessage(status: number): string {
  if (status === 401) return 'Your session has ended. Please sign in again.';
  if (status === 403) return 'You do not have permission to do this.';
  if (status === 404) return 'We could not find what you asked for. It may have been removed, or the link is out of date.';
  if (status === 413) return 'The upload is too large.';
  if (status === 429) return 'Too many requests. Please wait and try again.';
  if (status >= 500) return 'The server could not complete this request. Please try again in a moment.';
  return `The request could not be completed (HTTP ${status}).`;
}

const problemResponse = (status: number, problem: ApiProblem) =>
  new Response(JSON.stringify(problem), { status, headers: { 'content-type': 'application/json' } });

/** Typed client generated from docs/openapi.json. Cookies carry the session; CSRF header on writes. */
export const api = createClient<paths>({ baseUrl: '', credentials: 'include' });
api.use({
  onRequest({ request }) {
    if (csrf && request.method !== 'GET' && request.method !== 'HEAD') request.headers.set('x-csrf-token', csrf);
    return request;
  },
  // Every non-2xx result reaches callers as an ApiProblem, so `r.error.message` is always something a user can read.
  async onResponse({ response }) {
    if (response.ok) return response;
    const body = await response.clone().json().catch(() => null);
    if (isProblem(body)) return response;
    return problemResponse(response.status, { code: 'http_error', message: statusMessage(response.status) });
  },
  onError() {
    return problemResponse(503, { code: 'network', message: 'Could not reach the server. Check your connection and try again.' });
  },
});

export const problemOf = (e: unknown): ApiProblem =>
  isProblem(e) ? e : { code: 'unknown', message: 'Something went wrong. Please try again.' };

/** For endpoints whose OpenAPI declares only success responses: throw the server's problem message on a non-2xx result. */
export async function ensureOk(r: { response: Response; error?: unknown }): Promise<void> {
  if (r.response.ok) return;
  // openapi-fetch has already read the body into `r.error`; the response body itself can no longer be read.
  throw new Error(isProblem(r.error) ? r.error.message : statusMessage(r.response.status));
}

/** Uploads a file (raw body) and returns its id; throws with the server's plain-language reason on failure. */
export async function uploadFile(file: File): Promise<string> {
  let r: Response;
  try {
    r = await fetch(`/api/v1/files?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf }, body: await file.arrayBuffer(),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(isProblem(body) ? body.message : statusMessage(r.status));
  if (!body || typeof body.id !== 'string') throw new Error('The upload did not complete. Please try again.');
  return body.id;
}
