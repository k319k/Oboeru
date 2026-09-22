import { test, expect } from './fixtures';

test('top page loads', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('h1, h2, [role="heading"]')).toBeVisible();
});
