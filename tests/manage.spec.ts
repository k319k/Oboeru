import { test, expect, type Page } from '@playwright/test';
import { gotoWithSeed } from './helpers';

// ---------------------------------------------------------------------------
// Fixed seed data (deterministic per test — independent contexts)
// ---------------------------------------------------------------------------

const seed = {
	chapters: [
		{ id: 'ch-ja-01', name: 'はじめの一歩（日本語）', parentId: null, order: 1 },
		{ id: 'ch-en-01', name: 'First Steps（English）', parentId: null, order: 2 }
	],
	sentences: [
		{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
		{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'すみません、駅はどこですか。', language: 'ja', order: 2 },
		{ id: 'en-01', chapterId: 'ch-en-01', text: 'Good morning.', language: 'en', order: 1 }
	]
};

const nestedSeed = {
	chapters: [
		{ id: 'parent', name: '親チャプター', parentId: null, order: 1 },
		{ id: 'child', name: '子チャプター', parentId: 'parent', order: 1 },
		{ id: 'grandchild', name: '孫チャプター', parentId: 'child', order: 1 }
	],
	sentences: [
		{ id: 's1', chapterId: 'parent', text: '親の文章', language: 'ja', order: 1 },
		{ id: 's2', chapterId: 'child', text: '子の文章', language: 'ja', order: 1 }
	]
};

/** Seed localStorage then navigate to /manage. Waits for chapter rows to render — the $effect loads localStorage during hydration, and clicks before that are lost (handler not yet attached). */
async function gotoManage(
	page: Page,
	data?: { chapters?: unknown[]; sentences?: unknown[] }
): Promise<void> {
	await gotoWithSeed(page, data);
	await page.goto('/manage');
	await page.waitForSelector('[data-testid="chapter-name"]', { timeout: 10000 });
}

/**
 * Interact with a shadcn Select: click the trigger (identified by testid),
 * then click the option with the given visible label. shadcn Select renders
 * a button trigger + a portaled listbox (no native <select>), so the native
 * `selectOption()` cannot be used.
 */
async function pickOption(page: Page, testId: string, optionLabel: string): Promise<void> {
	await page.getByTestId(testId).click();
	await page.getByRole('option', { name: optionLabel }).click();
}

// ---------------------------------------------------------------------------
// Tabs (tablist / tab / tabpanel + arrow keys + ?tab= deep link)
// ---------------------------------------------------------------------------

test.describe('Tabs', () => {
	test('switching tabs shows only the active panel', async ({ page }) => {
		await gotoManage(page, seed);

		// Default tab is チャプター
		await expect(page.getByRole('tab', { name: 'チャプター' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByTestId('add-root-chapter')).toBeVisible();
		await expect(page.getByTestId('add-sentence')).toBeHidden();
		await expect(page.getByTestId('threshold-slider')).toBeHidden();
		await expect(page.getByTestId('export-button')).toBeHidden();

		// 文章 tab
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(page.getByRole('tab', { name: '文章' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByTestId('add-sentence')).toBeVisible();
		await expect(page.getByTestId('add-root-chapter')).toBeHidden();

		// 設定 tab
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByTestId('threshold-slider')).toBeVisible();
		await expect(page.getByTestId('add-sentence')).toBeHidden();

		// データ tab
		await page.getByRole('tab', { name: 'データ' }).click();
		await expect(page.getByTestId('export-button')).toBeVisible();
		await expect(page.getByTestId('import-input')).toBeAttached();
		await expect(page.getByTestId('threshold-slider')).toBeHidden();
		await expect(page.getByTestId('add-root-chapter')).toBeHidden();
	});

	test('deep link ?tab= opens the target tab directly', async ({ page }) => {
		await gotoWithSeed(page, seed);
		await page.goto('/manage?tab=設定');

		await expect(page.getByRole('tab', { name: '設定' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.getByTestId('threshold-slider')).toBeVisible();
		await expect(page.getByTestId('add-root-chapter')).toBeHidden();
	});

	test('arrow keys move tab focus and activate (Home/End, wraps around)', async ({
		page
	}) => {
		await gotoManage(page, seed);
		const chapterTab = page.getByRole('tab', { name: 'チャプター' });
		const sentenceTab = page.getByRole('tab', { name: '文章' });
		const settingsTab = page.getByRole('tab', { name: '設定' });
		const dataTab = page.getByRole('tab', { name: 'データ' });

		await chapterTab.focus();
		await page.keyboard.press('ArrowRight');
		await expect(sentenceTab).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(settingsTab).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(dataTab).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(chapterTab).toBeFocused(); // wraps around
		await page.keyboard.press('ArrowLeft');
		await expect(dataTab).toBeFocused();
		await page.keyboard.press('Home');
		await expect(chapterTab).toBeFocused();
		await page.keyboard.press('End');
		await expect(dataTab).toBeFocused();
	});
});

// ---------------------------------------------------------------------------
// Chapter CRUD
// ---------------------------------------------------------------------------

test.describe('Chapter CRUD', () => {
	test('full cycle: create → visible → rename → delete', async ({ page }) => {
		await gotoManage(page, seed);

		// Create
		await page.getByTestId('add-root-chapter').click();
		await page.getByTestId('new-chapter-name').fill('テストチャプター');
		await page.getByTestId('confirm-add-chapter').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: 'テストチャプター' })
		).toBeVisible();

		// Rename
		const row = page.locator('.chapter-row', { hasText: 'テストチャプター' });
		await row.getByTestId('edit-chapter').click();
		await page.getByTestId('edit-chapter-name').fill('改名チャプター');
		await page.getByTestId('confirm-edit-chapter').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '改名チャプター' })
		).toBeVisible();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: 'テストチャプター' })
		).toHaveCount(0);

		// Delete (confirm via AlertDialog)
		const renamedRow = page.locator('.chapter-row', { hasText: '改名チャプター' });
		await renamedRow.getByTestId('delete-chapter').click();
		await page.getByTestId('confirm-delete-chapter').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '改名チャプター' })
		).toHaveCount(0);

		// Store intact: original 2 chapters remain
		await expect(page.getByTestId('chapter-name')).toHaveCount(2);
	});

	test('rejects empty chapter name with inline error and keeps store intact', async ({
		page
	}) => {
		await gotoManage(page, seed);
		const initialCount = await page.getByTestId('chapter-name').count();

		await page.getByTestId('add-root-chapter').click();
		await page.getByTestId('new-chapter-name').fill('   ');
		await page.getByTestId('confirm-add-chapter').click();

		await expect(page.getByTestId('chapter-validation-error')).toBeVisible();
		await expect(page.getByTestId('chapter-validation-error')).toContainText('必須');
		expect(await page.getByTestId('chapter-name').count()).toBe(initialCount);
	});

	test('rejects empty child chapter name with inline error', async ({ page }) => {
		await gotoManage(page, seed);

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-chapter').click();
		await page.getByTestId('new-child-chapter-name').fill('   ');
		await page.getByTestId('confirm-add-child').click();

		await expect(page.getByTestId('chapter-validation-error')).toBeVisible();
		await expect(page.getByTestId('chapter-validation-error')).toContainText('必須');
	});
});

// ---------------------------------------------------------------------------
// Chapter nesting (unlimited depth, recursive rendering)
// ---------------------------------------------------------------------------

test.describe('Chapter nesting', () => {
	test('adds child and grandchild, renders with increasing indentation', async ({
		page
	}) => {
		await gotoManage(page, seed);

		// Add child to ch-ja-01
		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-chapter').click();
		await page.getByTestId('new-child-chapter-name').fill('子チャプター');
		await page.getByTestId('confirm-add-child').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '子チャプター' })
		).toBeVisible();

		// Add grandchild to the child
		const childRow = page.locator('.chapter-row', { hasText: '子チャプター' });
		await childRow.getByTestId('add-child-chapter').click();
		await page.getByTestId('new-child-chapter-name').fill('孫チャプター');
		await page.getByTestId('confirm-add-child').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '孫チャプター' })
		).toBeVisible();

		// Depth assertion: grandchild node is indented deeper than child node
		const childNode = page
			.getByTestId('chapter-name')
			.filter({ hasText: '子チャプター' })
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
		const grandchildNode = page
			.getByTestId('chapter-name')
			.filter({ hasText: '孫チャプター' })
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');

		const childMargin = parseFloat(await childNode.evaluate((el) => getComputedStyle(el).marginLeft));
		const grandchildMargin = parseFloat(
			await grandchildNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		expect(grandchildMargin).toBeGreaterThan(childMargin);
		expect(childMargin).toBeGreaterThan(0);
	});

	test('collapses and expands nested children', async ({ page }) => {
		await gotoManage(page, nestedSeed);

		// Parent is collapsed by default → child hidden
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '子チャプター' })
		).toHaveCount(0);

		// Expand parent
		const parentRow = page.locator('.chapter-row', { hasText: '親チャプター' });
		await parentRow.locator('.expand-toggle').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '子チャプター' })
		).toBeVisible();

		// Expand child → grandchild visible
		const childRow = page.locator('.chapter-row', { hasText: '子チャプター' });
		await childRow.locator('.expand-toggle').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '孫チャプター' })
		).toBeVisible();

		// Collapse parent → all descendants hidden
		await parentRow.locator('.expand-toggle').click();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '子チャプター' })
		).toHaveCount(0);
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '孫チャプター' })
		).toHaveCount(0);
	});
});

// ---------------------------------------------------------------------------
// Chapter delete with descendants
// ---------------------------------------------------------------------------

test.describe('Chapter delete with descendants', () => {
	test('accepting confirm cascades: chapters and sentences removed', async ({ page }) => {
		await gotoManage(page, nestedSeed);

		const parentRow = page.locator('.chapter-row', { hasText: '親チャプター' });
		await parentRow.getByTestId('delete-chapter').click();
		await page.getByTestId('confirm-delete-chapter').click();

		// All descendant chapters gone
		await expect(page.getByTestId('chapter-name')).toHaveCount(0);

		// Sentences of deleted chapters gone
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '親の文章' })
		).toHaveCount(0);
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '子の文章' })
		).toHaveCount(0);
	});

	test('dismissing confirm keeps everything unchanged', async ({ page }) => {
		await gotoManage(page, nestedSeed);

		// Expand parent and child so all nested chapters are rendered
		const parentRow = page.locator('.chapter-row', { hasText: '親チャプター' });
		await parentRow.locator('.expand-toggle').click();
		const childRow = page.locator('.chapter-row', { hasText: '子チャプター' });
		await childRow.locator('.expand-toggle').click();

		await parentRow.getByTestId('delete-chapter').click();
		await page.getByTestId('cancel-delete-chapter').click();

		// Nothing deleted
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '親チャプター' })
		).toBeVisible();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '子チャプター' })
		).toBeVisible();
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '孫チャプター' })
		).toBeVisible();

		// Sentences live in the 文章 tab.
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '親の文章' })
		).toBeVisible();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '子の文章' })
		).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Chapter reorder
// ---------------------------------------------------------------------------

test.describe('Chapter reorder', () => {
	const reorderSeed = {
		chapters: [
			{ id: 'c1', name: 'チャプター1', parentId: null, order: 1 },
			{ id: 'c2', name: 'チャプター2', parentId: null, order: 2 },
			{ id: 'c3', name: 'チャプター3', parentId: null, order: 3 }
		],
		sentences: []
	};

	test('moves chapter up and down among siblings', async ({ page }) => {
		await gotoManage(page, reorderSeed);

		// Move c2 up
		const c2Row = page.locator('.chapter-row', { hasText: 'チャプター2' });
		await c2Row.getByTestId('move-chapter-up').click();

		const names = page.getByTestId('chapter-name');
		await expect(names.nth(0)).toHaveText('チャプター2');
		await expect(names.nth(1)).toHaveText('チャプター1');
		await expect(names.nth(2)).toHaveText('チャプター3');

		// Move c2 down (back to original position)
		const c2RowAgain = page.locator('.chapter-row', { hasText: 'チャプター2' });
		await c2RowAgain.getByTestId('move-chapter-down').click();

		await expect(names.nth(0)).toHaveText('チャプター1');
		await expect(names.nth(1)).toHaveText('チャプター2');
		await expect(names.nth(2)).toHaveText('チャプター3');
	});

	test('boundary buttons are disabled for first and last siblings', async ({ page }) => {
		await gotoManage(page, reorderSeed);

		const c1Row = page.locator('.chapter-row', { hasText: 'チャプター1' });
		const c3Row = page.locator('.chapter-row', { hasText: 'チャプター3' });

		await expect(c1Row.getByTestId('move-chapter-up')).toBeDisabled();
		await expect(c3Row.getByTestId('move-chapter-down')).toBeDisabled();
		await expect(c1Row.getByTestId('move-chapter-down')).toBeEnabled();
		await expect(c3Row.getByTestId('move-chapter-up')).toBeEnabled();
	});
});

// ---------------------------------------------------------------------------
// Chapter language badges (task-13: one tokenized pill per language)
// ---------------------------------------------------------------------------

test.describe('Chapter language badges', () => {
	test('single-language chapter rows show one badge, empty rows show none', async ({
		page
	}) => {
		await gotoManage(page, seed);

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await expect(jaRow.locator('.language-badge')).toHaveText(['JA']);
		const enRow = page.locator('.chapter-row', { hasText: 'First Steps（English）' });
		await expect(enRow.locator('.language-badge')).toHaveText(['EN']);
	});

	test('mixed-language chapter shows both badges, empty chapter shows none', async ({
		page
	}) => {
		await gotoManage(page, {
			chapters: [
				{ id: 'mix', name: 'ミックス', parentId: null, order: 1 },
				{ id: 'empty', name: '空チャプター', parentId: null, order: 2 }
			],
			sentences: [
				{ id: 'm1', chapterId: 'mix', text: 'こんにちは。', language: 'ja', order: 1 },
				{ id: 'm2', chapterId: 'mix', text: 'Hello.', language: 'en', order: 2 }
			]
		});

		const mixRow = page.locator('.chapter-row', { hasText: 'ミックス' });
		await expect(mixRow.locator('.language-badge')).toHaveText(['JA', 'EN']);
		await expect(
			page.locator('.chapter-row', { hasText: '空チャプター' }).locator('.language-badge')
		).toHaveCount(0);
	});

	test('sentence rows show the tokenized language badge', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		const jaItem = page.locator('.sentence-item', { hasText: 'おはようございます。' });
		await expect(jaItem.locator('.language-badge')).toHaveText(['日本語']);
		const enItem = page.locator('.sentence-item', { hasText: 'Good morning.' });
		await expect(enItem.locator('.language-badge')).toHaveText(['English']);
	});
});

// ---------------------------------------------------------------------------
// Sentence CRUD
// ---------------------------------------------------------------------------

test.describe('Sentence CRUD', () => {
	test('full cycle: add → visible → edit → delete', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		// Add
		await page.getByTestId('add-sentence').click();
		await page.getByTestId('new-sentence-text').fill('新しい文章です。');
		await pickOption(page, 'new-sentence-lang', '日本語');
		await pickOption(page, 'new-sentence-chapter', 'はじめの一歩（日本語）');
		await page.getByTestId('confirm-add-sentence').click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '新しい文章です。' })
		).toBeVisible();

		// Edit
		const sentenceRow = page.locator('.sentence-item', { hasText: '新しい文章です。' });
		await sentenceRow.getByTestId('edit-sentence').click();
		await page.getByTestId('edit-sentence-text').fill('編集された文章です。');
		await page.getByTestId('confirm-edit-sentence').click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '編集された文章です。' })
		).toBeVisible();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '新しい文章です。' })
		).toHaveCount(0);

		// Delete (confirm via AlertDialog)
		const editedRow = page.locator('.sentence-item', { hasText: '編集された文章です。' });
		await editedRow.getByTestId('delete-sentence').click();
		await page.getByTestId('confirm-delete-sentence').click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '編集された文章です。' })
		).toHaveCount(0);

		// Store intact: original 3 sentences remain
		await expect(page.getByTestId('sentence-text')).toHaveCount(3);
	});

	test('rejects empty sentence text with inline error and keeps store intact', async ({
		page
	}) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();
		const initialCount = await page.getByTestId('sentence-text').count();

		await page.getByTestId('add-sentence').click();
		await page.getByTestId('new-sentence-text').fill('   ');
		await page.getByTestId('confirm-add-sentence').click();

		await expect(page.getByTestId('sentence-validation-error')).toBeVisible();
		await expect(page.getByTestId('sentence-validation-error')).toContainText('必須');
		expect(await page.getByTestId('sentence-text').count()).toBe(initialCount);
	});

	test('rejects sentence text over 200 chars with inline error', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();
		const initialCount = await page.getByTestId('sentence-text').count();
		const longText = 'あ'.repeat(201);

		await page.getByTestId('add-sentence').click();
		await page.getByTestId('new-sentence-text').fill(longText);
		await page.getByTestId('confirm-add-sentence').click();

		await expect(page.getByTestId('sentence-validation-error')).toBeVisible();
		await expect(page.getByTestId('sentence-validation-error')).toContainText('200');
		expect(await page.getByTestId('sentence-text').count()).toBe(initialCount);
	});

	test('shows live character counter', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		await page.getByTestId('add-sentence').click();
		await page.getByTestId('new-sentence-text').fill('こんにちは');
		await expect(page.getByText('5/200')).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test.describe('Filters', () => {
	test('filters sentences by language', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		// All: 3 sentences
		await expect(page.getByTestId('sentence-text')).toHaveCount(3);

		// ja only
		await pickOption(page, 'language-filter', '日本語');
		await expect(page.getByTestId('sentence-text')).toHaveCount(2);
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'おはようございます。' })
		).toBeVisible();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'Good morning.' })
		).toHaveCount(0);

		// en only
		await pickOption(page, 'language-filter', 'English');
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'Good morning.' })
		).toBeVisible();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'おはようございます。' })
		).toHaveCount(0);
	});

	test('filters sentences by chapter', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');
		await expect(page.getByTestId('sentence-text')).toHaveCount(2);
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'おはようございます。' })
		).toBeVisible();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'Good morning.' })
		).toHaveCount(0);

		await pickOption(page, 'chapter-filter', 'First Steps（English）');
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'Good morning.' })
		).toBeVisible();
	});

	test('combines language and chapter filters', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');
		await pickOption(page, 'language-filter', 'English');
		// No English sentences in the Japanese chapter
		await expect(page.getByTestId('sentence-text')).toHaveCount(0);
		await expect(page.getByText('フィルターに一致する文章がありません')).toBeVisible();
	});

	test('shows sentence counts per chapter', async ({ page }) => {
		await gotoManage(page, seed);

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await expect(jaRow).toContainText('(2文)');
		const enRow = page.locator('.chapter-row', { hasText: 'First Steps（English）' });
		await expect(enRow).toContainText('(1文)');
	});
});

// ---------------------------------------------------------------------------
// Track groups (トラック別グループ化 + トラックCRUD)
// ---------------------------------------------------------------------------

const tracksSeed = {
	chapters: [{ id: 'c1', name: 'チャプター1', parentId: null, order: 1 }],
	tracks: [
		{ id: 't1', chapterId: 'c1', name: '前半', order: 1 },
		{ id: 't2', chapterId: 'c1', name: '後半', order: 2 }
	],
	sentences: [
		{ id: 's1', chapterId: 'c1', trackId: 't1', text: '前半の文章', language: 'ja', order: 1 },
		{ id: 's2', chapterId: 'c1', trackId: 't2', text: '後半の文章', language: 'ja', order: 1 }
	]
};

// Edit + chapter move into a chapter that has no tracks yet
const chapterMoveSeed = {
	chapters: [
		{ id: 'c1', name: '移動元', parentId: null, order: 1 },
		{ id: 'c2', name: 'トラックなし章', parentId: null, order: 2 }
	],
	tracks: [
		{ id: 't1', chapterId: 'c1', name: '前半', order: 1 },
		{ id: 't2', chapterId: 'c1', name: '後半', order: 2 }
	],
	sentences: [
		{ id: 'mv1', chapterId: 'c1', trackId: 't1', text: '移動される文章', language: 'ja', order: 1 }
	]
};

const STORAGE_KEY = 'oboeru:v1';

/** Locate a track group by its header name (hasText on the whole group is
   ambiguous once a sentence containing the track name is inside another
   group, e.g. after moving sentences between tracks). */
function trackGroup(page: Page, name: string) {
	return page.getByTestId('track-group').filter({
		has: page.getByTestId('track-name').filter({ hasText: name })
	});
}

test.describe('Track groups', () => {
	test('group headers show track name and sentence counts, collapse hides rows', async ({
		page
	}) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();

		// Old-format seeds are shimmed into one トラック1 per chapter
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');
		await expect(page.getByTestId('track-group')).toHaveCount(1);
		await expect(page.getByTestId('track-name')).toHaveText('トラック1');
		await expect(page.locator('.track-header')).toContainText('(2文)');
		await expect(page.getByTestId('sentence-text')).toHaveCount(2);

		// Collapse the group via its header toggle
		await page.getByRole('button', { name: 'トラック1 を折りたたむ' }).click();
		await expect(page.getByTestId('sentence-text')).toHaveCount(0);
		await expect(page.getByTestId('track-name')).toBeVisible();

		// Expand again
		await page.getByRole('button', { name: 'トラック1 を展開' }).click();
		await expect(page.getByTestId('sentence-text')).toHaveCount(2);

		// The English chapter has its own group
		await pickOption(page, 'chapter-filter', 'First Steps（English）');
		await expect(page.getByTestId('track-group')).toHaveCount(1);
		await expect(page.locator('.track-header')).toContainText('(1文)');
	});

	test('adds a track and renames it', async ({ page }) => {
		await gotoManage(page, seed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');

		await page.getByTestId('add-track').click();
		await page.getByTestId('new-track-name').fill('応用編');
		await page.getByTestId('confirm-add-track').click();

		// New (empty) group appears alongside the shimmed トラック1
		await expect(page.getByTestId('track-group')).toHaveCount(2);
		await expect(page.getByTestId('track-name').filter({ hasText: '応用編' })).toBeVisible();

		// Rename via the group header
		const group = trackGroup(page, '応用編');
		await group.getByTestId('edit-track').click();
		await page.getByTestId('edit-track-name').fill('上級編');
		await page.getByTestId('confirm-edit-track').click();

		await expect(page.getByTestId('track-name').filter({ hasText: '上級編' })).toBeVisible();
		await expect(page.getByTestId('track-name').filter({ hasText: '応用編' })).toHaveCount(0);
	});

	test('deleting a track removes its sentences', async ({ page }) => {
		await gotoManage(page, tracksSeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'チャプター1');

		await expect(page.getByTestId('sentence-text')).toHaveCount(2);

		const t1Group = trackGroup(page, '前半');
		await t1Group.getByTestId('delete-track').click();
		await page.getByTestId('confirm-delete-track').click();

		await expect(page.getByTestId('track-name').filter({ hasText: '前半' })).toHaveCount(0);
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '前半の文章' })
		).toHaveCount(0);
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);

		// Other chapter's content is untouched — switch back to すべて
		await pickOption(page, 'chapter-filter', 'すべて');
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);
	});

	test('sentence form track selector assigns new sentences to the chosen track', async ({
		page
	}) => {
		await gotoManage(page, tracksSeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'チャプター1');

		await page.getByTestId('add-sentence').click();
		// Track selector defaults to the chapter's first track
		await expect(page.getByTestId('sentence-form-track')).toContainText('前半');
		await page.getByTestId('new-sentence-text').fill('追加の文章です。');
		await page.getByTestId('confirm-add-sentence').click();

		// Default selection → 前半 group
		const zenhanGroup = trackGroup(page, '前半');
		await expect(
			zenhanGroup.getByTestId('sentence-text').filter({ hasText: '追加の文章です。' })
		).toBeVisible();

		// Second add, explicitly choosing 後半
		await page.getByTestId('add-sentence').click();
		await page.getByTestId('new-sentence-text').fill('後半に追加。');
		await pickOption(page, 'sentence-form-track', '後半');
		await page.getByTestId('confirm-add-sentence').click();

		const kohanGroup = trackGroup(page, '後半');
		await expect(
			kohanGroup.getByTestId('sentence-text').filter({ hasText: '後半に追加。' })
		).toBeVisible();
		await expect(
			zenhanGroup.getByTestId('sentence-text').filter({ hasText: '後半に追加。' })
		).toHaveCount(0);
	});

	test('edit form track selector moves a sentence between tracks', async ({ page }) => {
		await gotoManage(page, tracksSeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'チャプター1');

		const row = page.locator('.sentence-item', { hasText: '前半の文章' });
		await row.getByTestId('edit-sentence').click();
		await pickOption(page, 'sentence-form-track', '後半');
		await page.getByTestId('confirm-edit-sentence').click();

		const kohanGroup = trackGroup(page, '後半');
		await expect(
			kohanGroup.getByTestId('sentence-text').filter({ hasText: '前半の文章' })
		).toBeVisible();
		// 前半 group remains (chapter-scoped view shows empty tracks) with no rows
		await expect(trackGroup(page, '前半').getByTestId('sentence-text')).toHaveCount(0);
	});

	test('reorders tracks within a chapter, boundary buttons disabled', async ({ page }) => {
		await gotoManage(page, tracksSeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'チャプター1');

		const t1Group = trackGroup(page, '前半');
		const t2Group = trackGroup(page, '後半');

		await expect(t1Group.getByTestId('track-order-up')).toBeDisabled();
		await expect(t1Group.getByTestId('track-order-down')).toBeEnabled();
		await expect(t2Group.getByTestId('track-order-up')).toBeEnabled();
		await expect(t2Group.getByTestId('track-order-down')).toBeDisabled();

		// Move 後半 up → order swaps
		await t2Group.getByTestId('track-order-up').click();
		const names = page.getByTestId('track-name');
		await expect(names.nth(0)).toHaveText('後半');
		await expect(names.nth(1)).toHaveText('前半');
	});

	test('add-track form renders exactly once in the all-tracks view', async ({ page }) => {
		await gotoManage(page, tracksSeed);
		await page.getByRole('tab', { name: '文章' }).click();

		// すべて view: チャプター1 has two track groups, each offering +
		await expect(page.getByTestId('add-track')).toHaveCount(2);
		await page.getByTestId('add-track').first().click();

		// Inline form is anchored to the clicked group only — single input on screen
		await expect(page.getByTestId('new-track-name')).toHaveCount(1);
		await page.getByTestId('new-track-name').fill('第3のトラック');
		await page.getByTestId('confirm-add-track').click();
		await expect(page.getByTestId('new-track-name')).toHaveCount(0);

		// Added (empty) track shows up in the chapter-filtered view
		await pickOption(page, 'chapter-filter', 'チャプター1');
		await expect(page.getByTestId('track-group')).toHaveCount(3);
		await expect(page.getByTestId('track-name').filter({ hasText: '第3のトラック' })).toBeVisible();
	});

	test('moving a sentence to a trackless chapter lands in the auto-created track', async ({
		page
	}) => {
		await gotoManage(page, chapterMoveSeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', '移動元');

		const row = page.locator('.sentence-item', { hasText: '移動される文章' });
		await row.getByTestId('edit-sentence').click();
		// Chapter selector → chapter that has no tracks (selector falls back to トラック1)
		await pickOption(page, 'edit-sentence-chapter', 'トラックなし章');
		await page.getByTestId('confirm-edit-sentence').click();

		// UI: the sentence now renders under the new chapter's トラック1 group
		await pickOption(page, 'chapter-filter', 'トラックなし章');
		await expect(page.getByTestId('track-name')).toHaveText('トラック1');
		await expect(page.locator('.track-header')).toContainText('(1文)');
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);
		await expect(page.getByTestId('sentence-text')).toContainText('移動される文章');

		// Storage: the saved trackId belongs to the new chapter (c2)
		const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), STORAGE_KEY);
		const moved = stored.sentences.find((s: { id: string }) => s.id === 'mv1');
		expect(moved.chapterId).toBe('c2');
		const savedTrack = stored.tracks.find((t: { id: string }) => t.id === moved.trackId);
		expect(savedTrack).toBeTruthy();
		expect(savedTrack.chapterId).toBe('c2');
	});
});
