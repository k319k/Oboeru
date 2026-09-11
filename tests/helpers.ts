import type { Page } from '@playwright/test';

/**
 * Navigate to the app and optionally seed localStorage with test data.
 * After injection, reloads the page so SvelteKit reads the seeded state.
 */
export async function gotoWithSeed(
	page: Page,
	seed?: { chapters?: unknown[]; sentences?: unknown[] }
): Promise<void> {
	await page.goto('/');
	if (seed) {
		await page.evaluate((data) => {
			localStorage.setItem('oboeru:v1', JSON.stringify(data));
		}, seed);
		await page.reload();
	}
}
