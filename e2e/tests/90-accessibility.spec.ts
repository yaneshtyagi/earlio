import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { signIn, user } from './helpers';

// WCAG 2.1 AA on the key page of each role, in English and Hindi, at desktop and phone widths.
const PAGES: Array<{ who: string; email: string; paths: string[] }> = [
  { who: 'supplier', email: user('kumar', 'FinanceUser'), paths: ['/', '/invoices', '/recourse', '/relationships'] },
  { who: 'buyer', email: user('northwind', 'FinanceUser'), paths: ['/', '/invoices?status=Submitted', '/payments'] },
  { who: 'bank', email: user('kestrel', 'CreditOfficer'), paths: ['/', '/bank/invitations', '/limits'] },
  { who: 'insurer', email: user('sentinel', 'Underwriter'), paths: ['/', '/insurance/requests'] },
  { who: 'platform', email: user('earlio', 'PlatformAdmin'), paths: ['/', '/admin/scorecard', '/audit'] },
];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

for (const lang of ['en', 'hi'] as const) {
  for (const size of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    for (const p of PAGES) {
      test(`axe ${p.who} ${lang} ${size.name}`, async ({ page }) => {
        await page.setViewportSize(size);
        await page.addInitScript((l) => { try { localStorage.setItem('earlio.lang', l); } catch { /* ignore */ } }, lang);
        await signIn(page, p.email);
        for (const path of p.paths) {
          await page.goto(path);
          await expect(page.getByRole('main')).toBeVisible();
          await page.waitForLoadState('networkidle');
          const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} on ${path} (${v.help})`), `${p.who} ${path}`).toEqual([]);
          if (size.name === 'phone') expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll on ${path}`).toBeTruthy();
        }
      });
    }
  }
}
