import { test, expect } from '@playwright/test';
import { gotoWithSeed } from './helpers';
import { defaultChapters, defaultSentences } from '../src/lib/default-sentences';

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

	test('shows sentence count per chapter', async ({ page }) => {
		await page.goto('/');
		// Each default chapter has 10 sentences
		await expect(page.getByText('10文').first()).toBeVisible();
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

	test('parent card badge aggregates descendant sentence counts', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [
				{ id: 'parent-1', name: '親A', parentId: null, order: 1 },
				{ id: 'child-1', name: '子A', parentId: 'parent-1', order: 1 },
				{ id: 'grandchild-1', name: '孫A', parentId: 'child-1', order: 1 },
				{ id: 'grandchild-2', name: '孫B', parentId: 'child-1', order: 2 },
				{ id: 'parent-2', name: '親B', parentId: null, order: 2 },
				{ id: 'child-2', name: '子B', parentId: 'parent-2', order: 1 }
			],
			sentences: [
				{ id: 's-1', chapterId: 'grandchild-1', text: 'こんばんは。', language: 'ja', order: 1 },
				{ id: 's-2', chapterId: 'grandchild-1', text: 'さようなら。', language: 'ja', order: 2 },
				{ id: 's-3', chapterId: 'grandchild-1', text: 'また明日。', language: 'ja', order: 3 },
				{ id: 's-4', chapterId: 'grandchild-2', text: '四つ目。', language: 'ja', order: 1 },
				{ id: 's-5', chapterId: 'grandchild-2', text: '五つ目。', language: 'ja', order: 2 },
				{ id: 's-6', chapterId: 'parent-2', text: '直接の文。', language: 'ja', order: 1 },
				{ id: 's-7', chapterId: 'child-2', text: '六つ目。', language: 'ja', order: 1 },
				{ id: 's-8', chapterId: 'child-2', text: '七つ目。', language: 'ja', order: 2 },
				{ id: 's-9', chapterId: 'child-2', text: '八つ目。', language: 'ja', order: 3 },
				{ id: 's-10', chapterId: 'child-2', text: '九つ目。', language: 'ja', order: 4 }
			]
		});

		// 親A: 0 direct + 子A(0 direct) + 孫A(3) + 孫B(2) = 5 → no direct → no start button
		const parentA = page.getByTestId('chapter-card').filter({ hasText: '親A' });
		await expect(parentA).toContainText('5文');
		await expect(parentA.getByTestId('card-start')).toHaveCount(0);

		// 子A: 0 direct + 孫A 3 + 孫B 2 = 5 → no direct → no start button
		const childA = page.getByTestId('chapter-card').filter({ hasText: '子A' });
		await expect(childA).toContainText('5文');
		await expect(childA.getByTestId('card-start')).toHaveCount(0);

		// 孫A: 3 direct → start button present
		const grandchildA = page.getByTestId('chapter-card').filter({ hasText: '孫A' });
		await expect(grandchildA).toContainText('3文');
		await expect(grandchildA.getByTestId('card-start')).toHaveCount(1);

		// 親B: 1 direct + 子B 4 = 5 → direct sentences exist → start button present
		const parentB = page.getByTestId('chapter-card').filter({ hasText: '親B' });
		await expect(parentB).toContainText('5文');
		await expect(parentB.getByTestId('card-start')).toHaveCount(1);
	});

	test('clicking card start navigates to /practice?chapter= via SPA (no full reload)', async ({
		page
	}) => {
		await page.goto('/');

		const jaCard = page.getByTestId('chapter-card').filter({ hasText: 'はじめの一歩（日本語）' });
		await Promise.all([
			page.waitForURL(/\/practice\?chapter=ch-ja-01/),
			jaCard.getByTestId('card-start').click()
		]);

		expect(page.url()).toContain('/practice?chapter=ch-ja-01');
		// SPA navigation: the document is not replaced → exactly one navigation entry.
		const navCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
		expect(navCount).toBe(1);
	});

	test('clicking a child card start navigates to /practice with the child id', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [
				{ id: 'parent-1', name: '親チャプター', parentId: null, order: 1 },
				{ id: 'child-1', name: '子チャプター', parentId: 'parent-1', order: 1 }
			],
			sentences: [
				{ id: 's-1', chapterId: 'child-1', text: 'こんにちは。', language: 'ja', order: 1 }
			]
		});

		const childCard = page.getByTestId('chapter-card').filter({ hasText: '子チャプター' });
		await Promise.all([
			page.waitForURL(/\/practice\?chapter=child-1/),
			childCard.getByTestId('card-start').click()
		]);
	});

	test('navigation links are present', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('link', { name: 'おぼえる' })).toBeVisible();
		await expect(page.getByRole('link', { name: '管理', exact: true })).toBeVisible();
	});

	// ---------------------------------------------------------------------------
	// Nested tree (T4)
	// ---------------------------------------------------------------------------

	test('nested chapters are displayed as a tree with children indented', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [
				{ id: 'parent-1', name: '親チャプター', parentId: null, order: 1 },
				{ id: 'child-1', name: '子チャプター', parentId: 'parent-1', order: 1 },
				{ id: 'grandchild-1', name: '孫チャプター', parentId: 'child-1', order: 1 }
			],
			sentences: []
		});

		await expect(page.getByText('親チャプター')).toBeVisible();
		await expect(page.getByText('子チャプター')).toBeVisible();
		await expect(page.getByText('孫チャプター')).toBeVisible();

		// Children are indented deeper than their parent (tree structure)
		const parentBox = await page.getByText('親チャプター').boundingBox();
		const childBox = await page.getByText('子チャプター').boundingBox();
		const grandchildBox = await page.getByText('孫チャプター').boundingBox();
		expect(childBox!.x).toBeGreaterThan(parentBox!.x);
		expect(grandchildBox!.x).toBeGreaterThan(childBox!.x);
	});

	test('expand/collapse toggle shows and hides child chapters', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [
				{ id: 'parent-1', name: '親チャプター', parentId: null, order: 1 },
				{ id: 'child-1', name: '子チャプター', parentId: 'parent-1', order: 1 }
			],
			sentences: []
		});

		// Default: expanded → child visible
		await expect(page.getByText('子チャプター')).toBeVisible();

		// Collapse → child hidden
		await page.getByRole('button', { name: '折りたたむ' }).click();
		await expect(page.getByText('子チャプター')).toBeHidden();

		// Expand again → child visible
		await page.getByRole('button', { name: '展開する' }).click();
		await expect(page.getByText('子チャプター')).toBeVisible();
	});

	test('chapters are sorted by order ascending within each level', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [
				{ id: 'parent-1', name: '親A', parentId: null, order: 2 },
				{ id: 'parent-2', name: '親B', parentId: null, order: 1 },
				{ id: 'child-1', name: '子B', parentId: 'parent-2', order: 2 },
				{ id: 'child-2', name: '子A', parentId: 'parent-2', order: 1 }
			],
			sentences: []
		});

		// Depth-first order: 親B(order 1) → 子A(order 1) → 子B(order 2) → 親A(order 2)
		const items = page.locator('.chapter-item');
		await expect(items).toHaveCount(4);
		const texts = await items.allTextContents();
		expect(texts[0]).toContain('親B');
		expect(texts[1]).toContain('子A');
		expect(texts[2]).toContain('子B');
		expect(texts[3]).toContain('親A');
	});
});
