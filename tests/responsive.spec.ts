import { test, expect, type Page } from './fixtures';
import { mkdirSync, appendFileSync } from 'node:fs';
import { gotoWithSeed, seedHistory } from './helpers';
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

/**
 * Tall content: one deliberately long sentence plus a few short ones.
 * A one-sentence seed never overflows the practice body, so a broken height
 * chain (min-h-* instead of a definite height) is invisible — the document
 * grows instead of the body and the fixed action zone leaves the viewport.
 * The long sentence is what forces the feedback word-diff / legend and the
 * summary's failed list past one viewport.
 */
const TALL_CHUNK =
	'今日はとてもいい天気ですね 理論 練習 音読 暗唱 暗記 単語 短语 段落 章 節 句 点 読 記号 用法 意味 発音 アクセント トーン ピッチ 韻律 テンポ 速度 数 図 表 計算 証明 論理学 微分 積分 統計 確率 行列 固有値 漸化式 境界条件 初期値 解 近似 誤差 収束 安定性 数値 可視化 標本 母集団 仮説 検定 有意差 効果量 信頼区間 推定 偏り 分散 共 Dispersion 考慮 猫 犬 鳥 魚 木 山 川 海 空 風 雨 雪 雷 霧 虹 曙 夕 夜 朝 昼 晩 ';
const TALL_LONG = TALL_CHUNK.repeat(6);

const TALL_SEED = {
	chapters: [{ id: 'tall-1', name: '背の高いコンテンツ検証章', parentId: null, order: 1 }],
	sentences: [
		{ id: 't-1', chapterId: 'tall-1', text: TALL_LONG, language: 'ja', order: 1 },
		{ id: 't-2', chapterId: 'tall-1', text: 'こんにちは。', language: 'ja', order: 2 },
		{ id: 't-3', chapterId: 'tall-1', text: 'お元気ですか。', language: 'ja', order: 3 }
	]
};

/** A partial transcript → a real word-diff spanning the whole long sentence. */
const TALL_TRANSCRIPT = TALL_LONG.replace(/[0-9]/g, '').slice(0, Math.floor(TALL_LONG.length * 0.75));

/**
 * The history section at 390px, with every part of the top page that the
 * content tree feeds rendered. Four deliberate choices, each one guarding
 * something the previous seed could not see:
 *
 * 1. **25 sessions** — above the UI's initial `historyLimit` of 20, so the
 *    section renders 20 rows AND the さらに表示 button. Below that the button
 *    is never in the DOM and its tap target cannot be gated.
 * 2. **A 120-character unbreakable name on a node that does not exist**
 *    (`HISTORY_LONG_NAME` / `gone-node`). Japanese wraps between characters, so
 *    an ordinary name can never reach the horizontal overflow the gate exists
 *    to catch; only a long Latin token can. A missing node is what forces the
 *    *stored* name to be the one displayed (and `(削除済み)` to render), so the
 *    long string is genuinely on screen rather than shadowed by a live name.
 * 3. **Stale `nodeName`s on the live sessions.** `sessionName` prefers the
 *    current chapter/track name, so a seed whose stored name equals the live
 *    one proves nothing — `nodeName: '章'` against a chapter also named `章` is
 *    dead data. `保存時の旧名` can never be displayed, and the test asserts so.
 * 4. **Real sentences + sentence stats.** `streak.totalAttempts` is the sum of
 *    the stats' attempts, so `sentences: {}` left the streak pill unrendered and
 *    the dot row / progress bar absent. h-1..h-5 give 2 passed / 2 hard /
 *    1 untouched against the default threshold of 80, so the chapter row's
 *    progress bar and the track row's dots are both non-empty.
 */
const HISTORY_LONG_NAME = 'A'.repeat(120);
/** Stored but never displayed — the live chapter name wins. */
const HISTORY_STALE_NAME = '保存時の旧名';
/** One clock read for every offset, so a midnight crossing cannot skew the day keys. */
const HISTORY_NOW = Date.now();
const HISTORY_DAY_MS = 86_400_000;

/** Chapter + track + sentences, so the tree rows have real denominators. */
const HISTORY_CONTENT = {
	chapters: [{ id: 'ch-1', name: '現在の章名', parentId: null, order: 1 }],
	tracks: [{ id: 'tr-1', chapterId: 'ch-1', parentId: null, order: 1, name: '現在のトラック名' }],
	sentences: [
		{ id: 'h-1', chapterId: 'ch-1', trackId: 'tr-1', text: 'こんにちは。', language: 'ja', order: 1 },
		{ id: 'h-2', chapterId: 'ch-1', trackId: 'tr-1', text: 'お元気ですか。', language: 'ja', order: 2 },
		{ id: 'h-3', chapterId: 'ch-1', trackId: 'tr-1', text: 'また明日。', language: 'ja', order: 3 },
		{ id: 'h-4', chapterId: 'ch-1', trackId: 'tr-1', text: 'さようなら。', language: 'ja', order: 4 },
		{ id: 'h-5', chapterId: 'ch-1', trackId: 'tr-1', text: 'Hello there.', language: 'en', order: 5 }
	]
};

const HISTORY_SEED = {
	version: 1,
	// Scores chosen against the default threshold of 80: 96/88 pass, 58/71 are
	// hard, and h-4 has no stat at all so its dot stays untouched. The window
	// MEAN is what decides, so each entry carries a full 3- or 2-attempt window
	// rather than a lone score — and its length (min 1, max 3) also puts a
	// realistic 直近 N 回 on the rows this seed renders.
	sentences: {
		'h-1': { attempts: 3, scores: [96, 96, 96], lastPracticedAt: HISTORY_NOW },
		'h-2': { attempts: 1, scores: [58], lastPracticedAt: HISTORY_NOW },
		'h-3': { attempts: 2, scores: [71, 71], lastPracticedAt: HISTORY_NOW - HISTORY_DAY_MS },
		'h-5': { attempts: 1, scores: [88], lastPracticedAt: HISTORY_NOW - HISTORY_DAY_MS }
	},
	sessions: Array.from({ length: 25 }, (_, i) => {
		// The three newest rows carry the adversarial long name; row 3 onwards
		// are live nodes, so both display paths sit inside the 20 rendered.
		const deleted = i < 3;
		return {
			id: 's' + i,
			nodeId: deleted ? 'gone-node' : i === 3 ? 'tr-1' : 'ch-1',
			nodeName: deleted ? HISTORY_LONG_NAME : HISTORY_STALE_NAME,
			startedAt: HISTORY_NOW - i * HISTORY_DAY_MS,
			endedAt: HISTORY_NOW - i * HISTORY_DAY_MS + 1000,
			durationMs: 1000,
			attempted: 1,
			passedSentences: 1,
			totalScore: 90,
			skipped: i === 3 ? 2 : 0,
			endedEarly: i === 3
		};
	})
};

/** The two buttons the history section owns, measured for a precise failure message. */
const HISTORY_BUTTONS = ['history-toggle', 'history-more'] as const;

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

/**
 * Mock /api/judge with the key-less fallback so a failing attempt never hits
 * the real OpenRouter endpoint. Registered FIRST so a test-specific judge mock
 * registered later overrides it (Playwright matches the last route first).
 */
async function mockJudgeFallback(page: Page) {
	await page.route('**/api/judge', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ available: false })
		})
	);
}

/** Mock /api/transcribe with a fixed transcript (plus the judge fallback). */
async function mockTranscribe(page: Page, text: string) {
	await mockJudgeFallback(page);
	await page.route('**/api/transcribe', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ text })
		})
	);
}

/**
 * Assert the practice shell clamps instead of growing: the document must not
 * exceed the viewport, the body must be the element that actually overflows
 * (and must start at the top), and the fixed action zone must stay in view.
 */
async function expectBodyScrollsNotDocument(page: Page, label: string) {
	const geo = await page.evaluate(() => {
		const de = document.documentElement;
		const body = document.querySelector('[data-testid="practice-body"]');
		const zone = document.querySelector('[data-testid="action-zone"]');
		const zr = zone?.getBoundingClientRect() ?? null;
		return {
			vh: window.innerHeight,
			docScrollH: de.scrollHeight,
			docScrollW: de.scrollWidth,
			docClientW: de.clientWidth,
			docScrollTop: de.scrollTop,
			bodyScrollH: body?.scrollHeight ?? 0,
			bodyClientH: body?.clientHeight ?? 0,
			bodyScrollTop: body?.scrollTop ?? -1,
			zoneBottom: zr ? zr.bottom : null,
			zoneTop: zr ? zr.top : null
		};
	});
	logEvidence(`\n=== shell clamp: ${label} ===`);
	logEvidence(
		`  document scrollHeight=${geo.docScrollH} innerHeight=${geo.vh} ` +
			`(ghost=${geo.docScrollH - geo.vh})`
	);
	logEvidence(
		`  body scrollHeight=${geo.bodyScrollH} clientHeight=${geo.bodyClientH} ` +
			`scrollTop=${geo.bodyScrollTop}`
	);
	logEvidence(`  action-zone top=${geo.zoneTop} bottom=${geo.zoneBottom}`);

	// The document must not grow past the viewport, and must not scroll.
	expect(
		geo.docScrollH,
		`${label}: the document must not grow past the viewport (no page-level scroll)`
	).toBe(geo.vh);
	expect(geo.docScrollW, `${label}: no horizontal overflow`).toBeLessThanOrEqual(geo.docClientW);
	// Proof the body is the scroll region: its content exceeds its box …
	expect(
		geo.bodyScrollH,
		`${label}: the body must overflow its own box (otherwise overflow-y-auto never fires)`
	).toBeGreaterThan(geo.bodyClientH);
	// … and it starts at the top, showing the first line of content.
	expect(geo.bodyScrollTop, `${label}: the body must start at the top`).toBe(0);
	// The fixed action zone stays inside the viewport.
	expect(geo.zoneBottom, `${label}: action-zone must exist`).not.toBeNull();
	expect(geo.zoneBottom!, `${label}: the action zone must stay inside the viewport`).toBeLessThanOrEqual(
		geo.vh + 1
	);
	expect(geo.zoneTop!, `${label}: the action zone must not start above the viewport`).toBeGreaterThanOrEqual(
		-1
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
			await page.goto('/practice?node=parent-1');
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

	/**
	 * `expectNoHorizontalOverflow` is BLIND to this one, which is why it survived:
	 * the badge row carries `overflow-hidden`, so a count that does not fit is cut
	 * inside its own box while `documentElement` stays at scrollWidth === clientWidth.
	 * Measured before the fix: 2 language badges + 120 sentences → the count text
	 * column shrank to 115px against a 134px `120/120 合格 · 95%`, so 19px of the
	 * average — the number the user asked for — was invisible.
	 *
	 * So this asserts the CLIP on the count element itself, and separately that the
	 * page still does not overflow. The second half of the test re-seeds a
	 * single-language chapter to prove the wrap does not cost a single-language row
	 * any height (nothing wraps there: badge + count = 160px of the 172px column).
	 */
	test('a two-badge chapter row wraps the count instead of clipping the average', async ({
		page
	}) => {
		/** 120 sentences alternating ja/en → two badges, all scored 95. */
		function mixedContent(languages: ('ja' | 'en')[]) {
			return {
				chapters: [{ id: 'ch-1', name: '混在チャプター', parentId: null, order: 1 }],
				tracks: [{ id: 'tr-1', chapterId: 'ch-1', parentId: null, order: 1, name: 'トラック' }],
				sentences: Array.from({ length: 120 }, (_, i) => ({
					id: `s-${i}`,
					chapterId: 'ch-1',
					trackId: 'tr-1',
					text: `文 ${i}`,
					language: languages[i % languages.length],
					order: i + 1
				}))
			};
		}

		const readCount = () =>
			page.evaluate(() => {
				const el = document.querySelector('[data-testid="chapter-card-count"]');
				const badges = Array.from(document.querySelectorAll('.language-badge'));
				const tops = badges.map((b) => Math.round(b.getBoundingClientRect().top));
				const row = el!.parentElement!;
				return {
					text: el!.textContent?.replace(/\s+/g, ' ').trim() ?? '',
					clipped: el!.scrollWidth - el!.clientWidth,
					client: el!.clientWidth,
					scroll: el!.scrollWidth,
					badgeCount: badges.length,
					badgesShareOneLine: new Set(tops).size === 1,
					countBelowBadges:
						Math.round(el!.getBoundingClientRect().top) > Math.min(...tops),
					rowHeight: Math.round(row.getBoundingClientRect().height),
					cardHeight: Math.round(
						document.querySelector('[data-testid="chapter-card"]')!.getBoundingClientRect().height
					),
					docOverflow:
						document.documentElement.scrollWidth - document.documentElement.clientWidth
				};
			});

		const seedAll95 = () =>
			seedHistory(page, {
				version: 1,
				sessions: [],
				sentences: Object.fromEntries(
					Array.from({ length: 120 }, (_, i) => [
						`s-${i}`,
						{ attempts: 1, scores: [95], lastPracticedAt: Date.now() }
					])
				)
			});

		await gotoWithSeed(page, mixedContent(['ja', 'en']));
		await seedAll95();

		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('120/120 合格 · 95%');
		const mixed = await readCount();
		logEvidence(
			`\n=== chapter count clip @390px (2 badges): "${mixed.text}" client=${mixed.client} scroll=${mixed.scroll} clipped=${mixed.clipped} rowH=${mixed.rowHeight} cardH=${mixed.cardHeight}`
		);
		// The average is fully visible. 19px of it were cut before the fix.
		expect(mixed.badgeCount, 'the mixed chapter must render both language badges').toBe(2);
		expect(mixed.clipped, 'the count text must not be clipped inside the badge row').toBe(0);
		expect(mixed.scroll).toBe(mixed.client);
		// The fix's mechanism, not a coincidence: the badges stay on one line and
		// the count moved below them, so nothing was simply hidden.
		expect(mixed.badgesShareOneLine).toBe(true);
		expect(mixed.countBelowBadges).toBe(true);
		// …and wrapping did not turn into page overflow.
		expect(mixed.docOverflow).toBe(0);

		// Single-language: one badge, so badges + count still fit on one line and
		// the row must be exactly as short as it was before the fix.
		await gotoWithSeed(page, mixedContent(['ja']));
		await seedAll95();
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('120/120 合格 · 95%');
		const single = await readCount();
		logEvidence(
			`\n=== chapter count clip @390px (1 badge): "${single.text}" clipped=${single.clipped} rowH=${single.rowHeight} cardH=${single.cardHeight}`
		);
		expect(single.badgeCount).toBe(1);
		expect(single.clipped).toBe(0);
		// One line: 20px. A wrap that fired here would mean the fix costs every
		// single-language chapter 25px of height for nothing.
		expect(single.badgesShareOneLine).toBe(true);
		expect(single.countBelowBadges).toBe(false);
		expect(single.rowHeight, 'a one-badge row must stay on a single line').toBe(20);
		expect(single.docOverflow).toBe(0);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/top-two-badge-count.png`, fullPage: true });
	});

	/**
	 * The three gates the top-page scans above cannot cover, because they seed
	 * only `oboeru:v1` and so never render the new UI:
	 *
	 *   - the seed guards below prove the streak pill, the 20 history rows and
	 *     さらに表示 are actually on screen (otherwise every other assertion
	 *     here would pass over zero elements),
	 *   - `expectNoHorizontalOverflow` proves a 120-character unbreakable node
	 *     name plus the streak pill cannot spill sideways at 390px. Japanese
	 *     wraps between characters, so without the Latin token in HISTORY_SEED
	 *     this gate would be measuring nothing,
	 *   - `expectTapTargets` (asserting, unlike the a11y.spec.ts copy) proves
	 *     the history toggle and さらに表示 are >= 44px at 390px.
	 *
	 * Reuses this file's own module-private helpers — no duplicated copy of
	 * `checkTapTargets`, so the existing tap-target tests are untouched.
	 */
	test('top page with history open — no overflow, tap targets >= 44px', async ({ page }) => {
		await gotoWithSeed(page, HISTORY_CONTENT);
		await seedHistory(page, HISTORY_SEED, { open: true });

		// Setup guards: an empty history renders no section at all, and an empty
		// `sentences` map leaves the streak pill unrendered (its totalAttempts is
		// the sum of the stats' attempts). Either way the assertions below would
		// pass vacuously.
		await expect(page.getByTestId('history-log')).toBeVisible();
		await expect(page.getByTestId('history-item')).toHaveCount(20); // historyLimit
		await expect(page.getByTestId('history-more')).toBeVisible();
		await expect(page.getByTestId('streak-pill')).toBeVisible();
		await expect(page.getByTestId('track-dots')).toBeVisible();
		await expect(page.getByTestId('chapter-progress')).toBeVisible();

		// The headline gate first. Japanese wraps between characters, so only the
		// Latin token in HISTORY_SEED can ever reach this — which is exactly why
		// the overflow assertion, not the tap-target one, is what proves the seed
		// is adversarial.
		await expectNoHorizontalOverflow(page, '/ history open');
		await expectTapTargets(page, '/ history open');

		// Then prove the long name is really on screen and really is too long for
		// its row. A seed whose stored name were shadowed by a live name (or
		// dropped by a rename) would leave nothing to overflow, and the gate above
		// would pass for the wrong reason.
		const longRow = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="history-item-name"]');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return {
				text: el.textContent?.trim() ?? '',
				clientWidth: el.clientWidth,
				scrollWidth: el.scrollWidth,
				right: r.right
			};
		});
		expect(longRow, '/ history: the long node name must be rendered').not.toBeNull();
		expect(
			longRow!.text.length,
			'/ history: the displayed name must be the 120-char stored name, not a live one'
		).toBe(HISTORY_LONG_NAME.length);
		expect(
			longRow!.scrollWidth,
			'/ history: the long name must genuinely exceed its row (nothing to prove otherwise)'
		).toBeGreaterThan(longRow!.clientWidth);
		expect(
			Math.round(longRow!.right),
			'/ history: the truncated name must stay inside the viewport'
		).toBeLessThanOrEqual(390);

		// The 最終/苦手/直近 line must not CLIP. `expectNoHorizontalOverflow` above
		// cannot see clipping: `truncate` keeps the page at scrollWidth === clientWidth
		// while cutting the text off inside the row. The chapter row's text column
		// measures 172px at 390px, and `最終 今日 · 苦手 2 文 · 直近 1 回` needs 202px —
		// so `truncate` on this line silently hid 直近 N 回 on every chapter row
		// (measured 30-70px clipped). It wraps instead. Adding `truncate` back makes
		// this assertion fail.
		const lastLines = await page.evaluate(() => {
			const out: { testid: string; text: string; clipped: number }[] = [];
			for (const id of ['chapter-last', 'track-last']) {
				for (const el of Array.from(document.querySelectorAll(`[data-testid="${id}"]`))) {
					out.push({
						testid: id,
						text: el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
						clipped: el.scrollWidth - el.clientWidth
					});
				}
			}
			return out;
		});
		expect(lastLines.length, 'the 最終 lines must be rendered').toBeGreaterThan(0);
		for (const line of lastLines) {
			logEvidence(`\n=== clipped text @390px: ${line.testid} "${line.text}" clipped=${line.clipped}px`);
			expect(line.clipped, `${line.testid} "${line.text}" is clipped`).toBeLessThanOrEqual(0);
		}
		// 直近 N 回 actually reaches the screen on both row kinds (a clipped tail
		// would leave the text present but invisible).
		await expect(page.getByTestId('chapter-last').first()).toContainText('直近 1 回');
		await expect(page.getByTestId('track-last').first()).toContainText('直近 1 回');

		// `(削除済み)` rides OUTSIDE the truncated name: with a 120-char name it is
		// the only thing telling the user the node is gone.
		await expect(page.getByTestId('history-item').first()).toContainText('(削除済み)');
		// Live name wins over the stored one — HISTORY_STALE_NAME must never show.
		const rows = await page.getByTestId('history-item').allInnerTexts();
		expect(rows.some((t) => t.includes('現在の章名'))).toBe(true);
		expect(rows.some((t) => t.includes('現在のトラック名'))).toBe(true);
		expect(rows.some((t) => t.includes(HISTORY_STALE_NAME))).toBe(false);

		const boxes = await page.evaluate((ids) => {
			const out: Record<string, { h: number; w: number } | null> = {};
			for (const id of ids) {
				const el = document.querySelector(`[data-testid="${id}"]`);
				const r = el?.getBoundingClientRect();
				out[id] = r ? { h: Math.round(r.height), w: Math.round(r.width) } : null;
			}
			return out;
		}, HISTORY_BUTTONS);
		logEvidence(
			`\n=== history tap targets @390px: ` +
				HISTORY_BUTTONS.map((id) => `${id}=${boxes[id] ? `${boxes[id]!.w}x${boxes[id]!.h}px` : 'MISSING'}`).join(', ') +
				` | long name: clientWidth=${longRow!.clientWidth} scrollWidth=${longRow!.scrollWidth} right=${Math.round(longRow!.right)} ===`
		);
		for (const id of HISTORY_BUTTONS) {
			expect(boxes[id], `/ history: [data-testid="${id}"] must be rendered`).not.toBeNull();
			expect(boxes[id]!.h, `/ history: ${id} height >= 44px`).toBeGreaterThanOrEqual(44);
		}

		await page.screenshot({ path: `${SCREENSHOT_DIR}/top-history.png`, fullPage: true });
	});

	test('practice show — no overflow, tap targets >= 44px, skip full-width + header exit', async ({
		page
	}) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?node=parent-1');

		await expectNoHorizontalOverflow(page, '/practice show');
		await expectTapTargets(page, '/practice show');

		const barWidth = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="progress-bar"]');
			return el ? el.getBoundingClientRect().width : 0;
		});
		expect(
			barWidth,
			'/practice show: the progress bar must span the full width at 390px'
		).toBeGreaterThanOrEqual((await page.evaluate(() => window.innerWidth)) * 0.8);

		// Keyboard hints are meaningless without a keyboard. Assert on the
		// *visible* count rather than `.first()`: there are 7 `.kbd-hint`
		// elements across the phase branches and a `.first()` check would only
		// ever cover one of them.
		await expect(page.locator('.kbd-hint:visible')).toHaveCount(0);

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

		// The bottom action zone is fixed: it never scrolls out of the viewport.
		const zone = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="action-zone"]');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
		});
		expect(zone, '/practice show: action-zone not found').not.toBeNull();
		expect(zone?.bottom ?? Infinity).toBeLessThanOrEqual((zone?.vh ?? 0) + 1);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice.png`, fullPage: true });
	});

	test('practice recording — no overflow, tap targets >= 44px', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?node=parent-1');

		// T13 push-to-talk: hold Space to enter (and stay in) the recording phase.
		// The ready state is asserted first: `record-ready-hint` only exists while
		// phase === 'hidden' && !micConnecting && !micError, so a toBeHidden()
		// anywhere else passes vacuously with a zero element count.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('record-ready-hint')).toBeHidden();
		await expect(page.locator('.kbd-hint:visible')).toHaveCount(0);

		await startHold(page);
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });

		await expectNoHorizontalOverflow(page, '/practice recording');
		await expectTapTargets(page, '/practice recording');

		// While recording the skip button is inert: disabled, and no S hint
		// (an S keycap that does nothing must not be shown).
		await expect(page.getByTestId('skip-btn')).toBeDisabled();
		await expect(page.locator('.kbd-hint:visible')).toHaveCount(0);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-recording.png`, fullPage: true });
	});

	/**
	 * Regression guard for the level history meter's horizontal overflow.
	 *
	 * The 32-bar history has an intrinsic min-content width of
	 * 8px*32 + 3px*31 + p-2*2 = 365px. The *parent*
	 * `<div class="flex flex-col items-center justify-start gap-4 py-4">` sets
	 * `align-items: center`, so `sentence-recording` resolves to a *fit-content*
	 * cross size, and fit-content can never go below min-content.
	 * (`sentence-recording`'s own `align-items` does not affect its own width —
	 * removing it fixes nothing.) Without a
	 * definite `w-full` on that wrapper the meter stayed 365px wide at
	 * 320/360px, was centred so it spilled ~22px off BOTH edges, and
	 * `overflow-hidden` on the bar row never got a chance to clip:
	 * the newest bar itself ended up outside the viewport.
	 *
	 * `expectNoHorizontalOverflow` cannot catch this on its own — the meter
	 * overflows *inside* an ancestor that clips, and the spilled area is on the
	 * left, which `documentElement.scrollWidth` does not report in LTR. So this
	 * test measures the bar row's own box against the viewport.
	 *
	 * Note on the oldest bar: with 32 bars at 320px only ~25 fit, so the oldest
	 * bars are *supposed* to be clipped on the left by `overflow-hidden`. The
	 * invariant asserted here is therefore "the row's box is inside the viewport
	 * and the newest bar is visible", not "all 32 bars are visible".
	 */
	for (const width of [320, 360, 390, 430]) {
		test(`practice recording — level history stays inside the viewport at ${width}px`, async ({
			page
		}) => {
			await page.setViewportSize({ width, height: 844 });
			await gotoWithSeed(page, SEED);
			await mockTtsApi(page);
			await page.goto('/practice?node=parent-1');

			await startHold(page);
			// Bars are appended on every level callback (100ms), loud or quiet, so
			// this does not depend on the bursty fake-audio beep.
			await page.waitForFunction(
				() => document.querySelectorAll('[data-testid="level-history"] span').length >= 32,
				null,
				{ timeout: 20000 }
			);

			const geo = await page.evaluate(() => {
				const row = document.querySelector<HTMLElement>('[data-testid="level-history"]');
				if (!row) throw new Error('level-history is missing');
				const rr = row.getBoundingClientRect();
				const bars = [...row.querySelectorAll('span')];
				const newest = bars[bars.length - 1].getBoundingClientRect();
				return {
					viewportW: window.innerWidth,
					rowLeft: rr.left,
					rowRight: rr.right,
					rowWidth: rr.width,
					barCount: bars.length,
					newestLeft: newest.left,
					newestRight: newest.right,
					// Bars the row's own overflow-hidden cuts on the left.
					clippedLeft: bars.filter((b) => b.getBoundingClientRect().left < rr.left - 0.5)
						.length,
					bodyScrollW: document.body.scrollWidth,
					bodyClientW: document.body.clientWidth,
					docScrollW: document.documentElement.scrollWidth,
					docClientW: document.documentElement.clientWidth
				};
			});

			const label = `/practice recording @${width}px`;

			expect(geo.barCount, `${label}: the history must be full`).toBe(32);

			// The row's own box must sit inside the viewport, not spill off both
			// edges. This is the assertion that fails without `w-full` on
			// `sentence-recording` (measured: rowLeft=-22.5, rowRight=342.5 at 320px).
			expect(geo.rowLeft, `${label}: the meter must not spill off the left edge`).toBeGreaterThanOrEqual(
				-0.5
			);
			expect(
				geo.rowRight,
				`${label}: the meter must not spill off the right edge`
			).toBeLessThanOrEqual(geo.viewportW + 0.5);

			// The newest bar is the one the user is actually looking at; if the
			// row is pushed out, this is the first thing to disappear.
			expect(geo.newestRight, `${label}: the newest bar must be fully visible`).toBeLessThanOrEqual(
				geo.rowRight + 0.5
			);
			expect(geo.newestLeft, `${label}: the newest bar must be fully visible`).toBeGreaterThanOrEqual(
				geo.rowLeft - 0.5
			);

			// Neither the body nor the document may scroll horizontally.
			expect(geo.bodyScrollW, `${label}: body must not overflow`).toBeLessThanOrEqual(
				geo.bodyClientW
			);
			expect(geo.docScrollW, `${label}: document must not overflow`).toBeLessThanOrEqual(
				geo.docClientW
			);

			// Below 390px the 365px min-content cannot fit, so clipping is the
			// designed behaviour and we assert it actually happened. At >= 390px
			// all 32 bars fit and nothing may be clipped.
			if (width < 390) {
				expect(
					geo.clippedLeft,
					`${label}: narrow viewports must clip the oldest bars, not overflow`
				).toBeGreaterThan(0);
			} else {
				expect(geo.clippedLeft, `${label}: all 32 bars fit, none may be clipped`).toBe(0);
			}

			// Screenshot while still holding Space: releasing first lets the 300ms
			// timer elapse, which unmounts `level-history` and moves the body to
			// the feedback phase — the artifact would show no meter at all.
			await page.screenshot({
				path: `${SCREENSHOT_DIR}/level-history-${width}px.png`,
				fullPage: true
			});

			await page.keyboard.up('Space');
		});
	}

	test('practice feedback — no overflow, action buttons stacked full-width', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, 'こんにちは。');
		await page.goto('/practice?node=parent-1');

		// T13 push-to-talk: hold Space past the 0.5s short-tap guard, release → score.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

		await expectNoHorizontalOverflow(page, '/practice feedback');
		await expectTapTargets(page, '/practice feedback');

		// No visible keyboard hint in the feedback phase either (症状 C).
		await expect(page.locator('.kbd-hint:visible')).toHaveCount(0);

		// 操作ボタン縦積み: 次へ / もう一度聴く / スキップ live in the bottom
		// action zone, stacked vertically, each spanning the zone width.
		await expect(page.locator('[data-testid="feedback-actions"]')).toBeVisible();

		const rects = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="feedback-actions"]');
			if (!el) return null;
			return Array.from(el.querySelectorAll('button')).map((b) => {
				const r = b.getBoundingClientRect();
				return { width: r.width, top: r.top, bottom: r.bottom };
			});
		});
		expect(rects, '/practice feedback: action buttons not found').not.toBeNull();

		const containerWidth = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="feedback-actions"]');
			return el ? (el as HTMLElement).clientWidth : 0;
		});

		// Guards against a vacuous pass: an empty feedback-actions would make
		// both loops below run zero times, and a zero container width would
		// make every threshold trivially true. The contract for the feedback
		// action zone is 主操作 1 (次へ / もう一度試す) + サブ 2 (もう一度聴く / スキップ).
		expect(
			rects!.length,
			'/practice feedback: expected the 3 stacked action buttons (1 primary + 2 secondary)'
		).toBeGreaterThanOrEqual(3);
		expect(
			containerWidth,
			'/practice feedback: feedback-actions must have a measurable width'
		).toBeGreaterThan(0);

		for (const r of rects ?? []) {
			expect(
				r.width,
				'/practice feedback: action buttons must span the container'
			).toBeGreaterThanOrEqual(containerWidth * 0.85);
		}

		const sorted = [...(rects ?? [])].sort((a, b) => a.top - b.top);
		for (let i = 1; i < sorted.length; i++) {
			expect(
				sorted[i].top,
				'/practice feedback: action buttons must stack vertically at 390px'
			).toBeGreaterThanOrEqual(sorted[i - 1].bottom - 2);
		}
		logEvidence('practice feedback: action buttons stacked vertically, container-width ✓');

		// アクションゾーンは常にビューポート内に収まること
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.waitForTimeout(200);
		const zone = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="action-zone"]');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
		});
		expect(zone, '/practice feedback: action-zone not found').not.toBeNull();
		expect(
			(zone?.bottom ?? Infinity),
			'/practice feedback: the action zone must stay inside the viewport'
		).toBeLessThanOrEqual((zone?.vh ?? 0) + 1);
		expect(
			(zone?.top ?? -Infinity),
			'/practice feedback: the action zone must not start above the viewport'
		).toBeGreaterThanOrEqual(-1);

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-feedback.png`, fullPage: true });
	});

	// -------------------------------------------------------------------------
	// Tall-content regression: 「本文のみスクロール」 must actually be the
	// scroll region. With a one-sentence seed everything fits, so a broken
	// height chain (min-h-* instead of a definite height) is invisible: the
	// document grows instead of the body, the document scrolls, and the fixed
	// action zone leaves the viewport. These tests use a deliberately long
	// sentence so the feedback body and the summary both overflow the region.
	// -------------------------------------------------------------------------

	test('practice feedback (tall content) — the body scrolls, the action zone stays put', async ({
		page
	}) => {
		await gotoWithSeed(page, TALL_SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, TALL_TRANSCRIPT);
		await page.goto('/practice?node=tall-1');

		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		// The long sentence really did produce a multi-line word diff.
		await expect(page.getByTestId('word-diff')).toBeVisible();

		await expectBodyScrollsNotDocument(page, '/practice feedback tall');
		await expectNoHorizontalOverflow(page, '/practice feedback tall');
		await expectTapTargets(page, '/practice feedback tall');

		// Scrolling the body must not move the header or the action zone.
		const before = await page.evaluate(() => {
			const z = document.querySelector('[data-testid="action-zone"]')!.getBoundingClientRect();
			const h = document.querySelector('[data-testid="practice-header"]')!.getBoundingClientRect();
			return { zoneTop: z.top, zoneBottom: z.bottom, headerTop: h.top };
		});
		await page.evaluate(() => {
			const b = document.querySelector('[data-testid="practice-body"]')!;
			b.scrollTop = b.scrollHeight;
		});
		await page.waitForTimeout(300);
		const after = await page.evaluate(() => {
			const z = document.querySelector('[data-testid="action-zone"]')!.getBoundingClientRect();
			const h = document.querySelector('[data-testid="practice-header"]')!.getBoundingClientRect();
			const b = document.querySelector('[data-testid="practice-body"]')!;
			return {
				zoneTop: z.top,
				zoneBottom: z.bottom,
				headerTop: h.top,
				bodyScrollTop: b.scrollTop,
				bodyScrollH: b.scrollHeight,
				bodyClientH: b.clientHeight,
				docScrollTop: document.documentElement.scrollTop
			};
		});
		expect(
			after.bodyScrollTop,
			'/practice feedback tall: the body must actually scroll internally'
		).toBeGreaterThan(0);
		expect(
			after.docScrollTop,
			'/practice feedback tall: the document itself must not scroll'
		).toBe(0);
		expect(after.zoneTop, '/practice feedback tall: the action zone must not move').toBe(
			before.zoneTop
		);
		expect(after.zoneBottom, '/practice feedback tall: the action zone must not move').toBe(
			before.zoneBottom
		);
		expect(after.headerTop, '/practice feedback tall: the header must not move').toBe(
			before.headerTop
		);
		logEvidence('practice feedback tall: body scrolls, header + action zone pinned ✓');

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-feedback-tall.png` });
	});

	test('practice advances with the body scrolled back to the top', async ({ page }) => {
		await gotoWithSeed(page, TALL_SEED);
		await mockTtsApi(page);
		// A wrong transcript → the retry path, so the next round is reached via
		// もう一度試す rather than 次へ.
		await mockTranscribe(page, 'ちがう');
		await page.goto('/practice?node=tall-1');

		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await page.evaluate(() => {
			const b = document.querySelector('[data-testid="practice-body"]')!;
			b.scrollTop = b.scrollHeight;
		});
		await page.waitForTimeout(200);
		expect(
			await page.evaluate(
				() => document.querySelector('[data-testid="practice-body"]')!.scrollTop
			),
			'setup: the body must be scrolled before advancing'
		).toBeGreaterThan(0);

		// The next attempt must start at the top of the body.
		await page.getByTestId('retry-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10000 });
		expect(
			await page.evaluate(
				() => document.querySelector('[data-testid="practice-body"]')!.scrollTop
			),
			'a phase change must rewind the body to the top'
		).toBe(0);
		logEvidence('practice phase change: body scrollTop reset to 0 ✓');
	});

	test('practice summary (tall content) — scrolls inside, never past the viewport', async ({
		page
	}) => {
		await gotoWithSeed(page, TALL_SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, 'ちがう');
		await page.goto('/practice?node=tall-1');

		// Each sentence gets a real failing attempt (that is what populates
		// 間違えた文 — skip() alone would not), then a skip onward. Three
		// stacked stat cards plus a three-entry failed list overflows.
		for (let i = 0; i < 6; i++) {
			if (await page.getByTestId('summary').count()) break;
			await holdAndRelease(page);
			await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
			await page.getByTestId('skip-btn').click();
			await page.waitForFunction(
				() =>
					document.querySelector('[data-testid="summary"]') !== null ||
					document.querySelector('[data-testid="record-ready"]') !== null,
				undefined,
				{ timeout: 15000 }
			);
		}
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('summary-failed-item').first()).toBeVisible();

		const geo = await page.evaluate(() => {
			const de = document.documentElement;
			const summary = document.querySelector('[data-testid="summary"]')!;
			const scroller = summary.parentElement!;
			return {
				vh: window.innerHeight,
				docScrollH: de.scrollHeight,
				docScrollW: de.scrollWidth,
				docClientW: de.clientWidth,
				scrollH: scroller.scrollHeight,
				clientH: scroller.clientHeight,
				scrollTop: scroller.scrollTop,
				overflowY: getComputedStyle(scroller).overflowY
			};
		});
		logEvidence(`\n=== shell clamp: /practice summary tall ===`);
		logEvidence(
			`  document scrollHeight=${geo.docScrollH} innerHeight=${geo.vh} ` +
				`(ghost=${geo.docScrollH - geo.vh})`
		);
		logEvidence(
			`  summary scroller scrollHeight=${geo.scrollH} clientHeight=${geo.clientH} ` +
				`scrollTop=${geo.scrollTop} overflowY=${geo.overflowY}`
		);

		expect(
			geo.docScrollH,
			'/practice summary tall: the document must not grow past the viewport'
		).toBe(geo.vh);
		expect(geo.docScrollW, '/practice summary tall: no horizontal overflow').toBeLessThanOrEqual(
			geo.docClientW
		);
		expect(
			geo.scrollH,
			'/practice summary tall: the summary must overflow its own scroll wrapper'
		).toBeGreaterThan(geo.clientH);
		expect(
			geo.scrollTop,
			'/practice summary tall: the summary must start at the top'
		).toBe(0);
		await expectTapTargets(page, '/practice summary tall');

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-summary-tall.png` });
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
