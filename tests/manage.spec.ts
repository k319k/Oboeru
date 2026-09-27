import { test, expect, type Page } from './fixtures';
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

/**
 * A chapter with a two-level track tree plus a sibling track. Used by the
 * chapters-tab tree tests (expand/collapse, sibling reordering, cascade).
 */
const hierarchySeed = {
	chapters: [{ id: 'ch-ja-01', name: 'はじめの一歩（日本語）', parentId: null, order: 1 }],
	tracks: [
		{ id: 't1', chapterId: 'ch-ja-01', name: '基本', order: 1, parentId: null },
		{ id: 't1-1', chapterId: 'ch-ja-01', name: '基本-1', order: 1, parentId: 't1' },
		{ id: 't1-2', chapterId: 'ch-ja-01', name: '基本-2', order: 2, parentId: 't1' },
		{ id: 't2', chapterId: 'ch-ja-01', name: '応用', order: 2, parentId: null }
	],
	sentences: [
		{ id: 's1', chapterId: 'ch-ja-01', trackId: 't1', text: '基本の文章', language: 'ja', order: 1 },
		{ id: 's2', chapterId: 'ch-ja-01', trackId: 't1-1', text: '基本1の文章', language: 'ja', order: 1 },
		{ id: 's3', chapterId: 'ch-ja-01', trackId: 't1-2', text: '基本2の文章', language: 'ja', order: 1 },
		{ id: 's4', chapterId: 'ch-ja-01', trackId: 't2', text: '応用の文章', language: 'ja', order: 1 }
	]
};

	/**
 * hierarchySeed with the sentences stored in a different order than the tree:
 * 応用's sentence comes before 基本-1 / 基本-2's. The stored sentence array is
 * arbitrary (imports merge by id, and tracks are created at different times),
 * so a group list that follows it instead of the tree pre-order is wrong even
 * though hierarchySeed's own sentence order happens to coincide with the tree.
 */
const scrambledSentenceOrderSeed = {
	...hierarchySeed,
	sentences: [
		hierarchySeed.sentences[0],
		hierarchySeed.sentences[3],
		hierarchySeed.sentences[1],
		hierarchySeed.sentences[2]
	]
};

/** Seed localStorage then navigate to /manage. Waits for chapter rows to render — the $effect loads localStorage during hydration, and clicks before that are lost (handler not yet attached). */
async function gotoManage(
	page: Page,
	data?: { chapters?: unknown[]; tracks?: unknown[]; sentences?: unknown[] }
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

/**
 * Make sure a chapter node is open. Nodes default to expanded, so this is a
 * no-op unless the chapter was collapsed first — the tests below use it to state
 * their precondition without depending on the default.
 */
async function expandChapter(page: Page, name: string): Promise<void> {
	const row = page.locator('.chapter-row', { hasText: name });
	const toggle = row.locator('.expand-toggle');
	if ((await toggle.textContent())?.includes('▶')) {
		await toggle.click();
	}
}

/**
 * A chapters-tab track row located by its exact name. The row also renders the
 * count and the action labels, so `filter({ hasText: /^name$/ })` on the row
 * itself never matches — go through the name span and walk up to the row.
 * (Substring matching would also be ambiguous: 基本 / 基本-1 / 基本-2.)
 */
function trackRow(page: Page, name: string) {
	return page
		.getByTestId('tree-track-name')
		.filter({ hasText: new RegExp(`^${name}$`) })
		.locator('xpath=ancestor::*[@data-testid="tree-track-row"][1]');
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

	test('rejects empty child track name with inline error and keeps store intact', async ({
		page
	}) => {
		await gotoManage(page, seed);
		const before = await page.evaluate((key) => localStorage.getItem(key), 'oboeru:v1');

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-track').click();
		await page.getByTestId('confirm-add-track').click();
		await expect(page.getByTestId('track-validation-error')).toBeVisible();

		const after = await page.evaluate((key) => localStorage.getItem(key), 'oboeru:v1');
		expect(after).toBe(before);
	});
});

// ---------------------------------------------------------------------------
// Track nesting (章 + トラックが 1 本の木, recursive rendering)
// ---------------------------------------------------------------------------

test.describe('Track nesting', () => {
	test('adds a child track to a track, rendering with increasing indentation', async ({
		page
	}) => {
		await gotoManage(page, seed);

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-track').click();
		await page.getByTestId('new-child-track-name').fill('子トラック');
		await page.getByTestId('confirm-add-track').click();
		await expect(
			page.getByTestId('tree-track-name').filter({ hasText: '子トラック' })
		).toBeVisible();

		await trackRow(page, '子トラック').getByTestId('add-child-track').click();
		await page.getByTestId('new-child-track-name').fill('孫トラック');
		await page.getByTestId('confirm-add-track').click();
		await expect(
			page.getByTestId('tree-track-name').filter({ hasText: '孫トラック' })
		).toBeVisible();

		const childNode = page
			.getByTestId('tree-track-name')
			.filter({ hasText: '子トラック' })
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
		const grandchildNode = page
			.getByTestId('tree-track-name')
			.filter({ hasText: '孫トラック' })
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
		const childMargin = parseFloat(
			await childNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		const grandchildMargin = parseFloat(
			await grandchildNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		expect(grandchildMargin).toBeGreaterThan(childMargin);
		expect(childMargin).toBeGreaterThan(0);
	});

	test('collapses and expands nested tracks', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		// Nodes default to expanded: the chapter and 基本 are both open.
		await expect(page.getByTestId('tree-track-name')).toHaveCount(4);

		const chapterRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await chapterRow.locator('.expand-toggle').click();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(0);

		await chapterRow.locator('.expand-toggle').click();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(4);

		await trackRow(page, '基本').locator('.expand-toggle').click();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(2);
	});
});

test.describe('Inline sentence editing from the tree', () => {
	test('edits a sentence inline from a track row and keeps it after reload', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await expandChapter(page, 'はじめの一歩（日本語）');

		const input = page.getByTestId('inline-sentence-text').first();
		await input.fill('書き換えた文です。');
		await input.press('Enter');

		await page.reload();
		// Wait for hydration before clicking the tab: a click that lands before
		// the handler is attached is lost and the 文章 tabpanel stays `hidden`.
		await page.waitForSelector('[data-testid="chapter-name"]', { timeout: 10000 });
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '書き換えた文です。' })
		).toBeVisible();
	});

	test('inline editing saves on blur and rejects an empty text', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await expandChapter(page, 'はじめの一歩（日本語）');

		await page.getByTestId('inline-sentence-text').first().fill('blr で保存');
		await page.getByTestId('chapter-name').first().click();
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'blr で保存' })
		).toBeVisible();

		await page.getByRole('tab', { name: 'チャプター' }).click();
		await expandChapter(page, 'はじめの一歩（日本語）');
		await page.getByTestId('inline-sentence-text').first().fill('');
		await page.getByTestId('inline-sentence-text').first().press('Enter');
		await expect(page.getByTestId('inline-sentence-error')).toBeVisible();
		// The rejected draft stays in the field so the text is not lost
		await expect(page.getByTestId('inline-sentence-text').first()).toHaveValue('');
	});

	test('only track rows inline their own sentences, never the chapter row', async ({
		page
	}) => {
		await gotoManage(page, hierarchySeed);
		// Every node defaults to expanded, so all four track rows are open and
		// each shows its own single sentence: 4 editors for the seed's 4
		// sentences. 8 would mean the chapter row duplicated its children's
		// sentences, 1 per track would mean only the chapter's own.
		await expandChapter(page, 'はじめの一歩（日本語）');
		await expect(page.getByTestId('inline-sentence-text')).toHaveCount(4);

		// Collapsing 基本 drops its own editor *and* both child rows
		// (基本-1 / 基本-2) — a parent's editor never lists descendant sentences.
		await trackRow(page, '基本').locator('.expand-toggle').click();
		await expect(page.getByTestId('inline-sentence-text')).toHaveCount(1);
		await expect(page.getByTestId('inline-sentence-text').first()).toHaveValue('応用の文章');
	});
});

test.describe('Track CRUD in the tree', () => {
	test('reorders tracks within the same parent only', async ({ page }) => {
		await gotoManage(page, hierarchySeed);

		const t1 = trackRow(page, '基本');
		const t2 = trackRow(page, '応用');

		await expect(t1.getByTestId('tree-track-up')).toBeDisabled();
		await expect(t1.getByTestId('tree-track-down')).toBeEnabled();
		await expect(t2.getByTestId('tree-track-down')).toBeDisabled();
		// A lone child has no siblings to swap with
		await expect(trackRow(page, '基本-1').getByTestId('tree-track-up')).toBeDisabled();

		await t2.getByTestId('tree-track-up').click();
		await expect(page.getByTestId('tree-track-row').nth(0)).toContainText('応用');
	});

	test('renames a track from its row', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await trackRow(page, '応用').getByTestId('tree-track-edit').click();
		await page.getByTestId('tree-edit-track-name').fill('上級');
		await page.getByTestId('tree-confirm-edit-track').click();
		await expect(page.getByTestId('tree-track-name').filter({ hasText: '上級' })).toBeVisible();
	});

	test('rejects an empty child track name', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await trackRow(page, '応用').getByTestId('add-child-track').click();
		await page.getByTestId('confirm-add-track').click();
		await expect(page.getByTestId('track-validation-error')).toBeVisible();
	});

	test('deleting a track removes its descendant tracks and sentences', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await trackRow(page, '基本').getByTestId('tree-track-delete').click();
		// 基本 + 基本-1 + 基本-2
		await expect(page.getByTestId('delete-track-preview')).toContainText('3');
		await page.getByTestId('confirm-delete-track').click();

		await expect(page.getByTestId('tree-track-name')).toHaveCount(1);
		await expect(page.getByTestId('tree-track-name').filter({ hasText: '応用' })).toBeVisible();

		await page.getByRole('tab', { name: '文章' }).click();
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);
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

		// 子/孫 chapters became tracks of 親チャプター (the shim also keeps the
		// per-chapter トラック1, so the chapter owns 5 track rows in total).
		const parentRow = page.locator('.chapter-row', { hasText: '親チャプター' });
		await expect(page.getByTestId('tree-track-name')).toHaveCount(5);

		await parentRow.getByTestId('delete-chapter').click();
		await page.getByTestId('cancel-delete-chapter').click();

		// Nothing deleted
		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '親チャプター' })
		).toBeVisible();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(5);
		await expect(
			page.getByTestId('tree-track-name').filter({ hasText: '子チャプター' })
		).toBeVisible();
		await expect(
			page.getByTestId('tree-track-name').filter({ hasText: '孫チャプター' })
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
// Track groups (articles tab: トラック別グループ化のみ。トラックの追加・
// 改名・並び替え・削除は chapters タブが担当する)
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

	/**
	 * A track created in the chapters tab has to reach the 文章 tab as its own
	 * group, empty ones included. (Renaming is covered by `Track CRUD in the
	 * tree` — the articles tab no longer mutates tracks.)
	 */
	test('a track added in the chapters tab shows up as an empty group', async ({ page }) => {
		await gotoManage(page, seed);

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-track').click();
		await page.getByTestId('new-child-track-name').fill('応用編');
		await page.getByTestId('confirm-add-track').click();

		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');

		// New (empty) group appears alongside the shimmed トラック1
		await expect(page.getByTestId('track-group')).toHaveCount(2);
		await expect(page.getByTestId('track-name').filter({ hasText: '応用編' })).toBeVisible();
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

	test('groups are listed in the tree pre-order', async ({ page }) => {
		await gotoManage(page, scrambledSentenceOrderSeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');
		await expect(page.getByTestId('track-name')).toHaveText(['基本', '基本-1', '基本-2', '応用']);
	});

	test('the track selector can pick a nested track and assigns the sentence to it', async ({
		page
	}) => {
		await gotoManage(page, hierarchySeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');

		await page.getByTestId('add-sentence').click();
		await expect(page.getByTestId('sentence-form-track')).toContainText('基本');
		await page.getByTestId('new-sentence-text').fill('子トラックに入れる。');
		await pickOption(page, 'sentence-form-track', '基本-1');
		await page.getByTestId('confirm-add-sentence').click();

		await expect(
			trackGroup(page, '基本-1')
				.getByTestId('sentence-text')
				.filter({ hasText: '子トラックに入れる。' })
		).toBeVisible();
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
