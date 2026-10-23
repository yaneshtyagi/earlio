import createClient from 'openapi-fetch';
import type { paths } from './schema';

let csrf = '';
export const setCsrfToken = (t: string) => { csrf = t; };

/** Typed client generated from docs/openapi.json. Cookies carry the session; CSRF header on writes. */
export const api = createClient<paths>({ baseUrl: '', credentials: 'include' });
api.use({
  onRequest({ request }) {
    if (csrf && request.method !== 'GET' && request.method !== 'HEAD') request.headers.set('x-csrf-token', csrf);
    return request;
  },
});

export interface ApiProblem { code: string; message: string; details?: unknown }
export const problemOf = (e: unknown): ApiProblem =>
  e && typeof e === 'object' && 'message' in e ? (e as ApiProblem) : { code: 'unknown', message: 'Something went wrong.' };

/** For endpoints whose OpenAPI declares only success responses: throw the server's problem message on a non-2xx result. */
export async function ensureOk(r: { response: Response }): Promise<void> {
  if (r.response.ok) return;
  const body = await r.response.clone().json().catch(() => null);
  throw new Error(problemOf(body).message);
}
