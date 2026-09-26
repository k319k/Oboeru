import { test, expect, type Page } from './fixtures';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdirSync, appendFileSync } from 'node:fs';
import { gotoWithSeed } from './helpers';
import { mockTtsApi, silentWavBytes } from './tts-mock';

// ---------------------------------------------------------------------------
// WCAG AA cross-cutting accessibility (oboeru-ui-ux-v2 T10)
// ---------------------------------------------------------------------------
// Every page and its main states is scanned with axe in BOTH themes; zero
// serious/critical violations must hold:
//   /            — empty + seeded (T5 card UI)
//   /practice    — show/tts, recording, passing and failing feedback (T6/T8)
//   /manage      — all four tabs (T7) incl. the 設定 tab's 表示テーマ fieldset
// On top of axe:
//   - the --correct/--incorrect tokens are measured against --background
//     (>= 4.5:1 in light AND dark),
//   - key interactions are asserted: tab roles + arrow keys, card ▶ /
//     stop-recording >= 44px, a single polite 合格 announcement,
//   - prefers-reduced-motion removes the recording pulse / celebration-pop.
// ---------------------------------------------------------------------------

const EVIDENCE_DIR = '.omo/evidence/oboeru-ui-ux-v2';
const EVIDENCE_FILE = `${EVIDENCE_DIR}/task-10-oboeru-ui-ux-v2.txt`;
const EVIDENCE_DIR_13 = `${EVIDENCE_DIR}/task-13-consistency`;
const EVIDENCE_FILE_13 = `${EVIDENCE_DIR_13}/contrast-log.txt`;

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

const BADGE_SEED = {
	chapters: [
		{ id: 'ch-ja', name: '日本語チャプター', parentId: null, order: 1 },
		{ id: 'ch-en', name: 'English Chapter', parentId: null, order: 2 }
	],
	sentences: [
		{ id: 's-ja', chapterId: 'ch-ja', text: 'こんにちは。', language: 'ja', order: 1 },
		{ id: 's-en', chapterId: 'ch-en', text: 'Hello.', language: 'en', order: 1 }
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

/**
 * Wait for running CSS transitions/animations to finish (bounded). axe
 * samples computed colors mid-flight, so a scan right after a theme switch
 * or tab click would otherwise read interpolated colors as violations.
 * Infinite animations (spinners/pulse) settle via the 1s race cap.
 */
async function waitForTransitionQuiet(page: Page) {
	await page.evaluate(() => {
		const anims = document.getAnimations();
		return Promise.race([
			Promise.allSettled(anims.map((a) => a.finished)),
			new Promise((resolve) => setTimeout(resolve, 1000))
		]);
	});
}

/** Assert no serious/critical violations and log the full axe JSON to evidence. */
async function expectNoSeriousCritical(page: Page, label: string) {
	await waitForTransitionQuiet(page);
	const { results, serious } = await scanSeriousCritical(page);
	logEvidence(`\n=== axe scan: ${label} ===`);
	logEvidence(JSON.stringify(results.violations, null, 2));
	const summary =
		results.violations.map((v) => `${v.id}(${v.impact})x${v.nodes.length}`).join(', ') || 'none';
	logEvidence(`summary: ${results.violations.length} violation(s) [${summary}]`);
	expect(
		serious,
		`${label}: expected 0 serious/critical violations, got ${serious.length}`
	).toHaveLength(0);
}

/** Return visible interactive elements with height < 44px. */
async function checkTapTargets(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const selector = 'button, a, [role="button"], input, select, textarea';
		const offenders: string[] = [];
		for (const el of Array.from(document.querySelectorAll(selector))) {
			const htmlEl = el as HTMLElement;
			if (htmlEl.classList.contains('sr-only')) continue; // visually hidden
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
}

/**
 * Log non-conforming tap targets to the evidence file. Log-only here: the
 * desktop manage tree uses 32px action buttons by design (the 390px mobile
 * layout is asserted 0-offenders in responsive.spec.ts).
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
}

/** Measure one element's box, log it, and assert the 44px minimum. */
async function logTapTarget(page: Page, selector: string, label: string) {
	const box = await page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { w: Math.round(r.width), h: Math.round(r.height) };
	}, selector);
	logEvidence(`tap-target ${label} (${selector}): ${box ? `${box.w}x${box.h}px` : 'NOT FOUND'}`);
	expect(box, `${label}: element not found`).not.toBeNull();
	expect(box!.h, `${label}: height >= 44px`).toBeGreaterThanOrEqual(44);
	expect(box!.w, `${label}: width >= 44px`).toBeGreaterThanOrEqual(44);
}

/**
 * Contrast of the --correct / --incorrect token colors against --background,
 * computed from the browser's own color resolution (canvas pixel read-back,
 * so oklch is converted exactly like the page renders it).
 */
async function expectTokenContrast(page: Page, theme: 'light' | 'dark') {
	const ratios = await page.evaluate(() => {
		const SENTINEL = 'rgb(1, 2, 3)';
		const parseToRgb = (cssColor: string): [number, number, number] => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const ctx = canvas.getContext('2d')!;
			ctx.fillStyle = SENTINEL;
			ctx.fillRect(0, 0, 1, 1);
			ctx.fillStyle = cssColor;
			ctx.fillRect(0, 0, 1, 1);
			if (ctx.fillStyle === SENTINEL) throw new Error(`color parse failed: ${cssColor}`);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			return [d[0], d[1], d[2]];
		};
		const luminance = ([r, g, b]: [number, number, number]) => {
			const f = (c: number) => {
				const s = c / 255;
				return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
			};
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		};
		const contrast = (a: string, b: string) => {
			const la = luminance(parseToRgb(a));
			const lb = luminance(parseToRgb(b));
			const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
			return (hi + 0.05) / (lo + 0.05);
		};
		const probe = document.createElement('span');
		document.body.appendChild(probe);
		probe.style.color = 'var(--correct)';
		const correct = getComputedStyle(probe).color;
		probe.style.color = 'var(--incorrect)';
		const incorrect = getComputedStyle(probe).color;
		probe.remove();
		const bg = getComputedStyle(document.body).backgroundColor;
		return { correct: contrast(correct, bg), incorrect: contrast(incorrect, bg) };
	});
	logEvidence(
		`token contrast (${theme}): --correct vs --background = ${ratios.correct.toFixed(2)}:1, ` +
			`--incorrect vs --background = ${ratios.incorrect.toFixed(2)}:1`
	);
	expect(ratios.correct, `${theme}: --correct contrast >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
	expect(ratios.incorrect, `${theme}: --incorrect contrast >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
}

/** Switch to dark (system theme follows prefers-color-scheme) and drop the
 *  practice session snapshot so the reload starts a fresh session. */
async function switchToDarkFresh(page: Page) {
	await page.evaluate(() => sessionStorage.clear());
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.reload();
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

/** Slow TTS so the tts phase stays on screen for the axe scan. */
async function mockSlowTts(page: Page, delayMs: number) {
	await page.route('**/api/tts', async (route) => {
		await new Promise((r) => setTimeout(r, delayMs));
		await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWavBytes(80) });
	});
}

test.describe('Accessibility (WCAG AA)', () => {
	test.beforeAll(() => {
		ensureEvidenceDir();
		logEvidence(`\n########## task-10-oboeru-ui-ux-v2 (a11y) — ${new Date().toISOString()}`);
		logEvidence('# command: npx playwright test tests/a11y.spec.ts');
	});

	test('top page (empty data) — light & dark', async ({ page }) => {
		await gotoWithSeed(page, { chapters: [], sentences: [] });
		await expectNoSeriousCritical(page, '/ empty light');
		await expectTapTargets(page, '/ empty light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await expectNoSeriousCritical(page, '/ empty dark');
		await expectTapTargets(page, '/ empty dark');
	});

	test('top page (seeded) — light & dark + card ▶ 44px', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		// Cards render after hydration (SSR shows the empty state).
		await expect(page.getByTestId('chapter-card').first()).toBeVisible();
		await logTapTarget(page, '.chapter-item .expand-toggle', 'top card ▶ light');
		await expectNoSeriousCritical(page, '/ seeded light');
		await expectTapTargets(page, '/ seeded light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await expect(page.getByTestId('chapter-card').first()).toBeVisible();
		await logTapTarget(page, '.chapter-item .expand-toggle', 'top card ▶ dark');
		await expectNoSeriousCritical(page, '/ seeded dark');
		await expectTapTargets(page, '/ seeded dark');
	});

	test('manage tabs ×4 — light & dark (roles, arrow keys)', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/manage');
		await page.waitForLoadState('networkidle');
		await page.getByRole('tab', { name: 'チャプター' }).waitFor();

		// ARIA tabs pattern: tablist > 4 tabs wired to labelled tabpanels.
		await expect(page.getByRole('tablist', { name: '管理セクション' })).toBeVisible();
		await expect(page.getByRole('tab')).toHaveCount(4);
		for (const t of MANAGE_TABS) {
			const tab = page.getByRole('tab', { name: t.label });
			await expect(tab).toHaveAttribute('aria-controls', `tabpanel-${t.id}`);
			await expect(page.locator(`#tabpanel-${t.id}`)).toHaveAttribute(
				'aria-labelledby',
				`tab-${t.id}`
			);
		}
		await logTapTarget(page, '[role="tab"]', 'manage tab light');

		// Arrow keys move selection AND focus (roving tabindex).
		await page.getByRole('tab', { name: 'チャプター' }).click();
		await page.keyboard.press('ArrowRight');
		const next = page.getByRole('tab', { name: '文章' });
		await expect(next).toHaveAttribute('aria-selected', 'true');
		await expect(next).toBeFocused();
		await expect(page.locator('#tabpanel-sentences')).toBeVisible();
		await expect(page.locator('#tabpanel-chapters')).toBeHidden();
		logEvidence('manage tabs: role=tablist/tab/tabpanel + ArrowRight moves selection & focus ✓');

		for (const t of MANAGE_TABS) {
			await page.getByRole('tab', { name: t.label }).click();
			await expect(page.locator(`#tabpanel-${t.id}`)).toBeVisible();
			await expectNoSeriousCritical(page, `/manage tab=${t.label} light`);
			await expectTapTargets(page, `/manage tab=${t.label} light`);
		}

		await switchToDarkFresh(page);
		await page.waitForLoadState('networkidle');
		await page.getByRole('tab', { name: 'チャプター' }).waitFor();
		for (const t of MANAGE_TABS) {
			await page.getByRole('tab', { name: t.label }).click();
			await expect(page.locator(`#tabpanel-${t.id}`)).toBeVisible();
			await expectNoSeriousCritical(page, `/manage tab=${t.label} dark`);
			await expectTapTargets(page, `/manage tab=${t.label} dark`);
		}
	});

	test('practice show/tts — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockSlowTts(page, 3000);
		await page.goto('/practice?chapter=child-1');
		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await expectNoSeriousCritical(page, '/practice show/tts light');
		await expectTapTargets(page, '/practice show/tts light');

		await switchToDarkFresh(page);
		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await expectNoSeriousCritical(page, '/practice show/tts dark');
		await expectTapTargets(page, '/practice show/tts dark');
	});

	test('practice recording — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?chapter=child-1');
		// T13 push-to-talk: recording runs only while Space is held.
		await startHold(page);
		// The recording phase is static (only the timer/level meter ticks)
		// once the stop button appears — safe to scan.
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });

		await logTapTarget(page, '[data-testid="stop-btn"]', 'practice recording light');
		await expectNoSeriousCritical(page, '/practice recording light');
		await expectTapTargets(page, '/practice recording light');

		// Release before the reload so the next keydown is not flagged as
		// auto-repeat (Playwright keeps the key pressed across navigation).
		await page.keyboard.up('Space');
		await switchToDarkFresh(page);
		await startHold(page);
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });
		await logTapTarget(page, '[data-testid="stop-btn"]', 'practice recording dark');
		await expectNoSeriousCritical(page, '/practice recording dark');
		await expectTapTargets(page, '/practice recording dark');
	});

	test('practice feedback (pass) — light & dark + single 合格 announcement', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, 'こんにちは。');
		await page.goto('/practice?chapter=child-1');
		// T13 push-to-talk: hold Space past the 0.5s short-tap guard, release → score.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveText('100%');
		await expect(page.getByTestId('score')).toHaveClass(/pass/);
		await expect(page.getByTestId('score')).toHaveClass(/celebrate/);

		// Exactly ONE polite live region announces the pass (the phase status
		// <p role="status"> is a different element and never says 合格).
		const live = page.locator('p.sr-only[aria-live="polite"]', { hasText: '合格' });
		await expect(live).toHaveCount(1);
		await expect(live).toBeVisible();
		logEvidence('feedback pass: 合格 polite live region count=1 ✓');

		// Green diff tokens rendered (axe checks their rendered contrast).
		await expect(
			page.locator('[data-testid="diff-token"][data-status="match"]').first()
		).toBeVisible();
		await expectNoSeriousCritical(page, '/practice feedback pass light');
		await expectTapTargets(page, '/practice feedback pass light');

		await switchToDarkFresh(page);
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expectNoSeriousCritical(page, '/practice feedback pass dark');
		await expectTapTargets(page, '/practice feedback pass dark');
	});

	test('practice feedback (fail) — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, 'ぜんぜんちがう');
		await page.goto('/practice?chapter=child-1');
		// T13 push-to-talk: hold Space past the 0.5s short-tap guard, release → score.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/fail/);
		await expectNoSeriousCritical(page, '/practice feedback fail light');
		await expectTapTargets(page, '/practice feedback fail light');

		await switchToDarkFresh(page);
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expectNoSeriousCritical(page, '/practice feedback fail dark');
		await expectTapTargets(page, '/practice feedback fail dark');
	});

	test('--correct/--incorrect token contrast >= 4.5:1 (light & dark)', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await expectTokenContrast(page, 'light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await expectTokenContrast(page, 'dark');
	});

	/**
	 * task-13: contrast of every rendered .language-badge (foreground vs its
	 * own token background). Both tabpanels stay in the DOM, so chapter-row
	 * (JA/EN) and sentence-row (日本語/English) pills are all measured from a
	 * single page — computed styles resolve even on the hidden panel.
	 */
	async function expectBadgeContrast(page: Page, theme: 'light' | 'dark') {
		const badges = await page.evaluate(() => {
			const SENTINEL = 'rgb(1, 2, 3)';
			const parseToRgb = (cssColor: string): [number, number, number] => {
				const canvas = document.createElement('canvas');
				canvas.width = canvas.height = 1;
				const ctx = canvas.getContext('2d')!;
				ctx.fillStyle = SENTINEL;
				ctx.fillRect(0, 0, 1, 1);
				ctx.fillStyle = cssColor;
				ctx.fillRect(0, 0, 1, 1);
				if (ctx.fillStyle === SENTINEL) throw new Error(`color parse failed: ${cssColor}`);
				const d = ctx.getImageData(0, 0, 1, 1).data;
				return [d[0], d[1], d[2]];
			};
			const luminance = ([r, g, b]: [number, number, number]) => {
				const f = (c: number) => {
					const s = c / 255;
					return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
				};
				return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
			};
			const contrast = (a: string, b: string) => {
				const la = luminance(parseToRgb(a));
				const lb = luminance(parseToRgb(b));
				const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
				return (hi + 0.05) / (lo + 0.05);
			};
			return [...document.querySelectorAll('.language-badge')].map((b) => {
				const s = getComputedStyle(b);
				return {
					text: b.textContent!.trim(),
					ratio: contrast(s.color, s.backgroundColor),
					color: s.color,
					background: s.backgroundColor
				};
			});
		});
		for (const b of badges) {
			appendFileSync(
				EVIDENCE_FILE_13,
				`badge contrast (${theme}): "${b.text}" ${b.color} on ${b.background} = ${b.ratio.toFixed(2)}:1\n`
			);
		}
		// Guard against a selector/seed regression measuring nothing.
		for (const label of ['日本語', 'English', 'JA', 'EN']) {
			expect(
				badges.some((b) => b.text === label),
				`${theme}: a "${label}" .language-badge must be rendered`
			).toBe(true);
		}
		for (const b of badges) {
			expect(
				b.ratio,
				`${theme}: badge "${b.text}" contrast ${b.ratio.toFixed(2)}:1 < 4.5 (AA)`
			).toBeGreaterThanOrEqual(4.5);
		}
	}

	test('language badge token contrast >= 4.5:1 (light & dark, task-13)', async ({ page }) => {
		mkdirSync(EVIDENCE_DIR_13, { recursive: true });
		appendFileSync(
			EVIDENCE_FILE_13,
			`\n## task-13 badge contrast — ${new Date().toISOString()}\n`
		);
		await gotoWithSeed(page, BADGE_SEED);
		await page.goto('/manage?tab=%E6%96%87%E7%AB%A0');
		await page.getByTestId('sentence-text').first().waitFor();
		await expectBadgeContrast(page, 'light');

		await switchToDarkFresh(page);
		await page.getByTestId('sentence-text').first().waitFor();
		await expectBadgeContrast(page, 'dark');
	});

	test('prefers-reduced-motion removes recording pulse / celebration-pop', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, 'こんにちは。');
		await page.goto('/practice?chapter=child-1');

		const animName = (sel: string) =>
			page.evaluate((s) => {
				const el = document.querySelector(s);
				return el ? getComputedStyle(el).animationName : null;
			}, sel);

		// T13: the recording pulse belongs to the recording phase (hold Space).
		await startHold(page);
		await expect(page.getByTestId('recording-timer')).toBeVisible({ timeout: 10000 });
		expect(await animName('.animate-pulse')).toBe('none');
		logEvidence('reduced-motion: recording pulse → none ✓');

		// Release past the 0.5s short-tap guard → pass feedback; the score
		// celebration animation must be disabled under reduced motion.
		await page.waitForFunction(() => {
			const m = document
				.querySelector('[data-testid="recording-timer"]')
				?.textContent?.match(/(\d+\.\d+)/);
			return m ? parseFloat(m[1]) >= 0.7 : false;
		});
		await page.keyboard.up('Space');
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });
		expect(await animName('[data-testid="score"]')).toBe('none');
		logEvidence('reduced-motion: celebration-pop → none ✓');
	});
});
