import { test, expect, type Page } from './fixtures';

/**
 * Open manage › 設定 and return the 3 theme radio buttons.
 *
 * `networkidle` is required: the tab strip is in the SSR HTML before Svelte
 * attaches its click handler during hydration, so a click issued earlier is
 * lost and the settings panel stays `hidden`.
 */
async function openThemeControls(page: Page) {
	await page.goto('/manage');
	await page.waitForLoadState('networkidle');
	await page.getByRole('tab', { name: '設定' }).click();
	await expect(page.getByTestId('theme-system')).toBeVisible();
}

test.describe('Theme', () => {
	test('defaults to system; selecting dark then light pins the theme', async ({ page }) => {
		await openThemeControls(page);
		const html = page.locator('html');

		// Default (system → light in headless Chromium) → no .dark
		await expect(html).not.toHaveClass(/dark/);
		await expect(page.getByTestId('theme-system')).toBeChecked();

		await page.getByTestId('theme-dark').click();
		await expect(html).toHaveClass(/dark/);

		await page.getByTestId('theme-light').click();
		await expect(html).not.toHaveClass(/dark/);
	});

	test('theme persists across reload', async ({ page }) => {
		await openThemeControls(page);
		await page.getByTestId('theme-dark').click();
		await expect(page.locator('html')).toHaveClass(/dark/);

		await page.reload();
		await expect(page.locator('html')).toHaveClass(/dark/);
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByTestId('theme-dark')).toBeChecked();
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
		await page.goto('/manage');
		await page.waitForLoadState('networkidle');
		const html = page.locator('html');

		// system + dark OS → dark
		await expect(html).toHaveClass(/dark/);

		await page.getByRole('tab', { name: '設定' }).click();
		await page.getByTestId('theme-light').click();
		await expect(html).not.toHaveClass(/dark/);

		// OS changes no longer affect the explicit choice
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(html).not.toHaveClass(/dark/);
	});
});
