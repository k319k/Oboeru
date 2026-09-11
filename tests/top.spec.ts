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

	test('selects a chapter and shows practice start button', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: defaultChapters,
			sentences: defaultSentences
		});

		// Click the first chapter
		await page.getByText('はじめの一歩（日本語）').click();

		// Practice start section should appear
		await expect(page.getByText('練習開始')).toBeVisible();
		await expect(page.getByText('はじめの一歩（日本語） — 10文')).toBeVisible();
		await expect(page.getByRole('button', { name: '練習開始' })).toBeEnabled();
	});

	test('practice start button is disabled when nothing selected', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: defaultChapters,
			sentences: defaultSentences
		});

		await expect(page.getByRole('button', { name: '練習開始' })).toBeDisabled();
	});

	test('practice start button is disabled when selected chapter has no sentences', async ({
		page
	}) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-empty', name: '空のチャプター', parentId: null, order: 1 }],
			sentences: []
		});

		await page.getByText('空のチャプター').click();

		await expect(page.getByRole('button', { name: '練習開始' })).toBeDisabled();
	});

	test('clicking practice start navigates to /practice with chapter query', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: defaultChapters,
			sentences: defaultSentences
		});

		// Select the Japanese chapter
		await page.getByText('はじめの一歩（日本語）').click();

		// Click practice start — should navigate
		await Promise.all([
			page.waitForURL('**/practice**'),
			page.getByRole('button', { name: '練習開始' }).click()
		]);

		expect(page.url()).toContain('/practice?chapter=ch-ja-01');
	});

	test('selected chapter is visually highlighted', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: defaultChapters,
			sentences: defaultSentences
		});

		const firstChapter = page.getByText('はじめの一歩（日本語）');
		await firstChapter.click();

		// The parent button should have the 'selected' class
		const button = page.locator('button.chapter-item.selected');
		await expect(button).toBeVisible();
		await expect(button).toContainText('はじめの一歩（日本語）');
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

	test('clicking a child chapter navigates to /practice with the child id', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [
				{ id: 'parent-1', name: '親チャプター', parentId: null, order: 1 },
				{ id: 'child-1', name: '子チャプター', parentId: 'parent-1', order: 1 }
			],
			sentences: [
				{ id: 's-1', chapterId: 'child-1', text: 'こんにちは。', language: 'ja', order: 1 }
			]
		});

		await page.getByText('子チャプター').click();
		await expect(page.getByRole('button', { name: '練習開始' })).toBeEnabled();

		await Promise.all([
			page.waitForURL(/\/practice\?chapter=child-1/),
			page.getByRole('button', { name: '練習開始' }).click()
		]);
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
		const items = page.locator('button.chapter-item');
		await expect(items).toHaveCount(4);
		const texts = await items.allTextContents();
		expect(texts[0]).toContain('親B');
		expect(texts[1]).toContain('子A');
		expect(texts[2]).toContain('子B');
		expect(texts[3]).toContain('親A');
	});
});