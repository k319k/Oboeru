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

		await page.goto('/');

		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('2/2 合格 · 100%');
		// The bar is fed by the same percent() as the label — assert it too, so
		// a percent() that only the label reads cannot pass.
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

	test('a partially practised node shows a non-zero percentage', async ({ page }) => {
		// percent() guard. Every other assertion in the whole suite reads "0%"
		// (or "100%" from a full pass), so a percent() hardcoded to 0 would keep
		// top.spec.ts, responsive.spec.ts and the main test above green. This
		// one row is half-passed, so the only correct answers are 50% and a 50%
		// wide bar.
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 1, lastScore: 95, lastPracticedAt: Date.now() },
				's-2': { attempts: 1, lastScore: 45, lastPracticedAt: Date.now() }
			}
		});

		// 1 of 2 at or above the default threshold 80 → 50%.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('1/2 合格 · 50%');
		await expect(
			page.getByTestId('chapter-progress').first().locator('div')
		).toHaveAttribute('style', /width:\s*50%/);
		// The track row reads the same aggregation — one broken percent() would
		// have to be fixed in two places to pass both.
		await expect(trackCard(page, 'トラック1').getByTestId('track-card-count')).toHaveText(
			'1/2 合格 · 50%'
		);
		// 50% is not reachable by accident from 0 or 100, and it is not the
		// "empty" label either.
		await expect(page.getByTestId('chapter-card-count').first()).not.toHaveText('0文');
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
				's-2': { attempts: 1, lastScore: 40, lastPracticedAt: Date.now() },
				's-1': { attempts: 2, lastScore: 95, lastPracticedAt: Date.now() }
			}
		});

		const dots = trackCard(page, 'トラック1').getByTestId('track-dots').locator('span');
		await expect(dots).toHaveCount(2);
		await expect(dots.nth(0)).toHaveAttribute('data-dot', 'passed');
		await expect(dots.nth(1)).toHaveAttribute('data-dot', 'hard');
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
		await expect(row.getByTestId('track-card-count')).toHaveText('0/1 合格 · 0%');
		await expect(row.getByTestId('track-dots').locator('span')).toHaveCount(1);
	});

	test('lowering the threshold raises the pass count without practising', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-1': { attempts: 1, lastScore: 70, lastPracticedAt: Date.now() },
				's-2': { attempts: 1, lastScore: 70, lastPracticedAt: Date.now() }
			}
		});
		// Pass / hard are derived from lastScore against the LIVE threshold, not
		// stored — so nothing but the setting moves.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('0/2 合格 · 0%');
		await expect(trackCard(page, 'トラック1').getByTestId('track-dots').locator('span').first())
			.toHaveAttribute('data-dot', 'hard');

		await page.evaluate(() => {
			localStorage.setItem(
				'oboeru:settings:v1',
				JSON.stringify({ threshold: 60, ttsRate: 1, voiceURI: null, retryFrom: 'tts' })
			);
		});
		await page.reload();

		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('2/2 合格 · 100%');
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
		// No `0/0 合格 · 0%` — a percentage over an empty denominator is noise.
		await expect(page.getByTestId('chapter-card-count').first()).toHaveText('0文');
	});
});
