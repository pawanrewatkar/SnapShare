import { expect, test } from '@playwright/test';

test('landing, privacy and terms pages render', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Google Drive');
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible();
  await expect(page.getByText('drive.file').first()).toBeVisible();
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: 'Terms of Service' })).toBeVisible();
});

test('share page: invalid, revoked and expired links show clear states without leaking data', async ({ page }) => {
  const res = await page.goto('/s/not-a-real-token');
  await expect(page.getByRole('heading', { name: 'Link not found' })).toBeVisible();
  expect(res?.headers()['referrer-policy']).toBe('no-referrer');
  expect(res?.headers()['x-robots-tag']).toContain('noindex');
  await page.goto(`/s/${'r'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'This link was revoked' })).toBeVisible();
  await page.goto(`/s/${'e'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('e2e-file');
  await expect(page.locator('body')).not.toContainText('e2e@example.com');
});

test('public API returns 404/410 and security headers', async ({ request }) => {
  expect((await request.get('/api/public/shares/nope')).status()).toBe(404);
  const revoked = await request.get(`/api/public/shares/${'r'.repeat(43)}`);
  expect(revoked.status()).toBe(410);
  expect((await revoked.json()).status).toBe('revoked');
  expect((await request.get(`/api/public/shares/${'e'.repeat(43)}/content`)).status()).toBe(410);
  const home = await request.get('/');
  expect(home.headers()['x-frame-options']).toBe('DENY');
  expect(home.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect((await request.get('/api/assets')).status()).toBe(401);
});
