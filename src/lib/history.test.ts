import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Sentence } from './types';
import type { SessionRecord, SentenceStat } from './history';

function createStorageMock(): Storage {
	let store: Record<string, string> = {};
	return {
		get length() {
			return Object.keys(store).length;
		},
		clear() {
			store = {};
		},
		getItem(key: string) {
			return key in store ? store[key] : null;
		},
		setItem(key: string, value: string) {
			store[key] = value;
		},
		removeItem(key: string) {
			delete store[key];
		},
		key(index: number) {
			return Object.keys(store)[index] ?? null;
		}
	};
}

type HistoryModule = typeof import('./history');
let H: HistoryModule;
let ls: ReturnType<typeof createStorageMock>;

const KEY = 'oboeru:history:v1';

function seed(raw: unknown): void {
	ls.setItem(KEY, JSON.stringify(raw));
}

const VALID_SESSION: Omit<SessionRecord, 'id'> = {
	nodeId: 'ch-1',
	nodeName: '日本語基礎',
	startedAt: 1000,
	endedAt: 4000,
	durationMs: 3000,
	attempted: 10,
	passedSentences: 8,
	totalScore: 870,
	skipped: 1,
	endedEarly: false
};

const SENTENCE_FIXTURE: Sentence[] = [
	{ id: 's3', chapterId: 'ch-1', trackId: 'tr-1', text: 'c', language: 'ja', order: 2 },
	{ id: 's1', chapterId: 'ch-1', trackId: 'tr-1', text: 'a', language: 'ja', order: 0 },
	{ id: 's2', chapterId: 'ch-1', trackId: 'tr-1', text: 'b', language: 'ja', order: 1 }
];

function sent(id: string, order: number): Sentence {
	return { id, chapterId: 'ch-1', trackId: 'tr-1', text: id, language: 'ja', order };
}

/** One sentence's stat. `scores` is the window, oldest first. */
function stat(scores: number[], at = 1000, attempts = scores.length): SentenceStat {
	return { attempts, scores, lastPracticedAt: at };
}

/** N copies of one score — the shape a repeated-drill sentence actually has. */
function repeated(scoreValue: number, times: number): number[] {
	return Array.from({ length: times }, () => scoreValue);
}

beforeEach(async () => {
	ls = createStorageMock();
	Object.defineProperty(globalThis, 'localStorage', {
		value: ls,
		writable: true,
		configurable: true
	});
	// history.ts keeps an in-memory cache; a fresh module per test keeps it clean.
	vi.resetModules();
	H = await import('./history');
});

describe('loadHistory — defaults and validation', () => {
	it('returns an empty default when nothing is stored', () => {
		expect(H.loadHistory()).toEqual({ version: 1, sessions: [], sentences: {} });
	});

	it('falls back to the default on corrupt JSON', () => {
		ls.setItem(KEY, '{not json');
		expect(H.loadHistory()).toEqual({ version: 1, sessions: [], sentences: {} });
	});

	it('falls back to the default when the stored value is not an object', () => {
		seed('nope');
		expect(H.loadHistory()).toEqual({ version: 1, sessions: [], sentences: {} });
	});

	it('falls back to the default when version is not 1', () => {
		seed({ version: 2, sessions: [], sentences: {} });
		expect(H.loadHistory()).toEqual({ version: 1, sessions: [], sentences: {} });
	});

	it('clamps NaN / negative / fractional counters to non-negative integers', () => {
		seed({
			version: 1,
			sessions: [
				{
					id: 'a',
					nodeId: 'n',
					nodeName: 'x',
					startedAt: 1,
					endedAt: 2,
					durationMs: Number.NaN,
					attempted: -3,
					passedSentences: 2.7,
					totalScore: 10,
					skipped: -1,
					endedEarly: false
				}
			],
			sentences: { s1: { attempts: -1, scores: [80, 80.9, -5], lastPracticedAt: 5 } }
		});
		const data = H.loadHistory();
		expect(data.sessions[0].durationMs).toBe(0);
		expect(data.sessions[0].attempted).toBe(0);
		expect(data.sessions[0].passedSentences).toBe(2);
		expect(data.sessions[0].skipped).toBe(0);
		expect(data.sentences.s1.attempts).toBe(0);
		// The window goes through the SAME `score()` the writer uses, so a
		// fractional sample rounds rather than floors (80.9 → 81) and a negative
		// one still floors to 0. See the clamp describe block below.
		expect(data.sentences.s1.scores).toEqual([80, 81, 0]);
	});

	it('truncates sessions to the newest 500, keeping newest-first order', () => {
		const sessions = Array.from({ length: 503 }, (_, i) => ({
			id: `s${i}`,
			nodeId: 'n',
			nodeName: 'x',
			startedAt: i,
			endedAt: i,
			durationMs: 0,
			attempted: 1,
			passedSentences: 1,
			totalScore: 100,
			skipped: 0,
			endedEarly: false
		}));
		seed({ version: 1, sessions, sentences: {} });
		const data = H.loadHistory();
		expect(data.sessions).toHaveLength(500);
		expect(data.sessions[0].id).toBe('s0');
	});

	// Regression: the plan's `const EMPTY` literal was shared by every empty
	// return, so a caller mutating one "empty history" poisoned all of them.
	it('returns a fresh object each call, so a caller cannot poison the default', () => {
		expect(H.loadHistory()).not.toBe(H.loadHistory());
		// The shallow-spread wrapper is fresh either way; the array inside it
		// is what a shared literal would hand out to every caller.
		expect(H.loadHistory().sessions).not.toBe(H.loadHistory().sessions);
	});

	it('does not let a mutated result leak into the next read', () => {
		const first = H.loadHistory();
		// Injected by hand, not via finalizeSession — that one persists, so the
		// next read would legitimately see one session.
		first.sessions.push({ id: 'injected', ...VALID_SESSION });
		expect(H.loadHistory().sessions).toHaveLength(0);
	});
});

describe('recordSentenceAttempt', () => {
	it('creates a stat on the first attempt', () => {
		H.recordSentenceAttempt('s1', 87, 1000);
		expect(H.loadHistory().sentences.s1).toEqual({
			attempts: 1,
			scores: [87],
			lastPracticedAt: 1000
		});
	});

	it('appends to the score window on later attempts, oldest first', () => {
		H.recordSentenceAttempt('s1', 50, 1000);
		H.recordSentenceAttempt('s1', 92, 2000);
		expect(H.loadHistory().sentences.s1).toEqual({
			attempts: 2,
			scores: [50, 92],
			lastPracticedAt: 2000
		});
	});

	it('does not drop sibling stats across consecutive calls (cache integrity)', () => {
		H.recordSentenceAttempt('s1', 50, 1000);
		H.recordSentenceAttempt('s2', 60, 1000);
		H.recordSentenceAttempt('s1', 70, 2000);
		const { sentences } = H.loadHistory();
		expect(sentences.s1.scores).toEqual([50, 70]);
		expect(sentences.s2.scores).toEqual([60]);
	});

	// The window has a bound, on BOTH sides. Without the write-side cap the
	// persisted array grows without limit (localStorage quota — the spec's
	// 決定事項 3 measures ~95KB for 1000 fully-drilled sentences in this
	// shape, against a 5MB budget); without the read-side cap a hand-edited
	// or future value decides the verdict. Asserting only the re-read shape
	// would pass with the write cap deleted — loadHistory() re-clips — so the
	// raw payload is pinned here as well.
	it('keeps only the newest SCORE_WINDOW scores and drops the oldest', () => {
		for (let i = 1; i <= 12; i++) H.recordSentenceAttempt('s1', i * 5, i * 1000);
		const { sentences } = H.loadHistory();
		expect(H.SCORE_WINDOW).toBe(10);
		expect(sentences.s1.scores).toEqual([15, 20, 25, 30, 35, 40, 45, 50, 55, 60]);
		expect(sentences.s1.scores).toHaveLength(H.SCORE_WINDOW);
		const written = JSON.parse(ls.getItem(KEY) as string) as {
			sentences: Record<string, { scores: number[] }>;
		};
		expect(written.sentences.s1.scores).toHaveLength(H.SCORE_WINDOW);
		// The two oldest samples are gone from storage too, not just on read.
		expect(written.sentences.s1.scores).not.toContain(5);
		expect(written.sentences.s1.scores).not.toContain(10);
		// attempts is cumulative and keeps counting past the window.
		expect(sentences.s1.attempts).toBe(12);
	});

	it('never throws when localStorage rejects the write', () => {
		ls.setItem = () => {
			throw new Error('QuotaExceededError');
		};
		expect(() => H.recordSentenceAttempt('s1', 80, 1000)).not.toThrow();
	});

	it('stores 0 for a non-finite score instead of letting NaN reach the stats', () => {
		H.recordSentenceAttempt('s1', Number.NaN, 1000);
		const { sentences } = H.loadHistory();
		expect(sentences.s1.scores).toEqual([0]);
		// loadHistory() reads back 0 either way (null coerces to 0), so pin the
		// written payload: an unguarded NaN is serialised as null, which leaves
		// the cache saying NaN while storage says 0.
		expect(ls.getItem(KEY)).toContain('"scores":[0]');
		expect(H.computeNodeStats(SENTENCE_FIXTURE.filter((s) => s.id === 's1'), false, sentences, 80).avgScore).not.toBeNaN();
	});
});

// MIGRATION. `HistoryData.version` stays 1: loadHistory() shrinks to the empty
// default on a mismatch, so bumping it would discard every session row and
// sentence stat the user has accumulated. The old shape is absorbed on read
// instead — see readScores() in src/lib/history.ts.
describe('loadHistory — the pre-window shape is absorbed, not discarded', () => {
	const OLD_ENTRY = { attempts: 1, lastScore: 87, lastPracticedAt: 5000 };

	it('reads a stored lastScore as a one-element window', () => {
		seed({ version: 1, sessions: [], sentences: { s1: OLD_ENTRY } });
		expect(H.loadHistory().sentences.s1).toEqual({
			attempts: 1,
			scores: [87],
			lastPracticedAt: 5000
		});
	});

	// The whole point of the shim: mean([87]) === 87, so the deploy changes
	// nothing on screen. If the migration dropped the entry instead, or scored
	// it 0, this row would read 0/1 合格 · 0% and every past sentence would
	// silently become 苦手.
	it('scores an absorbed entry exactly as it scored before the deploy', () => {
		seed({ version: 1, sessions: [], sentences: { s1: OLD_ENTRY } });
		const stats = H.loadHistory().sentences;
		const node = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(node.passed).toBe(1);
		expect(node.hard).toBe(0);
		expect(node.avgScore).toBe(87);
	});

	it('prefers a real window over a stale lastScore on the same entry', () => {
		seed({
			version: 1,
			sessions: [],
			sentences: { s1: { attempts: 2, scores: [95, 40], lastScore: 40, lastPracticedAt: 1 } }
		});
		expect(H.loadHistory().sentences.s1.scores).toEqual([95, 40]);
	});

	it('keeps the attempts count, so のべ文数 does not move either', () => {
		seed({
			version: 1,
			sessions: [],
			sentences: { s1: { attempts: 12, lastScore: 91, lastPracticedAt: 1 } }
		});
		const stats = H.loadHistory().sentences;
		expect(stats.s1.attempts).toBe(12);
		expect(H.computeStreak(stats, [], Date.now()).totalAttempts).toBe(12);
	});

	// A stat with neither field is not a score of 95 to be recovered — there is
	// nothing to recover. An empty window means 0 → 苦手, the direction that
	// cannot invent a pass.
	it('reads a stat carrying neither field as 苦手, not as a pass', () => {
		seed({ version: 1, sessions: [], sentences: { s1: { attempts: 3 } } });
		const stats = H.loadHistory().sentences;
		expect(stats.s1.scores).toEqual([]);
		expect(H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80).hard).toBe(1);
	});

	// A window longer than SCORE_WINDOW can only arrive from a hand-edited or
	// future value; the read side must not hand back more than the verdict uses.
	// The tail is ALSO clamped, so the newest four samples all read 100 rather
	// than 110/120/130 — see the clamp test below for why the read path clamps.
	it('caps an over-long stored window to the newest SCORE_WINDOW, clamped', () => {
		seed({
			version: 1,
			sessions: [],
			sentences: {
				s1: {
					attempts: 14,
					scores: Array.from({ length: 14 }, (_, i) => i * 10),
					lastPracticedAt: 1
				}
			}
		});
		expect(H.loadHistory().sentences.s1.scores).toEqual([40, 50, 60, 70, 80, 90, 100, 100, 100, 100]);
	});
});

// A score is a percentage, but localStorage is a bag of numbers a hand-edited
// payload, a future writer or a devtools poke can put anything into. Before the
// row label started printing the average, an out-of-range value was merely
// compared to the threshold, so `500` was invisible; it now renders as text.
describe('loadHistory — a stored score is clamped to 0-100 on the READ path', () => {
	it('clamps a hand-edited over-100 lastScore instead of rendering 500%', () => {
		seed({ version: 1, sessions: [], sentences: { s1: { attempts: 1, lastScore: 500, lastPracticedAt: 1 } } });
		const stats = H.loadHistory().sentences;
		expect(stats.s1.scores).toEqual([100]);
		// The rendered label is the mean, so this is where 500 would have shown.
		expect(H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80).avgScore).toBe(100);
	});

	it('clamps every element of a stored window, on both edges', () => {
		seed({
			version: 1,
			sessions: [],
			sentences: { s1: { attempts: 3, scores: [-40, 87, 140], lastPracticedAt: 1 } }
		});
		expect(H.loadHistory().sentences.s1.scores).toEqual([0, 87, 100]);
		expect(H.computeNodeStats(SENTENCE_FIXTURE, false, H.loadHistory().sentences, 80).avgScore).toBe(62);
	});

	// A negative score was already floored at 0 by the old `nonNegInt`, so that
	// half is not the regression; the ceiling is. Assert both so the direction
	// cannot quietly flip back to floor-only.
	it('floors a negative stored score at 0', () => {
		seed({ version: 1, sessions: [], sentences: { s1: { attempts: 1, scores: [-1], lastPracticedAt: 1 } } });
		expect(H.loadHistory().sentences.s1.scores).toEqual([0]);
	});
});

// `readScores()` branches on `scores` first, so a payload carrying BOTH an empty
// `scores` and a live legacy `lastScore` used to take the empty array, read as
// mean 0, and silently turn a pass into 苦手. Unreachable from the current
// writer (it never writes both), but the read path must not be the weaker one.
describe('loadHistory — an EMPTY scores array does not shadow a live lastScore', () => {
	it('falls through to lastScore when scores is present but empty', () => {
		seed({
			version: 1,
			sessions: [],
			sentences: { s1: { attempts: 1, scores: [], lastScore: 87, lastPracticedAt: 1 } }
		});
		const stats = H.loadHistory().sentences;
		expect(stats.s1.scores).toEqual([87]);
		// The verdict the legacy entry would have had: 87 >= 80 → 合格. Reading
		// the empty array instead gives mean 0 → 苦手, a silent lost pass.
		const node = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(node.passed).toBe(1);
		expect(node.hard).toBe(0);
		expect(node.avgScore).toBe(87);
	});

	// The counterpart must not change: a NON-EMPTY window still wins over a
	// stale `lastScore` left on the same entry.
	it('still prefers a non-empty window over a stale lastScore', () => {
		seed({
			version: 1,
			sessions: [],
			sentences: { s1: { attempts: 2, scores: [95, 40], lastScore: 95, lastPracticedAt: 1 } }
		});
		expect(H.loadHistory().sentences.s1.scores).toEqual([95, 40]);
	});

	// And an entry with an empty `scores` and NO `lastScore` is still 苦手:
	// the fall-through must not invent evidence.
	it('reads a genuinely empty entry as 苦手', () => {
		seed({ version: 1, sessions: [], sentences: { s1: { attempts: 2, scores: [], lastPracticedAt: 1 } } });
		expect(H.loadHistory().sentences.s1.scores).toEqual([]);
		expect(H.computeNodeStats(SENTENCE_FIXTURE, false, H.loadHistory().sentences, 80).hard).toBe(1);
	});
});

describe('finalizeSession', () => {
	const base = VALID_SESSION;

	it('unshifts the record and assigns an id', () => {
		const stored = H.finalizeSession(base);
		expect(stored.id).toBeTruthy();
		const { sessions } = H.loadHistory();
		expect(sessions).toHaveLength(1);
		expect(sessions[0].id).toBe(stored.id);
	});

	it('keeps newest-first across multiple sessions', () => {
		H.finalizeSession({ ...base, nodeName: 'first' });
		const second = H.finalizeSession({ ...base, nodeName: 'second' });
		const { sessions } = H.loadHistory();
		expect(sessions.map((s) => s.nodeName)).toEqual(['second', 'first']);
		expect(sessions[0].id).toBe(second.id);
	});

	it('drops the oldest record past 500', () => {
		ls.setItem(
			KEY,
			JSON.stringify({
				version: 1,
				sentences: {},
				sessions: Array.from({ length: 500 }, (_, i) => ({ ...base, id: `old${i}` }))
			})
		);
		vi.resetModules();
		return import('./history').then((fresh) => {
			fresh.finalizeSession(base);
			const { sessions } = fresh.loadHistory();
			expect(sessions).toHaveLength(500);
			expect(sessions[0].nodeName).toBe(base.nodeName);
		});
	});

	it('returns a copy, so a caller mutating it cannot poison the next write', () => {
		const returned = H.finalizeSession(base);
		// The cache holds this row, and every later write stringifies the whole
		// cache — so a mutation here would be written straight back to storage.
		returned.attempted = 999;
		H.recordSentenceAttempt('s1', 90, 1000);
		expect(H.loadHistory().sessions[0].attempted).toBe(base.attempted);
	});

	it('never throws when localStorage rejects the write', () => {
		ls.setItem = () => {
			throw new Error('QuotaExceededError');
		};
		expect(() => H.finalizeSession(base)).not.toThrow();
	});
});

describe('loadHistoryUiState / saveHistoryUiState', () => {
	it('defaults to closed when nothing is stored', () => {
		expect(H.loadHistoryUiState()).toEqual({ open: false });
	});

	it('round-trips the open flag on a key separate from the data', () => {
		H.saveHistoryUiState({ open: true });
		expect(H.loadHistoryUiState()).toEqual({ open: true });
		expect(ls.getItem('oboeru:history-ui:v1')).not.toBeNull();
		expect(ls.getItem(KEY)).toBeNull();
	});

	it('falls back to closed on corrupt JSON and never throws on write', () => {
		ls.setItem('oboeru:history-ui:v1', '{broken');
		expect(H.loadHistoryUiState()).toEqual({ open: false });
		ls.setItem = () => {
			throw new Error('QuotaExceededError');
		};
		expect(() => H.saveHistoryUiState({ open: true })).not.toThrow();
	});
});

describe('computeNodeStats', () => {
	const sentences = SENTENCE_FIXTURE;

	// `SENTENCE_FIXTURE` is deliberately out of `order` (s3, s1, s2 for orders
	// 2, 0, 1), so this test fails if a sort ever comes back: `order` is only
	// meaningful inside one track, and the caller owns the display order.
	it('preserves the input sequence verbatim, without re-sorting by order', () => {
		const stats = { s1: stat([90], 5), s3: stat([40], 9, 2) };
		const node = H.computeNodeStats(sentences, false, stats, 80);
		expect(node.total).toBe(3);
		expect(node.passed).toBe(1);
		expect(node.hard).toBe(1);
		expect(node.practiced).toBe(2);
		expect(node.avgScore).toBe(65);
		expect(node.lastPracticedAt).toBe(9);
		// Input order s3 (40 → hard), s1 (90 → passed), s2 (no stat → untouched).
		expect(node.dots).toEqual(['hard', 'passed', 'untouched']);
	});

	// Regression (observed in the running app): a display set spanning two
	// tracks arrives in pre-order, but `order` restarts at 1 in each track. A
	// global `order` sort interleaved them and put the child's only sentence in
	// the middle of the parent's dots — `hard, passed, passed` instead of
	// `passed, passed, hard`, i.e. the row no longer read as practice order.
	it('keeps a two-track display set in pre-order, not in interleaved `order`', () => {
		const parent = [sent('s1', 1), sent('s2', 2)];
		const child = [{ ...sent('s3', 1), trackId: 'tr-child' }];
		const stats = { s1: stat([92]), s2: stat([92]), s3: stat([40]) };

		const node = H.computeNodeStats([...parent, ...child], false, stats, 80);
		expect(node.total).toBe(3);
		expect(node.dots).toEqual(['passed', 'passed', 'hard']);
	});

	it('omits dots for chapters and reports nulls when nothing was practised', () => {
		const node = H.computeNodeStats(sentences, true, {}, 80);
		expect(node.dots).toEqual([]);
		expect(node.avgScore).toBeNull();
		expect(node.lastPracticedAt).toBeNull();
		expect(node.total).toBe(3);
	});

	it('treats a window mean exactly at the threshold as passed', () => {
		const stats = { s1: stat([80], 1) };
		expect(H.computeNodeStats(sentences, false, stats, 80).passed).toBe(1);
		expect(H.computeNodeStats(sentences, false, stats, 81).hard).toBe(1);
	});

	it('raises passed and clears hard when the threshold is lowered', () => {
		const stats = { s1: stat([79]), s2: stat([85]) };
		const strict = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(strict.passed).toBe(1);
		expect(strict.hard).toBe(1);
		const relaxed = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 70);
		expect(relaxed.passed).toBe(2);
		expect(relaxed.hard).toBe(0);
	});

	// ── The user-reported defect, both directions ────────────────────────────
	// 「一回正解しただけで合格判定される！！直近10回の類似度の平均で出すべき！！」
	// Scoring on the newest value gave, at threshold 80:
	//   [40×9, 95] → 合格  — nine misses erased by one lucky pass, forever
	//   [95×9, 40] → 苦手  — nine passes erased by one slip
	// Neither is defensible for a memorisation app, and both were invisible to
	// 190 passing E2E tests: every existing assertion seeded a single score, so
	// mean([x]) and lastScore could not be told apart.
	it('reads [40×9, 95] as 苦手, so one lucky pass cannot settle a sentence', () => {
		const stats = { s1: stat([...repeated(40, 9), 95]) };
		const node = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(node.passed).toBe(0);
		expect(node.hard).toBe(1);
		// 9×40 + 95 = 455 / 10 = 45.5 → 46. The number the row shows must be the
		// one the verdict used, or 平均 46% next to 苦手 1 文 explains nothing.
		expect(node.avgScore).toBe(46);
		// SENTENCE_FIXTURE order is s3, s1, s2 — s1 is the middle dot.
		expect(node.dots).toEqual(['untouched', 'hard', 'untouched']);
	});

	it('reads [95×9, 40] as 合格, so one slip cannot undo nine passes', () => {
		const stats = { s1: stat([...repeated(95, 9), 40]) };
		const node = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(node.passed).toBe(1);
		expect(node.hard).toBe(0);
		// 9×95 + 40 = 895 / 10 = 89.5 → 90.
		expect(node.avgScore).toBe(90);
		expect(node.dots).toEqual(['untouched', 'passed', 'untouched']);
	});

	// One datum is still one verdict: the mean of [95] is 95, so the first
	// attempt behaves as it always did. The row says nothing about how thin the
	// evidence is — that label was removed as misleading (see the spec), not a
	// different verdict.
	it('passes a sentence scored exactly once', () => {
		const stats = { s1: stat([95]) };
		expect(H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80).passed).toBe(1);
		expect(H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80).avgScore).toBe(95);
	});

	// The fixture of the measurement that got the 直近 N 回 label removed: one
	// lopsided window must not change what the row reports about the other two
	// sentences. `practiced` is a COUNT of sentences with a stat, never a depth.
	it('counts a one-attempt sentence as practised, whatever the other depths are', () => {
		// s1 has a full window, s2 only one attempt, s3 none. Same shape as the
		// 20-sentence chapter in the review (19 deep, 1 shallow), shrunk to fit
		// the fixture. Window depth never enters the count.
		const stats = { s1: stat(repeated(95, 10)), s2: stat([40]) };
		const node = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(node.practiced).toBe(2);
		expect(node.total).toBe(3);
		// (95 + 40) / 2 = 67.5 → 68, per sentence — s1's ten samples weigh the
		// same as s2's one.
		expect(node.avgScore).toBe(68);
		expect(node.dots).toEqual(['untouched', 'passed', 'hard']);
	});

	it('averages the per-sentence means, so one drilled sentence cannot dominate', () => {
		// s1's mean is 89.5. Pooled with s2's single 95 the 11 samples average
		// 990/11 = 90; per-sentence it is (89.5 + 95) / 2 = 92.25 → 92. The
		// chapter says how its SENTENCES are doing, not how many times one of
		// them was drilled.
		const stats = { s1: stat([...repeated(95, 9), 40]), s2: stat([95]) };
		const node = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(node.avgScore).toBe(92);
		expect(H.SCORE_WINDOW).toBe(10);
	});

	it('returns an all-zero result for an empty display set', () => {
		expect(H.computeNodeStats([], false, { s1: stat([90]) }, 80)).toEqual({
			total: 0,
			passed: 0,
			practiced: 0,
			hard: 0,
			avgScore: null,
			lastPracticedAt: null,
			dots: []
		});
	});

	it('ignores orphan stats for sentences that no longer exist', () => {
		const stats = { s1: stat([90], 1000), gone: stat([10], 9000) };
		const node = H.computeNodeStats([sent('s1', 1)], false, stats, 80);
		expect(node.total).toBe(1);
		expect(node.practiced).toBe(1);
		expect(node.passed).toBe(1);
		expect(node.lastPracticedAt).toBe(1000);
	});

	// `computeNodeStats` is a pure function of the array it is handed — it never
	// inspects trackId. What this pins: every sentence in that array yields one
	// dot and one unit of the `N/M` denominator, and a stat for a sentence
	// outside the array moves neither. Which array a row passes is the
	// caller's discipline — every row passes `getNodeSentences(nodeId)`, its own
	// subtree, and no unit test here can enforce that.
	// The chapter half of the test shows the same rule with dots switched off:
	// the child track's sentence counts toward `total` and `passed` but adds no
	// dot, so a chapter row never pairs a dot count with a denominator.
	it('keeps the dot count and the N/M denominator on the same sentence set', () => {
		const child = { ...sent('s4', 4), trackId: 'tr-2' };
		const own = [sent('s1', 1), sent('s2', 2)];
		const stats = { s1: stat([90]), s2: stat([30]), s4: stat([90]) };

		const track = H.computeNodeStats(own, false, stats, 80);
		expect(track.total).toBe(2);
		expect(track.dots).toEqual(['passed', 'hard']);
		expect(track.dots).toHaveLength(track.total);

		const chapter = H.computeNodeStats([...own, child], true, stats, 80);
		expect(chapter.total).toBe(3);
		expect(chapter.passed).toBe(2);
		expect(chapter.dots).toEqual([]);
	});
});

describe('computeStreak', () => {
	const DAY = 24 * 60 * 60 * 1000;

	function at(base: number, daysAgo: number): number {
		const d = new Date(base);
		d.setHours(12, 0, 0, 0);
		return d.getTime() - daysAgo * DAY;
	}

	/** A session row on the day `daysAgo` before `now`. Only `startedAt` matters. */
	function sessionOn(now: number, daysAgo: number, name = `s${daysAgo}`): SessionRecord {
		const startedAt = at(now, daysAgo);
		return { ...VALID_SESSION, id: name, nodeName: name, startedAt, endedAt: startedAt + 1000 };
	}

	it('reports zero when nothing was practised', () => {
		expect(H.computeStreak({}, [], 1000 * DAY)).toEqual({ days: 0, totalAttempts: 0 });
	});

	it('counts consecutive days ending today', () => {
		const now = at(1000 * DAY, 0);
		const stats = {
			s1: stat([90], at(now, 0)),
			s2: stat([90], at(now, 1), 2),
			s3: stat([90], at(now, 2))
		};
		expect(H.computeStreak(stats, [], now)).toEqual({ days: 3, totalAttempts: 4 });
	});

	it('counts a single practised day as 1', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: stat([90], at(now, 0)) };
		expect(H.computeStreak(stats, [], now).days).toBe(1);
	});

	it('stops at the first gap and still counts yesterday as current', () => {
		const now = at(1000 * DAY, 0);
		const stats = {
			s1: stat([90], at(now, 1)),
			s2: stat([90], at(now, 2)),
			s3: stat([90], at(now, 5))
		};
		expect(H.computeStreak(stats, [], now).days).toBe(2);
	});

	it('reports zero when the last practice is two days old', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: stat([90], at(now, 2)) };
		expect(H.computeStreak(stats, [], now).days).toBe(0);
	});

	// THE regression. `SentenceStat.lastPracticedAt` keeps only the most recent
	// practice of each sentence, so practising the same three sentences on five
	// consecutive days leaves all three stats stamped today — the sentence side
	// of the day set collapses to one member and the headline reads 連続 1 日
	// forever. Repeating a chapter is the dominant use of a memorisation app.
	// Measured against the pre-fix function: days 1, 0, 0, 0, 0.
	it('counts every day of a streak when the same sentences are practised again', () => {
		const now = at(1000 * DAY, 0);
		const stats = {
			s1: stat([90], at(now, 0), 5),
			s2: stat([90], at(now, 0), 5),
			s3: stat([90], at(now, 0), 5)
		};
		const sessions = [0, 1, 2, 3, 4].map((d) => sessionOn(now, d));
		// The sentence side alone sees one day; only the union sees five.
		expect(H.computeStreak(stats, [], now).days).toBe(1);
		expect(H.computeStreak(stats, sessions, now)).toEqual({ days: 5, totalAttempts: 15 });
	});

	// Each source contributes a day the other lacks, and only the union makes
	// the run contiguous: sessions know days 0-1, stats know days 0 and 2.
	// Session-only would read 2, stats-only 1, the union 3.
	it('unions the session days with the sentence-stat days', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: stat([90], at(now, 0)), s2: stat([90], at(now, 2)) };
		const sessions = [sessionOn(now, 0), sessionOn(now, 1)];
		expect(H.computeStreak(stats, [], now).days).toBe(1);
		expect(H.computeStreak({}, sessions, now).days).toBe(2);
		expect(H.computeStreak(stats, sessions, now).days).toBe(3);
	});

	// A session lost to a tab kill never reaches the log, but the sentences it
	// scored still carry that day — so the union must not need the row to exist.
	it('counts a day whose session row was lost to a kill, via its sentence stats', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: stat([90], at(now, 1)) };
		// Nothing logged for that day at all.
		expect(H.computeStreak(stats, [], now).days).toBe(1);
	});

	// `totalAttempts` stays the sentence-stat sum: the log's `attempted` counts
	// attempts that are deliberately NOT recorded (a session lost to a kill), so
	// summing it here would double-count nothing but drift upward.
	it('takes のべ attempts from the sentence stats only', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: stat([90], at(now, 0), 2), s2: stat([40], at(now, 1), 3) };
		const sessions = [sessionOn(now, 0), sessionOn(now, 1)];
		expect(H.computeStreak(stats, sessions, now).totalAttempts).toBe(5);
	});
});

describe('formatRelativeDay', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const now = new Date(1000 * DAY);
	now.setHours(12, 0, 0, 0);

	/** Local wall clock N days back — calendar arithmetic, so DST stays safe. */
	function atClock(daysAgo: number, hours: number, minutes = 0): number {
		const d = new Date(now.getTime());
		d.setDate(d.getDate() - daysAgo);
		d.setHours(hours, minutes, 0, 0);
		return d.getTime();
	}

	it('names today, yesterday and older days in Japanese', () => {
		expect(H.formatRelativeDay(now.getTime(), now.getTime())).toBe('今日');
		expect(H.formatRelativeDay(now.getTime() - DAY, now.getTime())).toBe('昨日');
		expect(H.formatRelativeDay(now.getTime() - 5 * DAY, now.getTime())).toBe('5 日前');
	});

	// 05:00 → 20:00 is 0.625 day: a raw-millisecond diff rounds to 1 and prints
	// 昨日. Only calendar-day keying prints 今日, so this pair separates the two.
	// A 6-hour gap (06:00 → 12:00) would prove nothing — it rounds to 0 either way.
	it('names a timestamp 15 hours earlier on the same calendar day 今日', () => {
		expect(H.formatRelativeDay(atClock(0, 5), atClock(0, 20))).toBe('今日');
	});

	// 20 minutes across midnight is 0.014 day: a raw-millisecond diff rounds to 0
	// and prints 今日. Calendar-day keying sees two different days.
	it('names a timestamp from just before midnight 昨日 when read just after', () => {
		expect(H.formatRelativeDay(atClock(1, 23, 50), atClock(0, 0, 10))).toBe('昨日');
	});

	it('never returns a negative day count for a future timestamp', () => {
		expect(H.formatRelativeDay(now.getTime() + DAY, now.getTime())).toBe('今日');
	});
});
