import { test, expect, type Page } from './fixtures';
import { gotoWithSeed, seedHistory } from './helpers';
import { mockTtsApi } from './tts-mock';
import type { SessionRecord } from '../src/lib/history';

/**
 * Practice history, end to end.
 *
 * The main path is a real session driven by Space, not a localStorage seed: a
 * seeded `oboeru:history:v1` cannot tell "the app wrote this" from "the test
 * wrote this", so it would stay green if the write path were deleted outright.
 *
 * The three `regression:` tests are the ones nothing else covers. Each pins a
 * single line of `src/routes/practice/+page.svelte`; deleting that line leaves
 * every other suite green (proved per-test by mutation in the task-8 report).
 *
 * Conventions followed (AGENTS.md § E2E テスト規約):
 * 1. `record-ready` is awaited before EVERY first Space keydown — a keydown
 *    that fires before hydration is a one-shot loss.
 * 2. Holds go through `holdAndRelease` (holds until the on-screen timer reads
 *    ≥ 0.7s, so the 500ms short-press guard can never trip, and it always
 *    ends with `keyboard.up('Space')` so no `event.repeat` leaks into the next
 *    press). Nothing here leaves Space held across a reload or navigation.
 * 3. Advancing past a scoring feedback is an explicit `keyboard.press('Space')`
 *    tap (= 次へ) — never a timeout.
 * 4. `mockTranscribe` installs `mockJudgeFallback` first, so a key in `.env`
 *    cannot turn any of these into a real OpenRouter call.
 * 5. /api/tts is mocked too: a TTS failure lands in the `feedback` phase with
 *    an error, so `record-ready` would never appear and the whole flow would
 *    stall on the real endpoint (which needs OPENROUTER_API_KEY).
 *
 * Brief reconciliation (the snippet assumed helpers this repo does not have):
 * - `mockTranscribe` here takes an ARRAY of responses, last one repeating —
 *   not the object map the brief used. So "s-1 passes, s-2 fails, the retry
 *   passes" is `[{text:'あああ'}, {text:'alas'}, {text:'いいい'}]`: the retry
 *   session is a third call, not a re-read of the map.
 * - `/api/tts` is mocked (see 5 above); the brief omitted it.
 * - `record-ready` / `feedback` / `summary` / `retry-failed-btn` are the real
 *   testids, and the session is advanced with `next-btn` clicks or Space taps
 *   (both are the product's own primary action).
 * - `holdAndRelease` is a local copy of practice.spec.ts's helper (a spec file
 *   cannot be imported without re-registering its tests).
 * - The chapter name is `1章` and the deleted-node marker is a SIBLING span of
 *   the name (`消した章` + `(削除済み)`, no whitespace between them in
 *   textContent), so `'消した章 (削除済み)'` as one `toContainText` would
 *   never match — the two halves are asserted separately.
 */

const SEED = {
	chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
	tracks: [
		{ id: 'tr-1', chapterId: 'ch-1', name: 'トラック1', parentId: null, order: 1 },
		{ id: 'tr-2', chapterId: 'ch-1', name: 'トラック2', parentId: null, order: 2 }
	],
	sentences: [
		{ id: 's-1', chapterId: 'ch-1', trackId: 'tr-1', text: 'あああ', language: 'ja', order: 1 },
		{ id: 's-2', chapterId: 'ch-1', trackId: 'tr-1', text: 'いいい', language: 'ja', order: 2 }
	]
};

interface TranscribeResponse {
	status?: number;
	text?: string;
	delayMs?: number;
	headers?: Record<string, string>;
}

/** Mock /api/judge with the key-less fallback — see practice.spec.ts. */
async function mockJudgeFallback(page: Page): Promise<void> {
	await page.route('**/api/judge', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ available: false })
		})
	);
}

/** Mock /api/transcribe. Queue of responses; the last entry repeats. */
async function mockTranscribe(page: Page, responses: TranscribeResponse[]): Promise<void> {
	await mockJudgeFallback(page);
	let call = 0;
	await page.route('**/api/transcribe', async (route) => {
		const r = responses[Math.min(call, responses.length - 1)];
		call++;
		if (r.delayMs) {
			await new Promise((resolve) => setTimeout(resolve, r.delayMs));
		}
		if (r.status && r.status !== 200) {
			await route.fulfill({
				status: r.status,
				headers: r.headers ?? {},
				contentType: 'application/json',
				body: '{}'
			});
		} else {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ text: r.text ?? '' })
			});
		}
	});
}

/**
 * Hold Space until the on-screen timer reads ≥ 700ms, then release. Measured
 * by the timer rather than the wall clock so a slow worker cannot produce a
 * sub-500ms hold, and it always ends with `keyboard.up('Space')`.
 */
async function holdAndRelease(page: Page): Promise<void> {
	await page.keyboard.down('Space');
	await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
	await page.waitForFunction(() => {
		const m = document
			.querySelector('[data-testid="recording-timer"]')
			?.textContent?.match(/(\d+\.\d+)/);
		return m ? parseFloat(m[1]) >= 0.7 : false;
	});
	await page.keyboard.up('Space');
}

/**
 * Card of the track whose name is exactly `name`. A plain
 * `filter({ hasText: name })` collides whenever one name is a substring of
 * another ("トラック1" ⊂ "トラック1-1") and every assertion would then run in
 * strict mode against two rows — see top.spec.ts, which hit exactly that.
 */
function trackCard(page: Page, name: string) {
	const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
	return page.getByTestId('track-card').filter({
		has: page.getByTestId('track-card-name').filter({ hasText: exactName })
	});
}

/** The session rows as the app actually persisted them. */
async function readSessions(page: Page): Promise<SessionRecord[]> {
	return page.evaluate(() => {
		const raw = localStorage.getItem('oboeru:history:v1');
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return [];
		const sessions = (parsed as { sessions?: unknown }).sessions;
		return Array.isArray(sessions) ? (sessions as SessionRecord[]) : [];
	});
}

/** Wait for `count` persisted rows, then hand them back. */
async function waitForSessions(page: Page, count: number): Promise<SessionRecord[]> {
	await expect
		.poll(async () => (await readSessions(page)).length, {
			message: `expected ${count} persisted session row(s)`,
			timeout: 5000
		})
		.toBe(count);
	return readSessions(page);
}

/**
 * Run a whole session on the chapter node and land on the summary.
 * `responses` is consumed one entry per scoring attempt.
 */
async function practiseWholeChapter(
	page: Page,
	responses: TranscribeResponse[]
): Promise<void> {
	await gotoWithSeed(page, SEED);
	await mockTtsApi(page);
	await mockTranscribe(page, responses);
	await page.goto('/practice?node=ch-1');

	// Convention 1: never press Space before the ready screen exists.
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

	for (let i = 0; i < SEED.sentences.length; i++) {
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		// Convention 3: an explicit tap. On a pass this is 次へ, and the last
		// sentence's 次へ is what enters the summary.
		await page.keyboard.press('Space');
	}

	await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10_000 });
}

test.describe('Practice history', () => {
	test('a completed session lands on the top page as progress and one log row', async ({
		page
	}) => {
		await practiseWholeChapter(page, [{ text: 'あああ' }, { text: 'いいい' }]);

		// WRITE path, app-driven. Everything else in this file that touches
		// totalScore reads a seeded row, so `totalScore: 0` in settleSession()
		// corrupted every row's 平均 while all 22 history tests stayed green —
		// the mutation was only ever caught at the RENDER site
		// (sessionAverage() → 0), not where the value is produced. Both
		// sentences transcribed back exactly as read, so each scores 100 and the
		// row must carry their sum. `/api/judge` is stubbed to the key-less
		// fallback (mockTranscribe installs it), so finalScore === sim === 100
		// and the number is deterministic.
		const [written] = await waitForSessions(page, 1);
		expect(written.attempted).toBe(2);
		expect(written.totalScore).toBe(200);

		await page.goto('/');

		// Both sentences scored 100, so the average and the pass ratio coincide
		// at 100 here — this row cannot tell the two apart. The test that does
		// is 「a partially practised node」 below (label 70% / bar 50%).
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('2/2 合格 · 100%');
		// The BAR is the pass ratio. Asserted here too so a percent() that only
		// the bar reads cannot pass.
		await expect(
			page.getByTestId('chapter-progress').first().locator('div')
		).toHaveAttribute('style', /width:\s*100%/);
		await expect(page.getByTestId('streak-pill')).toContainText('連続 1 日');
		await expect(page.getByTestId('history-toggle')).toContainText('練習履歴 (1)');

		await page.getByTestId('history-toggle').click();
		await expect(page.getByTestId('history-log')).toBeVisible();
		await expect(page.getByTestId('history-item')).toHaveCount(1);
		await expect(page.getByTestId('history-item').first()).toContainText('2 文 合格');
		await expect(page.getByTestId('history-item-name').first()).toHaveText('1章');
		// The rendered average comes from the same field the assertion above
		// pins at the write site, so the two cannot drift apart.
		await expect(page.getByTestId('history-item').first()).toContainText('平均 100%');
		// No skips and no early stop: the marker must be absent, not merely
		// absent-looking. `途中で終了` is only rendered when endedEarly.
		await expect(page.getByTestId('history-item').first()).not.toContainText('途中で終了');
	});

	test('a chapter-started session records the chapter name', async ({ page }) => {
		// regression: `chapters = allChapters` in onMount. settleSession() looks
		// the start node up in `tracks` FIRST, and a chapter-started session has
		// no matching track, so without the `chapters` array nodeName resolves
		// to '' and the log renders `(削除済み)` for a chapter that still exists.
		await practiseWholeChapter(page, [{ text: 'あああ' }, { text: 'いいい' }]);

		const [record] = await waitForSessions(page, 1);
		expect(record.nodeId).toBe('ch-1');
		expect(record.nodeName).toBe('1章');

		// Same thing as the user sees it: the row must NOT claim to be deleted.
		await page.goto('/');
		await page.getByTestId('history-toggle').click();
		const item = page.getByTestId('history-item').first();
		await expect(item.getByTestId('history-item-name')).toHaveText('1章');
		await expect(item).not.toContainText('(削除済み)');
	});

	test('a session survives a reload after reaching summary', async ({ page }) => {
		// regression: `settleSession()` inside the summary branch of the
		// session-tracking $effect. onDestroy does NOT fire on a browser
		// reload — the realm is torn down without running Svelte's destroy hook
		// — so that one line is the only thing that persists the session on
		// this path. Remove it and the row is simply never written.
		await practiseWholeChapter(page, [{ text: 'あああ' }, { text: 'いいい' }]);

		// Nothing is held: holdAndRelease released Space and the last action was
		// a press(), so the reload cannot inherit `event.repeat`.
		await page.reload();

		const [record] = await waitForSessions(page, 1);
		expect(record.attempted).toBe(2);
		expect(record.passedSentences).toBe(2);
		expect(record.nodeId).toBe('ch-1');
	});

	test('the retry-failed session re-stamps startedAt instead of inheriting the old clock', async ({
		page
	}) => {
		// regression: `beginSession()` in retryFailedOnly(). The retry starts a
		// second session inside the same mount without going through
		// startSession(), so it must re-stamp the clock itself.
		//
		// Attempt 1 → s-1 passes; attempt 2 → s-2 fails; attempt 3 (the retry)
		// passes. The array mock replays the last entry, so the third entry is
		// what the retry's single sentence gets.
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, [{ text: 'あああ' }, { text: 'alas' }, { text: 'いいい' }]);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		// Sentence 1 → pass → 次へ.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		await page.keyboard.press('Space');

		// Sentence 2 → fail. A Space tap here would be もう一度試す (a retry of
		// the same sentence), so the session is ended explicitly instead.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		await page.getByTestId('stop-btn').click();
		await page.getByTestId('confirm-end-btn').click();

		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId('summary-failed-item')).toHaveCount(1);
		await expect(page.getByTestId('retry-failed-btn')).toBeVisible();

		// A real gap, so "the retry re-stamped" and "the retry inherited the
		// old clock" are distinguishable by more than a few ms.
		await page.waitForTimeout(1500);

		await page.getByTestId('retry-failed-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		await page.keyboard.press('Space');
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10_000 });

		// finalizeSession unshifts, so row 0 is the RETRY and row 1 the first
		// session. Two rows is itself the first half of the assertion: without
		// the re-stamp the retry has no sessionStartedAt to settle, so only one
		// row is ever written.
		const records = await waitForSessions(page, 2);
		expect(records[0].startedAt).toBeGreaterThan(records[1].startedAt);
		expect(records[0].startedAt - records[1].startedAt).toBeGreaterThan(1000);
		// And the retry's own duration must not be the whole elapsed span.
		// 8000 rather than 5000: this is the file's only wall-clock-derived
		// bound, and the segment measures ~1-2s locally, so headroom on a
		// throttled worker is worth more than the extra tightness.
		expect(records[0].durationMs).toBeLessThan(8000);
		// The user COMPLETED the retry, so its row must not claim an early stop.
		// `endedEarly = false` in retryFailedOnly() is the only thing clearing the
		// flag the first session set via 終了 — without it this row renders
		// "・ 途中で終了" for a run that finished, and every other assertion here
		// still passes.
		expect(records[0].endedEarly).toBe(false);
		// ...and the first session genuinely WAS ended with 終了, so it must keep
		// saying so. This stops the fix from over-clearing.
		expect(records[1].endedEarly).toBe(true);
	});

	// The label is the AVERAGE (avgScore), the bar is the PASS RATIO, and this
	// row is the one place the two disagree: (95 + 45) / 2 = 70 for the average,
	// 1 of 2 = 50 for the bar. Reading the label off the pass ratio — the bug
	// this row was written against — would print 50% here and every other
	// history test would still pass, because they either have no history at all
	// (no percentage now) or 100% (both numbers agree).
	test('a partially practised row shows the average score, and the bar the pass ratio', async ({
		page
	}) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 1, scores: [95], lastPracticedAt: Date.now() },
				's-2': { attempts: 1, scores: [45], lastPracticedAt: Date.now() }
			}
		});

		// 1 of 2 at or above the default threshold 80 → the BAR is 50%.
		await expect(
			page.getByTestId('chapter-progress').first().locator('div')
		).toHaveAttribute('style', /width:\s*50%/);
		// The TEXT is the average of the two window means: 70.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('1/2 合格 · 70%');
		// The track row reads the same aggregation — one broken label would have
		// to be fixed in two places to pass both.
		await expect(trackCard(page, 'トラック1').getByTestId('track-card-count')).toHaveText(
			'1/2 合格 · 70%'
		);
		// 70 is reachable from neither 0 nor 100 nor 50, and it is not the
		// "empty" label.
		await expect(page.getByTestId('chapter-card-count').first()).not.toHaveText('0文');
		await expect(page.getByTestId('chapter-card-count').first()).not.toHaveText('1/2 合格 · 50%');
	});

	test('track rows render one dot per subtree sentence in practice order', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		// Seeded in REVERSE practice order (s-2 before s-1): the dots must come
		// from the caller's display order (getNodeSentences), never from the
		// seed's key order — a stats map or an aggregation walked in insertion
		// order would render [hard, passed] here.
		//
		// Scope, stated precisely: this seed puts both sentences in ONE track,
		// where `sentence.order` and practice order coincide, so this test pins
		// the seed-order dimension only. The cross-track interleaving that a
		// `sentence.order` re-sort would break is unit-pinned in
		// src/lib/history.test.ts (computeNodeStats uses the array as given).
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-2': { attempts: 1, scores: [40], lastPracticedAt: Date.now() },
				's-1': { attempts: 2, scores: [95], lastPracticedAt: Date.now() }
			}
		});

		const dots = trackCard(page, 'トラック1').getByTestId('track-dots').locator('span');
		await expect(dots).toHaveCount(2);
		await expect(dots.nth(0)).toHaveAttribute('data-dot', 'passed');
		await expect(dots.nth(1)).toHaveAttribute('data-dot', 'hard');
	});

	// Measured, not asserted by attribute. A static `bg-border` next to a
	// conditional `class:bg-amber-500` used to render 苦手 in the untouched grey:
	// both utilities sit in Tailwind's single `utilities` layer at equal
	// specificity, so the generated stylesheet's source order decides the winner
	// (measured: `.bg-border` at offset 15223 beat `.bg-amber-500` at 14881) and
	// the attribute order in the template decides nothing. Every other dot test
	// in this file reads `data-dot`, which is computed from the window mean —
	// the state was always right and only the paint was wrong, so all of them
	// stayed green.
	test('each dot state paints its own colour, so 苦手 is not the 未着手 grey', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [{ id: 'tr-1', chapterId: 'ch-1', name: 'トラック1', parentId: null, order: 1 }],
			sentences: [
				{ id: 's-1', chapterId: 'ch-1', trackId: 'tr-1', text: 'あ', language: 'ja', order: 1 },
				{ id: 's-2', chapterId: 'ch-1', trackId: 'tr-1', text: 'い', language: 'ja', order: 2 },
				{ id: 's-3', chapterId: 'ch-1', trackId: 'tr-1', text: 'う', language: 'ja', order: 3 }
			]
		});
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				// s-1 over the default threshold 80, s-2 under it, s-3 never scored.
				's-1': { attempts: 1, scores: [95], lastPracticedAt: Date.now() },
				's-2': { attempts: 1, scores: [40], lastPracticedAt: Date.now() }
			}
		});

		// Hydration gate: without it evaluateAll() can sample the pre-hydration
		// DOM, which has no dots at all, and an empty sample reads as "one
		// colour" rather than as a failure.
		await expect(page.getByTestId('track-dots').locator('span')).toHaveCount(3);
		const dots = await page
			.getByTestId('track-dots')
			.locator('span')
			.evaluateAll((els) =>
				els.map((el) => ({
					dot: el.getAttribute('data-dot'),
					bg: getComputedStyle(el).backgroundColor
				}))
			);

		// The states themselves, so a failure below cannot be an empty or
		// mis-seeded fixture reading as "three different colours".
		expect(dots.map((d) => d.dot)).toEqual(['passed', 'hard', 'untouched']);
		// Three states, three colours. Anything that collapses 苦手 onto 未着手
		// — or paints a dot with no background at all — makes this 2 or 1.
		expect(new Set(dots.map((d) => d.bg)).size).toBe(3);
		const byState = Object.fromEntries(dots.map((d) => [d.dot, d.bg]));
		expect(byState.hard).not.toBe(byState.untouched);
		expect(byState.hard).not.toBe('');
	});

	// The dot row is the ONLY place the three counts reach a screen reader: the
	// spans are 7px squares with no text, so `role="img"` + its `aria-label`
	// are the accessible name for "1 passed, 1 hard, 1 untouched". Replacing the
	// label with a constant ("TODO") left all 189 tests green — every other dot
	// test reads `data-dot` or a colour, neither of which the label feeds.
	test('the dot row announces all three counts to a screen reader', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [{ id: 'tr-1', chapterId: 'ch-1', name: 'トラック1', parentId: null, order: 1 }],
			sentences: [
				{ id: 's-1', chapterId: 'ch-1', trackId: 'tr-1', text: 'あ', language: 'ja', order: 1 },
				{ id: 's-2', chapterId: 'ch-1', trackId: 'tr-1', text: 'い', language: 'ja', order: 2 },
				{ id: 's-3', chapterId: 'ch-1', trackId: 'tr-1', text: 'う', language: 'ja', order: 3 }
			]
		});
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 1, scores: [95], lastPracticedAt: Date.now() },
				's-2': { attempts: 1, scores: [40], lastPracticedAt: Date.now() }
			}
		});

		const dots = trackCard(page, 'トラック1').getByTestId('track-dots');
		await expect(dots).toHaveAttribute('role', 'img');
		// All three counts, with numbers that cannot be reached by accident: one
		// pass over the default threshold 80, one under it, one never scored.
		await expect(dots).toHaveAttribute(
			'aria-label',
			'合格 1 文 / 苦手 1 文 / 未着手 1 文'
		);
	});

	// Value-level, through the real component: the seed below is the shape the
	// dominant usage produces. Three sessions on three consecutive days, and one
	// sentence whose stat is stamped today (a re-practice overwrites the earlier
	// days' stamps, which is exactly why the sentence side alone cannot see the
	// run). Pre-fix the pill read 連続 1 日 here.
	test('the streak counts session days, not just the last practice of each sentence', async ({
		page
	}) => {
		const now = Date.now();
		const dayAgo = (n: number) => now - n * 24 * 60 * 60 * 1000;
		const row = (id: string, startedAt: number): SessionRecord => ({
			id,
			nodeId: 'ch-1',
			nodeName: '1章',
			startedAt,
			endedAt: startedAt + 60_000,
			durationMs: 60_000,
			attempted: 1,
			passedSentences: 1,
			totalScore: 90,
			skipped: 0,
			endedEarly: false
		});

		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [row('d0', dayAgo(0)), row('d1', dayAgo(1)), row('d2', dayAgo(2))],
			sentences: {
				// Same sentence each day: only its most recent stamp survives.
				's-1': { attempts: 3, scores: [95, 95, 95], lastPracticedAt: now },
				's-2': { attempts: 3, scores: [95, 95, 95], lastPracticedAt: now }
			}
		});

		// のべ is the sentence-stat attempt sum, not the log's — 3 + 3, not 3.
		await expect(page.getByTestId('streak-pill')).toContainText('連続 3 日 · のべ 6 文');
	});

	// The whole second line, exactly. Four single-line mutations of this row
	// (totalScore → 0, skipped → 0, formatStamp → a constant, the 平均 divisor)
	// left the suite at 180 passed because every other assertion in the branch
	// reads the section title, the row count or the node NAME — never these four
	// numbers. `expected` is built from the literal calendar time below rather
	// than from a reimplementation of formatStamp, so a formatter that returns a
	// constant cannot pass by agreeing with itself.
	test('a log row prints its stamp, pass count, average and skip count', async ({ page }) => {
		// Local 2026-01-02 03:04 — far enough from the epoch that a formatter
		// reading the wrong field (or a constant) cannot produce it by accident.
		const startedAt = new Date(2026, 0, 2, 3, 4).getTime();
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{
				version: 1,
				sessions: [
					{
						id: 'a',
						nodeId: 'ch-1',
						nodeName: '1章',
						startedAt,
						endedAt: startedAt + 90_000,
						durationMs: 90_000,
						attempted: 2,
						passedSentences: 1,
						// 174 / 2 = 87, so an off-by-one divisor reads 58 or 174.
						totalScore: 174,
						skipped: 1,
						endedEarly: false
					}
				],
				sentences: {}
			},
			{ open: true }
		);

		await expect(page.getByTestId('history-item').first()).toContainText(
			'01/02 03:04 · 1 文 合格 · 平均 87% · スキップ 1'
		);
		// And no early-stop marker on a completed row.
		await expect(page.getByTestId('history-item').first()).not.toContainText('途中で終了');
	});

	// spec success condition 1 (最終練習日 … が反映される) had NO assertion
	// anywhere in tests/ — grepping 最終 returned only the word inside a comment.
	// Deleting the line from both the chapter and the track row left all 180
	// tests green, because no other row field carries the date.
	test('practised rows show 最終 and the chapter row its 苦手 count', async ({ page }) => {
		const DAY = 24 * 60 * 60 * 1000;
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				// s-1 today and passing; s-2 yesterday and failing → 苦手 1.
				's-1': { attempts: 1, scores: [95], lastPracticedAt: Date.now() },
				's-2': { attempts: 1, scores: [45], lastPracticedAt: Date.now() - DAY }
			}
		});

		// No sample-size label: the row says the date and the 苦手 count, nothing
		// about how deep the evidence is (the 直近 N 回 label was removed as
		// misleading — see the spec's 決定事項).
		await expect(page.getByTestId('chapter-last').first()).toHaveText('最終 今日 · 苦手 1 文');
		// The track row carries the date but not the 苦手 count (the dots do that).
		await expect(trackCard(page, 'トラック1').getByTestId('track-last')).toHaveText('最終 今日');

		// A never-practised node has nothing to date, so the line is gated on
		// practiced > 0 — トラック2 holds no sentences at all here.
		await expect(trackCard(page, 'トラック2').getByTestId('track-last')).toHaveCount(0);
	});

	// The user-reported defect, end to end through the real row:
	// 「一回正解しただけで合格判定される！！直近10回の類似度の平均で出すべき！！」
	// Before the window, the newest score decided everything, so this row read
	// 2/2 合格 · 100% while one sentence's evidence was nine failures. Every
	// pre-existing seed in this file carried a SINGLE score, where mean([x])
	// and lastScore are indistinguishable — which is why 190 E2E tests stayed
	// green through the defect.
	test('a sentence is judged on the mean of its last 10 attempts, not the newest', async ({
		page
	}) => {
		const NINE_FAILURES_ONE_PASS = [40, 40, 40, 40, 40, 40, 40, 40, 40, 95];
		const NINE_PASSES_ONE_SLIP = [95, 95, 95, 95, 95, 95, 95, 95, 95, 40];
		const now = Date.now();

		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				// s-1: nine misses then one perfect pass → mean 46 → 苦手.
				's-1': { attempts: 10, scores: NINE_FAILURES_ONE_PASS, lastPracticedAt: now },
				// s-2: nine passes then one slip → mean 90 → 合格.
				's-2': { attempts: 10, scores: NINE_PASSES_ONE_SLIP, lastPracticedAt: now }
			}
		});

		// Newest-score scoring would read s-1 合格 (95) and s-2 苦手 (40) — the
		// exact inversion the user reported. The mean reads them the other way.
		// 1 of 2 passed → the bar says 50%; the LABEL is the average of the two
		// means: (45.5 + 89.5) / 2 = 67.5 → 68. Reverting the label to the pass
		// ratio (the pre-fix behaviour) prints 50% here.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('1/2 合格 · 68%');
		await expect(
			page.getByTestId('chapter-progress').first().locator('div')
		).toHaveAttribute('style', /width:\s*50%/);
		const dots = trackCard(page, 'トラック1').getByTestId('track-dots').locator('span');
		await expect(dots.nth(0)).toHaveAttribute('data-dot', 'hard');
		await expect(dots.nth(1)).toHaveAttribute('data-dot', 'passed');
		// The verdict came from a 10-deep mean, but the row does not claim a
		// sample size — the label was removed for claiming one wrongly.
		await expect(page.getByTestId('chapter-last').first()).toHaveText('最終 今日 · 苦手 1 文');
	});

	// A lopsided window must change nothing about what the row reports. This is
	// the seed that got 直近 N 回 deleted: 19 deep + 1 shallow printed the shallow
	// one's depth under a 95% that rested on all twenty, i.e. false for 19 of 20.
	test('the row states no sample size, so a lopsided window is not mislabelled', async ({
		page
	}) => {
		const now = Date.now();
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 10, scores: Array.from({ length: 10 }, () => 95), lastPracticedAt: now },
				's-2': { attempts: 1, scores: [95], lastPracticedAt: now }
			}
		});

		// Both sentences pass and the row says 2/2 — the only numbers on it are
		// about the SENTENCES. No 直近 / 回 anywhere on either row kind.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('2/2 合格 · 95%');
		await expect(page.getByTestId('chapter-last').first()).toHaveText('最終 今日 · 苦手 0 文');
		await expect(trackCard(page, 'トラック1').getByTestId('track-last')).toHaveText('最終 今日');
		for (const id of ['chapter-last', 'track-last']) {
			await expect(page.getByTestId(id).first()).not.toContainText('直近');
			await expect(page.getByTestId(id).first()).not.toContainText('回');
		}
	});

	// The migration, at the boundary it actually lives: storage written by the
	// previous release, carrying `lastScore` and no window. Nothing on screen may
	// move across the deploy, so this seed must read exactly as it always did.
	// `readScores()` in src/lib/history.ts turns it into `scores: [lastScore]`,
	// and mean([x]) === x.
	test('a history written before the window still reads as it did', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 1, lastScore: 87, lastPracticedAt: Date.now() },
				's-2': { attempts: 1, lastScore: 45, lastPracticedAt: Date.now() }
			}
		});

		// Unchanged verdicts: 87 passes, 45 does not. The average is (87 + 45) / 2
		// = 66 — identical to what the previous release's own numbers produced,
		// because the pre-window label was never a score at all (it was 1/2).
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('1/2 合格 · 66%');
		await expect(page.getByTestId('chapter-last').first()).toHaveText('最終 今日 · 苦手 1 文');
		const dots = trackCard(page, 'トラック1').getByTestId('track-dots').locator('span');
		await expect(dots.nth(0)).toHaveAttribute('data-dot', 'passed');
		await expect(dots.nth(1)).toHaveAttribute('data-dot', 'hard');
	});

	// `historyLimit += 0` left the suite green: no other test ever had 20+ rows
	// to page through. spec: 「初期表示は最新 20 件。`さらに表示` で全件表示する」.
	test('さらに表示 pages the log past its first 20 rows', async ({ page }) => {
		const now = Date.now();
		const row = (i: number) => ({
			id: `s${i}`,
			nodeId: 'ch-1',
			nodeName: '1章',
			startedAt: now - i * 60_000,
			endedAt: now - i * 60_000 + 30_000,
			durationMs: 30_000,
			attempted: 1,
			passedSentences: 1,
			totalScore: 90,
			skipped: 0,
			endedEarly: false
		});
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{ version: 1, sessions: Array.from({ length: 25 }, (_, i) => row(i)), sentences: {} },
			{ open: true }
		);

		await expect(page.getByTestId('history-item')).toHaveCount(20);
		const more = page.getByTestId('history-more');
		await expect(more).toHaveText('さらに表示 (残り 5 件)');
		await more.click();
		await expect(page.getByTestId('history-item')).toHaveCount(25);
		// Nothing left to page through, so the button goes away.
		await expect(page.getByTestId('history-more')).toHaveCount(0);
	});

	// The pill is gated on `streak.totalAttempts > 0`, which is the sentence-stat
	// attempt sum. Seeded log rows with no sentence stats prove the gate is the
	// attempt sum and not "any history at all": `{#if true}` rendered the pill
	// here as 連続 3 日 · のべ 0 文 and nothing caught it.
	test('the streak pill stays hidden when nothing has been scored', async ({ page }) => {
		const now = Date.now();
		const row = (id: string, startedAt: number) => ({
			id,
			nodeId: 'ch-1',
			nodeName: '1章',
			startedAt,
			endedAt: startedAt + 1000,
			durationMs: 1000,
			attempted: 1,
			passedSentences: 1,
			totalScore: 90,
			skipped: 0,
			endedEarly: false
		});
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [row('d0', now), row('d1', now - 86_400_000), row('d2', now - 172_800_000)],
			sentences: {}
		});

		// A three-day streak exists — the log rows say so — but のべ is 0, and a
		// pill reading のべ 0 文 is worse than no pill.
		await expect(page.getByTestId('streak-pill')).toHaveCount(0);
		// The log itself still renders: the gate is the pill, not the section.
		await expect(page.getByTestId('history-toggle')).toContainText('練習履歴 (3)');
	});

	test('an empty intermediate track reads like the session it starts', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: '空のトラック', order: 1, parentId: null },
				{ id: 't1-1', chapterId: 'ch-1', name: '孫のトラック', order: 1, parentId: 't1' }
			],
			sentences: [
				{ id: 's2', chapterId: 'ch-1', trackId: 't1-1', text: 'い', language: 'ja', order: 1 }
			]
		});
		// Not "0文" next to a live button — its subtree holds s2, so starting
		// from it really does run one sentence, and the dot row must be sized to
		// that same set.
		const row = trackCard(page, '空のトラック');
		await expect(row.getByTestId('card-start')).toHaveCount(1);
		// No percentage either: s2 has never been scored, so the row has a pass
		// count and no average to show.
		await expect(row.getByTestId('track-card-count')).toHaveText('0/1 合格');
		await expect(row.getByTestId('track-dots').locator('span')).toHaveCount(1);
	});

	test('lowering the threshold raises the pass count without practising', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 1, scores: [70], lastPracticedAt: Date.now() },
				's-2': { attempts: 1, scores: [70], lastPracticedAt: Date.now() }
			}
		});
		// Pass / hard are derived from the score window's MEAN against the LIVE
		// threshold, not stored — so nothing but the setting moves.
		// The average is 70 either way — the threshold moves the VERDICT, not the
		// score, which is the point: 0/2 合格 · 70% says 「70% だが閾値 80% に届かない」.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('0/2 合格 · 70%');
		await expect(trackCard(page, 'トラック1').getByTestId('track-dots').locator('span').first())
			.toHaveAttribute('data-dot', 'hard');

		await page.evaluate(() => {
			localStorage.setItem(
				'oboeru:settings:v1',
				JSON.stringify({ threshold: 60, ttsRate: 1, voiceURI: null, retryFrom: 'tts' })
			);
		});
		await page.reload();

		// 2/2 now — and the average is STILL 70%, unchanged by the setting. Before
		// this was "2/2 合格 · 100%", a pass ratio that made the row look better
		// than it is; the number that did not move is the one worth reading.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('2/2 合格 · 70%');
		await expect(trackCard(page, 'トラック1').getByTestId('track-dots').locator('span').first())
			.toHaveAttribute('data-dot', 'passed');
	});

	test('the history section stays open across a reload', async ({ page }) => {
		// Both directions of the same contract, because the seeded half alone
		// only reaches loadHistoryUiState(): with `open: true` written straight
		// into storage, deleting `saveHistoryUiState({ open: historyOpen })`
		// from toggleHistory() (src/routes/+page.svelte:143) leaves every
		// assertion below green — including a real user who expands the log,
		// reloads and finds it collapsed. src/lib/history.test.ts unit-tests the
		// function in isolation, so the call site had no coverage at all; the
		// click at the bottom is the only way a test can reach the write.
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{
				version: 1,
				sessions: [
					{
						id: 'a',
						nodeId: 'ch-1',
						nodeName: '1章',
						startedAt: Date.now(),
						endedAt: Date.now(),
						durationMs: 1000,
						attempted: 1,
						passedSentences: 1,
						totalScore: 90,
						skipped: 0,
						endedEarly: false
					}
				],
				sentences: {}
			},
			{ open: true }
		);
		await expect(page.getByTestId('history-log')).toBeVisible();
		await page.reload();
		await expect(page.getByTestId('history-log')).toBeVisible();
		// The open state is persisted, not remembered per page view only.
		await expect(page.getByTestId('history-toggle')).toHaveAttribute('aria-expanded', 'true');

		// The write half. Collapsed, the log is not in the DOM at all (it lives
		// inside `{#if historyOpen}`), so this asserts absence rather than
		// visibility.
		await page.getByTestId('history-toggle').click();
		await expect(page.getByTestId('history-log')).toHaveCount(0);
		await expect(page.getByTestId('history-toggle')).toHaveAttribute('aria-expanded', 'false');
		await page.reload();
		// Hydration gate before the negative assertions. `historyOpen` is
		// initialised to `false` in the component and only then overwritten from
		// storage, so a correctly-collapsed reload and a page that has not
		// applied the stored state yet are indistinguishable — and
		// `toHaveCount(0)` would happily pass on the un-hydrated DOM, which is
		// exactly how a broken save slips through. The history section renders
		// out of that same load effect, so waiting for it means the state has
		// been applied.
		await expect(page.getByTestId('history-section')).toBeVisible();
		await expect(page.getByTestId('history-log')).toHaveCount(0);
		await expect(page.getByTestId('history-toggle')).toHaveAttribute('aria-expanded', 'false');
	});

	test('a deleted node keeps its captured name in the log', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{
				version: 1,
				sessions: [
					{
						id: 'a',
						nodeId: 'gone',
						nodeName: '消した章',
						startedAt: Date.now(),
						endedAt: Date.now(),
						durationMs: 1000,
						attempted: 1,
						passedSentences: 0,
						totalScore: 30,
						skipped: 0,
						endedEarly: true
					}
				],
				sentences: {}
			},
			{ open: true }
		);
		// The name and the marker are sibling spans with no whitespace between
		// them, so they are asserted as two separate facts.
		const item = page.getByTestId('history-item').first();
		await expect(item.getByTestId('history-item-name')).toHaveText('消した章');
		await expect(item).toContainText('(削除済み)');
		await expect(item).toContainText('途中で終了');
	});

	test('a live name wins over the captured one after a rename', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{
				version: 1,
				sessions: [
					{
						id: 'a',
						nodeId: 'ch-1',
						// Stale: the chapter is now called 1章.
						nodeName: '古い名前',
						startedAt: Date.now(),
						endedAt: Date.now(),
						durationMs: 1000,
						attempted: 1,
						passedSentences: 1,
						totalScore: 90,
						skipped: 0,
						endedEarly: false
					}
				],
				sentences: {}
			},
			{ open: true }
		);
		const item = page.getByTestId('history-item').first();
		await expect(item.getByTestId('history-item-name')).toHaveText('1章');
		await expect(item).not.toContainText('(削除済み)');
	});

	test('no sessions means the history section is absent', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await expect(page.getByTestId('history-section')).toHaveCount(0);
	});

	test('a node with no sentences keeps the plain N文 label', async ({ page }) => {
		await gotoWithSeed(page, {
			chapters: [{ id: 'ch-1', name: '空の章', parentId: null, order: 1 }],
			tracks: [],
			sentences: []
		});
		// No `0/0 合格` — a count over an empty denominator is noise.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('0文');
	});

	// `settleSession()`'s `completedCount === 0` early return. AGENTS.md states it
	// as binding ("1 文も採点しなかったセッションは記録されない"), and deleting those
	// three lines left all 180 tests green: no other test opens a session and
	// leaves without scoring, so nothing ever produced a 0-attempt row to catch.
	test('a session that scored nothing writes no log row', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, [{ text: 'あああ' }]);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		// Open, look, leave — never a single scoring.
		await page.getByTestId('stop-btn').click();
		await page.getByTestId('confirm-end-btn').click();
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10_000 });

		expect(await readSessions(page)).toHaveLength(0);
		await page.goto('/');
		await expect(page.getByTestId('history-section')).toHaveCount(0);
		// Nothing was scored, so there is no sentence stat either — the pill is
		// gated on the same zero.
		await expect(page.getByTestId('streak-pill')).toHaveCount(0);
	});

	// A resumed session's `startedAt`. `applyRestore()` restores the counters but
	// re-stamped the clock at resume time, so a row could claim a 20-minute-old
	// session had lasted four seconds — the duration field is derived from this
	// stamp. The seed moves `savedAt` a minute into the past (still inside the
	// 30-minute TTL), so "stamped from savedAt" and "stamped at resume" differ by
	// a minute, far outside any timing tolerance.
	test('a resumed session keeps the original start time', async ({ page }) => {
		const GAP_MS = 60_000;
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, [{ text: 'あああ' }, { text: 'いいい' }]);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		// Score the first sentence so the snapshot the app writes has something
		// in it, then age that snapshot instead of using the app's own stamp.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		await page.keyboard.press('Space');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		const resumedAt = await page.evaluate(() => {
			const key = 'oboeru:progress:v1';
			const saved = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string, number>;
			saved.savedAt = Date.now() - 60_000;
			sessionStorage.setItem(key, JSON.stringify(saved));
			return saved.savedAt;
		});

		await page.reload();
		await expect(page.getByTestId('restore-dialog')).toBeVisible({ timeout: 10_000 });
		await page.getByTestId('resume-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		// Finish the resumed session.
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		await page.keyboard.press('Space');
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10_000 });

		const [record] = await waitForSessions(page, 1);
		// The pre-reload stamp, not the moment 続ける was pressed.
		expect(Math.abs(record.startedAt - resumedAt)).toBeLessThan(2000);
		// And the duration therefore spans the gap instead of the resume.
		expect(record.durationMs).toBeGreaterThan(GAP_MS - 2000);
		// Both attempts are counted, so the row is not silently half-empty.
		expect(record.attempted).toBe(2);
		// DOCUMENTED LIMITATION, pinned on purpose: `passedIds` is per-mount and
		// `practice-progress.ts` does not persist it, so the pre-reload pass is
		// missing here even though `attempted` counts it. Persisting `passedIds`
		// was ruled out of scope (spec §既知の制限); this assertion exists so the
		// day it changes is a deliberate one, not a silent data change.
		expect(record.passedSentences).toBe(1);
	});

	// `onDestroy(() => settleSession())` — the only writer on this path. A
	// client-side navigation away from a session in progress tears the component
	// down (Svelte runs the destroy hook), the summary $effect never runs
	// because `phase` is never 'summary', and `clearPracticeProgress()` is not
	// called either, so removing the block loses the row silently.
	//
	// Entered through the SPA (the top page's 練習 button) on purpose: a direct
	// `page.goto('/practice?…')` leaves no same-document history entry for
	// `page.goBack()` to pop, so it would leave via a full document load — which
	// never runs destroy hooks, and would pass with the block deleted.
	test('abandoning a session with the browser Back button still records it', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await mockTranscribe(page, [{ text: 'あああ' }]);
		await page.goto('/');

		// SPA navigation, so goBack() is a client-side route change.
		await page
			.getByTestId('chapter-card')
			.filter({ hasText: '1章' })
			.getByTestId('card-start')
			.click();
		await page.waitForURL('**/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		// One scored sentence, then leave mid-session (2 remain).
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10_000 });
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 10_000 });

		await page.goBack();
		await page.waitForURL((url) => !url.pathname.startsWith('/practice'));

		const [record] = await waitForSessions(page, 1);
		expect(record.attempted).toBe(1);
		expect(record.passedSentences).toBe(1);
		expect(record.nodeName).toBe('1章');
		// WRITE path for `skipped`, app-driven: this session skipped exactly one
		// sentence (the skip-btn press above), so the row must say so. The only
		// other assertion of a skip count in the suite reads a SEEDED row, which
		// is why `skipped: 0` in settleSession() reached main with every history
		// test green.
		expect(record.skipped).toBe(1);
		// And the score of the one sentence that WAS scored (100 for an exact
		// transcription), so the row is internally consistent: 1 attempted,
		// 100 total, 1 skipped.
		expect(record.totalScore).toBe(100);
		// `endedEarly`: the spec defines the field as "did this session end
		// without reaching summary". This row was written by onDestroy, i.e. the
		// session never reached summary, so it must say so — `settleSession(true)`
		// from the destroy hook is what makes that true. Without the `|| abandoned`
		// the row claimed a finished session.
		expect(record.endedEarly).toBe(true);
	});
});
