/**
 * Practice history storage.
 *
 * A single dedicated key, outside the Settings schema and outside the
 * content DB (`oboeru:v1`) — same pattern as `practice-progress.ts`. Every
 * operation swallows its own errors: a browser that refuses storage must
 * still be able to run a practice session, just without a history.
 *
 * History is deliberately device-local. Cloud sync (roadmap ⑥) merges
 * chapters/tracks/sentences; it cannot merge "what I practised", and
 * last-write-wins would silently discard it. Do not add it to a sync payload.
 */

import { generateId } from './sentences';
import type { Sentence } from './types';

const HISTORY_STORAGE_KEY = 'oboeru:history:v1';
const HISTORY_UI_KEY = 'oboeru:history-ui:v1';
const MAX_SESSIONS = 500;

/**
 * How many of a sentence's most recent scores are kept. The verdict is the mean
 * of that window, so 1 is the minimum a sentence needs before the mean can say
 * anything the newest score alone cannot.
 */
export const SCORE_WINDOW = 10;

export interface SessionRecord {
	id: string;
	/** Session's start node — a chapter or a track id. */
	nodeId: string;
	/** Display name captured at session start, so a deleted node still reads. */
	nodeName: string;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	/** Scoring attempts (retries included) — same definition as completedCount. */
	attempted: number;
	/**
	 * Distinct sentences that passed IN THIS MOUNT. Equals `passedIds.length` for
	 * a fresh session; a session resumed from `practice-progress.ts` starts with
	 * an empty `passedIds` (that module does not persist it), so the passes made
	 * before the reload are missing here while `attempted` still counts them.
	 * Accepted limitation — see the spec's 既知の制限.
	 */
	passedSentences: number;
	totalScore: number;
	skipped: number;
	endedEarly: boolean;
}

export interface SentenceStat {
	attempts: number;
	/**
	 * The newest `SCORE_WINDOW` finalScores, oldest first. Pass / hard /
	 * untouched are derived from the MEAN of this against the live threshold —
	 * scoring on the newest value alone let a single lucky pass settle a
	 * sentence as 合格 forever, and let one slip erase nine passes (measured:
	 * `[40×9, 95]` → 合格, `[95×9, 40]` → 苦手).
	 */
	scores: number[];
	lastPracticedAt: number;
}

export interface HistoryData {
	version: 1;
	/** Newest first. */
	sessions: SessionRecord[];
	sentences: Record<string, SentenceStat>;
}

export interface HistoryUiState {
	open: boolean;
}

/** Fresh object per call — a shared literal would let one caller mutate the default. */
function emptyData(): HistoryData {
	return { version: 1, sessions: [], sentences: {} };
}

function nonNegInt(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	return Math.floor(value);
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * The stored score window, oldest first, capped at SCORE_WINDOW.
 *
 * MIGRATION — `HistoryData.version` stays 1 forever. loadHistory() shrinks to
 * the empty default on a version mismatch, so bumping it would throw away every
 * session row and sentence stat the user has accumulated. Instead the OLD shape
 * is absorbed here: a stat written before the window existed carries a single
 * `lastScore`, and it reads as a one-element window. `mean([x]) === x`, so the
 * pass/hard verdict, the dot and the displayed average are all identical across
 * the deploy — the window only starts changing verdicts from the second attempt
 * onward. `attempts` is untouched, so のべ文数 does not move either.
 *
 * An entry with neither field yields an empty window: the mean of nothing is 0,
 * which reads as 苦手. That is the safe direction — it cannot manufacture a pass.
 */
function readScores(st: Record<string, unknown>): number[] {
	if (Array.isArray(st.scores)) return st.scores.map(nonNegInt).slice(-SCORE_WINDOW);
	if (typeof st.lastScore === 'number') return [nonNegInt(st.lastScore)];
	return [];
}

/** Clamped 0-100 integer, or 0 for anything non-finite. */
function score(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function readStorage(): HistoryData {
	try {
		const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
		if (raw === null) return emptyData();
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return emptyData();
		const obj = parsed as Record<string, unknown>;
		if (obj.version !== 1) return emptyData();

		const sessions: SessionRecord[] = [];
		if (Array.isArray(obj.sessions)) {
			for (const entry of obj.sessions) {
				if (typeof entry !== 'object' || entry === null) continue;
				const s = entry as Record<string, unknown>;
				sessions.push({
					id: str(s.id),
					nodeId: str(s.nodeId),
					nodeName: str(s.nodeName),
					startedAt: num(s.startedAt),
					endedAt: num(s.endedAt),
					durationMs: nonNegInt(s.durationMs),
					attempted: nonNegInt(s.attempted),
					passedSentences: nonNegInt(s.passedSentences),
					totalScore: nonNegInt(s.totalScore),
					skipped: nonNegInt(s.skipped),
					endedEarly: s.endedEarly === true
				});
				if (sessions.length >= MAX_SESSIONS) break;
			}
		}

		const sentences: Record<string, SentenceStat> = {};
		if (typeof obj.sentences === 'object' && obj.sentences !== null) {
			for (const [id, value] of Object.entries(obj.sentences as Record<string, unknown>)) {
				if (typeof value !== 'object' || value === null) continue;
				const st = value as Record<string, unknown>;
				sentences[id] = {
					attempts: nonNegInt(st.attempts),
					scores: readScores(st),
					lastPracticedAt: num(st.lastPracticedAt)
				};
			}
		}

		return { version: 1, sessions, sentences };
	} catch {
		return emptyData();
	}
}

/**
 * Parsed data held for the tab. A practice session calls
 * recordSentenceAttempt once per sentence; without this the full history
 * would be re-parsed and re-serialised on every scoring (~9ms each at 165KB).
 */
let cache: HistoryData | null = null;

function read(): HistoryData {
	if (cache === null) cache = readStorage();
	return cache;
}

function persist(data: HistoryData): void {
	cache = data;
	try {
		localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(data));
	} catch {
		// Storage unavailable or over quota — the in-memory copy still works.
	}
}

export function loadHistory(): HistoryData {
	return readStorage();
}

export function recordSentenceAttempt(sentenceId: string, value: number, at: number): void {
	const data = read();
	const prev = data.sentences[sentenceId];
	// A non-finite score would survive Math.round/Math.min as NaN, which
	// JSON.stringify writes as null: storage would read back 0 while the
	// cache said NaN, and computeNodeStats would render a literal "NaN%".
	// A 0-100 clamp is also what keeps the mean inside 0-100.
	const scores = [...(prev?.scores ?? []), score(value)].slice(-SCORE_WINDOW);
	data.sentences[sentenceId] = {
		attempts: (prev?.attempts ?? 0) + 1,
		scores,
		lastPracticedAt: at
	};
	persist(data);
}

export function finalizeSession(record: Omit<SessionRecord, 'id'>): SessionRecord {
	const data = read();
	const stored: SessionRecord = { id: generateId(), ...record };
	data.sessions.unshift(stored);
	if (data.sessions.length > MAX_SESSIONS) data.sessions.length = MAX_SESSIONS;
	persist(data);
	// A copy, not `stored`: the return value is the SAME object the cache holds,
	// so a caller mutating it would poison the next persist() (any later
	// recordSentenceAttempt writes the mutated copy). loadHistory() already
	// returns fresh objects for the same reason.
	return { ...stored };
}

export function loadHistoryUiState(): HistoryUiState {
	try {
		const raw = localStorage.getItem(HISTORY_UI_KEY);
		if (raw === null) return { open: false };
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return { open: false };
		return { open: (parsed as Record<string, unknown>).open === true };
	} catch {
		return { open: false };
	}
}

export function saveHistoryUiState(state: HistoryUiState): void {
	try {
		localStorage.setItem(HISTORY_UI_KEY, JSON.stringify(state));
	} catch {
		// Storage unavailable — the section still opens for this page view.
	}
}

// --- Pure derivations -------------------------------------------------------

export type DotState = 'passed' | 'hard' | 'untouched';

/** Mean of one sentence's score window. An empty window means 0 → 苦手. */
export function meanScore(scores: readonly number[]): number {
	if (scores.length === 0) return 0;
	return scores.reduce((sum, v) => sum + v, 0) / scores.length;
}

export interface NodeStats {
	/** Sentence count for the row's display set. */
	total: number;
	passed: number;
	/** Sentences scored at least once (= not untouched). */
	practiced: number;
	hard: number;
	/**
	 * Mean of the per-sentence means — sentences weigh EQUALLY. Pooling every
	 * sample instead would let one sentence drilled to 10 attempts dominate its
	 * chapter's average. Null when nothing was practised.
	 */
	avgScore: number | null;
	/**
	 * The smallest `scores.length` among the practised sentences — the N of the
	 * row's 直近 N 回. The MINIMUM on purpose: 「平均 87%」 alone cannot say
	 * whether the evidence is one lucky pass or ten steady ones, and the maximum
	 * would overstate a row whose other sentences have one attempt each.
	 */
	minSamples: number;
	lastPracticedAt: number | null;
	/** Empty for chapters; for tracks, one entry per display sentence, in display order. */
	dots: DotState[];
}

/**
 * Aggregate one row's display set. Pass exactly the sentences the row shows —
 * that is, `getNodeSentences(nodeId)`, so the `N/M` denominator is the real
 * session length and cannot disagree with the dot count in the same row.
 *
 * A sentence is 合格 when the MEAN of its window reaches the live threshold,
 * never on its newest score: one lucky pass must not settle a sentence, and one
 * slip must not erase nine passes.
 *
 * The array is used exactly as given: the caller supplies the display order,
 * and that order is practice order (pre-order — a node's own track, then each
 * child subtree). Do not re-sort by `sentence.order` here: `order` is only
 * meaningful within one track, so a global sort interleaves tracks and puts a
 * child's only sentence in the middle of the parent's dots.
 */
export function computeNodeStats(
	sentences: Sentence[],
	isChapter: boolean,
	stats: Readonly<Record<string, SentenceStat>>,
	threshold: number
): NodeStats {
	let passed = 0;
	let practiced = 0;
	let hard = 0;
	let meanSum = 0;
	let minSamples = Number.POSITIVE_INFINITY;
	let lastPracticedAt: number | null = null;
	const dots: DotState[] = [];

	for (const sentence of sentences) {
		const stat = stats[sentence.id];
		if (!stat) {
			if (!isChapter) dots.push('untouched');
			continue;
		}
		const mean = meanScore(stat.scores);
		practiced++;
		meanSum += mean;
		if (stat.scores.length < minSamples) minSamples = stat.scores.length;
		if (stat.lastPracticedAt > (lastPracticedAt ?? 0)) lastPracticedAt = stat.lastPracticedAt;
		if (mean >= threshold) {
			passed++;
			if (!isChapter) dots.push('passed');
		} else {
			hard++;
			if (!isChapter) dots.push('hard');
		}
	}

	return {
		total: sentences.length,
		passed,
		practiced,
		hard,
		avgScore: practiced > 0 ? Math.round(meanSum / practiced) : null,
		minSamples: practiced > 0 ? minSamples : 0,
		lastPracticedAt,
		dots
	};
}

export interface StreakInfo {
	/** Consecutive days ending today (0 when nothing was practised today). */
	days: number;
	/**
	 * Sum of every sentence stat's attempts — retries included. Deliberately
	 * NOT the log's `attempted` sum: a session lost to a tab kill scored its
	 * sentences (so they are counted here) but never wrote a row.
	 */
	totalAttempts: number;
}

function localDayKey(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeStreak(
	stats: Readonly<Record<string, SentenceStat>>,
	sessions: readonly SessionRecord[],
	now: number = Date.now()
): StreakInfo {
	const days = new Set<number>();
	let totalAttempts = 0;
	for (const stat of Object.values(stats)) {
		totalAttempts += stat.attempts;
		if (stat.lastPracticedAt > 0) days.add(localDayKey(stat.lastPracticedAt));
	}
	// The session rows are the per-DAY log; the sentence stats are not.
	// `SentenceStat.lastPracticedAt` holds only each sentence's MOST RECENT
	// practice, so practising the same chapter on five consecutive days leaves
	// every stat stamped today and the sentence side collapses to a single day
	// (measured against the pre-fix function: days 1, 0, 0, 0, 0). Session rows
	// are append-only and each carries its own `startedAt`, so they carry the
	// real run. The union loses nothing: a session lost to a tab kill is still
	// covered by that day's sentence stats. Bounded by MAX_SESSIONS, so a streak
	// longer than the retained log (500) is all the sentence side can extend.
	for (const session of sessions) {
		if (session.startedAt > 0) days.add(localDayKey(session.startedAt));
	}
	if (days.size === 0) return { days: 0, totalAttempts: 0 };

	// Today counts even before any scoring: opening the app is not a break.
	let cursor = localDayKey(now);
	if (!days.has(cursor)) cursor -= DAY_MS;
	let streak = 0;
	while (days.has(cursor)) {
		streak++;
		cursor -= DAY_MS;
	}
	return { days: streak, totalAttempts };
}

export function formatRelativeDay(ts: number, now: number = Date.now()): string {
	const diff = Math.round((localDayKey(now) - localDayKey(ts)) / DAY_MS);
	if (diff <= 0) return '今日';
	if (diff === 1) return '昨日';
	return `${diff} 日前`;
}
