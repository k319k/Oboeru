import { test, expect } from './fixtures';

test.describe('Theme', () => {
	test('toggle adds and removes .dark on <html>', async ({ page }) => {
		await page.goto('/');
		// The toggle button exists in the SSR HTML before Svelte attaches its
		// click handler during hydration — wait for hydration to avoid losing
		// the first click to the hydration race.
		await page.waitForLoadState('networkidle');

		const html = page.locator('html');
		const toggle = page.getByRole('button', { name: 'テーマ切替' });

		// Default (system → light in headless Chromium) → no .dark
		await expect(html).not.toHaveClass(/dark/);

		// First click → explicit dark
		await toggle.click();
		await expect(html).toHaveClass(/dark/);
		await expect(page.locator('svg.lucide-moon')).toBeVisible();

		// Second click → explicit light
		await toggle.click();
		await expect(html).not.toHaveClass(/dark/);
		await expect(page.locator('svg.lucide-sun')).toBeVisible();
	});

	test('theme persists across reload', async ({ page }) => {
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const html = page.locator('html');
		const toggle = page.getByRole('button', { name: 'テーマ切替' });

		await toggle.click();
		await expect(html).toHaveClass(/dark/);

		await page.reload();
		await expect(html).toHaveClass(/dark/);
	});

	test('system mode follows prefers-color-scheme', async ({ page }) => {
		// Emulate the OS preference before navigation so the FOUC script sees it
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto('/');

		const html = page.locator('html');
		await expect(html).toHaveClass(/dark/);

		// Switching the OS preference while in system mode updates live
		await page.emulateMedia({ colorScheme: 'light' });
		await expect(html).not.toHaveClass(/dark/);
	});

	test('explicit theme overrides system preference', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const html = page.locator('html');
		const toggle = page.getByRole('button', { name: 'テーマ切替' });

		// system + dark OS → dark
		await expect(html).toHaveClass(/dark/);

		// Click → explicit light, stays light even though the OS is dark
		await toggle.click();
		await expect(html).not.toHaveClass(/dark/);

		// OS changes no longer affect the explicit choice
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(html).not.toHaveClass(/dark/);
	});
});
