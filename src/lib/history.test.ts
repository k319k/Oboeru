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

function stat(lastScore: number, at = 1000, attempts = 1): SentenceStat {
	return { attempts, lastScore, lastPracticedAt: at };
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
			sentences: { s1: { attempts: -1, lastScore: 80, lastPracticedAt: 5 } }
		});
		const data = H.loadHistory();
		expect(data.sessions[0].durationMs).toBe(0);
		expect(data.sessions[0].attempted).toBe(0);
		expect(data.sessions[0].passedSentences).toBe(2);
		expect(data.sessions[0].skipped).toBe(0);
		expect(data.sentences.s1.attempts).toBe(0);
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
			lastScore: 87,
			lastPracticedAt: 1000
		});
	});

	it('increments attempts and overwrites lastScore on later attempts', () => {
		H.recordSentenceAttempt('s1', 50, 1000);
		H.recordSentenceAttempt('s1', 92, 2000);
		expect(H.loadHistory().sentences.s1).toEqual({
			attempts: 2,
			lastScore: 92,
			lastPracticedAt: 2000
		});
	});

	it('does not drop sibling stats across consecutive calls (cache integrity)', () => {
		H.recordSentenceAttempt('s1', 50, 1000);
		H.recordSentenceAttempt('s2', 60, 1000);
		H.recordSentenceAttempt('s1', 70, 2000);
		const { sentences } = H.loadHistory();
		expect(sentences.s1.lastScore).toBe(70);
		expect(sentences.s2.lastScore).toBe(60);
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
		expect(sentences.s1.lastScore).toBe(0);
		// loadHistory() reads back 0 either way (null coerces to 0), so pin the
		// written payload: an unguarded NaN is serialised as null, which leaves
		// the cache saying NaN while storage says 0.
		expect(ls.getItem(KEY)).toContain('"lastScore":0');
		expect(H.computeNodeStats(SENTENCE_FIXTURE.filter((s) => s.id === 's1'), false, sentences, 80).avgLastScore).not.toBeNaN();
	});
});

describe('finalizeSession / getSessions', () => {
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

	it('getSessions returns newest first and honours limit', () => {
		H.finalizeSession({ ...base, nodeName: 'first' });
		H.finalizeSession({ ...base, nodeName: 'second' });
		expect(H.getSessions(1).map((s) => s.nodeName)).toEqual(['second']);
		expect(H.getSessions()).toHaveLength(2);
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

	it('sorts by order and counts pass / hard / untouched', () => {
		const stats = {
			s1: { attempts: 1, lastScore: 90, lastPracticedAt: 5 },
			s3: { attempts: 2, lastScore: 40, lastPracticedAt: 9 }
		};
		const node = H.computeNodeStats(sentences, false, stats, 80);
		expect(node.total).toBe(3);
		expect(node.passed).toBe(1);
		expect(node.hard).toBe(1);
		expect(node.practiced).toBe(2);
		expect(node.avgLastScore).toBe(65);
		expect(node.lastPracticedAt).toBe(9);
		expect(node.dots).toEqual(['passed', 'untouched', 'hard']);
	});

	it('omits dots for chapters and reports nulls when nothing was practised', () => {
		const node = H.computeNodeStats(sentences, true, {}, 80);
		expect(node.dots).toEqual([]);
		expect(node.avgLastScore).toBeNull();
		expect(node.lastPracticedAt).toBeNull();
		expect(node.total).toBe(3);
	});

	it('treats lastScore === threshold as passed', () => {
		const stats = { s1: { attempts: 1, lastScore: 80, lastPracticedAt: 1 } };
		expect(H.computeNodeStats(sentences, false, stats, 80).passed).toBe(1);
		expect(H.computeNodeStats(sentences, false, stats, 81).hard).toBe(1);
	});

	it('raises passed and clears hard when the threshold is lowered', () => {
		const stats = { s1: stat(79), s2: stat(85) };
		const strict = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 80);
		expect(strict.passed).toBe(1);
		expect(strict.hard).toBe(1);
		const relaxed = H.computeNodeStats(SENTENCE_FIXTURE, false, stats, 70);
		expect(relaxed.passed).toBe(2);
		expect(relaxed.hard).toBe(0);
	});

	it('returns an all-zero result for an empty display set', () => {
		expect(H.computeNodeStats([], false, { s1: stat(90) }, 80)).toEqual({
			total: 0,
			passed: 0,
			practiced: 0,
			hard: 0,
			avgLastScore: null,
			lastPracticedAt: null,
			dots: []
		});
	});

	it('ignores orphan stats for sentences that no longer exist', () => {
		const stats = { s1: stat(90, 1000), gone: stat(10, 9000) };
		const node = H.computeNodeStats([sent('s1', 1)], false, stats, 80);
		expect(node.total).toBe(1);
		expect(node.practiced).toBe(1);
		expect(node.passed).toBe(1);
		expect(node.lastPracticedAt).toBe(1000);
	});

	// The invariant the whole feature rests on: inside one row the `N/M`
	// denominator and the dot count must describe the same sentences. A track
	// row is handed its own sentences, so a child track's sentence is outside
	// both — while the chapter row above it counts that sentence in its total
	// and deliberately renders no dots at all. Passing `getNodeSentences`'s
	// subtree to a track row would break exactly this pairing.
	it('keeps the dot count and the N/M denominator on the same sentence set', () => {
		const child = { ...sent('s4', 4), trackId: 'tr-2' };
		const own = [sent('s1', 1), sent('s2', 2)];
		const stats = { s1: stat(90), s2: stat(30), s4: stat(90) };

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

	it('reports zero when nothing was practised', () => {
		expect(H.computeStreak({}, 1000 * DAY)).toEqual({ days: 0, totalAttempts: 0 });
	});

	it('counts consecutive days ending today', () => {
		const now = at(1000 * DAY, 0);
		const stats = {
			s1: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 0) },
			s2: { attempts: 2, lastScore: 90, lastPracticedAt: at(now, 1) },
			s3: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 2) }
		};
		expect(H.computeStreak(stats, now)).toEqual({ days: 3, totalAttempts: 4 });
	});

	it('counts a single practised day as 1', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 0) } };
		expect(H.computeStreak(stats, now).days).toBe(1);
	});

	it('stops at the first gap and still counts yesterday as current', () => {
		const now = at(1000 * DAY, 0);
		const stats = {
			s1: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 1) },
			s2: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 2) },
			s3: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 5) }
		};
		expect(H.computeStreak(stats, now).days).toBe(2);
	});

	it('reports zero when the last practice is two days old', () => {
		const now = at(1000 * DAY, 0);
		const stats = { s1: { attempts: 1, lastScore: 90, lastPracticedAt: at(now, 2) } };
		expect(H.computeStreak(stats, now).days).toBe(0);
	});
});

describe('formatRelativeDay', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const now = new Date(1000 * DAY);
	now.setHours(12, 0, 0, 0);

	it('names today, yesterday and older days in Japanese', () => {
		expect(H.formatRelativeDay(now.getTime(), now.getTime())).toBe('今日');
		expect(H.formatRelativeDay(now.getTime() - DAY, now.getTime())).toBe('昨日');
		expect(H.formatRelativeDay(now.getTime() - 5 * DAY, now.getTime())).toBe('5 日前');
	});

	it('names two timestamps on the same calendar day 今日 regardless of the hour', () => {
		const morning = new Date(now.getTime());
		morning.setHours(6, 0, 0, 0);
		expect(H.formatRelativeDay(morning.getTime(), now.getTime())).toBe('今日');
	});

	it('never returns a negative day count for a future timestamp', () => {
		expect(H.formatRelativeDay(now.getTime() + DAY, now.getTime())).toBe('今日');
	});
});