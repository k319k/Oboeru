import type { Page } from '@playwright/test';

/**
 * Navigate to the app and optionally seed localStorage with test data.
 * After injection, reloads the page so SvelteKit reads the seeded state.
 */
export async function gotoWithSeed(
	page: Page,
	seed?: { chapters?: unknown[]; tracks?: unknown[]; sentences?: unknown[] }
): Promise<void> {
	await page.goto('/');
	if (seed) {
		await page.evaluate((data) => {
			localStorage.setItem('oboeru:v1', JSON.stringify(data));
		}, seed);
		await page.reload();
	}
}

/**
 * Write the raw practice-history payloads. `gotoWithSeed` only ever writes
 * `oboeru:v1`, so the history keys need their own helper — without this the
 * streak pill, dot rows and the collapsible history section never render in a
 * test at all. The real shapes are owned by `src/lib/history.ts`; this stays
 * `unknown` on purpose so a seed can also carry deliberately-broken data.
 *
 * Call AFTER `gotoWithSeed` — this helper owns the reload that makes the app
 * re-read storage.
 */
export async function seedHistory(page: Page, history: unknown, ui?: unknown): Promise<void> {
	await page.evaluate(
		({ h, u }) => {
			localStorage.setItem('oboeru:history:v1', JSON.stringify(h));
			// `u == null` (not `!== null`) so an omitted ui never writes the
			// literal string "undefined" over a valid key.
			if (u != null) localStorage.setItem('oboeru:history-ui:v1', JSON.stringify(u));
		},
		{ h: history, u: ui ?? null }
	);
	await page.reload();
}
