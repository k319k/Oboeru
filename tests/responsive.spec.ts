import { test, expect, type Page } from './fixtures';
import { mkdirSync, appendFileSync } from 'node:fs';
import { gotoWithSeed } from './helpers';
import { mockTtsApi } from './tts-mock';

// ---------------------------------------------------------------------------
// Responsive layout (oboeru-ui-ux-v2 T10) — 390×844 mobile viewport
// ---------------------------------------------------------------------------
// Verifies that /, /practice (show / recording / feedback) and /manage (all
// four tabs) render without horizontal overflow at 390px, that the header nav
// fits, that practice action buttons stack full-width, that top cards are
// single-column, and that all visible interactive elements have a tap target
// >= 44px (WCAG 2.5.8). Layout fixes are limited to Tailwind responsive
// utilities so desktop (1280px) is unaffected.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = '.omo/evidence/oboeru-ui-ux-v2';
const EVIDENCE_FILE = `${EVIDENCE_DIR}/task-10-oboeru-ui-ux-v2.txt`;
const SCREENSHOT_DIR = `${EVIDENCE_DIR}/task-10-screenshots`;

const SEED = {
	chapters: [
		{ id: 'parent-1', name: '親チャプター', parentId: null, order: 1 },
		{ id: 'child-1', name: '子チャプター', parentId: 'parent-1', order: 1 }
	],
	sentences: [
		{ id: 's-1', chapterId: 'child-1', text: 'こんにちは。', language: 'ja', order: 1 },
		{ id: 's-2', chapterId: 'child-1', text: 'お元気ですか。', language: 'ja', order: 2 }
	]
};

const MANAGE_TABS = [
	{ id: 'chapters', label: 'チャプター' },
	{ id: 'sentences', label: '文章' },
	{ id: 'settings', label: '設定' },
	{ id: 'data', label: 'データ' }
] as const;

function ensureDirs() {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function logEvidence(line: string) {
	appendFileSync(EVIDENCE_FILE, line + '\n');
}

/** Assert no horizontal overflow at the document and body level. */
async function expectNoHorizontalOverflow(page: Page, label: string) {
	const { docScroll, docClient, bodyScroll, bodyClient } = await page.evaluate(() => {
		const de = document.documentElement;
		const body = document.body;
		return {
			docScroll: de.scrollWidth,
			docClient: de.clientWidth,
			bodyScroll: body.scrollWidth,
			bodyClient: body.clientWidth
		};
	});
	logEvidence(`\n=== horizontal overflow: ${label} ===`);
	logEvidence(
		`  documentElement scrollWidth=${docScroll} clientWidth=${docClient} (overflow=${
			docScroll > docClient ? 'YES' : 'no'
		})`
	);
	logEvidence(
		`  body scrollWidth=${bodyScroll} clientWidth=${bodyClient} (overflow=${
			bodyScroll > bodyClient ? 'YES' : 'no'
		})`
	);
	expect(docScroll, `${label}: documentElement horizontal overflow`).toBeLessThanOrEqual(docClient);
	expect(bodyScroll, `${label}: body horizontal overflow`).toBeLessThanOrEqual(bodyClient);
}

/** Return visible interactive elements with height < 44px (same selector/log as a11y.spec.ts). */
async function checkTapTargets(page: Page): Promise<string[]> {
	const bad = await page.evaluate(() => {
		const selector = 'button, a, [role="button"], input, select, textarea';
		const offenders: string[] = [];
		for (const el of Array.from(document.querySelectorAll(selector))) {
			const htmlEl = el as HTMLElement;
			if (htmlEl.classList.contains('sr-only')) continue; // visually hidden (skip link etc.)
			const rect = htmlEl.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) continue; // hidden
			const style = getComputedStyle(el);
			if (style.visibility === 'hidden' || style.display === 'none') continue;
			if (rect.height < 44) {
				const tag = el.tagName.toLowerCase();
				const label =
					el.getAttribute('aria-label') ||
					el.getAttribute('data-testid') ||
					el.textContent?.trim().slice(0, 30) ||
					'';
				offenders.push(`${tag}${label ? ` "${label}"` : ''} height=${Math.round(rect.height)}px`);
			}
		}
		return offenders;
	});
	return bad;
}

/** Assert all visible interactive elements >= 44px and log to evidence. */
async function expectTapTargets(page: Page, label: string) {
	const bad = await checkTapTargets(page);
	logEvidence(`\n=== tap-target 44px: ${label} ===`);
	if (bad.length === 0) {
		logEvidence('OK: all visible interactive elements >= 44px');
	} else {
		logEvidence(`NON-CONFORMING (${bad.length}):`);
		for (const b of bad) logEvidence(`  - ${b}`);
	}
	expect(bad, `${label}: expected all tap targets >= 44px, got ${bad.length} non-conforming`).toHaveLength(
		0
	);
}

/** Mock /api/transcribe with a fixed transcript. */
async function mockTranscribe(page: Page, text: string) {
	await page.route('**/api/transcribe', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ text })
		})
	);
}

/**
 * T13 push-to-talk: hold Space to record. Waits for the ready state first —
 * a keydown fired before hydration attaches the document listener is
 * silently lost. End the hold with keyboard.up('Space').
 */
async function startHold(page: Page): Promise<void> {
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
	await page.keyboard.down('Space');
	await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 10000 });
}

/** startHold, wait until the on-screen timer reads >= 0.7s (past the 0.5s
 *  short-tap guard), then release → transcribing → feedback. */
async function holdAndRelease(page: Page): Promise<void> {
	await startHold(page);
	await page.waitForFunction(() => {
		const m = document
			.querySelector('[data-testid="recording-timer"]')
			?.textContent?.match(/(\d+\.\d+)/);
		return m ? parseFloat(m[1]) >= 0.7 : false;
	});
	await page.keyboard.up('Space');
}

test.describe('Responsive layout (390px)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test.describe('App shell — practice hides the global nav', () => {
		test('/practice has no global nav; / still does', async ({ page }) => {
			await gotoWithSeed(page, SEED);
			await page.goto('/practice?chapter=child-1');
			await expect(page.getByTestId('sentence-text')).toBeVisible();

			await expect(page.getByRole('link', { name: 'おぼえる', exact: true })).toHaveCount(0);
			await expect(page.getByRole('link', { name: '管理', exact: true })).toHaveCount(0);
			// The practice header keeps its own 終了 affordance.
			await expect(page.getByTestId('stop-btn')).toBeVisible();

			await page.goto('/');
			await expect(page.getByRole('link', { name: 'おぼえる', exact: true })).toBeVisible();
			await expect(page.getByRole('link', { name: '管理', exact: true })).toBeVisible();
		});
	});

	test.beforeAll(() => {
		ensureDirs();
		logEvidence(`\n########## task-10-oboeru-ui-ux-v2 (responsive) — ${new Date().toISOString()}`);
		logEvidence('# command: npx playwright test tests/responsive.spec.ts');
		logEvidence('# viewport: 390x844');
	});

	test('top page (empty) — no overflow, tap targets >= 44px, single column', async ({ page }) => {
		await gotoWithSeed(page, { chapters: [], sentences: [] });

		await expectNoHorizontalOverflow(page, '/ empty');
		await expectTapTargets(page, '/ empty');

		// Header nav fits within the viewport (no horizontal scroll on the header).
		const headerOverflow = await page.evaluate(() => {
			const header = document.querySelector('header');
			if (!header) return null;
			return header.scrollWidth <= header.clientWidth;
		});
		expect(headerOverflow, '/ empty: header nav must not overflow').toBe(true);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/top-empty.png`, fullPage: true });
	});

	test('top page (seeded) — no overflow, tap targets >= 44px, single column', async ({ page }) => {
		await gotoWithSeed(page, SEED);

		await expectNoHorizontalOverflow(page, '/ seeded');
		await expectTapTargets(page, '/ seeded');

		// Top cards are single column at 390px: each chapter-item is stacked
		// vertically (its top is below the previous item's bottom) rather than
		// laid out side-by-side. Nested children are intentionally indented, so
		// we only assert vertical stacking, not identical left positions.
		const singleColumn = await page.evaluate(() => {
			const items = Array.from(document.querySelectorAll('.chapter-item'));
			if (items.length === 0) return true;
			let prevBottom = -Infinity;
			for (const el of items) {
				const r = el.getBoundingClientRect();
				if (r.top < prevBottom - 2) return false; // overlaps previous → not stacked
				prevBottom = r.bottom;
			}
			return true;
		});
		expect(singleColumn, '/ seeded: top cards must be single column').toBe(true);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/top-seeded.png`, fullPage: true });
	});

	test('practice show — no overflow, tap targets >= 44px, skip full-width + header exit', async ({
		page
	}) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?chapter=child-1');

		await expectNoHorizontalOverflow(page, '/practice show');
		await expectTapTargets(page, '/practice show');

		// T6 layout: 終了 moved to the header row; スキップ stays as the
		// full-width bottom action at 390px.
		const layout = await page.evaluate(() => {
			const skip = document.querySelector('[data-testid="skip-btn"]');
			const stop = document.querySelector('[data-testid="stop-btn"]');
			if (!skip || !stop) return null;
			const skipRect = skip.getBoundingClientRect();
			const stopRect = stop.getBoundingClientRect();
			// Full-width: skip spans the container width (>= 80% of viewport).
			const fullWidth = skipRect.width >= 0.8 * window.innerWidth;
			// 終了 sits in the header row, above the bottom action.
			const stopInHeader = stopRect.top < skipRect.top;
			return { fullWidth, stopInHeader };
		});
		expect(layout, '/practice: skip/stop buttons must be present').not.toBeNull();
		expect(layout!.fullWidth, '/practice: skip button must be full-width').toBe(true);
		expect(layout!.stopInHeader, '/practice: 終了 must sit in the header row').toBe(true);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice.png`, fullPage: true });
	});

	test('practice recording — no overflow, tap targets >= 44px', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?chapter=child-1');

		// T13 push-to-talk: hold Space to enter (and stay in) the recording phase.
		await startHold(page);
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });

		await expectNoHorizontalOverflow(page, '/practice recording');
		await expectTapTargets(page, '/practice recording');

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-recording.png`, fullPage: true });
	});

	test('practice feedback — no overflow, action buttons stacked full-width', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, 'こんにちは。');
		await page.goto('/practice?chapter=child-1');

		// T13 push-to-talk: hold Space past the 0.5s short-tap guard, release → score.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

		await expectNoHorizontalOverflow(page, '/practice feedback');
		await expectTapTargets(page, '/practice feedback');

		// 操作ボタン縦積み: もう一度聴く / 次へ stack vertically, each spanning
		// the feedback container (the flex-col sm:flex-row pattern).
		const stacked = await page.evaluate(() => {
			const container = document.querySelector('[data-testid="feedback"]');
			if (!container) return null;
			const rects = Array.from(container.querySelectorAll('button'))
				.map((b) => b.getBoundingClientRect())
				.sort((a, b) => a.top - b.top);
			if (rects.length < 2) return null;
			const eachFullWidth = rects.every((r) => r.width >= 0.85 * container!.clientWidth);
			const verticallyStacked = rects[1].top >= rects[0].bottom - 2;
			return { eachFullWidth, verticallyStacked };
		});
		expect(stacked, '/practice feedback: buttons not found').not.toBeNull();
		expect(
			stacked!.verticallyStacked,
			'/practice feedback: action buttons must stack vertically at 390px'
		).toBe(true);
		expect(
			stacked!.eachFullWidth,
			'/practice feedback: action buttons must span the container'
		).toBe(true);
		logEvidence('practice feedback: action buttons stacked vertically, container-width ✓');

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-feedback.png`, fullPage: true });
	});

	test('manage tabs ×4 — no overflow, tap targets >= 44px', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/manage');
		await page.waitForLoadState('networkidle');

		for (const t of MANAGE_TABS) {
			await page.getByRole('tab', { name: t.label }).click();
			await expect(page.locator(`#tabpanel-${t.id}`)).toBeVisible();

			await expectNoHorizontalOverflow(page, `/manage tab=${t.label}`);
			await expectTapTargets(page, `/manage tab=${t.label}`);

			await page.screenshot({
				path: `${SCREENSHOT_DIR}/manage-${t.id}.png`,
				fullPage: true
			});
		}
	});
});
