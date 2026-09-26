import { test, expect } from './fixtures';

test.describe('App shell', () => {
	test('skip link: first Tab focuses skip link, Enter moves focus to main content', async ({
		page
	}) => {
		await page.goto('/');

		const skipLink = page.getByRole('link', { name: 'メインコンテンツへ' });
		await expect(skipLink).toBeVisible();

		// First Tab press must land on the skip link (it is the first focusable element)
		await page.keyboard.press('Tab');
		await expect(skipLink).toBeFocused();

		// Enter activates the in-page anchor → focus moves to <main>
		await page.keyboard.press('Enter');
		await expect(page.locator('#main-content')).toBeFocused();
	});

	test('favicon.svg is referenced and served without 404', async ({ page }) => {
		const consoleErrors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text());
		});
		page.on('pageerror', (err) => consoleErrors.push(err.message));

		await page.goto('/');

		await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /favicon\.svg/);

		const response = await page.request.get('/favicon.svg');
		expect(response.status()).toBe(200);

		// Give the browser a moment to fetch the favicon, then assert no 404 surfaced
		await page.waitForTimeout(500);
		expect(consoleErrors.filter((e) => e.includes('404') || e.includes('favicon'))).toEqual([]);
	});

	test('active nav link color matches the --success token (AA green)', async ({ page }) => {
		await page.goto('/');

		const activeLink = page.getByRole('link', { name: 'おぼえる' });
		await expect(activeLink).toHaveClass(/active/);

		// T10 (oboeru-ui-ux-v2): the active link uses --success — --primary
		// (#58cc02) is 2.09:1 as text on white and would fail axe color-contrast.
		const matches = await page.evaluate(() => {
			const link = document.querySelector('nav a.active');
			if (!link) return false;
			const success = getComputedStyle(document.documentElement)
				.getPropertyValue('--success')
				.trim();
			return getComputedStyle(link).color === success;
		});
		expect(matches).toBe(true);
	});

	test('no theme toggle in the global nav; the 3-way control lives in manage › 設定', async ({
		page
	}) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'テーマ切替' })).toHaveCount(0);

		await page.goto('/manage');
		// The tab strip is in the SSR HTML before Svelte attaches its click
		// handler during hydration — an earlier click is lost and the settings
		// panel stays `hidden`.
		await page.waitForLoadState('networkidle');
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByRole('group', { name: '表示テーマ' })).toBeVisible();
		await expect(page.getByTestId('theme-system')).toBeVisible();
		await expect(page.getByTestId('theme-light')).toBeVisible();
		await expect(page.getByTestId('theme-dark')).toBeVisible();
	});
});