# 練習履歴の記録とトップページへの表示 — 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 練習結果（スコア・合格/苦手・最終練習日・過去セッション）を localStorage に永続化し、トップページに行ごとの進捗・ドット・ストリーク・履歴ログを表示する。

**Architecture:** `src/lib/history.ts` を新設し、既存 `src/lib/practice-progress.ts` と同じ契約（自己完結・全操作が `try/catch` でエラーを握り潰す）で永続化層と純粋な集計関数を提供する。書き込みは `practice/+page.svelte` の採点確定点と `summary` 到達時・`onDestroy` の両方、読み取りはトップページのみ。集計は既存の `sentencesByNode` から `statsByNode` を 1 度だけ計算し、全行が参照する。行の表示集合は `getNodeSentences(nodeId, …)`（= サブツリー）で、`/practice?node=` と同じなので `M` が実セッション長と一致する（AGENTS.md の「1 系統」規約）。

**Tech Stack:** SvelteKit 5（runes: `$state` / `$derived.by` / `$effect` / `onDestroy`）、TypeScript、Tailwind CSS v4、vitest（`src/**/*.test.ts` のみ収集）、Playwright（`tests/**`）。

## Global Constraints

- ** 提出は `npm run check` が 0 エラー**。`as any` / `@ts-ignore` / `@ts-expect-error` 禁止
- ** テストの削除・skip 化・アサーション弱化は禁止**。挙動変更時は正当に更新して報告する
- ** localStorage キー**: 永続化 `oboeru:history:v1`、UI 状態 `oboeru:history-ui:v1`。既存の `oboeru:v1` / `oboeru:settings:v1` / `oboeru:theme` / sessionStorage `oboeru:progress:v1` を変更しない
- ** 1 系統の規約**: 章/トラックの行が表示する文数は `getNodeSentences(nodeId, …)` の結果そのもの（= サブツリー）。`/practice?node=` も同じ集合を回るので `M` は実際のセッション長と一致する。`canPractice()` も同じ基準なので `0文` の行に練習ボタンが出ない
- ** 合格状態は保存しない**。`lastScore` だけ保存し、合格/苦手/未着手は現在の `threshold` から導出する
- ** `SentenceStat` は `attempts` / `lastScore` / `lastPracticedAt` の 3 フィールドだけ**。`passes` / `bestScore` は持たない
- ** 保持上限**: `sessions` は新しい順 500 件。超えたら最古を落とす。`sentences` は削除しない
- ** UI 文言は日本語**。レスポンシブ 390px を維持。`expectTapTargets`（`tests/a11y.spec.ts`）は可視 `button` に高さ 44px を要求する
- ** 既存 testid `chapter-card-count` / `track-card-count` は残す**。中身の文言だけが `N/M 合格 · X%` に変わる
- **ドット列は 390px で 1 行に約 22 個**。`flex flex-wrap` で折り返す。章行にはドットを出さない
- ** コメントは書かない**（既存コードのコメントの書き方に合わせる。ただし「why」を説明する設計コメントは AGENTS.md の流儀に従う）

## ファイル構成

| ファイル | 責務 |
|---|---|
| `src/lib/history.ts`（新規） | 永続化（`loadHistory` / `recordSentenceAttempt` / `finalizeSession` / `getSessions`）、純粋関数（`computeNodeStats` / `computeStreak` / `formatRelativeDay`）、UI 状態の读写（`loadHistoryUiState` / `saveHistoryUiState`） |
| `src/lib/history.test.ts`（新規） | 上記の vitest ユニットテスト |
| `src/lib/sentences.ts`（変更） | `generateId()` を export して `history.ts` から再利用（1 行） |
| `src/routes/practice/+page.svelte`（変更） | 採点確定点で文統計を記録、`beginSession()` で開始時刻をスタンプ、`onDestroy` でセッション確定、`:61` の嘘コメントを削除 |
| `src/routes/+page.svelte`（変更） | `statsByNode` の追加、`ownCount` / `chapterTotal` の削除、章行・トラック行の描画更新、ストリークピル、折りたたみ履歴セクション |
| `tests/helpers.ts`（変更） | `seedHistory(page, data)` を追加 |
| `tests/top.spec.ts`（変更） | 4 アサーションを新フォーマットへ更新 |
| `tests/e2e-full.spec.ts`（変更） | 1 アサーションを新フォーマットへ更新 |
| `tests/a11y.spec.ts`（変更） | 履歴シード済みトップページのスキャン + `expectTapTargets` |
| `tests/history.spec.ts`（新規） | 履歴 UI の E2E |
| `AGENTS.md`（変更） | ディレクトリ地図に `src/lib/history.ts` を追記、記録書き込みの規約を追記 |

---

### Task 1: `history.ts` の永続化層

`src/lib/history.ts` を新設し、`loadHistory` / `recordSentenceAttempt` / `finalizeSession` / `getSessions` を実装する。`generateId()` を `sentences.ts` から export して再利用する。

**Files:**
- Create: `src/lib/history.ts`
- Create: `src/lib/history.test.ts`
- Modify: `src/lib/sentences.ts:10`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  ```ts
  // src/lib/history.ts
  export interface SessionRecord {
    id: string;
    nodeId: string;
    nodeName: string;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    attempted: number;
    passedSentences: number;
    totalScore: number;
    skipped: number;
    endedEarly: boolean;
  }
  export interface SentenceStat { attempts: number; lastScore: number; lastPracticedAt: number; }
  export interface HistoryData {
    version: 1;
    sessions: SessionRecord[];
    sentences: Record<string, SentenceStat>;
  }
  export function loadHistory(): HistoryData;
  export function recordSentenceAttempt(sentenceId: string, score: number, at: number): void;
  export function finalizeSession(record: Omit<SessionRecord, 'id'>): SessionRecord;
  export function getSessions(limit?: number): SessionRecord[];
  ```
  `finalizeSession` は `id` を自前で払い（`generateId()`）、先頭に `unshift` し、500 件超で切断して、**保存された record を返す**。呼び出し側が id を生成する必要はない。

- [ ] **Step 1: `sentences.ts` の `generateId` を export する**

`src/lib/sentences.ts:10` を書き換える。

```ts
export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
```

- [ ] **Step 2: テストのローカルストレージモックと `beforeEach` を書く**

`src/lib/history.test.ts` を新規作成する。Node には Web Storage が無いので、既存の `src/lib/practice-progress.test.ts:15-51` と同じ手動モックを使う。`history.ts` は in-memory キャッシュを持つため、**テストごとにモジュールを取り直す**（静的 import ではキャッシュがテストを跨いで汚染される）。

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
});

describe('finalizeSession / getSessions', () => {
	const base = {
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
```

- [ ] **Step 3: テストを走らせて失敗を確認する**

Run: `npx vitest run src/lib/history.test.ts`
Expected: FAIL with `Cannot find module './history'`

- [ ] **Step 4: `src/lib/history.ts` の永続化層を実装する**

`src/lib/history.ts` を新規作成する。**このタスクでは永続化と UI 状態だけ**を実装する（`computeNodeStats` / `computeStreak` / `formatRelativeDay` は Task 2）。

```ts
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
	/** Distinct sentences that passed — same definition as passedIds.length. */
	passedSentences: number;
	totalScore: number;
	skipped: number;
	endedEarly: boolean;
}

export interface SentenceStat {
	attempts: number;
	/** Pass / hard / untouched are all derived from this against the live threshold. */
	lastScore: number;
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

const EMPTY: HistoryData = { version: 1, sessions: [], sentences: {} };

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

function readStorage(): HistoryData {
	try {
		const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
		if (raw === null) return { ...EMPTY, sentences: {} };
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY, sentences: {} };
		const obj = parsed as Record<string, unknown>;
		if (obj.version !== 1) return { ...EMPTY, sentences: {} };

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
					lastScore: nonNegInt(st.lastScore),
					lastPracticedAt: num(st.lastPracticedAt)
				};
			}
		}

		return { version: 1, sessions, sentences };
	} catch {
		return { ...EMPTY, sentences: {} };
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

export function recordSentenceAttempt(sentenceId: string, score: number, at: number): void {
	const data = read();
	const prev = data.sentences[sentenceId];
	data.sentences[sentenceId] = {
		attempts: (prev?.attempts ?? 0) + 1,
		lastScore: Math.max(0, Math.min(100, Math.round(score))),
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
	return stored;
}

export function getSessions(limit?: number): SessionRecord[] {
	const all = read().sessions;
	if (typeof limit !== 'number' || limit <= 0) return [...all];
	return all.slice(0, limit);
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

export interface NodeStats {
	/** Sentence count for the row's display set. */
	total: number;
	passed: number;
	/** Sentences scored at least once (= not untouched). */
	practiced: number;
	hard: number;
	avgLastScore: number | null;
	lastPracticedAt: number | null;
	/** Empty for chapters; the display set in `order` for tracks. */
	dots: DotState[];
}

/**
 * Aggregate one row's display set. Pass exactly the sentences the row shows:
 * a chapter's whole subtree, a track's own sentences. Mixing the two makes
 * the `N/M` denominator disagree with the dot count in the same row.
 */
export function computeNodeStats(
	sentences: Sentence[],
	isChapter: boolean,
	stats: Readonly<Record<string, SentenceStat>>,
	threshold: number
): NodeStats {
	const ordered = [...sentences].sort((a, b) => a.order - b.order);
	let passed = 0;
	let practiced = 0;
	let hard = 0;
	let scoreSum = 0;
	let lastPracticedAt: number | null = null;
	const dots: DotState[] = [];

	for (const sentence of ordered) {
		const stat = stats[sentence.id];
		if (!stat) {
			if (!isChapter) dots.push('untouched');
			continue;
		}
		practiced++;
		scoreSum += stat.lastScore;
		if (stat.lastPracticedAt > (lastPracticedAt ?? 0)) lastPracticedAt = stat.lastPracticedAt;
		if (stat.lastScore >= threshold) {
			passed++;
			if (!isChapter) dots.push('passed');
		} else {
			hard++;
			if (!isChapter) dots.push('hard');
		}
	}

	return {
		total: ordered.length,
		passed,
		practiced,
		hard,
		avgLastScore: practiced > 0 ? Math.round(scoreSum / practiced) : null,
		lastPracticedAt,
		dots
	};
}

export interface StreakInfo {
	/** Consecutive days ending today (0 when nothing was practised today). */
	days: number;
	/** Sum of every sentence stat's attempts — retries included. */
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
	now: number = Date.now()
): StreakInfo {
	const days = new Set<number>();
	let totalAttempts = 0;
	for (const stat of Object.values(stats)) {
		totalAttempts += stat.attempts;
		if (stat.lastPracticedAt > 0) days.add(localDayKey(stat.lastPracticedAt));
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
```

**注意**: `loadHistory()` は**常にストレージから読む**（キャッシュを返さない）。テストが `localStorage` を直接シードして `loadHistory()` で検証できるようにするため。キャッシュは write 経路だけが使う。

- [ ] **Step 5: テストを走らせて通ることを確認する**

Run: `npx vitest run src/lib/history.test.ts`
Expected: PASS（5 つの describe が緑）

- [ ] **Step 6: 型チェック**

Run: `npm run check`
Expected: `svelte-check found 0 errors`（`Sentence` の未使用 import が出たら `computeNodeStats` の引数で使っているので残すこと）

- [ ] **Step 7: コミット**

```bash
git add src/lib/history.ts src/lib/history.test.ts src/lib/sentences.ts
git commit -m "feat(history): add localStorage-backed practice history with node stats"
```

---

### Task 2: `computeNodeStats` / `computeStreak` / `formatRelativeDay` のユニットテスト

Task 1 で実装した純粋関数の振る舞いを固定する。**表示集合が 1 行の中で揃っていること**が最重要の検証項目。

**Files:**
- Modify: `src/lib/history.test.ts`（末尾に describe を追加）

**Interfaces:**
- Consumes: Task 1 の `computeNodeStats(sentences, isChapter, stats, threshold)` / `computeStreak(stats, now)` / `formatRelativeDay(ts, now)` / `type NodeStats` / `type DotState` / `type SentenceStat`
- Produces: なし（テストのみ）

- [ ] **Step 1: テストヘルパーを文件的先頭に足す**

`src/lib/history.test.ts` の `const KEY = ...` の直後（`beforeEach` の直前）に足す。

```ts
function sent(id: string, order: number): Sentence {
	return { id, chapterId: 'ch-1', trackId: 'tr-1', text: id, language: 'ja', order };
}

function stat(lastScore: number, at = 1000, attempts = 1): SentenceStat {
	return { attempts, lastScore, lastPracticedAt: at };
}
```

- [ ] **Step 2: `computeNodeStats` のテストを末尾に追加する**

```ts
describe('computeNodeStats', () => {
	const list = [sent('s1', 1), sent('s2', 2), sent('s3', 3)];

	it('total equals the display set length', () => {
		expect(H.computeNodeStats(list, false, {}, 80).total).toBe(3);
	});

	it('counts untouched sentences as neither passed nor hard', () => {
		const stats = H.computeNodeStats(list, false, { s1: stat(90) }, 80);
		expect(stats.total).toBe(3);
		expect(stats.practiced).toBe(1);
		expect(stats.passed).toBe(1);
		expect(stats.hard).toBe(0);
	});

	it('derives hard when lastScore is below the threshold', () => {
		const stats = H.computeNodeStats(list, false, { s1: stat(79), s2: stat(80) }, 80);
		expect(stats.passed).toBe(1);
		expect(stats.hard).toBe(1);
		expect(stats.dots).toEqual(['hard', 'passed', 'untouched']);
	});

	it('raising passed and lowering hard follows a lowered threshold', () => {
		const stats = { s1: stat(79), s2: stat(85) };
		expect(H.computeNodeStats(list, false, stats, 80).passed).toBe(1);
		expect(H.computeNodeStats(list, false, stats, 70).passed).toBe(2);
		expect(H.computeNodeStats(list, false, stats, 70).hard).toBe(0);
	});

	it('returns dots in order regardless of input order', () => {
		const shuffled = [sent('s3', 3), sent('s1', 1), sent('s2', 2)];
		const stats = H.computeNodeStats(shuffled, false, { s1: stat(90), s3: stat(10) }, 80);
		expect(stats.dots).toEqual(['passed', 'untouched', 'hard']);
	});

	it('returns an empty dots array for a chapter row', () => {
		const stats = H.computeNodeStats(list, true, { s1: stat(90) }, 80);
		expect(stats.dots).toEqual([]);
		expect(stats.passed).toBe(1);
	});

	it('returns empty dots for an empty display set', () => {
		expect(H.computeNodeStats([], false, {}, 80)).toEqual({
			total: 0,
			passed: 0,
			practiced: 0,
			hard: 0,
			avgLastScore: null,
			lastPracticedAt: null,
			dots: []
		});
	});

	it('averages lastScore over practised sentences only', () => {
		const stats = H.computeNodeStats(list, false, { s1: stat(90), s2: stat(70) }, 80);
		expect(stats.avgLastScore).toBe(80);
	});

	it('returns null avgLastScore when nothing was practised', () => {
		expect(H.computeNodeStats(list, false, {}, 80).avgLastScore).toBeNull();
	});

	it('returns the max lastPracticedAt of the display set', () => {
		const stats = H.computeNodeStats(list, false, { s1: stat(90, 1000), s2: stat(90, 5000) }, 80);
		expect(stats.lastPracticedAt).toBe(5000);
	});

	it('ignores orphan stats for sentences that no longer exist', () => {
		const stats = H.computeNodeStats([sent('s1', 1)], false, { s1: stat(90), gone: stat(10, 9000) }, 80);
		expect(stats.total).toBe(1);
		expect(stats.practiced).toBe(1);
		expect(stats.lastPracticedAt).toBe(1000);
	});
});

describe('computeStreak', () => {
	const day = 24 * 60 * 60 * 1000;
	const now = new Date(2026, 9, 1, 12, 0, 0).getTime();

	it('is zero with no stats at all', () => {
		expect(H.computeStreak({}, now)).toEqual({ days: 0, totalAttempts: 0 });
	});

	it('counts a single day as 1', () => {
		expect(H.computeStreak({ a: stat(90, now) }, now).days).toBe(1);
	});

	it('counts consecutive days ending today', () => {
		const stats = { a: stat(90, now), b: stat(90, now - day), c: stat(90, now - 2 * day) };
		expect(H.computeStreak(stats, now).days).toBe(3);
	});

	it('still counts yesterday when nothing was practised today', () => {
		const stats = { a: stat(90, now - day), b: stat(90, now - 2 * day) };
		expect(H.computeStreak(stats, now).days).toBe(2);
	});

	it('breaks on a gap day', () => {
		const stats = { a: stat(90, now), b: stat(90, now - 3 * day) };
		expect(H.computeStreak(stats, now).days).toBe(1);
	});

	it('sums attempts across every stat', () => {
		const stats = { a: stat(90, now, 5), b: stat(90, now, 2) };
		expect(H.computeStreak(stats, now).totalAttempts).toBe(7);
	});
});

describe('formatRelativeDay', () => {
	const day = 24 * 60 * 60 * 1000;
	const now = new Date(2026, 9, 1, 12, 0, 0).getTime();

	it('labels the same calendar day 今日', () => {
		const morning = new Date(2026, 9, 1, 6, 0, 0).getTime();
		expect(H.formatRelativeDay(morning, now)).toBe('今日');
	});

	it('labels the previous day 昨日', () => {
		expect(H.formatRelativeDay(now - day, now)).toBe('昨日');
	});

	it('labels older days N 日前', () => {
		expect(H.formatRelativeDay(now - 3 * day, now)).toBe('3 日前');
	});
});
```

`sent()` / `stat()` ヘルパーが使う型を、`src/lib/history.test.ts` の先頭 import に追加する。
型は値ではないので `H`（動的 import）経由では参照できず、静的 type import が必要になる。
`./history` の型 import は `vi.resetModules()` と干渉しない（型はコンパイル時に消える）。

```ts
import type { Sentence } from './types';
import type { SentenceStat } from './history';
```

- [ ] **Step 3: テストを走らせる**

Run: `npx vitest run src/lib/history.test.ts`
Expected: PASS

- [ ] **Step 4: 型チェック**

Run: `npm run check`
Expected: `svelte-check found 0 errors`

- [ ] **Step 5: コミット**

```bash
git add src/lib/history.test.ts
git commit -m "test(history): cover node stats, streak and relative-day derivations"
```

---

### Task 3: 練習画面からの記録

採点確定点で文統計を書き、開始時刻を 1 つのヘルパーでスタンプし、`onDestroy` でセッションを確定する。`retryFailedOnly()` での再スタンプを忘れない。

**Files:**
- Modify: `src/routes/practice/+page.svelte`

**Interfaces:**
- Consumes: Task 1 の `recordSentenceAttempt(sentenceId, score, at)` / `finalizeSession(record)`
- Produces: なし（ページ内のみ）

- [ ] **Step 1: import を追加する**

`src/routes/practice/+page.svelte:2` 付近の import 群に足す。

```ts
import { recordSentenceAttempt, finalizeSession } from '$lib/history';
```

- [ ] **Step 2: 嘘コメントを削除し、セッション開始時刻の state を足す**

`src/routes/practice/+page.svelte:60-64` の

```ts
	// Session outcome tracking for the summary (memory only, not persisted).
	let endedEarly: boolean = $state(false);
	let passedIds: string[] = $state([]);
	let failedEntries: Sentence[] = $state([]);
```

を

```ts
	let endedEarly: boolean = $state(false);
	let passedIds: string[] = $state([]);
	let failedEntries: Sentence[] = $state([]);

	/** Session start, stamped by beginSession(). Persisted with the session record. */
	let sessionStartedAt: number | null = $state(null);
```

に置き換える。コメントは外す（実装後は嘘になる）。

- [ ] **Step 3: `beginSession()` を足す**

`startSession()`（`:782-785`）の直前に追加する。

```ts
	/**
	 * Stamp the session start. retryFailedOnly() starts a second session inside
	 * the same mount without going through startSession(), so both callers
	 * must re-stamp or the retry's startedAt / durationMs inherit the
	 * previous session's clock.
	 */
	function beginSession(): void {
		sessionStartedAt = Date.now();
	}

	function startSession(): void {
		beginSession();
		sessionReady = true;
		phase = 'show';
	}
```

`startSession` の既存の `sessionReady = true; phase = 'show';` は置き換える（重複させない）。

- [ ] **Step 4: `retryFailedOnly()` で再スタンプする**

`src/routes/practice/+page.svelte:321-333` の `retryFailedOnly` を

```ts
	/** Restart the session with only the sentences that never passed. */
	function retryFailedOnly(): void {
		if (failedEntries.length === 0) return;
		settleSession();
		sentences = [...failedEntries];
		currentIndex = 0;
		resetAttemptState();
		skippedCount = 0;
		totalScore = 0;
		completedCount = 0;
		passedIds = [];
		failedEntries = [];
		endedEarly = false;
		beginSession();
		phase = 'show';
	}
```

に置き換える。`memory only` のコメントは外す。

- [ ] **Step 5: `settleSession()` を定義する**

`retryFailedOnly()` の直後に追加する。

```ts
	/**
	 * Persist the finished session. Called from retryFailedOnly(), from the
	 * summary transition in the progress $effect, and from onDestroy —
	 * onDestroy alone loses a session the user completed and then reloaded,
	 * because a browser reload tears down the realm without running Svelte's
	 * destroy hook. Nulling sessionStartedAt makes every later call a no-op.
	 */
	function settleSession(): void {
		if (sessionStartedAt === null || !sessionNodeId) return;
		if (completedCount === 0) {
			sessionStartedAt = null;
			return;
		}
		const endedAt = Date.now();
		const node =
			tracks.find((t) => t.id === sessionNodeId) ??
			chapters.find((c) => c.id === sessionNodeId) ??
			null;
		finalizeSession({
			nodeId: sessionNodeId,
			nodeName: node?.name ?? '',
			startedAt: sessionStartedAt,
			endedAt,
			durationMs: endedAt - sessionStartedAt,
			attempted: completedCount,
			passedSentences: passedIds.length,
			totalScore,
			skipped: skippedCount,
			endedEarly
		});
		sessionStartedAt = null;
	}
```

`chapters` / `tracks` がpractice ページに存在することを確認すること（`tracks = allTracks` が `:895`、chapters は onMount で読む）。`chapters` を読む変数が無ければ `onMount` で `loadChapters()` して state に入れる。

- [ ] **Step 6: 採点確定点で文統計を記録する**

`src/routes/practice/+page.svelte:747-758` の

```ts
			score = finalScore;
			totalScore += finalScore;
			completedCount++;
			if (finalScore >= threshold) {
				if (!passedIds.includes(s.id)) passedIds.push(s.id);
				failedEntries = failedEntries.filter((entry) => entry.id !== s.id);
			} else {
				if (!failedEntries.some((entry) => entry.id === s.id)) failedEntries.push(s);
			}
```

の `}` の直後（`phase = 'feedback';` の直前）に 1 行足す。

```ts
			recordSentenceAttempt(s.id, finalScore, Date.now());
```

- [ ] **Step 7: summary 到達時と `onDestroy` の両方でセッションを確定する**

**なぜ summary でも確定するのか**: `onDestroy` だけだと、summary に到達してからリロードやタブを
閉じた場合、そのセッションは**永久に失われる**。既存の `$effect` が summary で既に
`clearPracticeProgress()` を呼ぶので、次の mount は `completedCount === 0` で始まり
`settleSession()` のガードが早期 return する。ロードマップ⑤ は PWA (Android)、⑥ はクラウド同期で、
タブを背景に入れるのが既定の挙動なので、これは通常の経路で起きる。

**二重計上は起きない**: `settleSession()` は末尾で `sessionStartedAt = null` にするため、2 回目の
呼び出しは no-op。`retryFailedOnly()` は settle → カウンタリセット → `beginSession()` の順なので、
summary で確定していても正しい。

`src/routes/practice/+page.svelte:2` の import を

```ts
import { onMount, onDestroy } from 'svelte';
```

にし、既存の `$effect`（`phase === 'summary'` で `clearPracticeProgress()` を呼ぶところ）に
`settleSession()` を 1 行足す。

```ts
	$effect(() => {
		if (!sessionReady) return;
		if (phase === 'summary') {
			clearPracticeProgress();
			settleSession();
			return;
		}
```

さらに `onMount` ブロック（`:854-907`）の直後に追加する。

```ts
	// Settled at summary as well: onDestroy alone loses a session the user
	// completed and then reloaded or closed the tab. settleSession() nulls
	// sessionStartedAt, so the second call is a no-op rather than a double count.
	onDestroy(() => {
		settleSession();
	});
```

- [ ] **Step 8: 型チェックとユニットテスト**

Run: `npm run check && npx vitest run`
Expected: `svelte-check found 0 errors`、vitest 全緑

- [ ] **Step 9: E2E で回帰がないことを確認する**

Run: `npx playwright test tests/practice.spec.ts tests/e2e-full.spec.ts --workers=1 --reporter=list`
Expected: 緑（このタスクはトップページ改变をしていないので `top.spec.ts` の文数アサーションはまだ緑）

- [ ] **Step 10: コミット**

```bash
git add src/routes/practice/+page.svelte
git commit -m "feat(practice): record sentence stats and settle the session on unmount"
```

---

### Task 4: トップページの行表示（進捗・ドット）

`statsByNode` を追加し、章行とトラック行を描画し直す。`ownCount()` / `chapterTotal()` は削除する（呼び出し元が無くなる）。

**Files:**
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: Task 1 の `loadHistory()` / `computeNodeStats(...)` / `formatRelativeDay(ts, now)` / `type HistoryData` / `type NodeStats`、Task 1 の `loadSettings()`（既存 `src/lib/settings.ts:73`）
- Produces: なし（ページ内のみ）

- [ ] **Step 1: import と state を追加する**

`src/routes/+page.svelte:1-19` の import / state 群に足す。

```ts
	import { loadHistory, computeNodeStats, formatRelativeDay, type HistoryData, type NodeStats } from '$lib/history';
	import { loadSettings } from '$lib/settings';
```

```ts
	let history = $state<HistoryData>({ version: 1, sessions: [], sentences: {} });
	let threshold = $state(80);
	// Captured once per history load so relative dates do not drift mid-render.
	let nowMs = $state(Date.now());
```

- [ ] **Step 2: 履歴と設定を読む `$effect` を追加する**

`src/routes/+page.svelte:21-25` の `$effect` の直後に追加する。

```ts
	$effect(() => {
		history = loadHistory();
		threshold = loadSettings().threshold;
		nowMs = Date.now();
	});
```

**注意**: 他の `$effect`（`:21-25`）は `chapters` / `sentences` / `tracks` を読むだけなので、この effect は独立してよい。ただし** practise 画面からトップに戻った時に `threshold` が最新になる必要がある**。`/practice` → `/` の遷移は组件を再生成するので effect は再実行される。

- [ ] **Step 3: `statsByNode` を追加する**

`src/routes/+page.svelte:59-61` の `nodeSentences()` の直後に追加する。
**`displaySentencesByNode` のような中間 map は作らない** — `nodeSentences()` が既に
`getNodeSentences` の結果を持つので、サブツリー基準に統一した以上それがそのまま表示集合になる。

```ts
	/**
	 * One aggregation per row, read by every number, percentage and dot.
	 * The display set is getNodeSentences(nodeId) — the same sentences
	 * /practice?node=nodeId walks — so the row's denominator is the real
	 * session length and canPractice() cannot disagree with it.
	 */
	let statsByNode = $derived.by(() => {
		const map = new Map<string, NodeStats>();
		for (const [id, list] of sentencesByNode) {
			map.set(
				id,
				computeNodeStats(list, chapters.some((c) => c.id === id), history.sentences, threshold)
			);
		}
		return map;
	});

	function nodeStats(nodeId: string): NodeStats {
		return (
			statsByNode.get(nodeId) ?? {
				total: 0,
				passed: 0,
				practiced: 0,
				hard: 0,
				avgLastScore: null,
				lastPracticedAt: null,
				dots: []
			}
		);
	}
```

- [ ] **Step 4: `ownCount` / `chapterTotal` を削除する**

`src/routes/+page.svelte:63-71` の 2 関数を丸ごと削除する。マークアップは `progressLabel(nodeStats(id))`
になり `NodeStats.total` が同じ数値を持つので、呼び出し元が無くなる。

`canPractice()`（`:81-83`）は**書き換えない**。`nodeSentences(nodeId).length > 0` は行の `M > 0` と
完全に一致するので、ここも直すと 2 系統になる。

**なぜサブツリーに統一したか**: 传统は章=サブツリー / トラック=直属（`ownCount`）で別 subset だったため、
直属文の無い中間トラックが `0文` の横で練習ボタンを出していた（押すとサブツリー分のセッションが始まる）。
これは AGENTS.md が明文で禁じる「`0文` なのに `練習` ボタン」の矛盾そのもの。
`tests/top.spec.ts:191` が「祖先は全部開始可能」を意図として固定している realistic な入力で起きていた。

- [ ] **Step 5: 表示用の小道具を追加する**

`nodeStats()` の直後に追加する。

```ts
	function percent(part: number, total: number): number {
		return total === 0 ? 0 : Math.round((part / total) * 100);
	}

	/** "0/N 合格 · 87%" — or the plain "N文" when the node holds no sentences. */
	function progressLabel(stats: NodeStats): string {
		if (stats.total === 0) return `${stats.total}文`;
		return `${stats.passed}/${stats.total} 合格 · ${percent(stats.passed, stats.total)}%`;
	}
```

- [ ] **Step 6: トラック行のマークアップを差し替える**

`src/routes/+page.svelte:154-161` の

```svelte
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="truncate text-base font-semibold" data-testid="track-card-name"
							>{track.name}</span
						>
						<span class="text-sm text-muted-foreground" data-testid="track-card-count"
							>{ownCount(track.id)}文</span
						>
					</div>
```

を

```svelte
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="truncate text-base font-semibold" data-testid="track-card-name"
							>{track.name}</span
						>
						<span class="truncate text-sm text-muted-foreground" data-testid="track-card-count"
							>{progressLabel(nodeStats(track.id))}</span
						>
						<div
							class="flex flex-wrap gap-[3px]"
							role="img"
							aria-label={`合格 ${nodeStats(track.id).passed} 文 / 苦手 ${nodeStats(track.id).hard} 文 / 未着手 ${nodeStats(track.id).total - nodeStats(track.id).practiced} 文`}
							data-testid="track-dots"
						>
							{#each nodeStats(track.id).dots as dot, i (i)}
								<span
									class="size-[7px] rounded-[2px] bg-border"
									class:bg-success={dot === 'passed'}
									class:bg-amber-500={dot === 'hard'}
									data-dot={dot}
								></span>
							{/each}
						</div>
						{#if nodeStats(track.id).practiced > 0}
							<span class="text-sm text-muted-foreground" data-testid="track-last">
								最終 {formatRelativeDay(nodeStats(track.id).lastPracticedAt ?? nowMs, nowMs)}
							</span>
						{/if}
					</div>
```

に置き換える。

- [ ] **Step 7: 章行のマークアップを差し替える**

`src/routes/+page.svelte:204-214` の

```svelte
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="chapter-name truncate text-base font-semibold">{chapter.name}</span>
						<div class="flex items-center gap-1.5">
							{#each chapterLanguages(chapter.id) as lang (lang)}
								{@render languageBadge(lang)}
							{/each}
							<span class="text-sm text-muted-foreground" data-testid="chapter-card-count"
								>{chapterTotal(chapter.id)}文</span
							>
						</div>
					</div>
```

を

```svelte
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="chapter-name truncate text-base font-semibold">{chapter.name}</span>
						<div class="flex items-center gap-1.5 overflow-hidden">
							{#each chapterLanguages(chapter.id) as lang (lang)}
								{@render languageBadge(lang)}
							{/each}
							<span
								class="truncate text-sm text-muted-foreground"
								data-testid="chapter-card-count">{progressLabel(nodeStats(chapter.id))}</span
							>
						</div>
						<div
							class="h-1 w-full overflow-hidden rounded-full bg-border"
							aria-hidden="true"
							data-testid="chapter-progress"
						>
							<div
								class="h-full rounded-full bg-success"
								style:width={`${percent(nodeStats(chapter.id).passed, nodeStats(chapter.id).total)}%`}
							></div>
						</div>
						{#if nodeStats(chapter.id).practiced > 0}
							<span class="truncate text-sm text-muted-foreground" data-testid="chapter-last">
								最終 {formatRelativeDay(nodeStats(chapter.id).lastPracticedAt ?? nowMs, nowMs)} · 苦手 {nodeStats(chapter.id).hard} 文
							</span>
						{/if}
					</div>
```

に置き換える。

- [ ] **Step 8: 型チェック**

Run: `npm run check`
Expected: `svelte-check found 0 errors`

**`{@const}` を使わない**: Svelte 5 の `{@const}` は `{#each}` / `{#if}` / `{#snippet}` / `{#key}` の
**直下**にのみ置ける。Step 6/7 のように通常の `<div>` の最初の子に置くとコンパイルエラーになるので、
`nodeStats(track.id)` / `nodeStats(chapter.id)` を**直接呼び出す**。`nodeStats()` は `Map.get` 1 回だけなので
呼び出しコストは無視できる。

- [ ] **Step 9: 390px のスクショダンプと dumped DOM で検証する**

目視はできないので、机械的に検証できる形に変換する。`dev` サーバーを起動し、
Playwright で 390×844 のスクリーンショットを**ワークスペースにダンプ**し、
ついでに描画後の DOM を JSON でダンプして、行high-level な構造を検証する。

`/tmp/opencode` を作業ディレクトリに使ってよい（使い捨て）。 dumped ファイルは
`.superpowers/sdd/2026-10-01-practice-history/` 配下に置く（git-ignored）。

种子（既定データは各章 10 文、track は `tr-ch-ja-01` / `tr-ch-en-01`）:

```js
{
  "version": 1,
  "sessions": [],
  "sentences": {
    "ja-01-1": { "attempts": 2, "lastScore": 92, "lastPracticedAt": 1757000000000 },
    "ja-01-2": { "attempts": 1, "lastScore": 55, "lastPracticedAt": 1756600000000 },
    "ja-01-3": { "attempts": 1, "lastScore": 10, "lastPracticedAt": 1756600000000 }
  }
}
```

`.superpowers/sdd/2026-10-01-practice-history/dump-top.mjs` に次を書く（`playwright` はプロジェクトに既に依存として入ってる）:

```js
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '.superpowers/sdd/2026-10-01-practice-history';
mkdirSync(OUT, { recursive: true });
const HISTORY = {
  version: 1,
  sessions: [],
  sentences: {
    'ja-01-1': { attempts: 2, lastScore: 92, lastPracticedAt: 1757000000000 },
    'ja-01-2': { attempts: 1, lastScore: 55, lastPracticedAt: 1756600000000 },
    'ja-01-3': { attempts: 1, lastScore: 10, lastPracticedAt: 1756600000000 }
  }
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.evaluate((h) => localStorage.setItem('oboeru:history:v1', JSON.stringify(h)), HISTORY);
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="chapter-card"]');

const dump = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="chapter-card"], [data-testid="track-card"]')].map((card) => {
    const name = card.querySelector('[data-testid="track-card-name"], .chapter-name')?.textContent?.trim() ?? '';
    const count = card.querySelector('[data-testid="chapter-card-count"], [data-testid="track-card-count"]')?.textContent?.trim() ?? null;
    const last = card.querySelector('[data-testid="chapter-last"], [data-testid="track-last"]')?.textContent?.trim() ?? null;
    const bar = card.querySelector('[data-testid="chapter-progress"]');
    const dots = [...(card.querySelector('[data-testid="track-dots"]')?.children ?? [])].map((el) => el.getAttribute('data-dot'));
    return { name, count, last, barWidth: bar ? getComputedStyle(bar.firstElementChild).width : null, dots };
  });
  return { rows, streak: document.querySelector('[data-testid="streak-pill"]')?.textContent?.trim() ?? null };
});
writeFileSync(`${OUT}/task4-top-dump.json`, JSON.stringify(dump, null, 2));
const main = await page.$('main');
await main.screenshot({ path: `${OUT}/task4-top-390.png` });
console.log(JSON.stringify(dump, null, 2));
await browser.close();
```

Run: `node .superpowers/sdd/2026-10-01-practice-history/dump-top.mjs`（`npm run dev` を別ターミナルで起動済みである必要あり）

Expected（ dumped JSON で確認すること）:

- 2 章が `0/10 合格 · 0%` ではなく **`1/10 合格 · 10%`** になる（`ja-01-1` の `lastScore: 92 >= 80`）
- `ja-01-1` / `ja-01-2` / `ja-01-3` を含むトラックの行に `dots` が **`["passed", "hard", "hard", ...未着手×7]`** で、
  `ja-01-1` に対応する index が先頭（`order` 昇順）
- `last` が `最終 1 日前` のような相対表記になっている
- 章の行に `dots` が**無い**（空配列）— 章は集約
- `barWidth` が章行だけ非空で `0%` より大きい
- スクリーンショットが 390px 幅で生成されている

**`ja-01-*` の id が既定データに存在しない場合**、dots が全部 `untouched` になるのが正しい。
その場合は `src/lib/default-sentences.ts` を読んで**実在する文 id** に差し替えて再実行する
（このチェック自体が「`stats` に無い文は `untouched`」という契約の検証になる）。

写真は目視できないので、**dumped JSON の値を上記の Expected と 1 項目ずつ照合**すること。
差異があれば実装を直す。

- [ ] **Step 10: 既存 E2E の失敗を確認する（预期的）**

Run: `npx playwright test tests/top.spec.ts --workers=1 --reporter=list`
Expected: `shows sentence count per chapter` / `chapter count aggregates descendant tracks…` が**赤**（`10文` / `2文` / `1文` が見つからない）。Task 6 で直す。

- [ ] **Step 11: コミット**

```bash
git add src/routes/+page.svelte
git commit -m "feat(top): show per-node progress, weak-sentence dots and last-practice day"
```

---

### Task 5: ストリークピルと履歴セクション

`computeStreak` の結果をピルに出し、ページ最下部に折りたたみ可能なセッションログを出す。

**Files:**
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: Task 1 の `computeStreak(stats, now)` / `getSessions(limit)` / `loadHistoryUiState()` / `saveHistoryUiState(state)` / `type SessionRecord`
- Produces: なし（ページ内のみ）

- [ ] **Step 1: state を追加する**

Task 4 の state 群に足す。

```ts
	let streak = $state({ days: 0, totalAttempts: 0 });
	let historyOpen = $state(false);
	let historyLimit = $state(20);
```

- [ ] **Step 2: 履歴を読む `$effect` を Task 4 の effect に足す**

Task 4 Step 2 の effect を

```ts
	$effect(() => {
		history = loadHistory();
		threshold = loadSettings().threshold;
		nowMs = Date.now();
		streak = computeStreak(history.sentences, nowMs);
		historyOpen = loadHistoryUiState().open;
	});
```

に置き換える。import に `computeStreak` / `getSessions` / `loadHistoryUiState` / `saveHistoryUiState` / `type SessionRecord` を追加する。

- [ ] **Step 3: 開閉と Helpers を実装する**

`progressLabel()`（Task 4 Step 5）の直後に追加する。

```ts
	function toggleHistory(): void {
		historyOpen = !historyOpen;
		saveHistoryUiState({ open: historyOpen });
	}

	function showMoreHistory(): void {
		historyLimit += 20;
	}

	/** Current name when the node still exists, otherwise the captured one. */
	function sessionNodeName(record: SessionRecord): string {
		const live =
			tracks.find((t) => t.id === record.nodeId)?.name ??
			chapters.find((c) => c.id === record.nodeId)?.name;
		if (live) return live;
		return record.nodeName ? `${record.nodeName} (削除済み)` : '(削除済み)';
	}

	function sessionAverage(record: SessionRecord): number {
		return record.attempted > 0 ? Math.round(record.totalScore / record.attempted) : 0;
	}

	function formatStamp(ts: number): string {
		const d = new Date(ts);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
```

- [ ] **Step 4: ストリークピルを `<h1>` の直後に差し込む**

`src/routes/+page.svelte:108-109` の

```svelte
<h1 class="mb-1 text-2xl font-bold">おぼえる</h1>
<p class="mb-6 text-sm text-muted-foreground">カードの練習ボタンですぐに開始できます</p>
```

を

```svelte
<h1 class="mb-1 text-2xl font-bold">おぼえる</h1>
<p class="mb-6 text-sm text-muted-foreground">カードの練習ボタンですぐに開始できます</p>

{#if streak.totalAttempts > 0}
	<p
		class="mb-4 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border px-4 text-sm text-muted-foreground"
		data-testid="streak-pill"
	>
		連続 {streak.days} 日 · のべ {streak.totalAttempts} 文
	</p>
{/if}
```

に置き換える。`min-h-11`（44px）は `expectTapTargets` の対象ではないが（`<p>` なので）、見た目の下限として無害（`<p>` なので `expectTapTargets` の対象外）。

- [ ] **Step 5: 履歴セクションを `{#if chapters.length === 0}` の `{:else}` ブロック末尾に足す**

`src/routes/+page.svelte` の `{:else}` ブロック内で `</div>`（`.chapter-tree` の閉じタグ）の**後**に差し込む。

```svelte
		{#if history.sessions.length > 0}
			{@const visible = getSessions(historyLimit)}
			<section class="mt-6 border-t border-border pt-4" data-testid="history-section">
				<h2>
					<button
						type="button"
						class="flex min-h-11 w-full items-center gap-2 text-left text-base font-semibold"
						aria-expanded={historyOpen}
						aria-controls="history-log"
						onclick={toggleHistory}
						data-testid="history-toggle"
					>
						<ChevronRight
							class="h-5 w-5 transition-transform"
							class:rotate-90={historyOpen}
						/>
						練習履歴 ({history.sessions.length})
					</button>
				</h2>
				{#if historyOpen}
					<div id="history-log" class="flex flex-col gap-1 pt-2" data-testid="history-log">
						{#each visible as record (record.id)}
							<p class="text-sm text-muted-foreground" data-testid="history-item">
								{formatStamp(record.startedAt)} · {sessionNodeName(record)} ·
								{record.passedSentences} 文 合格 · 平均 {sessionAverage(record)}% ·
								スキップ {record.skipped}{record.endedEarly ? ' · 途中で終了' : ''}
							</p>
						{/each}
						{#if visible.length < history.sessions.length}
							<button
								type="button"
								class="mt-2 inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm"
								onclick={showMoreHistory}
								data-testid="history-more"
							>
								さらに表示 (残り {history.sessions.length - visible.length} 件)
							</button>
						{/if}
					</div>
				{/if}
			</section>
		{/if}
```

**注意**: `{@const}` は `{#if}` の直下でのみ有効なので、`{#if history.sessions.length > 0}` の**最初の子**として置く（`{@const}` は block の子でのみ有効）。`{#each}` の key は `record.id`。

**設置位置（重要）**: `{#if chapters.length === 0} … {:else} … {/if}` の**外側**、`{/if}` の直後（`</main>` の前）に置く。`{:else}` ブロック内に入れると、章を全削除した瞬間に履歴セクションまで消えてしまう（履歴は章とは独立に存在するため）。

- [ ] **Step 6: 型チェック**

Run: `npm run check`
Expected: `svelte-check found 0 errors`

- [ ] **Step 7: 390px のスクショダンプと dumped DOM で検証する**

Task 4 Step 9 と同じ方式。`.superpowers/sdd/2026-10-01-practice-history/dump-history.mjs` を書き、**ピル / 履歴セクション /
展開状態 / 削除済みノードの表示 / さらに表示** を dumped JSON で検証する。

```js
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '.superpowers/sdd/2026-10-01-practice-history';
mkdirSync(OUT, { recursive: true });
const now = Date.now();
const day = 86400000;
const HISTORY = {
  version: 1,
  sentences: { 'ja-01-1': { attempts: 3, lastScore: 90, lastPracticedAt: now } },
  sessions: Array.from({ length: 25 }, (_, i) => ({
    id: 'sess' + i,
    nodeId: 'nonexistent',
    nodeName: '消えた章',
    startedAt: now - i * day,
    endedAt: now - i * day,
    durationMs: 30000,
    attempted: 10,
    passedSentences: 8,
    totalScore: 870,
    skipped: 1,
    endedEarly: i % 3 === 0
  }))
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.evaluate((h) => localStorage.setItem('oboeru:history:v1', JSON.stringify(h)), HISTORY);
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="chapter-card"]');

const snap = async (label) => {
  const d = await page.evaluate(() => ({
    streak: document.querySelector('[data-testid="streak-pill"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    toggle: document.querySelector('[data-testid="history-toggle"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    expanded: document.querySelector('[data-testid="history-toggle"]')?.getAttribute('aria-expanded') ?? null,
    items: [...document.querySelectorAll('[data-testid="history-item"]')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
    more: document.querySelector('[data-testid="history-more"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  }));
  return { label, ...d };
};

const steps = [];
steps.push(await snap('initial (collapsed)'));
await page.getByTestId('history-toggle').click();
steps.push(await snap('after open'));
await page.reload();
steps.push(await snap('after reload (state remembered)'));
await page.getByTestId('history-more').click();
steps.push(await snap('after さらに表示'));

writeFileSync(`${OUT}/task5-history-dump.json`, JSON.stringify(steps, null, 2));
const main = await page.$('main');
await main.screenshot({ path: `${OUT}/task5-top-390.png` });
console.log(JSON.stringify(steps, null, 2));
await browser.close();
```

Run: `node .superpowers/sdd/2026-10-01-practice-history/dump-history.mjs`

Expected（dumped JSON を 1 項目ずつ照合）:

- `initial`: `streak` が `連続 1 日 · のべ 3 文` / `toggle` が `練習履歴 (25)` /
  `expanded` が `"false"` / `items` が**空配列** / `more` が `null`
- `after open`: `expanded` が `"true"` / `items.length === 20` / `more` が `さらに表示 (残り 5 件)`
- `after reload`: `expanded` が**依然 `"true"`**（開閉状態の永続化）、`items.length === 20`
- `after さらに表示`: `items.length === 25` / `more` が `null`
- 全 `items` に `消えた章 (削除済み)` が含まれる（現在存在しないノードなので解決失敗）
- `i % 3 === 0` の行に `途中で終了` が付き、他には付かない

**さらに**、履歴セクションの表示ノードを消したケース（`nodeId: 'ja-01'` など実在する id に
1 件だけ差し替えたダンプ）を 1 回書き、`nodeName` ではなく**現在の名前**が出ることを確認する。

写真は目視できないので、**dumped JSON の値を上記の Expected と 1 項目ずつ照合**すること。

- [ ] **Step 8: コミット**

```bash
git add src/routes/+page.svelte
git commit -m "feat(top): add streak pill and collapsible session history"
```

---

### Task 6: 既存 E2E のアサーション更新

`32文` → `N/M 合格 · X%` の変更で必ず落ちる 5 アサーションを、正当な新フォーマットへ更新する。

**Files:**
- Modify: `tests/top.spec.ts:52,158-160`
- Modify: `tests/e2e-full.spec.ts:215`

**Interfaces:**
- Consumes: Task 4 の表示フォーマット
- Produces: なし（テストのみ）

- [ ] **Step 1: `tests/top.spec.ts:50-53` を更新する**

```ts
	test('shows sentence count per chapter', async ({ page }) => {
		await page.goto('/');
		// Each default chapter has 10 sentences, none practised yet.
		await expect(page.getByText('0/10 合格 · 0%').first()).toBeVisible();
	});
```

- [ ] **Step 2: `tests/top.spec.ts:149-161` を更新する**

```ts
	test('chapter count aggregates descendant tracks while a track row shows its own count', async ({
		page
	}) => {
		await gotoWithSeed(page, NESTED_TRACK_SEED);

		// Chapter 1章: 1 (トラック1) + 1 (トラック1-1) = 2. Descendants are NOT
		// double counted on the track row itself.
		await expect(
			page.getByTestId('chapter-card').filter({ hasText: '1章' }).getByTestId('chapter-card-count')
		).toContainText('0/2 合格');
		await expect(trackCard(page, 'トラック1-1').getByTestId('track-card-count')).toContainText('0/1 合格');
		await expect(trackCard(page, 'トラック1').getByTestId('track-card-count')).toContainText('0/2 合格');
	});
```

**重要 — このテストは意図反转している**: トラック1 は自分の文 1 文 + 子トラックの 1 文 = **2**。
旧設計（トラック=直属）は `0/1 合格` を assert していたが、それは行の `M` が実際のセッション長と
食い違っていた（`トラック1` を押すと 2 文のセッションが始まる）。サブツリー基準に統一したので
`0/2 合格` が正。**テスト名とコメントも正確に直す**（Assert 弱化ではなく、意図的に変えた挙動の反映）:

```ts
	test('every row counts the subtree it would actually practise', async ({ page }) => {
		await gotoWithSeed(page, NESTED_TRACK_SEED);

		// 1章 = 1 (トラック1) + 1 (トラック1-1) = 2.
		// トラック1 = its own 1 + its child's 1 = 2 — the session started from
		// トラック1 really does walk both sentences.
		// トラック1-1 = 1 (leaf).
		await expect(
			page.getByTestId('chapter-card').filter({ hasText: '1章' }).getByTestId('chapter-card-count')
		).toContainText('0/2 合格');
		await expect(trackCard(page, 'トラック1-1').getByTestId('track-card-count')).toContainText('0/1 合格');
		await expect(trackCard(page, 'トラック1').getByTestId('track-card-count')).toContainText('0/2 合格');
	});
```

さらに `tests/top.spec.ts:191` の `a track is startable when only a descendant track holds sentences` に
**行の文言のアサーションを追加**する（現状はボタンの数しか見ていないので、今回の矛盾が再発しても
テストは緑のまま）:

```ts
		// Subtree-based, not own-sentence-based: every ancestor of the sentence
		// (the leaf, the empty intermediate track, the chapter) is startable.
		await expect(page.getByTestId('chapter-card').getByTestId('card-start')).toHaveCount(1);
		await expect(trackCard(page, '文のないトラック').getByTestId('card-start')).toHaveCount(1);
		await expect(trackCard(page, '孫のトラック').getByTestId('card-start')).toHaveCount(1);

		// And the empty intermediate track must not read "0文" next to a live
		// button — its subtree holds s2, so the session started from it is 1 long.
		await expect(trackCard(page, '文のないトラック').getByTestId('track-card-count')).toContainText(
			'0/1 合格'
		);
	});

**注意**: `toHaveText` ではなく `toContainText` を使う。章行の `chapter-card-count` は言語バッジと同じ `flex` コンテナ内にあり、`toHaveText` は完全一致を要求するため。

- [ ] **Step 3: `tests/e2e-full.spec.ts:213-216` を更新する**

```ts
	// Cross-page state: the created sentence counts toward the new chapter
	const e2eChapter = page.getByTestId('chapter-card').filter({ hasText: 'E2Eチャプター' });
	await expect(e2eChapter).toContainText('0/1 合格');
```

- [ ] **Step 4: 2 つの spec を走らせる**

Run: `npx playwright test tests/top.spec.ts tests/e2e-full.spec.ts --workers=1 --reporter=list`
Expected: 緑

- [ ] **Step 5: コミット**

```bash
git add tests/top.spec.ts tests/e2e-full.spec.ts
git commit -m "test(top): update sentence-count assertions to the progress format"
```

---

### Task 7: 履歴シード済みトップページの a11y スキャン

既存 `tests/a11y.spec.ts:281-295` のトップスキャンは `gotoWithSeed(page, SEED)` でしかシードせず、履歴を一切持たないため**新 UI が一度も axe に掛からない**。履歴をシードした状態のスキャンを追加する。

**Files:**
- Modify: `tests/helpers.ts`
- Modify: `tests/a11y.spec.ts`

**Interfaces:**
- Consumes: Task 4 / Task 5 の UI
- Produces: `tests/helpers.ts` の `seedHistory(page, data)`

- [ ] **Step 1: `tests/helpers.ts` に `seedHistory` を追加する**

`src/tests/helpers.ts` 末尾（`gotoWithSeed` の閉じ括弧の後）に追加する。`tests/helpers.ts:7-18` の `gotoWithSeed` は `oboeru:v1` しか書かないので、履歴キーは別 함수で扱う。

```ts
/** Write raw history payloads (the practice screen owns the real shape). */
export async function seedHistory(
	page: Page,
	history: unknown,
	ui?: unknown
): Promise<void> {
	await page.evaluate(
		({ h, u }) => {
			if (h !== null) localStorage.setItem('oboeru:history:v1', JSON.stringify(h));
			if (u !== null) localStorage.setItem('oboeru:history-ui:v1', JSON.stringify(u));
		},
		{ h: history, u: ui ?? null }
	);
	await page.reload();
}
```

**注意**: `gotoWithSeed` は**既にリロードする**ので、呼び順は `await gotoWithSeed(page, SEED); await seedHistory(page, HISTORY_SEED, { open: true });`（`seedHistory` 自身が最後のリロード擔う）。

- [ ] **Step 2: `tests/a11y.spec.ts` に履歴シードを足す**

`tests/a11y.spec.ts:28-37` の `SEED` の直後に追加する。

```ts
/**
 * The top-page scan above seeds only oboeru:v1, so the progress bars, dot
 * rows, streak pill and history section never reach axe. Seed a history too.
 */
const HISTORY_SEED = {
	version: 1,
	sessions: [
		{
			id: 'sess-1',
			nodeId: 'child-1',
			nodeName: '子チャプター',
			startedAt: Date.now() - 86_400_000,
			endedAt: Date.now() - 86_400_000 + 30_000,
			durationMs: 30_000,
			attempted: 2,
			passedSentences: 1,
			totalScore: 170,
			skipped: 0,
			endedEarly: false
		},
		{
			id: 'sess-2',
			nodeId: 'deleted-node',
			nodeName: '消した章',
			startedAt: Date.now() - 172_800_000,
			endedAt: Date.now() - 172_800_000 + 12_000,
			durationMs: 12_000,
			attempted: 1,
			passedSentences: 0,
			totalScore: 40,
			skipped: 1,
			endedEarly: true
		}
	],
	sentences: {
		's-1': { attempts: 2, lastScore: 92, lastPracticedAt: Date.now() - 86_400_000 },
		's-2': { attempts: 1, lastScore: 45, lastPracticedAt: Date.now() - 86_400_000 }
	}
};
```

- [ ] **Step 3: スキャンテストを追加する**

`tests/a11y.spec.ts` の `test('top page (seeded) — light & dark + card ▶ 44px', ...)` の直後に追加する。

```ts
	test('top page (history seeded, section open) — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(page, HISTORY_SEED, { open: true });
		await expect(page.getByTestId('history-log')).toBeVisible();

		await expectNoSeriousCritical(page, '/ history light');
		await expectTapTargets(page, '/ history light');

		await page.emulateMedia({ colorScheme: 'dark' });
		await page.reload();
		await expect(page.getByTestId('history-log')).toBeVisible();
		await expectNoSeriousCritical(page, '/ history dark');
		await expectTapTargets(page, '/ history dark');
	});
```

import に `seedHistory` を追加する（`tests/a11y.spec.ts:4` の `import { gotoWithSeed } from './helpers';` を `import { gotoWithSeed, seedHistory } from './helpers';` に変更）。

- [ ] **Step 4: a11y spec を走らせる**

Run: `npx playwright test tests/a11y.spec.ts --workers=1 --reporter=list`
Expected: 緑。新テストで `expectTapTargets` が 44px 未満を報告したら、Step 3 で足した `min-h-11` が効いていない（`p` は対象外だが `button` は対象）。該当 buttons を 44px 以上にする。

- [ ] **Step 5: コミット**

```bash
git add tests/helpers.ts tests/a11y.spec.ts
git commit -m "test(a11y): scan the top page with a seeded practice history"
```

---

### Task 8: 履歴 UI の E2E

実際の練習を通して、記録が最後まで繋がることを確認する。localStorage の直接シードではなく**練習を 1 回完走する**ことを主経路にする。

**Files:**
- Create: `tests/history.spec.ts`

**Interfaces:**
- Consumes: Task 3 の記録、Task 4/5 の UI、`tests/helpers.ts` の `gotoWithSeed` / `seedHistory`
- Produces: なし（テストのみ）

- [ ] **Step 1: E2E スケルトンを書く**

`tests/history.spec.ts` を新規作成する。`tests/practice.spec.ts` の `mockTranscribe`（既定で `mockJudgeFallback` 適用済み）を使う。

```ts
import { test, expect } from './fixtures';
import { gotoWithSeed, seedHistory } from './helpers';
import { mockTranscribe } from './tts-mock';

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

test.describe('Practice history', () => {
	test('a completed session lands on the top page as progress and one log row', async ({
		page
	}) => {
		await mockTranscribe(page, { 'あああ': 'あああ', 'いいい': 'いいい' });
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible();

		for (let i = 0; i < 2; i++) {
			await page.keyboard.down('Space');
			await page.waitForTimeout(900);
			await page.keyboard.up('Space');
			await expect(page.getByTestId('feedback')).toBeVisible();
			await page.keyboard.press('Space');
		}
		await expect(page.getByTestId('summary')).toBeVisible();
		await page.keyboard.up('Space');

		await page.goto('/');
		await expect(page.getByTestId('chapter-card-count').first()).toContainText('2/2 合格');
		await expect(page.getByTestId('chapter-progress').first()).toBeVisible();
		await expect(page.getByTestId('streak-pill')).toContainText('連続 1 日');
		await expect(page.getByTestId('history-toggle')).toContainText('練習履歴 (1)');

		await page.getByTestId('history-toggle').click();
		await expect(page.getByTestId('history-item')).toHaveCount(1);
		await expect(page.getByTestId('history-item').first()).toContainText('2 文 合格');
	});

	test('track rows render one dot per subtree sentence in practice order', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(page, {
			version: 1,
			sessions: [],
			sentences: {
				's-2': { attempts: 1, lastScore: 40, lastPracticedAt: Date.now() },
				's-1': { attempts: 2, lastScore: 95, lastPracticedAt: Date.now() }
			}
		});

		const dots = page.getByTestId('track-card').filter({ hasText: 'トラック1' }).getByTestId('track-dots').locator('span');
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
		// from it really does run one sentence.
		const row = page.getByTestId('track-card').filter({ hasText: '空のトラック' });
		await expect(row.getByTestId('card-start')).toHaveCount(1);
		await expect(row.getByTestId('track-card-count')).toContainText('0/1 合格');
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
		await expect(page.getByTestId('chapter-card-count').first()).toContainText('0/2 合格');

		await page.evaluate(() => {
			localStorage.setItem('oboeru:settings:v1', JSON.stringify({ threshold: 60, ttsRate: 1, voiceURI: null, retryFrom: 'tts' }));
		});
		await page.reload();
		await expect(page.getByTestId('chapter-card-count').first()).toContainText('2/2 合格');
	});

	test('the history section stays open across a reload', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{
				version: 1,
				sessions: [
					{
						id: 'a', nodeId: 'ch-1', nodeName: '1章',
						startedAt: Date.now(), endedAt: Date.now(), durationMs: 1000,
						attempted: 1, passedSentences: 1, totalScore: 90, skipped: 0, endedEarly: false
					}
				],
				sentences: {}
			},
			{ open: true }
		);
		await expect(page.getByTestId('history-log')).toBeVisible();
		await page.reload();
		await expect(page.getByTestId('history-log')).toBeVisible();
	});

	test('a deleted node keeps its captured name in the log', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await seedHistory(
			page,
			{
				version: 1,
				sessions: [
					{
						id: 'a', nodeId: 'gone', nodeName: '消した章',
						startedAt: Date.now(), endedAt: Date.now(), durationMs: 1000,
						attempted: 1, passedSentences: 0, totalScore: 30, skipped: 0, endedEarly: true
					}
				],
				sentences: {}
			},
			{ open: true }
		);
		await expect(page.getByTestId('history-item').first()).toContainText('消した章 (削除済み)');
		await expect(page.getByTestId('history-item').first()).toContainText('途中で終了');
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
		await expect(page.getByTestId('chapter-card-count').first()).toContainText('0文');
	});
});
```

**Task 3 のレビューで追加された必須アサーション（レビューで欠落と判定された 3 件）** —
これらは `practice/+page.svelte` の `settleSession()` / `beginSession()` / `nodeName` 経路に対する
**唯一のカバレッジ**。どれか 1 行を削除しても現状の全スイートは緑のままなので、**このタスクで初めて固定する**。

```ts
	test('the retry-failed session re-stamps startedAt instead of inheriting the old clock', async ({
		page
	}) => {
		// Arrange: finish a session with ONE failure so 間違えた文だけやり直す appears.
		await mockTranscribe(page, { 'あああ': 'あああ', 'いいい': 'alas' });
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible();

		for (let i = 0; i < 2; i++) {
			await page.keyboard.down('Space');
			await page.waitForTimeout(900);
			await page.keyboard.up('Space');
			await expect(page.getByTestId('feedback')).toBeVisible();
			await page.keyboard.press('Space');
		}
		await expect(page.getByTestId('summary')).toBeVisible();
		await page.keyboard.up('Space');

		// Act: restart with only the failed sentence, then finish it after a real delay.
		await page.waitForTimeout(1500);
		await page.getByTestId('retry-failed-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible();
		await page.keyboard.down('Space');
		await page.waitForTimeout(900);
		await page.keyboard.up('Space');
		await expect(page.getByTestId('feedback')).toBeVisible();
		await page.keyboard.press('Space');
		await expect(page.getByTestId('summary')).toBeVisible();
		await page.keyboard.up('Space');

		// Assert: TWO session rows exist, and the retry's startedAt is ~1.5s later
		// than the first session's — not a copy of it.
		const records = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('oboeru:history:v1') ?? '{}').sessions ?? []
		);
		expect(records).toHaveLength(2);
		expect(records[0].startedAt).toBeGreaterThan(records[1].startedAt);
		expect(records[0].startedAt - records[1].startedAt).toBeGreaterThan(1000);
	});

	test('a chapter-started session records the chapter name', async ({ page }) => {
		await mockTranscribe(page, { 'あああ': 'あああ', 'いいい': 'いいい' });
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible();

		for (let i = 0; i < 2; i++) {
			await page.keyboard.down('Space');
			await page.waitForTimeout(900);
			await page.keyboard.up('Space');
			await expect(page.getByTestId('feedback')).toBeVisible();
			await page.keyboard.press('Space');
		}
		await expect(page.getByTestId('summary')).toBeVisible();
		await page.keyboard.up('Space');

		const records = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('oboeru:history:v1') ?? '{}').sessions ?? []
		);
		expect(records).toHaveLength(1);
		expect(records[0].nodeId).toBe('ch-1');
		expect(records[0].nodeName).toBe('1章');
	});
```

**追加した assertion（summary 確定の分）**: summary 到達後にリロードしてから
`oboeru:history:v1` を読み、**セッション行が残っている**ことを確認する。これは Task 3 の
「summary でも確定」追加（`$effect` 内の `settleSession()`）の 1 行を削除しても
緑のままになるため、同じ理由でここで固定する。

```ts
	test('a session survives a reload after reaching summary', async ({ page }) => {
		await mockTranscribe(page, { 'あああ': 'あああ', 'いいい': 'いいい' });
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?node=ch-1');
		await expect(page.getByTestId('record-ready')).toBeVisible();
		for (let i = 0; i < 2; i++) {
			await page.keyboard.down('Space');
			await page.waitForTimeout(900);
			await page.keyboard.up('Space');
			await expect(page.getByTestId('feedback')).toBeVisible();
			await page.keyboard.press('Space');
		}
		await expect(page.getByTestId('summary')).toBeVisible();
		await page.keyboard.up('Space');

		await page.reload();
		const records = await page.evaluate(() =>
			JSON.parse(localStorage.getItem('oboeru:history:v1') ?? '{}').sessions ?? []
		);
		expect(records).toHaveLength(1);
		expect(records[0].attempted).toBe(2);
	});
```

**注意**: `mockTranscribe` のシグネチャと `record-ready` / `feedback` / `summary` の testid は `tests/practice.spec.ts` の実物に合わせて調整すること。`tests/practice.spec.ts` の `holdAndRelease` ヘルパー（保持 ≥ 0.7s、`keyboard.up` 前に `keyboard.up('Space')` を必ず呼ぶ）があればそれを使う。**リロード前に `keyboard.up('Space')` を呼ぶこと**（押しっぱなしだと次の down が `event.repeat=true` になり repeat ガードに握り潰される）。`record-ready` の可視待ちを最初の Space keydown の前に必ず入れること（hydration 前に発火した keydown はワンショットで消える）。

- [ ] **Step 2: 走らせて失敗を確認する**

Run: `npx playwright test tests/history.spec.ts --workers=1 --reporter=list`
Expected: 新機能が未実装なので失敗する。`mockTranscribe` のシグネチャや testid の食い違いがあれば `tests/practice.spec.ts` の実物を参照して合わせる。

- [ ] **Step 3: 全部緑にする**

Run: `npx playwright test tests/history.spec.ts --workers=1 --reporter=list`
Expected: 全緑

- [ ] **Step 4: フルスイートを走らせる**

Run: `npx playwright test --workers=1 --reporter=list`
Expected: 全緑。`tests/practice.spec.ts`（〜:153）と full-flow は並列負荷で稀にフレーキーなので `--workers=1` で確定させる。

- [ ] **Step 5: コミット**

```bash
git add tests/history.spec.ts
git commit -m "test(history): cover progress, dots, threshold, streak and the session log"
```

---

### Task 9: AGENTS.md の更新

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: 全タスク
- Produces: なし（ドキュメント）

- [ ] **Step 1: ディレクトリ地図に `history.ts` を追記する**

`AGENTS.md` のディレクトリ地図で `src/lib/practice-progress.ts` の項目の直後に追加する。

```md
- `src/lib/history.ts` — **練習履歴の永続化 + 集計** (キー `oboeru:history:v1` = `{version:1, sessions, sentences}`、UI 状態は別キー `oboeru:history-ui:v1`)。`loadHistory` / `recordSentenceAttempt` / `finalizeSession` / `getSessions` と、純関数 `computeNodeStats` / `computeStreak` / `formatRelativeDay`。**全操作が `try/catch` で自前のエラーを握り潰す** (プライベートモードでも練習は動く)。`loadHistory()` は常にストレージから読む (キャッシュを返さない — テストが localStorage を直接シードして検証できるようにするため)。キャッシュは write 経路だけが使う (1 文ごとに parse+stringify すると約 9ms、165KB で 1 フレームの半分)
```

- [ ] **Step 2: 記録の書き込み規約を追記する**

`AGENTS.md` の「採点パイプライン規約」節の末尾に追記する。

```md
- **練習結果の記録** (`src/lib/history.ts`): 文統計は `doTranscribe` の採点確定点 (`practice/+page.svelte:747-755` の直後) で 1 文ごとに `recordSentenceAttempt`、セッション record は **`summary` 到達時（進捗 `$effect` 内）と `onDestroy` の両方**で `finalizeSession` する。`onDestroy` はブラウザの reload / タブを閉じた時には**発火しない**（JS realm が破棄されるだけで Svelte の destroy hook が走らない）ので、summary での確定は必須であり、`onDestroy` は SvelteKit のリンク遷移やブラウザの「戻る」で**セッション途中離脱**した時の担当になる。`settleSession()` が `sessionStartedAt = null` で終わるので二重計上は起きない。`retryFailedOnly()` は `startSession()` を**呼ばない**ので、`beginSession()` で `sessionStartedAt` を再スタンプしないと不正データを書く
- **合格状態は保存しない。** `SentenceStat` は `attempts` / `lastScore` / `lastPracticedAt` の 3 つだけ。合格/苦手/未着手は `lastScore` と**現在の** `threshold` から導出する (閾値を下げると進捗が動くのが正しい)
- **章行とトラック行の文数の基準は混ぜない — 両方ともサブツリー。** `getNodeSentences(nodeId, …)` の結果をそのまま使い、`/practice?node=` と同じ集合を回るので行の `M` が実セッション長と一致する。`canPractice()` も同じ基準。`getNodeSentences` は**トラックにもサブツリーを返す** (`sentences.ts`) ので、トラック行を直属に絞ると「`0文` なのに `練習` ボタン」の矛盾（AGENTS.md が禁じる）が起きる
- **履歴はデバイスローカルのまま。** ロードマップ⑥ のクラウド同期対象に**含めない** (練習実績はマージ不能 — last-write-wins で上書きされる)
```

- [ ] **Step 3: 最終検証**

Run: `npm run check && npx vitest run && npx playwright test --workers=1 --reporter=list`
Expected: `svelte-check found 0 errors`、vitest 全緑、Playwright 全緑

- [ ] **Step 4: コミット**

```bash
git add AGENTS.md
git commit -m "docs: record the practice history storage contract"
```

---

## 最終検証（ユーザー承認ゲート）

自動検証の完了後、**実機ゲート**をユーザーで確認してもらう（AGENTS.md の運用ルールに従い「実機ゲート込み」で完了とみなさない）:

1. Android Chrome で 1 章を練習して全文を終わらせる → トップページで `N/N 合格 · 100%` が出る
2. リロードしても進捗が残る
3. トラック行のドットが練習順に並び、合格/苦手/未着手が緑/橙/灰色に見える
4. ピルに `連続 1 日` が出る
5. 履歴セクションを開いて、前日のログが行として出る
6. 管理画面 › 設定 で認識閾値を 80 → 60 に 바꾸ると、トップページで合格数が増える
7. |lang| 390px でドット列が折り返しても行が崩れない
8. 章を削除してから履歴 섹션 を見ると `(削除済み)` が出る
