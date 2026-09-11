import { test, expect } from '@playwright/test';

test('top page loads', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1, h2, [role="heading"]')).toBeVisible();
});
