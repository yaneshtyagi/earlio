import { expect, test } from '@playwright/test';
import { PASSWORD, autoDialogs, signIn, user } from './helpers';

// J-0: a supplier registers, completes KYC, is approved by the platform, and links to a buyer that approves from its side.
test('J-0 onboarding and relationship linking', async ({ page }) => {
  autoDialogs(page);
  const tag = String(Date.now()).slice(-6); // unique per run so the journey can be repeated against the same database
  const name = `Brightloom Garments ${tag}`;
  const email = `owner${tag}@brightloom.test`;
  await page.goto('/register');
  await page.getByLabel('Legal name').fill(name);
  await page.getByLabel('Country (2-letter code)').fill('IN');
  await page.getByLabel('Annual turnover (INR)').fill('45000000');
  await page.getByLabel('Your name').fill('Meera Joshi');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByRole('heading', { name: 'Registered' })).toBeVisible();

  // first sign-in asks for the authenticator code (and shows recovery codes when it has just been enrolled)
  await page.goto('/');
  await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Use demo code/ }).click();
  await page.getByRole('button', { name: 'Verify' }).click();
  const saved = page.getByRole('button', { name: 'I have saved them' });
  await expect(saved.or(page.getByRole('navigation', { name: 'Main' }))).toBeVisible();
  if (await saved.isVisible()) await saved.click();
  await page.getByRole('link', { name: 'KYC application' }).click();

  // upload every required document
  await expect(page.getByRole('button', { name: 'Upload' }).first()).toBeVisible();
  const missing = page.getByRole('row').filter({ hasText: 'missing' });
  const count = await missing.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('row').filter({ hasText: 'missing' }).first().getByRole('button', { name: 'Upload' }).click();
    await (await chooser).setFiles({ name: `doc-${i}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(`document ${i}`) });
    await expect(page.getByRole('row').filter({ hasText: 'missing' })).toHaveCount(count - i - 1);
  }
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText(/Submitted\. A platform reviewer|in_review/).first()).toBeVisible();

  // the platform approves it
  await signIn(page, user('earlio', 'PlatformAdmin'));
  await page.getByRole('link', { name: 'KYC queue' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0);

  // the new supplier proposes a link with a buyer; the buyer approves
  await signIn(page, email);
  await page.getByRole('link', { name: 'Relationships' }).click();
  await page.getByPlaceholder(/Search by name/).fill('Northwind');
  await page.getByRole('row').filter({ hasText: 'Northwind Retail' }).getByRole('button', { name: 'Propose' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Northwind' }).getByText('pending')).toBeVisible();
  await signIn(page, user('northwind', 'Approver'));
  await page.getByRole('link', { name: 'Relationships' }).click();
  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('row').filter({ hasText: name }).getByText('pending')).toBeVisible(); // both sides must approve
  // a different person at the supplier must approve what the proposer started: the admin adds an approver
  await signIn(page, email);
  await page.getByRole('link', { name: 'Users' }).click();
  await page.getByLabel('Name').fill('Ravi Menon'); await page.getByLabel('Work email').fill(`approver${tag}@brightloom.test`);
  await page.getByLabel('Role').selectOption('Approver'); await page.getByLabel('Starting password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('status')).toContainText('Ravi Menon was added');
  await page.context().clearCookies(); await page.goto('/');
  await page.getByLabel('Email').fill(`approver${tag}@brightloom.test`); await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /Use demo code/ }).click(); await page.getByRole('button', { name: 'Verify' }).click();
  const saved2 = page.getByRole('button', { name: 'I have saved them' });
  await expect(saved2.or(page.getByRole('navigation', { name: 'Main' }))).toBeVisible();
  if (await saved2.isVisible()) await saved2.click();
  await page.getByRole('link', { name: 'Relationships' }).click();
  await page.getByRole('row').filter({ hasText: 'Northwind' }).getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Northwind' }).getByText('active')).toBeVisible();
});
