import { test, expect, type Page } from './fixtures';
import { gotoWithSeed } from './helpers';
import { defaultChapters, defaultSentences } from '../src/lib/default-sentences';

/**
 * Card of the track whose name is exactly `name`. A plain
 * `filter({ hasText: name })` is not usable here: "トラック1" is a substring of
 * "トラック1-1", so the filter would match both rows and every assertion on the
 * result would run in strict mode against two elements.
 */
function trackCard(page: Page, name: string) {
	const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
	return page.getByTestId('track-card').filter({
		has: page.getByTestId('track-card-name').filter({ hasText: exactName })
	});
}

const NESTED_TRACK_SEED = {
	chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
	tracks: [
		{ id: 't1', chapterId: 'ch-1', name: 'トラック1', order: 1, parentId: null },
		{ id: 't1-1', chapterId: 'ch-1', name: 'トラック1-1', order: 1, parentId: 't1' }
	],
	sentences: [
		{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 },
		{ id: 's2', chapterId: 'ch-1', trackId: 't1-1', text: 'い', language: 'ja', order: 1 }
	]
};

test.describe('Top page', () => {
	test('loads and displays heading おぼえる', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('heading', { name: 'おぼえる' })).toBeVisible();
	});

	test('shows empty state when no chapters', async ({ page }) => {
		await gotoWithSeed(page, { chapters: [], sentences: [] });
		await expect(page.getByText('データがありません。管理画面で追加してください')).toBeVisible();
		await expect(page.getByRole('link', { name: '管理画面で追加する' })).toBeVisible();
	});

	test('lists chapters from default seed data', async ({ page }) => {
		await page.goto('/');
		// Default seed has 2 chapters
		await expect(page.getByText('はじめの一歩（日本語）')).toBeVisible();
		await expect(page.getByText('First Steps（English）')).toBeVisible();
	});

	test('shows the pass count and percentage per chapter', async ({ page }) => {
		await page.goto('/');
		// Each default chapter has 10 sentences, none practised yet — a fresh
		// context has no history, so the row reads "0 of 10 passed".
		await expect(page.getByText('0/10 合格 · 0%').first()).toBeVisible();
	});

	// ---------------------------------------------------------------------------
	// Card UI (T5) — one-tap start, aggregated counts, no 2-step flow
	// ---------------------------------------------------------------------------

	test('cards with direct sentences show a practice start button', async ({ page }) => {
		await page.goto('/');

		const jaCard = page.getByTestId('chapter-card').filter({ hasText: 'はじめの一歩（日本語）' });
		const startButton = jaCard.getByTestId('card-start');
		await expect(startButton).toBeVisible();
		await expect(startButton).toContainText('練習');

		// The old 2-step flow (select chapter → bottom start button) is gone.
		await expect(page.getByRole('button', { name: '練習開始' })).toHaveCount(0);
	});

	test('chapter without direct sentences has no practice start button', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-empty', name: '空のチャプター', parentId: null, order: 1 }],
			sentences: []
		});

		const card = page.getByTestId('chapter-card').filter({ hasText: '空のチャプター' });
		await expect(card).toBeVisible();
		await expect(card.getByTestId('card-start')).toHaveCount(0);
	});

	test('clicking card start navigates to /practice?node= via SPA (no full reload)', async ({
		page
	}) => {
		await page.goto('/');

		const jaCard = page.getByTestId('chapter-card').filter({ hasText: 'はじめの一歩（日本語）' });
		await Promise.all([
			page.waitForURL(/\/practice\?node=ch-ja-01/),
			jaCard.getByTestId('card-start').click()
		]);

		expect(page.url()).toContain('/practice?node=ch-ja-01');
		// SPA navigation: the document is not replaced → exactly one navigation entry.
		const navCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
		expect(navCount).toBe(1);
	});

	test('clicking a track start navigates to /practice?node=<trackId> without a full reload', async ({
		page
	}) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [{ id: 't1', chapterId: 'ch-1', name: 'トラック1', order: 1, parentId: null }],
			sentences: [{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 }]
		});

		const reloads: string[] = [];
		page.on('load', () => reloads.push(page.url()));
		await trackCard(page, 'トラック1').getByTestId('card-start').click();
		await page.waitForURL('**/practice?node=t1');
		expect(reloads).toHaveLength(0);
	});

	test('navigation links are present', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('link', { name: 'おぼえる' })).toBeVisible();
		await expect(page.getByRole('link', { name: '管理', exact: true })).toBeVisible();
	});

	// ---------------------------------------------------------------------------
	// Nested tree — chapters and tracks share one tree
	// ---------------------------------------------------------------------------

	test('tracks are displayed as a tree under their chapter with increasing indentation', async ({
		page
	}) => {
		await gotoWithSeed(page, NESTED_TRACK_SEED);

		await expect(trackCard(page, 'トラック1')).toBeVisible();
		await expect(trackCard(page, 'トラック1-1')).toBeVisible();

		// Depth-first: chapter → track → child track, each level indented deeper.
		const chapterNode = page
			.getByTestId('chapter-card')
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
		const trackNode = trackCard(page, 'トラック1-1').locator(
			'xpath=ancestor::div[contains(@class,"tree-node")][1]'
		);
		const chapterMargin = parseFloat(
			await chapterNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		const trackMargin = parseFloat(
			await trackNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		expect(trackMargin).toBeGreaterThan(chapterMargin);
	});

	test('every row counts the subtree it would actually practise', async ({ page }) => {
		await gotoWithSeed(page, NESTED_TRACK_SEED);

		// 1章 = 1 (トラック1) + 1 (トラック1-1) = 2.
		// トラック1 = its own 1 + its child's 1 = 2 — the session started from
		// トラック1 really does walk both sentences.
		// トラック1-1 = 1 (leaf).
		await expect(
			page.getByTestId('chapter-card').filter({ hasText: '1章' }).getByTestId('chapter-card-count')
		).toHaveText('0/2 合格 · 0%');
		await expect(trackCard(page, 'トラック1-1').getByTestId('track-card-count')).toHaveText(
			'0/1 合格 · 0%'
		);
		await expect(trackCard(page, 'トラック1').getByTestId('track-card-count')).toHaveText(
			'0/2 合格 · 0%'
		);
	});

	test('expand/collapse toggle shows and hides child tracks', async ({ page }) => {
		await gotoWithSeed(page, NESTED_TRACK_SEED);

		const chapterCard = page.getByTestId('chapter-card').filter({ hasText: '1章' });

		// Default: expanded → both tracks visible
		await expect(trackCard(page, 'トラック1')).toBeVisible();
		await expect(trackCard(page, 'トラック1-1')).toBeVisible();

		// Collapse the chapter → its tracks are hidden
		await chapterCard.getByRole('button', { name: '折りたたむ' }).click();
		await expect(trackCard(page, 'トラック1')).toBeHidden();
		await expect(trackCard(page, 'トラック1-1')).toBeHidden();

		// Expand again → tracks visible
		await chapterCard.getByRole('button', { name: '展開する' }).click();
		await expect(trackCard(page, 'トラック1')).toBeVisible();
		await expect(trackCard(page, 'トラック1-1')).toBeVisible();

		// A track row collapses its own subtree, independently of the chapter.
		await trackCard(page, 'トラック1').getByRole('button', { name: '折りたたむ' }).click();
		await expect(trackCard(page, 'トラック1')).toBeVisible();
		await expect(trackCard(page, 'トラック1-1')).toBeHidden();

		await trackCard(page, 'トラック1').getByRole('button', { name: '展開する' }).click();
		await expect(trackCard(page, 'トラック1-1')).toBeVisible();
	});

	test('a track is startable when only a descendant track holds sentences', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: '文のないトラック', order: 1, parentId: null },
				{ id: 't1-1', chapterId: 'ch-1', name: '孫のトラック', order: 1, parentId: 't1' }
			],
			sentences: [
				{ id: 's2', chapterId: 'ch-1', trackId: 't1-1', text: 'い', language: 'ja', order: 1 }
			]
		});

		// Subtree-based, not own-sentence-based: every ancestor of the sentence
		// (the leaf, the empty intermediate track, the chapter) is startable.
		await expect(page.getByTestId('chapter-card').getByTestId('card-start')).toHaveCount(1);
		await expect(trackCard(page, '文のないトラック').getByTestId('card-start')).toHaveCount(1);
		await expect(trackCard(page, '孫のトラック').getByTestId('card-start')).toHaveCount(1);

		// And the empty intermediate track must not read "0文" next to a live
		// button — its subtree holds s2, so the session started from it is 1 long.
		await expect(trackCard(page, '文のないトラック').getByTestId('track-card-count')).toHaveText(
			'0/1 合格 · 0%'
		);
	});

	test('a node whose subtree holds no sentence has no practice start button', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: '空のトラック', order: 1, parentId: null },
				{ id: 't1-1', chapterId: 'ch-1', name: '空の孫', order: 1, parentId: 't1' }
			],
			sentences: []
		});

		await expect(page.getByTestId('chapter-card').getByTestId('card-start')).toHaveCount(0);
		await expect(page.getByTestId('track-card').getByTestId('card-start')).toHaveCount(0);
	});

	test('chapters and tracks are sorted by order ascending within each level', async ({ page }) => {
		await gotoWithSeed(page, {
			// Flat roots only: sub-chapters are migrated into tracks on load, so a
			// nested chapter seed can no longer assert chapter-level nesting.
			chapters: [
				{ id: 'parent-1', name: '親A', parentId: null, order: 2 },
				{ id: 'parent-2', name: '親B', parentId: null, order: 1 }
			],
			// Seeded in reverse `order` on purpose: rendering must sort, not echo.
			tracks: [
				{ id: 'tr-b', chapterId: 'parent-2', name: 'トラックB', order: 1, parentId: null },
				{ id: 'tr-b-1', chapterId: 'parent-2', name: 'トラックB-1', order: 1, parentId: 'tr-b' },
				{ id: 'tr-a', chapterId: 'parent-2', name: 'トラックA', order: 2, parentId: null },
				{ id: 'tr-a1', chapterId: 'parent-1', name: '親Aのトラック', order: 1, parentId: null }
			],
			sentences: []
		});

		// Depth-first order: 親B(order 1) → 親A(order 2)
		const chapters = page.locator('.chapter-item');
		await expect(chapters).toHaveCount(2);
		const chapterTexts = await chapters.allTextContents();
		expect(chapterTexts[0]).toContain('親B');
		expect(chapterTexts[1]).toContain('親A');

		// Depth-first order: トラックB(order 1) → トラックB-1 (its child) → トラックA(order 2)
		// → 親Aのトラック (the next chapter's own track).
		const tracks = page.getByTestId('track-card');
		await expect(tracks).toHaveCount(4);
		await expect(tracks.nth(0)).toContainText('トラックB');
		await expect(tracks.nth(1)).toContainText('トラックB-1');
		await expect(tracks.nth(2)).toContainText('トラックA');
		await expect(tracks.nth(3)).toContainText('親Aのトラック');
	});
});
