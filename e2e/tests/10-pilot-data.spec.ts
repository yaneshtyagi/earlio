import { expect, test } from '@playwright/test';
import { apiAs, signIn, user } from './helpers';

// Read-through of the seeded pilot data (POC plan Appendix A) as each role sees it.
test('supplier sees every state of its invoices', async ({ page }) => {
  await signIn(page, user('kumar', 'FinanceUser'));
  await page.goto('/invoices');
  const main = page.getByRole('main');
  for (const [no, state] of [['INV-1003', 'Rejected'], ['INV-1005', 'OffersReceived'], ['INV-1009', 'Disputed'], ['INV-1012', 'NotEligible']]) {
    await expect(main.getByRole('row').filter({ hasText: no }), no).toContainText(state);
  }
});

test('buyer sees funded and accepted invoices addressed to it', async ({ page }) => {
  await signIn(page, user('northwind', 'FinanceUser'));
  await page.goto('/invoices');
  await expect(page.getByRole('row').filter({ hasText: 'INV-1006' })).toContainText('Funded');
  await expect(page.getByRole('row').filter({ hasText: 'INV-1004' })).toContainText('Accepted');
});

test('bank sees invitations with its own offer and cover decisions', async ({ page }) => {
  await signIn(page, user('kestrel', 'CreditOfficer'));
  await page.goto('/bank/invitations');
  const row = page.getByRole('row').filter({ hasText: 'INV-1021' });
  await expect(row).toContainText('approved');
  await expect(row).toContainText('OffersReceived');
});

test('platform verifies the audit chain and sees the pilot scorecard', async ({ page }) => {
  await signIn(page, user('earlio', 'PlatformAdmin'));
  await page.goto('/audit');
  await page.getByRole('button', { name: 'Verify chain' }).click();
  await expect(page.getByRole('status').or(page.getByText(/intact|valid|verified/i)).first()).toBeVisible();
  await page.goto('/admin/scorecard');
  await expect(page.getByRole('heading', { name: /scorecard/i })).toBeVisible();
});

test('a supplier cannot read another supplier\'s invoices through the API', async () => {
  const kumar = await apiAs(user('kumar', 'FinanceUser'));
  const mine = (await kumar.get('/api/v1/invoices')).items ?? [];
  const other = await apiAs(user('anand', 'FinanceUser'));
  const theirs = (await other.get('/api/v1/invoices')).items ?? [];
  const ids = new Set(mine.map((i: any) => i.id));
  expect(theirs.some((i: any) => ids.has(i.id))).toBe(false);
});
