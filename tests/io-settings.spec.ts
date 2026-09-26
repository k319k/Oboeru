import { test, expect } from './fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oboeru:v1';
const SETTINGS_KEY = 'oboeru:settings:v1';

/** Seed localStorage with chapters and sentences before navigating. */
async function seedData(page: import('@playwright/test').Page) {
	const chapters = [
		{ id: 'ch-ja-01', name: 'はじめの一歩（日本語）', parentId: null, order: 1 },
		{ id: 'ch-en-01', name: 'First Steps（English）', parentId: null, order: 2 }
	];
	const sentences = [
		{
			id: 'ja-01',
			chapterId: 'ch-ja-01',
			text: 'おはようございます。',
			language: 'ja',
			order: 1
		},
		{
			id: 'en-01',
			chapterId: 'ch-en-01',
			text: 'Good morning.',
			language: 'en',
			order: 1
		}
	];

	await page.addInitScript(({ storageKey, settingsKey, chapters, sentences }) => {
		// Only seed if the key is absent so that reloads (which re-run this
		// script) do not clobber values the test just persisted.
		if (!localStorage.getItem(storageKey)) {
			localStorage.setItem(
				storageKey,
				JSON.stringify({ chapters, sentences })
			);
		}
		if (!localStorage.getItem(settingsKey)) {
			localStorage.setItem(
				settingsKey,
				JSON.stringify({
					threshold: 80,
					ttsRate: 1.0,
					voiceURI: null,
					retryFrom: 'tts'
				})
			);
		}
	}, {
		storageKey: STORAGE_KEY,
		settingsKey: SETTINGS_KEY,
		chapters,
		sentences
	});

	// Navigate and wait for hydration. Chapter rows only render after the
	// $effect loads localStorage during hydration; interacting before that
	// loses clicks (event handlers not yet attached) — the same pattern as
	// manage.spec.ts's gotoManage().
	await page.goto('/manage');
	await page.waitForSelector('[data-testid="chapter-name"]', { timeout: 10000 });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

test.describe('JSON Export', () => {
	test('clicking export triggers file download', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const downloadPromise = page.waitForEvent('download');
		await page.getByTestId('export-button').click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^oboeru-export-\d{8}\.json$/);

		// Read the downloaded content and verify structure
		const path = await download.path();
		expect(path).toBeTruthy();

		const content = await download.path().then(async (p) => {
			const fs = await import('fs/promises');
			return fs.readFile(p!, 'utf-8');
		});
		const data = JSON.parse(content);

		expect(data.version).toBe(2);
		expect(data.exportedAt).toBeTruthy();
		expect(Array.isArray(data.chapters)).toBe(true);
		expect(Array.isArray(data.tracks)).toBe(true);
		expect(Array.isArray(data.sentences)).toBe(true);
		expect(data.chapters.length).toBeGreaterThanOrEqual(2);
		// Old-format seeds are shimmed: one default track per chapter
		expect(data.tracks.length).toBeGreaterThanOrEqual(2);
		expect(data.sentences.length).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// Import — Valid
// ---------------------------------------------------------------------------

test.describe('JSON Import — Valid', () => {
	test('importing a valid JSON adds new sentences and shows summary', async ({
		page
	}) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		// Create a valid import file (v2: tracks required)
		const importData = {
			version: 2,
			exportedAt: new Date().toISOString(),
			chapters: [
				{
					id: 'ch-import-01',
					name: 'インポートチャプター',
					parentId: null,
					order: 3
				}
			],
			tracks: [
				{
					id: 'tr-import-01',
					chapterId: 'ch-import-01',
					name: 'トラック1',
					order: 1
				}
			],
			sentences: [
				{
					id: 'imported-01',
					chapterId: 'ch-import-01',
					trackId: 'tr-import-01',
					text: 'インポートされた文章です。',
					language: 'ja',
					order: 1
				},
				{
					id: 'imported-02',
					chapterId: 'ch-import-01',
					trackId: 'tr-import-01',
					text: 'Another imported sentence.',
					language: 'en',
					order: 2
				}
			]
		};

		const fileContent = JSON.stringify(importData);

		// Upload the file
		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'import.json',
			mimeType: 'application/json',
			buffer: Buffer.from(fileContent)
		});

		// Verify success message
		const message = page.getByTestId('import-message');
		await expect(message).toBeVisible();
		await expect(message).toContainText('1件のチャプター');
		await expect(message).toContainText('1件のトラック');
		await expect(message).toContainText('2件の文章をインポートしました');
		await expect(message).toHaveClass(/success/);
	});
});

// ---------------------------------------------------------------------------
// Import — Overwrite existing by ID
// ---------------------------------------------------------------------------

test.describe('JSON Import — Merge', () => {
	test('importing with existing IDs overwrites', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		// Import with the same chapter/track/sentence IDs but different values
		const importData = {
			version: 2,
			exportedAt: new Date().toISOString(),
			chapters: [
				{
					id: 'ch-ja-01',
					name: '上書きされたチャプター',
					parentId: null,
					order: 1
				}
			],
			tracks: [
				{
					id: 'tr-ch-ja-01',
					chapterId: 'ch-ja-01',
					name: '上書きトラック',
					order: 1
				}
			],
			sentences: [
				{
					id: 'ja-01',
					chapterId: 'ch-ja-01',
					trackId: 'tr-ch-ja-01',
					text: '上書きされた文章。',
					language: 'ja',
					order: 1
				}
			]
		};

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'merge.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(importData))
		});

		const message = page.getByTestId('import-message');
		await expect(message).toContainText('インポートしました');

		// Verify localStorage has overwritten data
		const stored = await page.evaluate((key) => {
			return JSON.parse(localStorage.getItem(key)!);
		}, STORAGE_KEY);

		const overwrittenChapter = stored.chapters.find(
			(c: { id: string }) => c.id === 'ch-ja-01'
		);
		expect(overwrittenChapter.name).toBe('上書きされたチャプター');

		const overwrittenSentence = stored.sentences.find(
			(s: { id: string }) => s.id === 'ja-01'
		);
		expect(overwrittenSentence.text).toBe('上書きされた文章。');

		const overwrittenTrack = stored.tracks.find(
			(t: { id: string }) => t.id === 'tr-ch-ja-01'
		);
		expect(overwrittenTrack.name).toBe('上書きトラック');
	});
});

// ---------------------------------------------------------------------------
// Import — Invalid JSON
// ---------------------------------------------------------------------------

test.describe('JSON Import — Invalid', () => {
	test('importing invalid JSON shows error', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'bad.json',
			mimeType: 'application/json',
			buffer: Buffer.from('not valid json {{{')
		});

		const message = page.getByTestId('import-message');
		await expect(message).toBeVisible();
		await expect(message).toContainText('不正なJSONファイルです');
		await expect(message).toHaveClass(/error/);
	});

	test('importing missing chapters array shows error', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const importData = {
			version: 2,
			tracks: [],
			sentences: []
			// chapters missing
		};

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'no-chapters.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(importData))
		});

		const message = page.getByTestId('import-message');
		await expect(message).toContainText('チャプターデータがありません');
	});

	test('importing missing tracks array shows error', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const importData = {
			version: 2,
			chapters: [],
			sentences: []
			// tracks missing
		};

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'no-tracks.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(importData))
		});

		const message = page.getByTestId('import-message');
		await expect(message).toContainText('トラックデータがありません');
	});

	test('importing missing sentences array shows error', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const importData = {
			version: 2,
			chapters: [],
			tracks: []
			// sentences missing
		};

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'no-sentences.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(importData))
		});

		const message = page.getByTestId('import-message');
		await expect(message).toContainText('文章データがありません');
	});
});

// ---------------------------------------------------------------------------
// Import — Version mismatch
// ---------------------------------------------------------------------------

test.describe('JSON Import — Version Mismatch', () => {
	test('importing version 1 (pre-tracks format) shows error', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const importData = {
			version: 1,
			exportedAt: new Date().toISOString(),
			chapters: [],
			sentences: []
		};

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'v1.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(importData))
		});

		const message = page.getByTestId('import-message');
		await expect(message).toContainText('対応していないバージョンです');
	});
});

// ---------------------------------------------------------------------------
// Settings — Threshold persistence
// ---------------------------------------------------------------------------

test.describe('Settings — Threshold', () => {
	test('changing threshold persists across reload', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: '設定' }).click();

		// Verify default value
		await expect(page.getByTestId('threshold-value')).toHaveText('80');

		// Change threshold via keyboard (80 → 50, step 1). shadcn Slider renders
		// a role="slider" thumb (no native <input type="range">), so `.fill()`
		// cannot be used — arrow keys adjust by one step each.
		const thresholdSlider = page.getByTestId('threshold-slider').getByRole('slider');
		await thresholdSlider.focus();
		for (let i = 0; i < 30; i++) {
			await thresholdSlider.press('ArrowLeft');
		}

		// Verify display updates
		await expect(page.getByTestId('threshold-value')).toHaveText('50');

		// Reload and verify persistence. Reload resets the tab to the default
		// (チャプター), so re-select 設定 before asserting the visible value.
		await page.reload();
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByTestId('threshold-value')).toHaveText('50');

		// Also verify localStorage
		const stored = await page.evaluate((key) => {
			return JSON.parse(localStorage.getItem(key)!);
		}, SETTINGS_KEY);
		expect(stored.threshold).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// Settings — TTS Speed persistence
// ---------------------------------------------------------------------------

test.describe('Settings — TTS Speed', () => {
	test('changing TTS speed persists across reload', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: '設定' }).click();

		// Verify default value
		await expect(page.getByTestId('tts-rate-value')).toHaveText('1.0');

		// Change speed via keyboard (1.0 → 1.5, step 0.1)
		const ttsSlider = page.getByTestId('tts-speed-slider').getByRole('slider');
		await ttsSlider.focus();
		for (let i = 0; i < 5; i++) {
			await ttsSlider.press('ArrowRight');
		}

		// Verify display updates
		await expect(page.getByTestId('tts-rate-value')).toHaveText('1.5');

		// Reload and verify persistence. Reload resets the tab to the default
		// (チャプター), so re-select 設定 before asserting the visible value.
		await page.reload();
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByTestId('tts-rate-value')).toHaveText('1.5');

		const stored = await page.evaluate((key) => {
			return JSON.parse(localStorage.getItem(key)!);
		}, SETTINGS_KEY);
		expect(stored.ttsRate).toBe(1.5);
	});
});

// ---------------------------------------------------------------------------
// Settings — Retry From persistence
// ---------------------------------------------------------------------------

test.describe('Settings — Retry From', () => {
	test('changing retry from persists across reload', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: '設定' }).click();

		// Default is TTS
		await expect(page.getByTestId('retry-tts')).toBeChecked();

		// Switch to rerecord
		await page.getByTestId('retry-rerecord').click();
		await expect(page.getByTestId('retry-rerecord')).toBeChecked();

		// Reload and verify. Reload resets the tab to the default (チャプター),
		// so re-select 設定 before asserting the visible radio state.
		await page.reload();
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByTestId('retry-rerecord')).toBeChecked();

		const stored = await page.evaluate((key) => {
			return JSON.parse(localStorage.getItem(key)!);
		}, SETTINGS_KEY);
		expect(stored.retryFrom).toBe('rerecord');
	});
});

// ---------------------------------------------------------------------------
// Settings — Voice select
// ---------------------------------------------------------------------------

test.describe('Settings — Voice Select', () => {
	test('default voice option is デフォルト (言語に応じて自動)', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: '設定' }).click();

		// The trigger should show デフォルト (言語に応じて自動) as the selected value
		const select = page.getByTestId('voice-select');
		await expect(select).toBeVisible();
		await expect(select).toContainText('デフォルト (言語に応じて自動)');

		// The option list contains デフォルト (言語に応じて自動) as the first option
		await select.click();
		await expect(page.getByRole('option', { name: 'デフォルト (言語に応じて自動)' })).toBeVisible();
	});
});
