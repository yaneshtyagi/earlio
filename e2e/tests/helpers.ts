import { expect, type APIRequestContext, type Page, request } from '@playwright/test';

export const API = process.env.E2E_API ?? 'http://localhost:4000';
export const PASSWORD = 'Earlio!Demo1';

/** Sign in through the real login form, using the development-only demo TOTP helper. */
export async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Use demo code/ }).click();
  await expect(page.getByLabel('Authentication code')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

export const user = (slug: string, role: string) => `${({ Admin: 'admin', FinanceUser: 'finance', Approver: 'approver', Viewer: 'viewer', CreditOfficer: 'credit', Operations: 'ops', RelationshipManager: 'rm', Underwriter: 'underwriter', ClaimsHandler: 'claims', PlatformAdmin: 'admin', Auditor: 'auditor' } as Record<string, string>)[role]}@${slug}.demo`;

/** A logged-in API client for set-up and clock control that the UI should not need to do (the clock is a demo-only control). */
export async function apiAs(email: string): Promise<{ ctx: APIRequestContext; csrf: string; get: (u: string) => Promise<any>; post: (u: string, b?: unknown) => Promise<{ status: number; json: any }>; put: (u: string, b?: unknown) => Promise<{ status: number; json: any }> }> {
  const ctx = await request.newContext({ baseURL: API });
  const l = await ctx.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const { csrfToken } = await l.json();
  const code = (await (await ctx.get(`/api/v1/dev/totp?email=${encodeURIComponent(email)}`)).json()).code;
  expect((await ctx.post('/api/v1/auth/mfa/verify', { data: { code }, headers: { 'x-csrf-token': csrfToken } })).ok()).toBeTruthy();
  const h = { 'x-csrf-token': csrfToken };
  const wrap = async (r: any) => ({ status: r.status(), json: await r.json().catch(() => null) });
  return { ctx, csrf: csrfToken, get: async (u) => (await ctx.get(u)).json(), post: async (u, b) => wrap(await ctx.post(u, { data: b, headers: h })), put: async (u, b) => wrap(await ctx.put(u, { data: b, headers: h })) };
}

/** Scenario invoices from the pilot seed (Appendix A), by label. */
export async function scenario(label: string): Promise<{ id: string; humanId: string; state: string }> {
  const a = await apiAs(user('earlio', 'PlatformAdmin'));
  const res = await a.get('/api/v1/admin/demo/scenarios');
  const hit = res.items.find((x: any) => x.label === label);
  if (!hit) throw new Error(`no scenario ${label}`);
  return hit;
}
export async function moveClock(args: { advanceHours?: number; advanceDays?: number; setTo?: string }) {
  const a = await apiAs(user('earlio', 'PlatformAdmin'));
  expect((await a.post('/api/v1/admin/clock', args)).status).toBe(200);
}

/** Several admin actions ask for a reason with a browser prompt/confirm: answer them. */
export function autoDialogs(page: Page, answer = 'Verified in the end-to-end run') {
  page.on('dialog', (d) => { void (d.type() === 'prompt' ? d.accept(answer) : d.accept()); });
}
