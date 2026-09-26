import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import playwrightConfig from '../playwright.config';
import { test, expect, type Page } from './fixtures';
import { loudWavBytes, mockTtsApi, silentWavBytes } from './tts-mock';

/**
 * Deterministic loud-source coverage for the level history meter's 56px clamp.
 *
 * Why this file exists
 * --------------------
 * The level history bars are clamped in the template:
 * `Math.max(3, Math.min(56, Math.round(level * 224)))`. Verifying that clamp
 * needs a *loud* sample, because quiet samples floor out at 3px and can never
 * exceed 56.
 *
 * Chromium's built-in fake audio device emits a **bursty** beep — one loud beep
 * per 500ms, silence in between — and a parallel Playwright worker throttles
 * requestAnimationFrame, so the loud sample often never arrives. Measured over 6
 * runs of the bursty-source test, the maximum declared height at the assert
 * point was `[10, 80, 5, 9, 86, 80]`: three of the six runs saw only 5–10px
 * samples. A dropped clamp therefore slipped through 5 runs out of 6 (83% false
 * negative), while the sibling test's `> 3` check passed happily because the
 * 3px floor still counts as "loud enough" for it.
 *
 * The fix is to stop depending on the built-in beep: feed a **continuous** loud
 * tone through `--use-file-for-fake-audio-capture`. Every sample then saturates,
 * so the clamp assertion is deterministic.
 *
 * Why a separate spec file
 * ------------------------
 * `test.use({ launchOptions })` forces a new browser and Playwright rejects it
 * inside a `describe` group ("Cannot use({ launchOptions }) in a describe group").
 * A dedicated file is the supported way to scope a launch option to a subset of
 * tests while leaving the rest of the suite on the default fake device.
 */

const STORAGE_KEY = 'oboeru:v1';
const SETTINGS_KEY = 'oboeru:settings:v1';

// Written to the OS temp dir, never into the repo. Amplitude and frequency are
// fixed inside loudWavBytes() so the bar heights stay reproducible.
const loudWavPath = join(tmpdir(), `oboeru-loud-tone-${process.pid}.wav`);
writeFileSync(loudWavPath, loudWavBytes());

// Inherit the project-level Chromium args rather than restating them, so this
// file cannot silently drop --use-fake-device-for-media-stream /
// --use-fake-ui-for-media-stream (or any arg added to the config later).
const baseChromiumArgs = playwrightConfig.projects?.[0]?.use?.launchOptions?.args ?? [];

test.use({
	launchOptions: {
		args: [...baseChromiumArgs, `--use-file-for-fake-audio-capture=${loudWavPath}`]
	}
});

/** Seed one chapter + one sentence and mock the scoring APIs, then navigate. */
async function setupPractice(page: Page) {
	await page.addInitScript(
		({ storageKey, settingsKey, chapters, sentences, settings }) => {
			localStorage.setItem(storageKey, JSON.stringify({ chapters, sentences }));
			localStorage.setItem(settingsKey, JSON.stringify(settings));
		},
		{
			storageKey: STORAGE_KEY,
			settingsKey: SETTINGS_KEY,
			chapters: [{ id: 'ch-ja-01', name: '日本語', parentId: null, order: 1 }],
			sentences: [
				{
					id: 'ja-01',
					chapterId: 'ch-ja-01',
					text: 'おはようございます。',
					language: 'ja',
					order: 1
				}
			],
			settings: { threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' }
		}
	);

	await page.route('**/api/tts', (route) =>
		route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWavBytes(80) })
	);
	await page.route('**/api/transcribe', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ text: 'おはようございます。' })
		})
	);
	// Registered first; matches last-registered-first, so this stays the fallback.
	await page.route('**/api/judge', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ available: false })
		})
	);

	await page.goto('/practice?chapter=ch-ja-01');
}

test.describe('level history overflow — deterministic loud source', () => {
	test('every bar is clamped to the 56px content box', async ({ page }) => {
		await setupPractice(page);
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10000 });

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 10000 });

		// Safe to wait on saturation here (unlike the bursty-source test in
		// practice.spec.ts): the continuous tone makes every sample loud, so the
		// loud predicate can no longer be starved by rAF throttling.
		await page.waitForFunction(
			() => {
				const bars = document.querySelectorAll('[data-testid="level-history"] span');
				return (
					bars.length >= 8 &&
					[...bars].some((b) => parseFloat((b as HTMLElement).style.height) === 56)
				);
			},
			null,
			{ timeout: 15000 }
		);

		const observed = await page.evaluate(() => {
			const row = document.querySelector<HTMLElement>('[data-testid="level-history"]');
			if (!row) throw new Error('level-history is missing');
			const rr = row.getBoundingClientRect();
			const cs = getComputedStyle(row);
			const contentTop = rr.top + parseFloat(cs.paddingTop);
			const contentBottom = rr.bottom - parseFloat(cs.paddingBottom);
			const bars = [...row.querySelectorAll('span')];
			return {
				contentBoxHeight: contentBottom - contentTop,
				tallestBarHeight: Math.max(...bars.map((b) => b.getBoundingClientRect().height)),
				barCount: bars.length,
				declaredHeights: bars.map((b) => parseFloat((b as HTMLElement).style.height))
			};
		});

		// The regression assertion. With the clamp reverted to
		// `Math.round(level * 260)`, a saturated sample declares ~120px and both
		// of these fail loudly instead of passing 5 times out of 6.
		expect(observed.declaredHeights.length).toBe(observed.barCount);
		for (const h of observed.declaredHeights) {
			expect(h).toBeLessThanOrEqual(56);
		}

		// And the loud end really was reached — otherwise the loop above would be
		// vacuous (3px floor always satisfies `<= 56`).
		expect(Math.max(...observed.declaredHeights)).toBe(56);

		// The layout invariant: the tallest bar does not escape the padding box.
		expect(observed.tallestBarHeight).toBeLessThanOrEqual(observed.contentBoxHeight + 0.5);

		await page.keyboard.up('Space');
	});
});
