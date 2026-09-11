import { test, expect, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { gotoWithSeed } from './helpers';

// ---------------------------------------------------------------------------
// Responsive layout (T10) — 390×844 mobile viewport
// ---------------------------------------------------------------------------
// Verifies that /, /practice, /manage render without horizontal overflow at
// 390px, that the header nav fits, that practice action buttons stack
// full-width, that top cards are single-column, and that all visible
// interactive elements have a tap target >= 44px (WCAG 2.5.8). Layout fixes
// are limited to Tailwind responsive utilities so desktop (1280px) is
// unaffected.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = '.omo/evidence/oboeru-ui-ux';
const EVIDENCE_FILE = `${EVIDENCE_DIR}/task-10-oboeru-ui-ux.txt`;
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

test.describe('Responsive layout (390px)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test.beforeAll(() => {
		ensureDirs();
		logEvidence(`# task-10-oboeru-ui-ux — ${new Date().toISOString()}`);
		logEvidence('# command: npx playwright test tests/responsive.spec.ts');
		logEvidence('# viewport: 390x844');
	});

	test('top page (empty) — no overflow, tap targets >= 44px, single column', async ({ page }) => {
		await gotoWithSeed(page, { chapters: [], sentences: [] });
		await page.waitForLoadState('networkidle');

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
		await page.waitForLoadState('networkidle');

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

	test('practice page — no overflow, tap targets >= 44px, action buttons stacked full-width', async ({
		page
	}) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?chapter=child-1');
		await page.waitForLoadState('networkidle');

		await expectNoHorizontalOverflow(page, '/practice');
		await expectTapTargets(page, '/practice');

		// Practice action buttons (skip/stop) are stacked full-width at 390px.
		const stacked = await page.evaluate(() => {
			const skip = document.querySelector('[data-testid="skip-btn"]');
			const stop = document.querySelector('[data-testid="stop-btn"]');
			if (!skip || !stop) return null;
			const skipRect = skip.getBoundingClientRect();
			const stopRect = stop.getBoundingClientRect();
			// Full-width: each button spans the container width (>= 80% of viewport).
			const fullWidth = skipRect.width >= 0.8 * window.innerWidth;
			// Stacked: stop is below skip (different vertical position, same horizontal).
			const stackedVertically = stopRect.top > skipRect.top + skipRect.height - 2;
			return { fullWidth, stackedVertically };
		});
		expect(stacked, '/practice: skip/stop buttons must be present').not.toBeNull();
		expect(stacked!.fullWidth, '/practice: action buttons must be full-width').toBe(true);
		expect(stacked!.stackedVertically, '/practice: action buttons must be stacked').toBe(true);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice.png`, fullPage: true });
	});

	test('manage page — no overflow, tap targets >= 44px', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/manage');
		await page.waitForLoadState('networkidle');

		await expectNoHorizontalOverflow(page, '/manage');
		await expectTapTargets(page, '/manage');

		await page.screenshot({ path: `${SCREENSHOT_DIR}/manage.png`, fullPage: true });
	});
});
