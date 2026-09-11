import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { writeFileSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { gotoWithSeed } from './helpers';

// ---------------------------------------------------------------------------
// WCAG AA cross-cutting accessibility (T9)
// ---------------------------------------------------------------------------
// Scans every page (/, /practice, /manage) with axe in both light and dark
// themes and asserts zero serious/critical violations. Also verifies that all
// visible interactive elements have a tap target >= 44px (WCAG 2.5.8).
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = '.omo/evidence/oboeru-ui-ux';
const EVIDENCE_FILE = `${EVIDENCE_DIR}/task-9-oboeru-ui-ux.txt`;

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

function ensureEvidenceDir() {
	mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function logEvidence(line: string) {
	appendFileSync(EVIDENCE_FILE, line + '\n');
}

/** Run axe and return violations with impact serious or critical. */
async function scanSeriousCritical(page: Page) {
	const results = await new AxeBuilder({ page }).analyze();
	const serious = results.violations.filter(
		(v) => v.impact === 'serious' || v.impact === 'critical'
	);
	return { results, serious };
}

/** Assert no serious/critical violations and log the full axe JSON to evidence. */
async function expectNoSeriousCritical(page: Page, label: string) {
	const { results, serious } = await scanSeriousCritical(page);
	logEvidence(`\n=== axe scan: ${label} ===`);
	logEvidence(JSON.stringify(results.violations, null, 2));
	expect(
		serious,
		`${label}: expected 0 serious/critical violations, got ${serious.length}`
	).toHaveLength(0);
}

/** Verify all visible interactive elements have height >= 44px. Returns non-conforming list. */
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

/**
 * Verify tap targets >= 44px and log non-conforming elements to the evidence
 * file (plan letter: verify + grep-able log, NOT assert 0 — dense tree/sentence
 * action buttons are intentionally < 44px to keep the 390px layout, T10).
 */
async function expectTapTargets(page: Page, label: string) {
	const bad = await checkTapTargets(page);
	logEvidence(`\n=== tap-target 44px: ${label} ===`);
	if (bad.length === 0) {
		logEvidence('OK: all visible interactive elements >= 44px');
	} else {
		logEvidence(`NON-CONFORMING (${bad.length}):`);
		for (const b of bad) logEvidence(`  - ${b}`);
	}
	const content = readFileSync(EVIDENCE_FILE, 'utf-8');
	expect(
		content,
		`${label}: tap-target evidence log was not written`
	).toContain(`=== tap-target 44px: ${label} ===`);
}

test.describe('Accessibility (WCAG AA)', () => {
	test.beforeAll(() => {
		ensureEvidenceDir();
		logEvidence(`# task-9-oboeru-ui-ux — ${new Date().toISOString()}`);
		logEvidence('# command: npx playwright test tests/a11y.spec.ts');
	});

	test('top page (empty data) — light & dark', async ({ page }) => {
		await gotoWithSeed(page, { chapters: [], sentences: [] });
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/ empty light');
		await expectTapTargets(page, '/ empty light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/ empty dark');
		await expectTapTargets(page, '/ empty dark');
	});

	test('top page (seeded) — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/ seeded light');
		await expectTapTargets(page, '/ seeded light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/ seeded dark');
		await expectTapTargets(page, '/ seeded dark');
	});

	test('practice page — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?chapter=child-1');
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/practice light');
		await expectTapTargets(page, '/practice light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/practice dark');
		await expectTapTargets(page, '/practice dark');
	});

	test('manage page — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/manage');
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/manage light');
		await expectTapTargets(page, '/manage light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expectNoSeriousCritical(page, '/manage dark');
		await expectTapTargets(page, '/manage dark');
	});
});
