# トラック階層統合 実装計画 (Track Hierarchy Integration)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 章をルート専用にし、トラックの階層（`Track.parentId`）で「章の中のまとまり」を1種類に統合する。子チャプターは読み込みシムで子トラックへ自動変換し、章・トラックのどこからでも練習を開始できるようにする。あわせて管理タブの木から本文をインライン編集できるようにする。

**Architecture:** データ層は `src/lib/sentences.ts` に階層の純関数群（`flattenTrackTree` / `getNodeDescendantTrackIds` / `getNodeSentences` / `getNodeTrail` / `migrateToV3`）を追加し、UI 層はそれを引数で受け取る純関数として呼ぶ。並び順は pre-order（自文 → 子トラック1配下 → 子トラック2配下）。`Track.parentId` を更新する API を作らないことでサイクル整合を型で担保する。移行は読み込み時シム＋書き込み戻し（lazy migration）、エクスポート/インポートは version 3（v2 も自動変換して受理）。

**Tech Stack:** SvelteKit 2 / Svelte 5 runes / TypeScript strict / Tailwind v4 / bits-ui (shadcn-svelte) / vitest / Playwright / Cloudflare Workers

**Spec:** `docs/superpowers/specs/2026-09-27-track-hierarchy-integration-design.md`

## Global Constraints

- `npm run check` は **0 エラー**、`npm test` と `npm run test:e2e` は **全緑** が完了条件
- ストレージキーは `oboeru:v1` のまま変更しない。エクスポート/インポートは `version: 3`、v2 は自動変換して**受理**、v1 は「対応していないバージョンです」で拒否
- `data-testid="progress"` の**内側 DOM 構造は変更しない**（`progress-bar` + `<span>` 2 個）。変わるのは span の文字列だけで、`基本 · 1 / 12` の完全一致 assert（章開始ケース）は現状のまま通す
- 章の `parentId` フィールドは型に残すが、UI から設定する経路を作らない（値は常に `null`）
- `Track.parentId` を更新する API を作らない。トラックの親は「追加する時点で確定」する
- 管理タブの track 行の testid は `tree-track-row` / `tree-track-name` / `tree-track-up` / `tree-track-down` / `tree-track-edit` / `tree-track-delete` とし、文章タブの既存 `track-name` / `add-track` / `edit-track` 等と衝突させない（`getByTestId` の strict mode 違反を避けるため）
- UI 文言は日本語。レスポンシブ 390px 維持、axe serious/critical 0 維持
- 既存テストを削除・skip 化しない。挙動が変わったテストは置き換えるが、置き換えた理由（何が変わったか）を各 Task の Step に明記する
- コミットはユーザー明示依頼時のみ。各 Task の commit ステップは**実装中に確認を取り、勝手に実行しない**

---

## File Structure

| ファイル | 責務 | 変更種別 |
|---|---|---|
| `src/lib/types.ts` | `Track.parentId` 追加 | 変更 |
| `src/lib/sentences.ts` | 階層純関数 5 つの追加、track CRUD の階層対応、`migrateToV3`、読み込みシム統合、`StorageData` の public 化 | 変更（データ層の最大） |
| `src/lib/sentences.test.ts` | 上記のユニットテスト | 変更 |
| `src/lib/default-sentences.ts` | 既定トラックに `parentId: null` | 変更 |
| `src/routes/+page.svelte` | トップページ: 章 + トラックの1本の木、`?node=` リンク | 変更 |
| `src/routes/manage/+page.svelte` | chapters タブ = 1本の木（track CRUD 含む）、インライン本文編集、sentences タブ簡略化、version 3 I/O | 変更（UI の最大） |
| `src/routes/practice/+page.svelte` | `?node=` 解決、パンくず固定表示、進捗行 2 モード | 変更 |
| `tests/top.spec.ts` | 木の E2E（2 本書き換え + 2 本新規） | 変更 |
| `tests/manage.spec.ts` | `Chapter nesting` → `Track nesting` 化、track CRUD テストの文 章タブへ移送、インライン編集テスト | 変更 |
| `tests/practice.spec.ts` | `?node=` 化、エラー文言 3 種、パンくず/進捗 2 モードのテスト | 変更 |
| `tests/io-settings.spec.ts` | version 3 化、v2 自動変換のテスト | 変更 |
| `AGENTS.md` | データモデル規約 / ディレクトリ地図 / E2E 規約の更新 | 変更 |
| `.omo/exports/build_babel_import.py` | version 3 での再生成（**任意**。babel を実データで使っている場合のみ） | 変更 |

---

### Task 1: `Track.parentId` を型に追加する

**Files:**
- Modify: `src/lib/types.ts:8-13`
- Modify: `src/lib/sentences.ts:55-63`（`StoreData` → `export interface StorageData`、`defaultTrackFor`）
- Modify: `src/lib/sentences.ts:171-187`（`addTrack` のシグネチャ）、`:226-267`（`addSentence`）、`:269-297`（`updateSentence`）

**Interfaces:**
- Produces:
  ```ts
  Track { id: string; chapterId: string; name: string; order: number; parentId: string | null }
  export interface StorageData { chapters: Chapter[]; tracks: Track[]; sentences: Sentence[] }
  addTrack(chapterId: string, name: string, parentTrackId?: string | null): Track
  ```
  以降の Task は `parentId` が必ず存在する前提で書ける。

- [ ] **Step 1: 型を変更する**

`src/lib/types.ts`:

```ts
export interface Track {
	id: string;
	chapterId: string;      // 最上位章。所属章を間接的に指定する冗長フィールド
	name: string;
	order: number;          // 同一親 (章 or 親トラック) 内での順序
	parentId: string | null; // NEW。親トラック。null なら章直下
}
```

- [ ] **Step 2: `StorageData` を public にして `defaultTrackFor` を直す**

`src/lib/sentences.ts`:

```ts
export interface StorageData {
	chapters: Chapter[];
	tracks: Track[];
	sentences: Sentence[];
}

function defaultTrackFor(ch: Chapter): Track {
	return { id: `tr-${ch.id}`, chapterId: ch.id, name: 'トラック1', order: 1, parentId: null };
}
```

`StoreData` を使う 3 箇所（`loadData` の戻り値、`saveData` の引数、`loadData` の型注釈）も
`StorageData` に置き換える。

- [ ] **Step 3: `addTrack` に `parentTrackId` を足す**

`src/lib/sentences.ts:171-187`:

```ts
export function addTrack(chapterId: string, name: string, parentTrackId: string | null = null): Track {
	if (!name.trim()) {
		throw new Error('Track name must not be empty');
	}
	const tracks = loadTracks();
	const siblings = tracks.filter(
		(t) => t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId
	);
	const maxOrder = siblings.reduce((max, t) => Math.max(max, t.order), 0);
	const track: Track = {
		id: generateId(),
		chapterId,
		name: name.trim(),
		order: maxOrder + 1,
		parentId: parentTrackId
	};
	tracks.push(track);
	saveTracks(tracks);
	return track;
}
```

`parentTrackId` に**既定値**があるので既存の 2 引数呼び出しはそのまま通る（Task 6 で型を締める）。

- [ ] **Step 4: 残りの Track literal に `parentId: null` を足す**

`addSentence`（`:243`）と `updateSentence`（`:288`）の自動生成トラック:

```ts
const track: Track = { id: `tr-${chapterId}`, chapterId, name: 'トラック1', order: 1, parentId: null };
```

- [ ] **Step 5: `npm run check` で残りを洗い出す**

Run: `npm run check`
Expected: `Property 'parentId' is missing` 系のエラーが出る。全部に `parentId: null` を足す。

`src/lib/default-sentences.ts:8-11` の `defaultTracks`（実際の id / chapterId に合わせること）:

```ts
export const defaultTracks: Track[] = [
	{ id: 'tr-ja-01', chapterId: 'ja-01', name: 'トラック1', order: 1, parentId: null },
	{ id: 'tr-en-01', chapterId: 'en-01', name: 'トラック1', order: 1, parentId: null }
];
```

- [ ] **Step 6: ユニットテストの Track literal を直す（**アサーションは変えない**）**

`src/lib/sentences.test.ts` の `addTrack` / `updateTrack` / `getChapterTracks` /
`getChapterSentences` / `deleteChapter` 関連の Track literal と、既存シードの
`defaultTracks` に `parentId: null` を追加する。**期待値アサーションは一切変更しない**
（データ構造のフィールドが増えただけ）。

Run: `npm test`
Expected: 全 PASS（Task 1 では新機能なし。テストの緑を守るだけのタスク）

- [ ] **Step 7: `npm run check`**

Expected: 0 エラー

- [ ] **Step 8: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/lib/types.ts src/lib/sentences.ts src/lib/sentences.test.ts src/lib/default-sentences.ts
git commit -m "feat: add Track.parentId to the data model"
```

---

### Task 2: 階層の走査純関数

**Files:**
- Modify: `src/lib/sentences.ts:208-215`（`getChapterTracks` の置き換え）
- Test: `src/lib/sentences.test.ts`

**Interfaces:**
- Produces:
  ```ts
  flattenTrackTree(chapterId: string, tracks: Track[]): Track[]   // 章直下 + 子孫を pre-order で平坦化
  getNodeDescendantTrackIds(trackId: string, tracks: Track[]): Set<string>  // 自身 + 子孫（cycle 安全）
  getChapterTracks(chapterId, tracks)  // flattenTrackTree の薄いラッパー（章の全トラック = pre-order）
  ```

- [ ] **Step 1: テストを先に書く（RED）**

`src/lib/sentences.test.ts` の末尾に追記（既存の `storage` mock と `beforeEach` をそのまま使う）:

```ts
// ---------------------------------------------------------------------------
// Track hierarchy traversal
// ---------------------------------------------------------------------------

function track(over: Partial<Track> & { id: string }): Track {
	return { chapterId: 'ch-1', name: over.id, order: 1, parentId: null, ...over };
}

describe('flattenTrackTree', () => {
	it('returns direct children then their subtrees in pre-order', () => {
		const tracks = [
			track({ id: 't2', name: 'B', order: 2 }),
			track({ id: 't1-1', name: 'B-1', order: 1, parentId: 't1' }),
			track({ id: 't1', name: 'A', order: 1 }),
			track({ id: 't1-2', name: 'A-2', order: 2, parentId: 't1' }),
			track({ id: 't1-1-1', name: 'A-1-1', order: 1, parentId: 't1-1' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual([
			't1',
			't1-1',
			't1-1-1',
			't1-2',
			't2'
		]);
	});

	it('never collects tracks from another chapter', () => {
		const tracks = [
			track({ id: 't1', chapterId: 'ch-1' }),
			track({ id: 'x1', chapterId: 'ch-2' }),
			track({ id: 'x1-1', chapterId: 'ch-2', parentId: 'x1' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual(['t1']);
	});

	it('returns an empty array for a chapter without tracks', () => {
		expect(flattenTrackTree('ch-none', [track({ id: 't1' })])).toEqual([]);
	});
});

describe('getNodeDescendantTrackIds', () => {
	it('includes the track itself and all descendants', () => {
		const tracks = [
			track({ id: 't1' }),
			track({ id: 't1-1', parentId: 't1' }),
			track({ id: 't1-1-1', parentId: 't1-1' }),
			track({ id: 't2' })
		];
		expect([...getNodeDescendantTrackIds('t1', tracks)].sort()).toEqual(['t1', 't1-1', 't1-1-1']);
	});

	it('terminates on a cyclic parentId chain', () => {
		const tracks = [track({ id: 'a', parentId: 'b' }), track({ id: 'b', parentId: 'a' })];
		expect([...getNodeDescendantTrackIds('a', tracks)].sort()).toEqual(['a', 'b']);
	});
});

describe('getChapterTracks (pre-order wrapper)', () => {
	it('lists nested tracks after their parent', () => {
		const tracks = [
			track({ id: 't1' }),
			track({ id: 't1-1', parentId: 't1' }),
			track({ id: 't2', order: 2 })
		];
		expect(getChapterTracks('ch-1', tracks).map((t) => t.id)).toEqual(['t1', 't1-1', 't2']);
	});
});
```

import 文に `flattenTrackTree` と `getNodeDescendantTrackIds` を追加する。

- [ ] **Step 2: RED を確認する**

Run: `npm test -- --run src/lib/sentences.test.ts -t "Track hierarchy"`
Expected: FAIL — `flattenTrackTree` が export されていない

- [ ] **Step 3: 実装する（GREEN）**

`src/lib/sentences.ts`:

```ts
/**
 * Flatten one chapter's track tree in depth-first (pre-order) order: the
 * chapter's direct children (parentId === null) sorted by `order`, each
 * immediately followed by its own subtree. Tracks of other chapters are never
 * collected, so a `parentId` pointing outside the chapter cannot leak nodes in.
 */
export function flattenTrackTree(chapterId: string, tracks: Track[]): Track[] {
	const result: Track[] = [];

	function walk(parentTrackId: string | null): void {
		const children = tracks
			.filter((t) => t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId)
			.sort((a, b) => a.order - b.order);
		for (const child of children) {
			result.push(child);
			walk(child.id);
		}
	}

	walk(null);
	return result;
}

/**
 * Ids of `trackId` plus every descendant track. Terminates on cyclic data
 * because an id is never visited twice.
 */
export function getNodeDescendantTrackIds(trackId: string, tracks: Track[]): Set<string> {
	const ids = new Set<string>([trackId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const t of tracks) {
			if (t.parentId !== null && ids.has(t.parentId) && !ids.has(t.id)) {
				ids.add(t.id);
				grew = true;
			}
		}
	}
	return ids;
}

/**
 * All tracks of a chapter in pre-order. Thin wrapper over `flattenTrackTree`
 * kept for the existing callers (addSentence / updateSentence auto-assign,
 * manage's chapter-filtered group list).
 */
export function getChapterTracks(chapterId: string, tracks: Track[]): Track[] {
	return flattenTrackTree(chapterId, tracks);
}
```

- [ ] **Step 4: GREEN を確認する**

Run: `npm test`
Expected: 全 PASS。`getChapterTracks` の既存テストはフラットデータなので結果が変わらない

- [ ] **Step 5: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/lib/sentences.ts src/lib/sentences.test.ts
git commit -m "feat: add track hierarchy traversal functions"
```

---

### Task 3: ノードの文収集（pre-order）

**Files:**
- Modify: `src/lib/sentences.ts:339-353`（`getChapterSentences` の置き換え）
- Test: `src/lib/sentences.test.ts`

**Interfaces:**
- Produces:
  ```ts
  getNodeSentences(nodeId: string, chapters: Chapter[], tracks: Track[], sentences: Sentence[]): Sentence[]
  getChapterSentences(chapterId: string, sentences: Sentence[]): Sentence[]  // 委譲するラッパー（シグネチャ不変）
  ```

- [ ] **Step 1: テストを先に書く（RED）**

```ts
// ---------------------------------------------------------------------------
// getNodeSentences
// ---------------------------------------------------------------------------

function chapter(id: string, name = id): Chapter {
	return { id, name, parentId: null, order: 1 };
}

function sentence(over: Partial<Sentence> & { id: string }): Sentence {
	return { chapterId: 'ch-1', trackId: 't1', text: over.id, language: 'ja', order: 1, ...over };
}

describe('getNodeSentences', () => {
	const chapters = [chapter('ch-1'), chapter('ch-2')];
	// t1 has 2 own sentences; t1-1 / t1-2 are its children; t2 is a sibling
	const tracks = [
		track({ id: 't1' }),
		track({ id: 't1-1', parentId: 't1', order: 1 }),
		track({ id: 't1-2', parentId: 't1', order: 2 }),
		track({ id: 't2', order: 2 })
	];
	const sentences = [
		sentence({ id: 's-t2', trackId: 't2', order: 1 }),
		sentence({ id: 's-t1-2b', trackId: 't1-2', order: 2 }),
		sentence({ id: 's-t1-2a', trackId: 't1-2', order: 1 }),
		sentence({ id: 's-t1b', trackId: 't1', order: 2 }),
		sentence({ id: 's-t1a', trackId: 't1', order: 1 }),
		sentence({ id: 's-t1-1', trackId: 't1-1', order: 1 }),
		sentence({ id: 's-other-chapter', trackId: 't1', chapterId: 'ch-2', order: 1 })
	];

	it('collects a whole chapter in pre-order: own sentences, then each subtree', () => {
		expect(getNodeSentences('ch-1', chapters, tracks, sentences).map((s) => s.id)).toEqual([
			's-t1a',
			's-t1b',
			's-t1-1',
			's-t1-2a',
			's-t1-2b',
			's-t2'
		]);
	});

	it('collects a track subtree: own sentences first, then child subtrees', () => {
		expect(getNodeSentences('t1', chapters, tracks, sentences).map((s) => s.id)).toEqual([
			's-t1a',
			's-t1b',
			's-t1-1',
			's-t1-2a',
			's-t1-2b'
		]);
	});

	it('collects a leaf track without leaking sibling or parent sentences', () => {
		expect(getNodeSentences('t1-2', chapters, tracks, sentences).map((s) => s.id)).toEqual([
			's-t1-2a',
			's-t1-2b'
		]);
	});

	it('returns an empty array for an unknown node', () => {
		expect(getNodeSentences('nope', chapters, tracks, sentences)).toEqual([]);
	});

	it('keeps sentences with an unknown trackId instead of dropping them', () => {
		const orphan = [sentence({ id: 's-orphan', trackId: 'gone' })];
		expect(getNodeSentences('t1', chapters, tracks, orphan).map((s) => s.id)).toEqual(['s-orphan']);
	});
});
```

import 文に `getNodeSentences` を追加する。

- [ ] **Step 2: RED を確認する**

Run: `npm test -- --run src/lib/sentences.test.ts -t "getNodeSentences"`
Expected: FAIL — `getNodeSentences` が export されていない

- [ ] **Step 3: 実装する（GREEN）**

`src/lib/sentences.ts:339-353` を差し替え:

```ts
function byTrackPosition(sentences: Sentence[], position: Map<string, number>): Sentence[] {
	return [...sentences].sort(
		(a, b) =>
			(position.get(a.trackId) ?? Number.MAX_SAFE_INTEGER) -
				(position.get(b.trackId) ?? Number.MAX_SAFE_INTEGER) || a.order - b.order
	);
}

/**
 * Sentences reachable from a node, in pre-order: a chapter's own tracks each
 * contributing their sentences then their subtree's; a track contributing its
 * own sentences then each child subtree's. Sentences whose trackId has no
 * matching track sort last (never dropped).
 */
export function getNodeSentences(
	nodeId: string,
	chapters: Chapter[],
	tracks: Track[],
	sentences: Sentence[]
): Sentence[] {
	const chapter = chapters.find((c) => c.id === nodeId);
	if (chapter) {
		const position = new Map(flattenTrackTree(chapter.id, tracks).map((t, i) => [t.id, i]));
		return byTrackPosition(
			sentences.filter((s) => s.chapterId === chapter.id),
			position
		);
	}
	const found = tracks.find((t) => t.id === nodeId);
	if (!found) return [];
	const position = new Map(flattenTrackTree(found.chapterId, tracks).map((t, i) => [t.id, i]));
	const scope = getNodeDescendantTrackIds(found.id, tracks);
	return byTrackPosition(
		sentences.filter((s) => scope.has(s.trackId)),
		position
	);
}

/**
 * Kept for existing callers: the chapter's sentences in pre-order. Now a thin
 * wrapper over `getNodeSentences`.
 */
export function getChapterSentences(chapterId: string, sentences: Sentence[]): Sentence[] {
	return getNodeSentences(chapterId, loadChapters(), loadTracks(), sentences);
}
```

- [ ] **Step 4: GREEN を確認する**

Run: `npm test`
Expected: 全 PASS。`getChapterSentences` の既存テスト（`orders sentences by track order first,
then sentence order` / `Sentence with unknown trackId sorts last`）はフラットデータなので結果不変

- [ ] **Step 5: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/lib/sentences.ts src/lib/sentences.test.ts
git commit -m "feat: collect node sentences in pre-order"
```

---

### Task 4: パンくず（ノードの系譜）

**Files:**
- Modify: `src/lib/sentences.ts`（`getNodeSentences` の直後に追加）
- Test: `src/lib/sentences.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface NodeRef { type: 'chapter' | 'track'; id: string; name: string }
  export function getNodeTrail(nodeId: string, chapters: Chapter[], tracks: Track[]): NodeRef[]
  ```
  章ノードなら 1 要素、トラックなら 章 + 祖先トラック + 自身、未知 id なら `[]`

- [ ] **Step 1: テストを先に書く（RED）**

```ts
// ---------------------------------------------------------------------------
// getNodeTrail
// ---------------------------------------------------------------------------

describe('getNodeTrail', () => {
	const chapters = [chapter('ch-1', '1章')];
	const tracks = [
		track({ id: 't1', name: 'トラック1' }),
		track({ id: 't1-1', name: 'トラック1-1', parentId: 't1' }),
		track({ id: 't1-1-1', name: 'トラック1-1-1', parentId: 't1-1' })
	];

	it('returns a single chapter ref for a chapter node', () => {
		expect(getNodeTrail('ch-1', chapters, tracks)).toEqual([
			{ type: 'chapter', id: 'ch-1', name: '1章' }
		]);
	});

	it('returns chapter → ancestors → self for a track node', () => {
		expect(getNodeTrail('t1-1-1', chapters, tracks)).toEqual([
			{ type: 'chapter', id: 'ch-1', name: '1章' },
			{ type: 'track', id: 't1', name: 'トラック1' },
			{ type: 'track', id: 't1-1', name: 'トラック1-1' },
			{ type: 'track', id: 't1-1-1', name: 'トラック1-1-1' }
		]);
	});

	it('returns an empty array for an unknown id', () => {
		expect(getNodeTrail('nope', chapters, tracks)).toEqual([]);
	});

	it('omits the chapter when the track has no matching chapter', () => {
		expect(getNodeTrail('t1', [], tracks)).toEqual([
			{ type: 'track', id: 't1', name: 'トラック1' }
		]);
	});
});
```

- [ ] **Step 2: RED を確認する**

Run: `npm test -- --run src/lib/sentences.test.ts -t "getNodeTrail"`
Expected: FAIL — `getNodeTrail` が export されていない

- [ ] **Step 3: 実装する（GREEN）**

```ts
export interface NodeRef {
	type: 'chapter' | 'track';
	id: string;
	name: string;
}

/**
 * Ancestor chain from the chapter down to `nodeId` (inclusive). Cycle-safe:
 * an already-visited track id stops the walk.
 */
export function getNodeTrail(nodeId: string, chapters: Chapter[], tracks: Track[]): NodeRef[] {
	const owner = chapters.find((c) => c.id === nodeId);
	if (owner) return [{ type: 'chapter', id: owner.id, name: owner.name }];

	const chain: Track[] = [];
	const seen = new Set<string>();
	let current: Track | undefined = tracks.find((t) => t.id === nodeId);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		chain.unshift(current);
		const parentId: string | null = current.parentId;
		current = parentId ? tracks.find((t) => t.id === parentId) : undefined;
	}
	if (chain.length === 0) return [];

	const head = chapters.find((c) => c.id === chain[0].chapterId);
	const trail: NodeRef[] = head ? [{ type: 'chapter', id: head.id, name: head.name }] : [];
	return [...trail, ...chain.map((t) => ({ type: 'track' as const, id: t.id, name: t.name }))];
}
```

- [ ] **Step 4: GREEN を確認する**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 5: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/lib/sentences.ts src/lib/sentences.test.ts
git commit -m "feat: add getNodeTrail for the practice breadcrumb"
```

---

### Task 5: 移行シム（子チャプター → 子トラック）

**Files:**
- Modify: `src/lib/sentences.ts`（`loadData` の直後に `migrateToV3`、`loadData` 内で適用）
- Test: `src/lib/sentences.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function migrateToV3(data: StorageData): StorageData
  ```
  副作用なし。子チャプターを「最も近い祖先章の直下トラック」化、文の `chapterId` / `trackId` を差替え、全チャプターの `parentId` を `null` 化、全トラックの `parentId` を補完。冪等。

- [ ] **Step 1: テストを先に書く（RED）**

```ts
// ---------------------------------------------------------------------------
// migrateToV3
// ---------------------------------------------------------------------------

describe('migrateToV3', () => {
	const flatData: StorageData = {
		chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
		tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }],
		sentences: [
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '文1', language: 'ja', order: 1 }
		]
	};

	it('passes a v3 payload through unchanged', () => {
		expect(migrateToV3(flatData)).toEqual(flatData);
	});

	it('only adds parentId: null to tracks of a v2 payload', () => {
		const v2: StorageData = {
			...flatData,
			tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1 } as Track]
		};
		const out = migrateToV3(v2);
		expect(out.chapters).toEqual(v2.chapters);
		expect(out.sentences).toEqual(v2.sentences);
		expect(out.tracks).toEqual([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }
		]);
	});

	it('converts a child chapter into a track of its parent chapter', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }],
			sentences: [
				{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '直下', language: 'ja', order: 1 },
				{ id: 's2', chapterId: 'ch-2', trackId: 't1', text: '子', language: 'ja', order: 1 }
			]
		});
		expect(out.chapters.map((c) => c.id)).toEqual(['ch-1']);
		expect(out.tracks.map((t) => t.id)).toEqual(['t1', 'tr-from-ch-ch-2']);
		expect(out.tracks[1]).toEqual({
			id: 'tr-from-ch-ch-2',
			chapterId: 'ch-1',
			name: '子章',
			order: 2,
			parentId: null
		});
		expect(out.sentences).toEqual([
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '直下', language: 'ja', order: 1 },
			{ id: 's2', chapterId: 'ch-1', trackId: 'tr-from-ch-ch-2', text: '子', language: 'ja', order: 1 }
		]);
	});

	it('lifts a grandchild chapter into the nearest ancestor chapter', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 },
				{ id: 'ch-3', name: '孫章', parentId: 'ch-2', order: 1 }
			],
			tracks: [],
			sentences: [
				{ id: 's3', chapterId: 'ch-3', trackId: 't-x', text: '孫', language: 'ja', order: 1 }
			]
		});
		expect(out.chapters.map((c) => c.id)).toEqual(['ch-1']);
		expect(out.tracks.map((t) => t.id)).toEqual(['tr-from-ch-ch-2', 'tr-from-ch-ch-3']);
		expect(out.sentences[0].chapterId).toBe('ch-1');
	});

	it('is idempotent', () => {
		const once = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [],
			sentences: [
				{ id: 's2', chapterId: 'ch-2', trackId: 't-x', text: '子', language: 'ja', order: 1 }
			]
		});
		expect(migrateToV3(once)).toEqual(once);
	});

	it('repairs a parentId that points at a missing track', () => {
		const out = migrateToV3({
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: 'deleted-parent' },
				{ id: 't2', chapterId: 'ch-1', name: 'B', order: 2, parentId: 't1' }
			],
			sentences: []
		});
		expect(out.tracks.find((t) => t.id === 't1')?.parentId).toBeNull();
		// a valid parentId is untouched
		expect(out.tracks.find((t) => t.id === 't2')?.parentId).toBe('t1');
	});

	it('re-numbers a converted track when the id already exists', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [
				{ id: 'tr-from-ch-ch-2', chapterId: 'ch-1', name: '既存', order: 1, parentId: null }
			],
			sentences: [
				{ id: 's2', chapterId: 'ch-2', trackId: 't-x', text: '子', language: 'ja', order: 1 }
			]
		});
		expect(out.tracks.map((t) => t.id)).toEqual(['tr-from-ch-ch-2', 'tr-from-ch-ch-2-2']);
		expect(out.sentences[0].trackId).toBe('tr-from-ch-ch-2-2');
	});

	it('places converted tracks after the existing tracks of the ancestor chapter', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null },
				{ id: 't2', chapterId: 'ch-1', name: 'B', order: 2, parentId: null }
			],
			sentences: []
		});
		expect(out.tracks[2].order).toBe(3);
	});
});
```

import 文に `migrateToV3` と型 `StorageData` を追加する。

- [ ] **Step 2: RED を確認する**

Run: `npm test -- --run src/lib/sentences.test.ts -t "migrateToV3"`
Expected: FAIL — `migrateToV3` が export されていない

- [ ] **Step 3: 実装する（GREEN）**

`src/lib/sentences.ts` の `loadData` の直後に追加:

```ts
/**
 * Normalise stored / imported data to the track-hierarchy schema: sub-chapters
 * become tracks of their nearest ancestor chapter, every chapter becomes a root
 * (parentId null) and every track gets a parentId. Idempotent — running it on
 * its own output changes nothing.
 */
export function migrateToV3(data: StorageData): StorageData {
	const chapters: Chapter[] = data.chapters.map((c) => ({ ...c, parentId: null }));
	// A `parentId` pointing at a track that does not exist would make the track
	// unreachable in `flattenTrackTree` (invisible in the tree, and `addSentence`
	// would attach its sentences to a different track), so repair those to null.
	//
	// **Definition matters**: the test is "the parent id is not in this payload",
	// NOT "the track cannot reach a chapter-direct root". A reachability-based
	// rule would also promote `a(parent: b) ↔ b(parent: a)` cycles to roots, which
	// breaks the cycle invariant test in `sentences.test.ts`. `flattenTrackTree`'s
	// `seen` set already makes cycle data terminate, so no further guard is needed.
	const trackIds = new Set(data.tracks.map((t) => t.id));
	const tracks: Track[] = data.tracks.map((t) => ({
		...t,
		parentId: t.parentId !== null && t.parentId !== undefined && trackIds.has(t.parentId)
			? t.parentId
			: null
	}));
	const sentences: Sentence[] = data.sentences.map((s) => ({ ...s }));

	const nestedChapters = data.chapters.filter((c) => c.parentId !== null);
	if (nestedChapters.length === 0) {
		return { chapters, tracks, sentences };
	}

	const chapterById = new Map(data.chapters.map((c) => [c.id, c]));
	// Old chapters disappear, so their sentences must be re-pointed at the
	// nearest ancestor that survives.
	const rootChapterIdOf = (chapterId: string): string => {
		let current = chapterId;
		const guard = new Set<string>();
		while (!guard.has(current)) {
			guard.add(current);
			const chapter = chapterById.get(current);
			if (!chapter) break;
			if (chapter.parentId === null) return chapter.id;
			current = chapter.parentId;
		}
		return chapterId;
	};

	const usedTrackIds = new Set(tracks.map((t) => t.id));
	for (const oldChapter of nestedChapters) {
		const ownerId = rootChapterIdOf(oldChapter.id);
		const base = `tr-from-ch-${oldChapter.id}`;
		let newId = base;
		let n = 2;
		while (usedTrackIds.has(newId)) {
			newId = `${base}-${n}`;
			n++;
		}
		usedTrackIds.add(newId);
		const maxOrder = tracks
			.filter((t) => t.chapterId === ownerId && (t.parentId ?? null) === null)
			.reduce((max, t) => Math.max(max, t.order), 0);
		tracks.push({
			id: newId,
			chapterId: ownerId,
			name: oldChapter.name,
			order: maxOrder + 1,
			parentId: null
		});
		for (const s of sentences) {
			if (s.chapterId === oldChapter.id) {
				s.chapterId = ownerId;
				s.trackId = newId;
			}
		}
	}

	return { chapters, tracks, sentences };
}
```

- [ ] **Step 4: 読み込みシムに統合して write-back する**

`loadData`（`:65-102`）の `if (!Array.isArray(parsed.tracks)) { ... } return { ... }` の部分を、
*v1 シム*（`tracks` 欠落）を先に適用してから `migrateToV3` を通す形に置き換える:

```ts
function loadData(): StorageData {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) {
			return {
				chapters: [...defaultChapters],
				tracks: [...defaultTracks],
				sentences: [...defaultSentences]
			};
		}
		const parsed = JSON.parse(raw);
		const chapters: Chapter[] = Array.isArray(parsed.chapters)
			? parsed.chapters
			: [...defaultChapters];
		const storedSentences: Sentence[] = Array.isArray(parsed.sentences)
			? parsed.sentences
			: [...defaultSentences];
		const base: StorageData = Array.isArray(parsed.tracks)
			? { chapters, tracks: parsed.tracks, sentences: storedSentences }
			: {
					// Old format without tracks: synthesize a default track per chapter and
					// backfill trackId (sentences with unknown chapterId are not skipped).
					chapters,
					tracks: chapters.map(defaultTrackFor),
					sentences: storedSentences.map((s) => ({
						...s,
						trackId: s.trackId ?? `tr-${s.chapterId}`
					}))
				};
		const migrated = migrateToV3(base);
		// Lazy write-back so the shim runs once per browser.
		if (JSON.stringify(migrated) !== raw) {
			saveData(migrated);
		}
		return migrated;
	} catch {
		return {
			chapters: [...defaultChapters],
			tracks: [...defaultTracks],
			sentences: [...defaultSentences]
		};
	}
}
```

- [ ] **Step 5: 読み込み時移行のテストを追加する**

```ts
describe('loadData migration (through the load* accessors)', () => {
	it('converts a stored sub-chapter into a track and writes it back', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				chapters: [
					{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
					{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
				],
				tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }],
				sentences: [
					{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '直下', language: 'ja', order: 1 },
					{ id: 's2', chapterId: 'ch-2', trackId: 't1', text: '子', language: 'ja', order: 1 }
				]
			})
		);

		expect(loadChapters().map((c) => c.id)).toEqual(['ch-1']);
		expect(loadTracks().map((t) => t.name)).toEqual(['A', '子章']);

		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
		expect(stored.chapters).toHaveLength(1);
		expect(stored.tracks.map((t: Track) => t.name)).toEqual(['A', '子章']);
		expect(stored.sentences.find((s: Sentence) => s.id === 's2').chapterId).toBe('ch-1');
	});

	it('backfills parentId: null on legacy tracks that have no parentId', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
				tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1 }],
				sentences: [
					{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 }
				]
			})
		);

		// Read path must hand out a fully-populated Track: the hierarchy functions
		// compare `t.parentId === null` directly, so `undefined` would misclassify
		// a legacy chapter-direct track as a child track.
		expect(loadTracks()).toEqual([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }
		]);
	});

	it('leaves already-migrated data untouched (no extra write)', () => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }]);
		saveSentences([]);
		const before = localStorage.getItem(STORAGE_KEY);
		loadChapters();
		expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
	});
});
```

- [ ] **Step 6: GREEN を確認する**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 7: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/lib/sentences.ts src/lib/sentences.test.ts
git commit -m "feat: migrate sub-chapters into nested tracks on load"
```

---

### Task 6: track CRUD の階層対応（カスケード削除 + parentId の封印）

**Files:**
- Modify: `src/lib/sentences.ts:189-206`（`updateTrack` / `deleteTrack`）
- Test: `src/lib/sentences.test.ts`

**Interfaces:**
- Produces:
  ```ts
  updateTrack(id: string, updates: Partial<Omit<Track, 'id' | 'parentId'>>): void
  deleteTrack(id: string): void   // 子孫トラック + 配下の全文をカスケード削除
  ```

- [ ] **Step 1: テストを先に書く（RED）**

```ts
// ---------------------------------------------------------------------------
// Track hierarchy CRUD
// ---------------------------------------------------------------------------

describe('deleteTrack', () => {
	beforeEach(() => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null },
			{ id: 't1-1', chapterId: 'ch-1', name: 'A-1', order: 1, parentId: 't1' },
			{ id: 't1-1-1', chapterId: 'ch-1', name: 'A-1-1', order: 1, parentId: 't1-1' },
			{ id: 't2', chapterId: 'ch-1', name: 'B', order: 2, parentId: null }
		]);
		saveSentences([
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'a', language: 'ja', order: 1 },
			{ id: 's2', chapterId: 'ch-1', trackId: 't1-1', text: 'b', language: 'ja', order: 1 },
			{ id: 's3', chapterId: 'ch-1', trackId: 't1-1-1', text: 'c', language: 'ja', order: 1 },
			{ id: 's4', chapterId: 'ch-1', trackId: 't2', text: 'd', language: 'ja', order: 1 }
		]);
	});

	it('removes descendant tracks and every sentence in the subtree', () => {
		deleteTrack('t1');
		expect(loadTracks().map((t) => t.id)).toEqual(['t2']);
		expect(loadSentences().map((s) => s.id)).toEqual(['s4']);
	});

	it('keeps the parent and its own sentences when a leaf is deleted', () => {
		deleteTrack('t1-1-1');
		expect(loadTracks().map((t) => t.id)).toEqual(['t1', 't1-1', 't2']);
		expect(loadSentences().map((s) => s.id)).toEqual(['s1', 's2', 's4']);
	});
});

describe('addTrack with a parent track', () => {
	beforeEach(() => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }]);
	});

	// NOTE: order is max+1 *within the same parent*, so the first child of t1 is 1
	// (t1 itself is a child of the chapter, not of itself).
	it('appends after the last sibling of the same parent', () => {
		addTrack('ch-1', 'A-2', 't1');
		addTrack('ch-1', 'A-1', 't1');
		const tracks = loadTracks();
		expect(tracks.find((t) => t.name === 'A-2')?.order).toBe(1);
		expect(tracks.find((t) => t.name === 'A-1')?.order).toBe(2);
	});

	it('counts only siblings of the same parent, not the whole chapter', () => {
		addTrack('ch-1', 'B', null);
		addTrack('ch-1', 'A-1', 't1');
		const tracks = loadTracks();
		expect(tracks.find((t) => t.name === 'A-1')?.order).toBe(1);
		expect(tracks.find((t) => t.name === 'B')?.order).toBe(2);
	});
});

describe('updateTrack', () => {
	beforeEach(() => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null },
			{ id: 't1-1', chapterId: 'ch-1', name: 'A-1', order: 1, parentId: 't1' }
		]);
	});

	it('renames and reorders without touching parentId', () => {
		updateTrack('t1-1', { name: 'Renamed', order: 5 });
		expect(loadTracks().find((x) => x.id === 't1-1')).toEqual({
			id: 't1-1',
			chapterId: 'ch-1',
			name: 'Renamed',
			order: 5,
			parentId: 't1'
		});
	});

	it('ignores a parentId key passed by an untyped caller', () => {
		updateTrack('t1-1', { name: 'X', parentId: 't1' } as Partial<Omit<Track, 'id'>>);
		expect(loadTracks().find((x) => x.id === 't1-1')?.parentId).toBe('t1');
	});
});
```

import 文に `addTrack` / `updateTrack` / `deleteTrack` / `saveChapters` / `saveTracks` /
`saveSentences` が含まれていることを確認する（無ければ追加）。

- [ ] **Step 2: RED を確認する**

Run: `npm test -- --run src/lib/sentences.test.ts -t "Track hierarchy CRUD"`
Expected: `deleteTrack` が孫のトラックと文を残すため FAIL。`updateTrack` の parentId テストも FAIL

- [ ] **Step 3: 実装する（GREEN）**

```ts
function withoutParentId(updates: Partial<Track>): Partial<Omit<Track, 'id' | 'parentId'>> {
	const copy: Record<string, unknown> = { ...updates };
	delete copy.parentId;
	return copy as Partial<Omit<Track, 'id' | 'parentId'>>;
}

/** `parentId` is excluded on purpose: a track's parent is fixed at creation. */
export function updateTrack(id: string, updates: Partial<Omit<Track, 'id' | 'parentId'>>): void {
	const tracks = loadTracks();
	const idx = tracks.findIndex((t) => t.id === id);
	if (idx === -1) throw new Error(`Track not found: ${id}`);
	tracks[idx] = { ...tracks[idx], ...withoutParentId(updates) };
	saveTracks(tracks);
}

/** Delete a track together with its whole subtree (descendant tracks + sentences). */
export function deleteTrack(id: string): void {
	const tracks = loadTracks();
	const sentences = loadSentences();
	const doomed = getNodeDescendantTrackIds(id, tracks);

	const remainingTracks = tracks.filter((t) => !doomed.has(t.id));
	const remainingSentences = sentences.filter((s) => !doomed.has(s.trackId));

	saveTracks(remainingTracks);
	saveSentences(remainingSentences);
}
```

- [ ] **Step 4: GREEN を確認する**

Run: `npm test && npm run check`
Expected: 全 PASS / 0 エラー

- [ ] **Step 5: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/lib/sentences.ts src/lib/sentences.test.ts
git commit -m "feat: cascade track deletion over subtrees and lock parentId"
```

---

### Task 7: インポート / エクスポートを version 3 にする

**Files:**
- Modify: `src/routes/manage/+page.svelte:664-671`（export）、`:698-705`（validate）、`:777-779`（import）
- Test: `tests/io-settings.spec.ts`

**Interfaces:**
- Produces: エクスポートは `{version: 3, exportedAt, chapters, tracks, sentences}`。インポートは v3 素通し / v2 を `migrateToV3` で変換 / v1 拒否

- [ ] **Step 1: E2E を先に書いて RED にする**

`tests/io-settings.spec.ts` の `:93` を `expect(data.version).toBe(3);` に変更し、末尾に:

```ts
// ---------------------------------------------------------------------------
// Import — v2 auto-migration
// ---------------------------------------------------------------------------

test.describe('JSON Import — v2 auto-migration', () => {
	test('importing a v2 payload with sub-chapters stores them as tracks', async ({ page }) => {
		await seedData(page);
		await page.getByRole('tab', { name: 'データ' }).click();

		const importData = {
			version: 2,
			exportedAt: new Date().toISOString(),
			chapters: [
				{ id: 'c1', name: '親', parentId: null, order: 1 },
				{ id: 'c1-sub', name: '子', parentId: 'c1', order: 1 }
			],
			tracks: [{ id: 'ct1', chapterId: 'c1', name: '既存', order: 1 }],
			sentences: [
				{ id: 'cs1', chapterId: 'c1', trackId: 'ct1', text: '直下', language: 'ja', order: 1 },
				{ id: 'cs2', chapterId: 'c1-sub', trackId: 'ct1', text: '子の文', language: 'ja', order: 1 }
			]
		};

		const fileChooserPromise = page.waitForEvent('filechooser');
		await page.getByTestId('import-input').click({ force: true });
		const fileChooser = await fileChooserPromise;
		await fileChooser.setFiles({
			name: 'v2.json',
			mimeType: 'application/json',
			buffer: Buffer.from(JSON.stringify(importData))
		});

		await expect(page.getByTestId('import-message')).toContainText('2件のチャプター');

		const stored = await page.evaluate(
			(key) => JSON.parse(localStorage.getItem(key)!),
			STORAGE_KEY
		);
		expect(stored.chapters.map((c: { id: string }) => c.id)).toEqual(['c1']);
		const migrated = stored.tracks.find((t: { name: string }) => t.name === '子');
		expect(migrated).toBeTruthy();
		expect(migrated.chapterId).toBe('c1');
		expect(migrated.parentId).toBeNull();
		const moved = stored.sentences.find((s: { id: string }) => s.id === 'cs2');
		expect(moved.chapterId).toBe('c1');
		expect(moved.trackId).toBe(migrated.id);
	});
});
```

（`tests/io-settings.spec.ts` に `const STORAGE_KEY = 'oboeru:v1';` が無い場合は追加する）

- [ ] **Step 2: RED を確認する**

Run: `npx playwright test tests/io-settings.spec.ts --workers=1 --reporter=list`
Expected: FAIL — `version` が 2 のまま / 子章がトラックにならない

- [ ] **Step 3: 実装する（GREEN）**

`handleExport`（`:665-671`）:

```ts
		const data = {
			version: 3,
			exportedAt: new Date().toISOString(),
			chapters,
			tracks: loadTracks(),
			sentences
		};
```

`validateImportJson`（`:703-705`）:

```ts
		if (obj.version !== 2 && obj.version !== 3) {
			return { valid: false, error: '対応していないバージョンです' };
		}
```

`handleImport`（`:777-779`）:

```ts
				// v2 payloads are normalised to the track-hierarchy schema before the
				// ID merge so sub-chapters arrive as tracks.
				const migratedImport = migrateToV3({
					chapters: data.chapters as Chapter[],
					tracks: data.tracks as Track[],
					sentences: data.sentences as Sentence[]
				});
				const importedChapters = migratedImport.chapters;
				const importedTracks = migratedImport.tracks;
				const importedSentences = migratedImport.sentences;
```

import 文（`:8-27`）に `migrateToV3` を追加する。

- [ ] **Step 4: GREEN を確認する**

Run: `npx playwright test tests/io-settings.spec.ts --workers=1 --reporter=list`
Expected: 全 PASS（v1 拒否のテストも緑のまま。既存の v2 インポート 4 本も緑）

- [ ] **Step 5: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/routes/manage/+page.svelte tests/io-settings.spec.ts
git commit -m "feat: export and import version 3 with v2 auto-migration"
```

---

### Task 8: トップページを章 + トラックの1本の木にする

**Files:**
- Modify: `src/routes/+page.svelte:1-122`（全面差し替え）
- Test: `tests/top.spec.ts`

**Interfaces:**
- Consumes: `flattenTrackTree`, `getNodeSentences`（Task 2/3）
- Produces: 章・トラックのどの行にも `data-testid="card-start"`。遷移先は `/practice?node=<id>`

- [ ] **Step 1: E2E を先に書いて RED にする**

`tests/top.spec.ts`:
- `nested chapters are displayed as a tree with children indented` を削除し、次の 2 本に置き換える（**理由**: 章はルート専用になり階層はトラックが持つようになったため）

```ts
test('tracks are displayed as a tree under their chapter with increasing indentation', async ({
	page
}) => {
	await gotoWithSeed(page, {
		chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
		tracks: [
			{ id: 't1', chapterId: 'ch-1', name: 'トラック1', order: 1, parentId: null },
			{ id: 't1-1', chapterId: 'ch-1', name: 'トラック1-1', order: 1, parentId: 't1' }
		],
		sentences: [
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 },
			{ id: 's2', chapterId: 'ch-1', trackId: 't1-1', text: 'い', language: 'ja', order: 1 }
		]
	});

	await expect(page.getByTestId('track-card').filter({ hasText: 'トラック1' })).toBeVisible();
	await expect(page.getByTestId('track-card').filter({ hasText: 'トラック1-1' })).toBeVisible();

	const chapterNode = page
		.getByTestId('chapter-card')
		.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
	const trackNode = page
		.getByTestId('track-card')
		.filter({ hasText: 'トラック1-1' })
		.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
	const chapterMargin = parseFloat(
		await chapterNode.evaluate((el) => getComputedStyle(el).marginLeft)
	);
	const trackMargin = parseFloat(
		await trackNode.evaluate((el) => getComputedStyle(el).marginLeft)
	);
	expect(trackMargin).toBeGreaterThan(chapterMargin);
});

test('chapter count aggregates descendant tracks while a track row shows its own count', async ({
	page
}) => {
	await gotoWithSeed(page, {
		chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
		tracks: [
			{ id: 't1', chapterId: 'ch-1', name: 'トラック1', order: 1, parentId: null },
			{ id: 't1-1', chapterId: 'ch-1', name: 'トラック1-1', order: 1, parentId: 't1' }
		],
		sentences: [
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 },
			{ id: 's2', chapterId: 'ch-1', trackId: 't1-1', text: 'い', language: 'ja', order: 1 }
		]
	});

	await expect(
		page.getByTestId('chapter-card').filter({ hasText: '1章' }).getByTestId('chapter-card-count')
	).toHaveText('2文');
	await expect(
		page
			.getByTestId('track-card')
			.filter({ hasText: 'トラック1-1' })
			.getByTestId('track-card-count')
	).toHaveText('1文');
});
```

- `parent card badge aggregates descendant sentence counts` を削除する（**理由**: 上の新テストが同じ検証を引き継ぎ、章の集計が「子トラックの合計」になったため）
- `clicking a child card start navigates to /practice with the child id` をトラック版に置き換える（**理由**: 子チャプターが無くなったため）:

```ts
test('clicking a track start navigates to /practice?node=<trackId> without a full reload', async ({
	page
}) => {
	await gotoWithSeed(page, {
		chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
		tracks: [{ id: 't1', chapterId: 'ch-1', name: 'トラック1', order: 1, parentId: null }],
		sentences: [
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 }
		]
	});

	const reloads: string[] = [];
	page.on('load', () => reloads.push(page.url()));
	await page
		.getByTestId('track-card')
		.filter({ hasText: 'トラック1' })
		.getByTestId('card-start')
		.click();
	await page.waitForURL('**/practice?node=t1');
	expect(reloads).toHaveLength(0);
});
```

- `chapters are sorted by order ascending within each level` に、トラックの並びアサーションを追加:

```ts
	await expect(page.getByTestId('track-card').nth(0)).toContainText('トラックB');
	await expect(page.getByTestId('track-card').nth(1)).toContainText('トラックA');
```

（そのテストの既存シードに `tracks` が必要。無ければシードに 2 本追加する）

- [ ] **Step 2: RED を確認する**

Run: `npx playwright test tests/top.spec.ts --workers=1 --reporter=list`
Expected: FAIL — `track-card` が無く、`card-start` が `?chapter=` へ飛ぶ

- [ ] **Step 3: 実装する（GREEN）**

`src/routes/+page.svelte` を全面書き換え:

```svelte
<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		loadChapters,
		loadSentences,
		loadTracks,
		flattenTrackTree,
		getNodeSentences
	} from '$lib/sentences';
	import { ChevronRight, Play } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { Chapter, Sentence, Track } from '$lib/types';

	let chapters = $state<Chapter[]>([]);
	let sentences = $state<Sentence[]>([]);
	let tracks = $state<Track[]>([]);

	// Collapsed node IDs (chapter or track). Default: everything expanded.
	let collapsed = $state<Set<string>>(new Set());

	$effect(() => {
		chapters = loadChapters();
		sentences = loadSentences();
		tracks = loadTracks();
	});

	function rootChapters(): Chapter[] {
		return chapters.filter((c) => c.parentId === null).sort((a, b) => a.order - b.order);
	}

	/** Direct children of a track; `parentTrackId === null` means "direct children of the chapter". */
	function getTrackChildren(chapterId: string, parentTrackId: string | null): Track[] {
		return tracks
			.filter((t) => t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId)
			.sort((a, b) => a.order - b.order);
	}

	function ownCount(trackId: string): number {
		return sentences.filter((s) => s.trackId === trackId).length;
	}

	/** A chapter row shows its whole subtree; a track row shows only its own sentences. */
	function chapterTotal(chapterId: string): number {
		return flattenTrackTree(chapterId, tracks).reduce((sum, t) => sum + ownCount(t.id), 0);
	}

	/** A node is startable when its subtree holds at least one sentence. */
	function canPractice(nodeId: string): boolean {
		return getNodeSentences(nodeId, chapters, tracks, sentences).length > 0;
	}

	function isExpanded(id: string): boolean {
		return !collapsed.has(id);
	}

	function toggleExpand(id: string) {
		const next = new Set(collapsed);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		collapsed = next;
	}

	function startPractice(nodeId: string) {
		goto(`/practice?node=${nodeId}`);
	}
</script>

<svelte:head>
	<title>おぼえる</title>
</svelte:head>

<h1 class="mb-1 text-2xl font-bold">おぼえる</h1>
<p class="mb-6 text-sm text-muted-foreground">カードの練習ボタンですぐに開始できます</p>

{#if chapters.length === 0}
	<div class="py-8 text-center">
		<p>データがありません。管理画面で追加してください</p>
		<a href="/manage" class="inline-flex min-h-11 items-center text-success underline"
			>管理画面で追加する</a
		>
	</div>
{:else}
	<div class="chapter-tree mb-4 flex flex-col gap-2">
		{#snippet trackNode(track: Track, depth: number)}
			<div class="tree-node" data-testid="track-card" style:margin-left={`${depth * 1.5}rem`}>
				<div
					class="track-item flex min-h-14 items-center gap-1 rounded-xl border border-border bg-card p-2 shadow-xs transition-colors hover:bg-accent/50"
				>
					{#if getTrackChildren(track.chapterId, track.id).length > 0}
						<button
							class="expand-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
							onclick={() => toggleExpand(track.id)}
							aria-label={isExpanded(track.id) ? '折りたたむ' : '展開する'}
							aria-expanded={isExpanded(track.id)}
						>
							<ChevronRight
								class={isExpanded(track.id)
									? 'h-5 w-5 rotate-90 transition-transform'
									: 'h-5 w-5 transition-transform'}
							/>
						</button>
					{:else}
						<span class="w-4 shrink-0" aria-hidden="true"></span>
					{/if}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="truncate text-base font-semibold" data-testid="track-card-name">{track.name}</span>
						<span class="text-sm text-muted-foreground" data-testid="track-card-count">{ownCount(track.id)}文</span>
					</div>
					{#if canPractice(track.id)}
						<Button
							class="h-11 gap-1.5 rounded-md px-5 text-base font-bold"
							data-testid="card-start"
							aria-label={`${track.name} の練習を開始`}
							onclick={() => startPractice(track.id)}
						>
							<Play class="size-5 fill-current" />
							練習
						</Button>
					{/if}
				</div>
				{#if isExpanded(track.id)}
					{#each getTrackChildren(track.chapterId, track.id) as child (child.id)}
						{@render trackNode(child, depth + 1)}
					{/each}
				{/if}
			</div>
		{/snippet}

		{#snippet chapterNode(chapter: Chapter, depth: number)}
			<div class="tree-node" style:margin-left={`${depth * 1.5}rem`}>
				<div
					class="chapter-item flex min-h-14 items-center gap-1 rounded-xl border border-border bg-card p-2 shadow-xs transition-colors hover:bg-accent/50"
					data-testid="chapter-card"
				>
					{#if getTrackChildren(chapter.id, null).length > 0}
						<button
							class="expand-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
							onclick={() => toggleExpand(chapter.id)}
							aria-label={isExpanded(chapter.id) ? '折りたたむ' : '展開する'}
							aria-expanded={isExpanded(chapter.id)}
						>
							<ChevronRight
								class={isExpanded(chapter.id)
									? 'h-5 w-5 rotate-90 transition-transform'
									: 'h-5 w-5 transition-transform'}
							/>
						</button>
					{:else}
						<span class="w-4 shrink-0" aria-hidden="true"></span>
					{/if}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="chapter-name truncate text-base font-semibold">{chapter.name}</span>
						<span class="text-sm text-muted-foreground" data-testid="chapter-card-count">{chapterTotal(chapter.id)}文</span>
					</div>
					{#if canPractice(chapter.id)}
						<Button
							class="h-11 gap-1.5 rounded-md px-5 text-base font-bold"
							data-testid="card-start"
							aria-label={`${chapter.name} の練習を開始`}
							onclick={() => startPractice(chapter.id)}
						>
							<Play class="size-5 fill-current" />
							練習
						</Button>
					{/if}
				</div>
				{#if isExpanded(chapter.id)}
					{#each getTrackChildren(chapter.id, null) as track (track.id)}
						{@render trackNode(track, depth + 1)}
					{/each}
				{/if}
			</div>
		{/snippet}

		{#each rootChapters() as chapter (chapter.id)}
			{@render chapterNode(chapter, 0)}
		{/each}
	</div>
{/if}
```

- [ ] **Step 4: GREEN を確認する**

Run: `npx playwright test tests/top.spec.ts --workers=1 --reporter=list`
Expected: 全 PASS（`shows sentence count per chapter` の `10文` は既定データの章・トラックの両方が 10 文なので `.first()` のままで通る）

- [ ] **Step 5: `npm run check`**

Expected: 0 エラー

- [ ] **Step 6: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/routes/+page.svelte tests/top.spec.ts
git commit -m "feat: show chapters and tracks as one tree on the top page"
```

---

### Task 9: 練習画面を `?node=` にする（パンくず + 進捗行 2 モード）

**Files:**
- Modify: `src/routes/practice/+page.svelte:109-150`（state / derived）、`:820-830`（進捗保存）、`:841-894`（onMount）、`:993-995`（ヘッダ）、`:1339`（復元ダイアログ文言）
- Test: `tests/practice.spec.ts`

**Interfaces:**
- Consumes: `getNodeTrail`, `getNodeSentences`（Task 3/4）
- Produces: `/practice?node=<chapterId|trackId>`。ヘッダ `chapter-name` にパンくず文字列（`日本語 › 基本`）。進捗行は章開始時のみトラック名付き

- [ ] **Step 1: E2E を先に書いて RED にする**

`tests/practice.spec.ts`:
- `SeedTrack` に `parentId?: string | null;` を追加
- `setupPractice`（`:150-163`）の 3 番目の引数名を `nodeId` にし、遷移先を `/practice?node=${nodeId}` に変更
- エラー系 3 本を新しい引数と文言に更新（**理由**: ノードはトラック|May渐进もになり得るので「章」の語は不正確になった）:

```ts
		await expect(page.getByTestId('error-message')).toContainText('ID が指定されていません');
```

```ts
		await page.goto('/practice?node=nope');
		await expect(page.getByTestId('error-message')).toContainText('ノードが見つかりません: nope');
```

```ts
		await page.goto('/practice?node=ch-ja-01');
		await expect(page.getByTestId('error-message')).toContainText('このノードには文がありません');
```

- `Practice — Tracks` describe に 3 本追加:

```ts
	test('starting from a track shows the breadcrumb and a plain progress line', async ({
		page
	}) => {
		await setupPractice(
			page,
			{
				transcribe: [{ text: 'x' }],
				tracks: [
					{ id: 'tr-a', chapterId: 'ch-ja-01', name: '基本', order: 1, parentId: null },
					{ id: 'tr-b', chapterId: 'ch-ja-01', name: '応用', order: 2, parentId: null }
				],
				sentences: [
					{ id: 'ja-01', chapterId: 'ch-ja-01', trackId: 'tr-a', text: 'おはようございます。', language: 'ja', order: 1 },
					{ id: 'ja-02', chapterId: 'ch-ja-01', trackId: 'tr-a', text: 'こんにちは。', language: 'ja', order: 2 }
				]
			},
			'tr-a'
		);

		await expect(page.getByTestId('chapter-name')).toHaveText('日本語 › 基本');
		// The breadcrumb already carries the track name, so the progress line stays plain
		await expect(page.getByTestId('progress')).toHaveText('1 / 2');
	});

	test('a track session collects its own and its descendant tracks in pre-order', async ({
		page
	}) => {
		await setupPractice(
			page,
			{
				transcribe: [{ text: 'x' }],
				tracks: [
					{ id: 'tr-a', chapterId: 'ch-ja-01', name: 'A', order: 1, parentId: null },
					{ id: 'tr-a-1', chapterId: 'ch-ja-01', name: 'A-1', order: 1, parentId: 'tr-a' },
					{ id: 'tr-a-2', chapterId: 'ch-ja-01', name: 'A-2', order: 2, parentId: 'tr-a' },
					{ id: 'tr-b', chapterId: 'ch-ja-01', name: 'B', order: 2, parentId: null }
				],
				sentences: [
					{ id: 's-a2', chapterId: 'ch-ja-01', trackId: 'tr-a-2', text: 'あ-2', language: 'ja', order: 1 },
					{ id: 's-a1', chapterId: 'ch-ja-01', trackId: 'tr-a-1', text: 'あ-1', language: 'ja', order: 1 },
					{ id: 's-b', chapterId: 'ch-ja-01', trackId: 'tr-b', text: 'びー', language: 'ja', order: 1 },
					{ id: 's-a', chapterId: 'ch-ja-01', trackId: 'tr-a', text: 'あ', language: 'ja', order: 1 }
				]
			},
			'tr-a'
		);

		await expect(page.getByTestId('sentence-text')).toHaveText('あ');
		await expect(page.getByTestId('progress')).toHaveText('1 / 3');
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('あ-1');
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('あ-2');
		// tr-b is outside the tr-a subtree
		await expect(page.getByTestId('progress')).toHaveText('3 / 3');
	});

	test('a chapter session still walks nested tracks in pre-order', async ({ page }) => {
		await setupPractice(
			page,
			{
				transcribe: [{ text: 'x' }],
				tracks: [
					{ id: 'tr-a', chapterId: 'ch-ja-01', name: 'A', order: 1, parentId: null },
					{ id: 'tr-a-1', chapterId: 'ch-ja-01', name: 'A-1', order: 1, parentId: 'tr-a' }
				],
				sentences: [
					{ id: 's-a1', chapterId: 'ch-ja-01', trackId: 'tr-a-1', text: 'あ-1', language: 'ja', order: 1 },
					{ id: 's-a', chapterId: 'ch-ja-01', trackId: 'tr-a', text: 'あ', language: 'ja', order: 1 }
				]
			},
			'ch-ja-01'
		);

		await expect(page.getByTestId('chapter-name')).toHaveText('日本語');
		await expect(page.getByTestId('sentence-text')).toHaveText('あ');
		await expect(page.getByTestId('progress')).toHaveText('A · 1 / 2');
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('progress')).toHaveText('A-1 · 2 / 2');
	});
```

- [ ] **Step 2: RED を確認する**

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list`
Expected: FAIL — `?node=` が読まれず `ID が指定されていません` になる

- [ ] **Step 3: state と derived を差し替える**

`src/routes/practice/+page.svelte`:

```ts
	// Breadcrumb of the node the session started from (chapter → ancestors → self).
	let nodeTrail = $state<NodeRef[]>([]);
	// A chapter-started session may show the current track name in the progress
	// line. A track-started session already shows it in the breadcrumb, so the
	// progress line stays plain.
	let startedFromChapter = $state(false);
	// Node (chapter or track) the session belongs to. Written into the progress
	// record's `chapterId` field, which predates tracks.
	let sessionNodeId: string | null = null;
```

`chapterName` と `currentChapterId` の宣言は削除する。derived を追加:

```ts
	let nodeTrailText = $derived(nodeTrail.map((n) => n.name).join(' › '));
```

`showTrackBadge`（`:147`）:

```ts
	let showTrackBadge = $derived(
		startedFromChapter && chapterTrackCount > 1 && currentTrackName !== ''
	);
```

import に `getNodeTrail` / `getNodeSentences` と型 `NodeRef` を追加する（`getChapterSentences` の
import は未使用になるので外す）。

- [ ] **Step 4: 進捗保存を nodeId 基準にする**

`:822-830`:

```ts
		if (!sessionNodeId) return;
		savePracticeProgress({
			// The progress record predates tracks; its `chapterId` field now
			// carries the session's node id (chapter or track).
			chapterId: sessionNodeId,
```

- [ ] **Step 5: onMount を差し替える**

```ts
		const rawNodeId = page.url.searchParams.get('node');
		if (!rawNodeId) {
			errorMessage = 'ID が指定されていません';
			endedEarly = true;
			phase = 'summary';
			return;
		}

		const allChapters = loadChapters();
		const allTracks = loadTracks();
		const trail = getNodeTrail(rawNodeId, allChapters, allTracks);

		if (trail.length === 0) {
			errorMessage = `ノードが見つかりません: ${rawNodeId}`;
			endedEarly = true;
			phase = 'summary';
			return;
		}

		nodeTrail = trail;
		startedFromChapter = trail.length === 1 && trail[0].type === 'chapter';

		const nodeSentences = getNodeSentences(rawNodeId, allChapters, allTracks, loadSentences());

		if (nodeSentences.length === 0) {
			errorMessage = 'このノードには文がありません';
			endedEarly = true;
			phase = 'summary';
			return;
		}

		sentences = nodeSentences;
		currentIndex = 0;
		sessionNodeId = rawNodeId;
		tracks = allTracks;

		const saved = loadPracticeProgress(rawNodeId);
		const hasProgress =
			saved !== null &&
			(saved.currentIndex > 0 || saved.completedCount > 0 || saved.skippedCount > 0);
		if (hasProgress && saved) {
			pendingRestore = saved;
			restoreDialogOpen = true;
		} else {
			startSession();
		}
	});
```

- [ ] **Step 6: ヘッダと復元ダイアログの文言を差し替える**

`:993-995`:

```svelte
			<h1 class="min-w-0 flex-1 truncate text-sm font-bold sm:text-base" data-testid="chapter-name">
				{nodeTrailText}
			</h1>
```

`:1339`:

```svelte
					{nodeTrailText}の練習途中の状態が残っています。
```

**進捗行（`:1008-1020`）は一切触らない。** DOM 構造が 11 箇所の完全一致 assert の契約。

- [ ] **Step 7: GREEN を確認する**

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list`
Expected: 全 PASS。特に既存の `Practice — Tracks` の `基本 · 1 / 2` が緑のまま（章開始ケースの回帰ガード）

- [ ] **Step 8: `npm run check`**

Expected: 0 エラー

- [ ] **Step 9: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/routes/practice/+page.svelte tests/practice.spec.ts
git commit -m "feat: start a practice session from any node"
```

---

### Task 10: 管理画面の chapters タブを 1 本の木にする（track CRUD を含む）

**Files:**
- Modify: `src/routes/manage/+page.svelte` の state（`:102-158`）、`:426-530`（track 操作）、`:617-631`（`cancelAllEdits`）、`:649-658`（自動 focus）、`:881-906`（`addTrackForm` snippet）、`:940-1141`（chapters パネル）、`:1768-1788` 付近（削除ダイアログ）
- Test: `tests/manage.spec.ts`

**Interfaces:**
- Consumes: `flattenTrackTree`, `getChapterTracks`, `getNodeDescendantTrackIds`, `addTrack(chapterId, name, parentTrackId)`, `updateTrack`, `deleteTrack`
- Produces: chapters タブで章 + トラックの CRUD が完結する。track 行の testid は `tree-track-row` / `tree-track-name` / `tree-track-up` / `tree-track-down` / `tree-track-edit` / `tree-track-delete`（文章タブの `track-name` 等と衝突させない）

- [ ] **Step 1: E2E を先に書いて RED にする**

`tests/manage.spec.ts`:
- 章.tab用の階層シードを追加（`nestedSeed` の上に）:

```ts
const hierarchySeed = {
	chapters: [{ id: 'ch-ja-01', name: 'はじめの一歩（日本語）', parentId: null, order: 1 }],
	tracks: [
		{ id: 't1', chapterId: 'ch-ja-01', name: '基本', order: 1, parentId: null },
		{ id: 't1-1', chapterId: 'ch-ja-01', name: '基本-1', order: 1, parentId: 't1' },
		{ id: 't1-2', chapterId: 'ch-ja-01', name: '基本-2', order: 2, parentId: 't1' },
		{ id: 't2', chapterId: 'ch-ja-01', name: '応用', order: 2, parentId: null }
	],
	sentences: [
		{ id: 's1', chapterId: 'ch-ja-01', trackId: 't1', text: '基本の文章', language: 'ja', order: 1 },
		{ id: 's2', chapterId: 'ch-ja-01', trackId: 't1-1', text: '基本1の文章', language: 'ja', order: 1 },
		{ id: 's3', chapterId: 'ch-ja-01', trackId: 't1-2', text: '基本2の文章', language: 'ja', order: 1 },
		{ id: 's4', chapterId: 'ch-ja-01', trackId: 't2', text: '応用の文章', language: 'ja', order: 1 }
	]
};
```

- `Chapter nesting` describe を `Track nesting` に置き換える（**理由**: 子チャプターは廃止され、階層はトラックが持つ）:

```ts
test.describe('Track nesting', () => {
	test('adds a child track to a track, rendering with increasing indentation', async ({
		page
	}) => {
		await gotoManage(page, seed);

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-track').click();
		await page.getByTestId('new-child-track-name').fill('子トラック');
		await page.getByTestId('confirm-add-track').click();
		await expect(
			page.getByTestId('tree-track-name').filter({ hasText: '子トラック' })
		).toBeVisible();

		await page.getByTestId('tree-track-row').filter({ hasText: '子トラック' })
			.getByTestId('add-child-track').click();
		await page.getByTestId('new-child-track-name').fill('孫トラック');
		await page.getByTestId('confirm-add-track').click();
		await expect(
			page.getByTestId('tree-track-name').filter({ hasText: '孫トラック' })
		).toBeVisible();

		const childNode = page
			.getByTestId('tree-track-name')
			.filter({ hasText: '子トラック' })
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
		const grandchildNode = page
			.getByTestId('tree-track-name')
			.filter({ hasText: '孫トラック' })
			.locator('xpath=ancestor::div[contains(@class,"tree-node")][1]');
		const childMargin = parseFloat(
			await childNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		const grandchildMargin = parseFloat(
			await grandchildNode.evaluate((el) => getComputedStyle(el).marginLeft)
		);
		expect(grandchildMargin).toBeGreaterThan(childMargin);
		expect(childMargin).toBeGreaterThan(0);
	});

	test('collapses and expands nested tracks', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await expect(page.getByTestId('tree-track-name')).toHaveCount(4);

		const chapterRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await chapterRow.locator('.expand-toggle').click();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(0);

		await chapterRow.locator('.expand-toggle').click();
		await page.getByTestId('tree-track-row').filter({ hasText: '基本' })
			.locator('.expand-toggle').click();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(2);
	});
});

test.describe('Track CRUD in the tree', () => {
	test('reorders tracks within the same parent only', async ({ page }) => {
		await gotoManage(page, hierarchySeed);

		const t1 = page.getByTestId('tree-track-row').filter({ hasText: /^基本$/ });
		const t2 = page.getByTestId('tree-track-row').filter({ hasText: '応用' });

		await expect(t1.getByTestId('tree-track-up')).toBeDisabled();
		await expect(t1.getByTestId('tree-track-down')).toBeEnabled();
		await expect(t2.getByTestId('tree-track-down')).toBeDisabled();
		// A lone child has no siblings to swap with
		await expect(
			page.getByTestId('tree-track-row').filter({ hasText: '基本-1' })
				.getByTestId('tree-track-up')
		).toBeDisabled();

		await t2.getByTestId('tree-track-up').click();
		await expect(page.getByTestId('tree-track-row').nth(0)).toContainText('応用');
	});

	test('renames a track from its row', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await page.getByTestId('tree-track-row').filter({ hasText: '応用' })
			.getByTestId('tree-track-edit').click();
		await page.getByTestId('edit-track-name').fill('上級');
		await page.getByTestId('confirm-edit-track').click();
		await expect(page.getByTestId('tree-track-name').filter({ hasText: '上級' })).toBeVisible();
	});

	test('rejects an empty child track name', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await page.getByTestId('tree-track-row').filter({ hasText: '応用' })
			.getByTestId('add-child-track').click();
		await page.getByTestId('confirm-add-track').click();
		await expect(page.getByTestId('track-validation-error')).toBeVisible();
	});

	test('deleting a track removes its descendant tracks and sentences', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await page.getByTestId('tree-track-row').filter({ hasText: /^基本$/ })
			.getByTestId('tree-track-delete').click();
		await expect(page.getByTestId('delete-track-preview')).toContainText('3');
		await page.getByTestId('confirm-delete-track').click();

		await expect(page.getByTestId('tree-track-name')).toHaveCount(1);
		await expect(page.getByTestId('tree-track-name').filter({ hasText: '応用' })).toBeVisible();

		await page.getByRole('tab', { name: '文章' }).click();
		await expect(page.getByTestId('sentence-text')).toHaveCount(1);
	});
});
```

- `Chapter CRUD` の `rejects empty child chapter name with inline error and keeps store intact` を
  トラック版に置き換える（**理由**: 「+ 子」 novella track のみになる）:

```ts
	test('rejects empty child track name with inline error and keeps store intact', async ({
		page
	}) => {
		await gotoManage(page, seed);
		const before = await page.evaluate((key) => localStorage.getItem(key), 'oboeru:v1');

		const jaRow = page.locator('.chapter-row', { hasText: 'はじめの一歩（日本語）' });
		await jaRow.getByTestId('add-child-track').click();
		await page.getByTestId('confirm-add-track').click();
		await expect(page.getByTestId('track-validation-error')).toBeVisible();

		const after = await page.evaluate((key) => localStorage.getItem(key), 'oboeru:v1');
		expect(after).toBe(before);
	});
```

- `Chapter delete with descendants` の `dismissing confirm keeps everything unchanged` を書き換え（**理由**: 子章の展開が不要になり、移行後のトラックを確認する形になる）:

```ts
	test('dismissing confirm keeps everything unchanged', async ({ page }) => {
		await gotoManage(page, nestedSeed);

		const parentRow = page.locator('.chapter-row', { hasText: '親チャプター' });
		await parentRow.locator('.expand-toggle').click();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(2);

		await parentRow.getByTestId('delete-chapter').click();
		await page.getByTestId('cancel-delete-chapter').click();

		await expect(
			page.getByTestId('chapter-name').filter({ hasText: '親チャプター' })
		).toBeVisible();
		await expect(page.getByTestId('tree-track-name')).toHaveCount(2);

		// Sentences live in the 文章 tab.
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '親の文章' })
		).toBeVisible();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '子の文章' })
		).toBeVisible();
	});
```

- `Track groups` describe から **4 本を削除**する（**理由**: トラックの追加・改名・並び替え・削除は
  chapters タブへ移送し、文章タブからは操作できなくなるため。Task 12 で 文章タブ前提の
  形に残す 3 本だけを残す）:
  - `adds a track and renames it`
  - `deleting a track removes its sentences`
  - `reorders tracks within a chapter, boundary buttons disabled`
  - `add-track form renders exactly once in the all-tracks view`

- [ ] **Step 2: RED を確認する**

Run: `npx playwright test tests/manage.spec.ts --workers=1 --reporter=list`
Expected: FAIL — `add-child-track` / `tree-track-row` / `delete-track-preview` が存在しない

- [ ] **Step 3: state を置き換える**

`src/routes/manage/+page.svelte` の state ブロックを:

```ts
	// One expansion set for chapters and tracks alike (node id keyed)
	let expandedNodes = $state<Set<string>>(new Set());

	// Chapter form state
	let editingChapterId = $state<string | null>(null);
	let editingChapterName = $state('');
	let addingRootChapter = $state(false);
	let newRootName = $state('');
	let chapterValidationError = $state('');

	// Track form state (the chapters tab is the only place tracks are managed)
	let editingTrackId = $state<string | null>(null);
	let editingTrackName = $state('');
	// Which node the inline "add child track" form is anchored to
	let addingChildTrackToId = $state<string | null>(null);
	let addingChildTrackIsChapter = $state(false);
	let newTrackName = $state('');
	let trackValidationError = $state('');
```

削除する宣言: `expandedChapters`, `addingChildToId`, `newChildName`, `addingTrackToChapterId`,
`addingTrackToTrackId`, `newChildNameRef`。`collapsedTracks` は 文章タブ用なので**残す**。

`cancelAllEdits`（`:617-631`）:

```ts
	function cancelAllEdits() {
		editingChapterId = null;
		addingRootChapter = false;
		addingSentence = false;
		editingSentenceId = null;
		addingChildTrackToId = null;
		addingChildTrackIsChapter = false;
		newTrackName = '';
		editingTrackId = null;
		editingTrackName = '';
		trackValidationError = '';
		sentenceValidationError = '';
		chapterValidationError = '';
	}
```

自動 focus の `$effect`（`:650-658`）:

```ts
	$effect(() => {
		if (addingRootChapter) newRootNameRef?.focus();
		if (editingChapterId) editChapterNameRef?.focus();
		if (addingSentence) newSentenceTextRef?.focus();
		if (editingSentenceId) editSentenceTextRef?.focus();
		if (addingChildTrackToId) newTrackNameRef?.focus();
		if (editingTrackId) editTrackNameRef?.focus();
	});
```

- [ ] **Step 4: ツリー用のヘルパーを追加する**

`// --- Track operations ---`（`:426`）の直前に:

```ts
	// --- Tree operations (chapters + tracks share one tree) ---

	function getTrackChildren(chapterId: string, parentTrackId: string | null): Track[] {
		return tracks
			.filter((t) => t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId)
			.sort((a, b) => a.order - b.order);
	}

	function findNode(id: string): Chapter | Track | null {
		return tracks.find((t) => t.id === id) ?? chapters.find((c) => c.id === id) ?? null;
	}

	function nodeChapterId(node: Chapter | Track): string {
		return 'chapterId' in node ? node.chapterId : node.id;
	}

	function isExpanded(id: string): boolean {
		return expandedNodes.has(id);
	}

	function toggleExpand(id: string) {
		const newSet = new Set(expandedNodes);
		if (newSet.has(id)) {
			newSet.delete(id);
		} else {
			newSet.add(id);
		}
		expandedNodes = newSet;
	}

	function expandNode(id: string) {
		const newSet = new Set(expandedNodes);
		newSet.add(id);
		expandedNodes = newSet;
	}

	function getOwnSentenceCount(trackId: string): number {
		return sentences.filter((s) => s.trackId === trackId).length;
	}

	function getChapterSentenceTotal(chapterId: string): number {
		return flattenTrackTree(chapterId, tracks).reduce(
			(sum, t) => sum + getOwnSentenceCount(t.id),
			0
		);
	}

	function startAddChildTrack(node: Chapter | Track): void {
		cancelAllEdits();
		addingChildTrackToId = node.id;
		addingChildTrackIsChapter = !('chapterId' in node);
		newTrackName = '';
		trackValidationError = '';
		expandNode(node.id);
	}

	function confirmAddChildTrack(): void {
		if (!addingChildTrackToId) return;
		if (!newTrackName.trim()) {
			trackValidationError = 'トラック名は必須です';
			return;
		}
		const node = findNode(addingChildTrackToId);
		if (!node) return;
		addTrack(
			nodeChapterId(node),
			newTrackName.trim(),
			addingChildTrackIsChapter ? null : addingChildTrackToId
		);
		addingChildTrackToId = null;
		addingChildTrackIsChapter = false;
		newTrackName = '';
		trackValidationError = '';
		refreshData();
		expandNode(node.id);
	}

	function cancelAddChildTrack(): void {
		addingChildTrackToId = null;
		addingChildTrackIsChapter = false;
		newTrackName = '';
		trackValidationError = '';
	}
```

`getTrackSiblings` / `canMoveTrack` / `moveTrack`（`:504-530`）を同一親 versions に:

```ts
	function getTrackSiblings(track: Track): Track[] {
		return getTrackChildren(track.chapterId, track.parentId ?? null);
	}

	function canMoveTrack(track: Track, direction: -1 | 1): boolean {
		const siblings = getTrackSiblings(track);
		const idx = siblings.findIndex((t) => t.id === track.id);
		if (idx === -1) return false;
		const target = idx + direction;
		return target >= 0 && target < siblings.length;
	}

	function moveTrack(track: Track, direction: -1 | 1): void {
		const siblings = getTrackSiblings(track);
		const idx = siblings.findIndex((t) => t.id === track.id);
		const target = idx + direction;
		if (idx === -1 || target < 0 || target >= siblings.length) return;
		const other = siblings[target];
		// Swap order values so the tree re-sorts correctly
		updateTrack(track.id, { order: other.order });
		updateTrack(other.id, { order: track.order });
		refreshData();
	}
```

`startAddChapter`（子チャプター用 `:327-360`）は削除する。`startEditChapter` / `confirmEditChapter` /
`cancelEditChapter` / `canMove` / `moveChapter` / `startEditTrack` / `confirmEditTrack` /
`cancelEditTrack` / `confirmDeleteChapter` / `confirmDeleteTrack` は既存実装のまま使う。

import に `flattenTrackTree`, `getNodeDescendantTrackIds` を追加する。

- [ ] **Step 5: chapters パネルを 1 本の木に置き換える**

`:981-1139`（`chapterNode` snippet と `chapter-tree` コンテナ）を削除して、代わりに 3 つの snippet
（`nodeRow` = 1 行だけ、`trackBranch` = トラックの再帰、`chapterBranch` = 章 1 行 + トラック）を置く:

```svelte
			{#snippet nodeRow(opts: {
				// Exactly one of chapter / track is non-null; `kind` is derived from it.
				chapter: Chapter | null;
				track: Track | null;
				id: string;
				name: string;
				depth: number;
				hasChildren: boolean;
				count: number;
			})}
				{@const kind = opts.chapter ? 'chapter' : 'track'}
				{@const node = opts.chapter ?? (opts.track as Track)}
				<div
					class={kind === 'chapter' ? 'chapter-row' : 'track-row'}
					role="treeitem"
					aria-selected="false"
					style:margin-left={`${opts.depth * 1.5}rem`}
				>
					<div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
						<Button
							variant="ghost"
							size="icon-xs"
							class="expand-toggle h-11 w-11 text-xs text-muted-foreground"
							onclick={() => toggleExpand(opts.id)}
							aria-label={isExpanded(opts.id) ? '折りたたむ' : '展開する'}
							aria-expanded={isExpanded(opts.id)}
						>
							{#if opts.hasChildren}
								{isExpanded(opts.id) ? '▼' : '▶'}
							{:else}
								<span class="inline-block w-4"></span>
							{/if}
						</Button>

						{#if (kind === 'chapter' ? editingChapterId : editingTrackId) === opts.id}
							<div class="flex flex-1 flex-col gap-2 rounded-md border border-border bg-muted/50 p-2">
								<Input
									type="text"
									bind:value={kind === 'chapter' ? editingChapterName : editingTrackName}
									bind:ref={kind === 'chapter' ? editChapterNameRef : editTrackNameRef}
									onkeydown={(e) =>
										handleChapterKeydown(
											e,
											kind === 'chapter' ? confirmEditChapter : confirmEditTrack,
											kind === 'chapter' ? cancelEditChapter : cancelEditTrack
										)}
									data-testid={kind === 'chapter' ? 'edit-chapter-name' : 'edit-track-name'}
								/>
								{#if kind === 'chapter' ? chapterValidationError : trackValidationError}
									<div
										class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
										role="alert"
										data-testid={kind === 'chapter' ? 'chapter-validation-error' : 'track-validation-error'}
									>
										{kind === 'chapter' ? chapterValidationError : trackValidationError}
									</div>
								{/if}
								<div class="flex gap-2">
									<Button
										size="sm"
										class="h-11"
										onclick={kind === 'chapter' ? confirmEditChapter : confirmEditTrack}
										data-testid={kind === 'chapter' ? 'confirm-edit-chapter' : 'confirm-edit-track'}
									>
										保存
									</Button>
									<Button
										size="sm"
										variant="outline"
										class="h-11"
										onclick={kind === 'chapter' ? cancelEditChapter : cancelEditTrack}
									>
										キャンセル
									</Button>
								</div>
							</div>
						{:else}
							{#if kind === 'chapter'}
								{#each chapterLanguages(opts.id) as lang (lang)}
									{@render languageBadge(lang, lang.toUpperCase())}
								{/each}
							{/if}
							<span
								class="min-w-0 flex-1 truncate font-medium"
								data-testid={kind === 'chapter' ? 'chapter-name' : 'tree-track-name'}
							>
								{opts.name}
							</span>
							<span class="sentence-count text-xs whitespace-nowrap text-muted-foreground">
								({opts.count}文)
							</span>
							{#if kind === 'chapter'}
								<div class="flex shrink-0 flex-wrap items-center gap-2">
									<Button
										size="sm"
										variant="outline"
										onclick={() => startAddChildTrack(node)}
										aria-label="トラックを追加"
										data-testid="add-child-track"
										class="h-11 min-w-16 sm:h-8 sm:min-w-14"
									>
										+ トラック
									</Button>
									<div class="flex gap-1" role="group" aria-label="並び替え">
										<Button
											size="sm"
											variant="outline"
											onclick={() => moveChapter(node as Chapter, -1)}
											aria-label="上へ移動"
											data-testid="move-chapter-up"
											disabled={!canMove(node as Chapter, -1)}
											class="h-11 min-w-11 sm:h-8 sm:min-w-8"
										>
											↑
										</Button>
										<Button
											size="sm"
											variant="outline"
											onclick={() => moveChapter(node as Chapter, 1)}
											aria-label="下へ移動"
											data-testid="move-chapter-down"
											disabled={!canMove(node as Chapter, 1)}
											class="h-11 min-w-11 sm:h-8 sm:min-w-8"
										>
											↓
										</Button>
									</div>
									<Button
										size="sm"
										variant="outline"
										onclick={() => startEditChapter(node as Chapter)}
										aria-label="名前を編集"
										data-testid="edit-chapter"
										class="h-11 min-w-16 sm:h-8 sm:min-w-14"
									>
										編集
									</Button>
									<Button
										size="sm"
										variant="destructive"
										onclick={() => {
											deleteChapterTarget = node as Chapter;
											deleteChapterDialogOpen = true;
										}}
										aria-label="削除"
										data-testid="delete-chapter"
										class="h-11 min-w-16 sm:h-8 sm:min-w-14"
									>
										削除
									</Button>
								</div>
							{:else}
								<div class="flex shrink-0 flex-wrap items-center gap-2">
									<Button
										size="sm"
										variant="outline"
										onclick={() => startAddChildTrack(node)}
										aria-label="子トラックを追加"
										data-testid="add-child-track"
										class="h-11 min-w-16 sm:h-8 sm:min-w-14"
									>
										+ 子
									</Button>
									<div class="flex gap-1" role="group" aria-label="トラック並び替え">
										<Button
											size="sm"
											variant="outline"
											onclick={() => moveTrack(node, -1)}
											aria-label="上へ移動"
											data-testid="tree-track-up"
											disabled={!canMoveTrack(node, -1)}
											class="h-11 min-w-11 sm:h-8 sm:min-w-8"
										>
											↑
										</Button>
										<Button
											size="sm"
											variant="outline"
											onclick={() => moveTrack(node, 1)}
											aria-label="下へ移動"
											data-testid="tree-track-down"
											disabled={!canMoveTrack(node, 1)}
											class="h-11 min-w-11 sm:h-8 sm:min-w-8"
										>
											↓
										</Button>
									</div>
									<Button
										size="sm"
										variant="outline"
										onclick={() => startEditTrack(node)}
										aria-label="トラック名を編集"
										data-testid="tree-track-edit"
										class="h-11 min-w-16 sm:h-8 sm:min-w-14"
									>
										編集
									</Button>
									<Button
										size="sm"
										variant="destructive"
										onclick={() => {
											deleteTrackTarget = node;
											deleteTrackDialogOpen = true;
										}}
										aria-label="トラックを削除"
										data-testid="tree-track-delete"
										class="h-11 min-w-16 sm:h-8 sm:min-w-14"
									>
										削除
									</Button>
								</div>
							{/if}
						{/if}
					</div>

					{#if addingChildTrackToId === opts.id}
						<div class="child-form ml-10 mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-2">
							<Input
								type="text"
								bind:value={newTrackName}
								bind:ref={newTrackNameRef}
								placeholder="トラック名"
								onkeydown={(e) => handleChapterKeydown(e, confirmAddChildTrack, cancelAddChildTrack)}
								data-testid="new-child-track-name"
							/>
							{#if trackValidationError}
								<div
									class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
									role="alert"
									data-testid="track-validation-error"
								>
									{trackValidationError}
								</div>
							{/if}
							<div class="flex gap-2">
								<Button size="sm" class="h-11" onclick={confirmAddChildTrack} data-testid="confirm-add-track">追加</Button>
								<Button size="sm" variant="outline" class="h-11" onclick={cancelAddChildTrack}>キャンセル</Button>
							</div>
						</div>
					{/if}
				</div>
			{/snippet}

			{#snippet trackBranch(chapterId: string, parentTrackId: string | null, depth: number)}
				{#each getTrackChildren(chapterId, parentTrackId) as track (track.id)}
					{@render nodeRow({
						chapter: null,
						track,
						id: track.id,
						name: track.name,
						depth,
						hasChildren: getTrackChildren(track.chapterId, track.id).length > 0,
						count: getOwnSentenceCount(track.id)
					})}
					{#if isExpanded(track.id)}
						{@render trackBranch(track.chapterId, track.id, depth + 1)}
					{/if}
				{/each}
			{/snippet}

			{#snippet chapterBranch(chapter: Chapter, depth: number)}
				{@render nodeRow({
					chapter,
					track: null,
					id: chapter.id,
					name: chapter.name,
					depth,
					hasChildren: getTrackChildren(chapter.id, null).length > 0,
					count: getChapterSentenceTotal(chapter.id)
				})}
				{#if isExpanded(chapter.id)}
					<div class="children" role="group">
						{@render trackBranch(chapter.id, null, depth + 1)}
					</div>
				{/if}
			{/snippet}

			<div class="chapter-tree mt-2" role="tree" aria-label="チャプターとトラックのツリー">
				{#each flatChapters.filter((c) => c.parentId === null) as chapter (chapter.id)}
					{@render chapterBranch(chapter, 0)}
				{/each}
			</div>
```

**設計上の要点**: `nodeRow` は **1 行だけ**を返す（子ノードを描かない）。再帰は
`trackBranch` が担当し、折りたたみは `isExpanded` で判定する。これで深さの上限を
上将に埋めずに済む。

- [ ] **Step 6: 削除ダイアログのプレビューを出す**

derived を追加:

```ts
	let deleteTrackPreview = $derived.by(() => {
		if (!deleteTrackTarget) return { tracks: 0, sentences: 0 };
		const scope = getNodeDescendantTrackIds(deleteTrackTarget.id, tracks);
		return {
			tracks: scope.size,
			sentences: sentences.filter((s) => scope.has(s.trackId)).length
		};
	});
```

`deleteTrackDialogOpen` の AlertDialog 本文を:

```svelte
				<p data-testid="delete-track-preview">
					{deleteTrackPreview.tracks}件のトラックと {deleteTrackPreview.sentences}件の文章を削除しますか？
				</p>
```

- [ ] **Step 7: GREEN を確認する**

Run: `npx playwright test tests/manage.spec.ts --workers=1 --reporter=list`
Expected: Step 1 で削除した 4 本を除き全 PASS

- [ ] **Step 8: `npm run check`**

Expected: 0 エラー

- [ ] **Step 9: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/routes/manage/+page.svelte tests/manage.spec.ts
git commit -m "feat: manage chapters and tracks in one tree"
```

---

### Task 11: 管理タブのインライン本文編集

**Files:**
- Modify: `src/routes/manage/+page.svelte`（`nodeRow` snippet 内・行 div の直後）
- Test: `tests/manage.spec.ts`

**Interfaces:**
- Consumes: `updateSentence`, Task 10 の `nodeRow` / `isExpanded`
- Produces: **トラック行の展開時**に、そのトラックの**直属**の文が `<textarea data-testid="inline-sentence-text">` で並ぶ。Enter / blur で保存される。IME 変換確定の Enter では保存しない。**章行には出ない**（同じ文に 2 つの編集框ができるため）

- [ ] **Step 1: E2E を先に書いて RED にする**

`tests/manage.spec.ts` の `Track nesting` describe に追加:

```ts
	test('edits a sentence inline from a track row and keeps it after reload', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await expandChapter(page, 'はじめの一歩（日本語）');

		const input = page.getByTestId('inline-sentence-text').first();
		await input.fill('書き換えた文です。');
		await input.press('Enter');

		await page.reload();
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: '書き換えた文です。' })
		).toBeVisible();
	});

	test('inline editing saves on blur and rejects an empty text', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await expandChapter(page, 'はじめの一歩（日本語）');

		await page.getByTestId('inline-sentence-text').first().fill('blr で保存');
		await page.locator('.chapter-row').first().click();
		await page.getByRole('tab', { name: '文章' }).click();
		await expect(
			page.getByTestId('sentence-text').filter({ hasText: 'blr で保存' })
		).toBeVisible();

		await page.getByRole('tab', { name: 'チャプター' }).click();
		await expandChapter(page, 'はじめの一歩（日本語）');
		await page.getByTestId('inline-sentence-text').first().fill('');
		await page.getByTestId('inline-sentence-text').first().press('Enter');
		await expect(page.getByTestId('inline-sentence-error')).toBeVisible();
	});

	test('only track rows inline their own sentences, never the chapter row', async ({
		page
	}) => {
		await gotoManage(page, hierarchySeed);
		// Chapter expanded: 基本 and 応用 rows are visible, neither is expanded yet
		await expandChapter(page, 'はじめの一歩（日本語）');
		await expect(page.getByTestId('inline-sentence-text')).toHaveCount(0);

		// Expanding 基本 inlines exactly 基本's own sentence (1), not its children's
		await page
			.getByTestId('tree-track-row')
			.filter({ hasText: '基本' })
			.locator('.expand-toggle')
			.click();
		await expect(page.getByTestId('inline-sentence-text')).toHaveCount(1);

		// Expanding its child 基本-1 adds that child's own sentence → 2
		await page
			.getByTestId('tree-track-row')
			.filter({ hasText: '基本-1' })
			.locator('.expand-toggle')
			.click();
		await expect(page.getByTestId('inline-sentence-text')).toHaveCount(2);
	});
```

ヘルパーを `tests/manage.spec.ts` の `pickOption` の次に追加:

```ts
async function expandChapter(page: Page, name: string): Promise<void> {
	const row = page.locator('.chapter-row', { hasText: name });
	const toggle = row.locator('.expand-toggle');
	if ((await toggle.textContent())?.includes('▶')) {
		await toggle.click();
	}
}
```

- [ ] **Step 2: RED を確認する**

Run: `npx playwright test tests/manage.spec.ts --workers=1 --reporter=list -g "inline"`
Expected: FAIL — `inline-sentence-text` が存在しない

- [ ] **Step 3: state と保存関数を追加する**

```ts
	// Inline sentence editing from the tree (text only — delete, language and
	// order stay in the 文章 tab)
	let inlineDrafts = $state<Record<string, string>>({});
	let inlineError = $state<Record<string, string>>({});

	/** A track's own sentences, ordered. Descendant tracks are never included —
	    the chapter row deliberately has no inline editor, otherwise the same
	    sentence would get two editors. */
	function ownSentencesOf(trackId: string): Sentence[] {
		return sentences.filter((s) => s.trackId === trackId).sort((a, b) => a.order - b.order);
	}

	/**
	 * Save on Enter or blur. `e.isComposing` is true while an IME candidate
	 * window is open, so the Enter that commits a Japanese conversion must not
	 * save — otherwise every conversion keystroke persists a half-typed text.
	 */
	function saveInlineSentence(sentenceId: string, e?: KeyboardEvent): void {
		if (e && (e.isComposing || e.keyCode === 229)) return;
		const draft = inlineDrafts[sentenceId];
		if (draft === undefined) return;
		if (!draft.trim()) {
			inlineError = { ...inlineError, [sentenceId]: '文章テキストは必須です' };
			return;
		}
		updateSentence(sentenceId, { text: draft });
		const nextDrafts = { ...inlineDrafts };
		delete nextDrafts[sentenceId];
		inlineDrafts = nextDrafts;
		const nextErrors = { ...inlineError };
		delete nextErrors[sentenceId];
		inlineError = nextErrors;
		refreshData();
	}
```

- [ ] **Step 4: UI を追加する**

`nodeRow` snippet 内、行 div（`flex flex-wrap items-center gap-2 rounded-md …`）を閉じた直後、
`{#if addingChildTrackToId === opts.id}` の**前**に差し込む:

```svelte
					{#if kind === 'track' && isExpanded(opts.id)}
						<div
							class="inline-sentences ml-10 mt-1 flex flex-col gap-2"
							data-testid="inline-sentence-list"
						>
							{#each ownSentencesOf(opts.id) as sentence (sentence.id)}
								<div class="flex flex-col gap-1">
									<Textarea
										rows={2}
										value={inlineDrafts[sentence.id] ?? sentence.text}
										oninput={(e) => {
											inlineDrafts = { ...inlineDrafts, [sentence.id]: e.currentTarget.value };
										}}
										onkeydown={(e) => {
											if (e.key === 'Enter' && !e.shiftKey) {
												e.preventDefault();
												saveInlineSentence(sentence.id, e);
											}
										}}
										onblur={() => saveInlineSentence(sentence.id)}
										aria-label={`文 ${sentence.order}: ${sentence.text}`}
										data-testid="inline-sentence-text"
									/>
									{#if inlineError[sentence.id]}
										<div
											class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
											role="alert"
											data-testid="inline-sentence-error"
										>
											{inlineError[sentence.id]}
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
```

- [ ] **Step 5: GREEN を確認する**

Run: `npx playwright test tests/manage.spec.ts --workers=1 --reporter=list -g "inline"`
Expected: 全 PASS

- [ ] **Step 6: `npm run check` と IME ガードのレビュー**

Run: `npm run check`
Expected: 0 エラー

**レビュー項目（自動テストでは出せないので必ずコードを読む）**:
- Enter ハンドラは `e.isComposing` を `saveInlineSentence` に渡し、blur ハンドラは渡さない。
  IME 確定直後の Enter は composition 中なので保存されず、確定テキストは**次の** Enter か blur で
  保存される。これが仕様どおり
- `KeyboardEvent.keyCode` は lib.dom に存在するので `as any` は不要。`@ts-expect-error` を
  使わないこと
- 空文字の Enter はエラーを出して保存しない（入力値は空のまま残る）

- [ ] **Step 7: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/routes/manage/+page.svelte tests/manage.spec.ts
git commit -m "feat: edit sentence text inline from the manage tree"
```

---

### Task 12: sentences タブの簡略化（pre-order 並び + 階層 select）

**Files:**
- Modify: `src/routes/manage/+page.svelte:220-233`（group 並び）、`:881-906`（`addTrackForm` snippet）、`:1204-1219`（+ トラックボタン）、`:1278-1297` と編集フォームのトラック select、`:1332-1436`（track actions）
- Test: `tests/manage.spec.ts`

**Interfaces:**
- Produces: トラックの追加・改名・並び替え・削除は chapters タブのみ。文章タブのグループは `flattenTrackTree` の pre-order 順。トラック select は深さに応じた全角スペースのインデント付き（**アクセシブルネームはトラック名のまま**）

- [ ] **Step 1: E2E を先に書いて RED にする**

`tests/manage.spec.ts` の `Track groups` describe 末尾に 2 本追加:

```ts
	test('groups are listed in the tree pre-order', async ({ page }) => {
		await gotoManage(page, hierarchySeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');
		await expect(page.getByTestId('track-name')).toHaveText(['基本', '基本-1', '基本-2', '応用']);
	});

	test('the track selector can pick a nested track and assigns the sentence to it', async ({
		page
	}) => {
		await gotoManage(page, hierarchySeed);
		await page.getByRole('tab', { name: '文章' }).click();
		await pickOption(page, 'chapter-filter', 'はじめの一歩（日本語）');

		await page.getByTestId('add-sentence').click();
		await expect(page.getByTestId('sentence-form-track')).toContainText('基本');
		await page.getByTestId('new-sentence-text').fill('子トラックに入れる。');
		await pickOption(page, 'sentence-form-track', '基本-1');
		await page.getByTestId('confirm-add-sentence').click();

		await expect(
			trackGroup(page, '基本-1')
				.getByTestId('sentence-text')
				.filter({ hasText: '子トラックに入れる。' })
		).toBeVisible();
	});
```

**置き換えた 4 本の再配置について**: `adds a track and renames it` / `deleting a track removes its
sentences` / `reorders tracks within a chapter, boundary buttons disabled` は Task 10 の
`Track CRUD in the tree` に内容 흡igen（`renames a track from its row` / `deleting a track removes its
descendant tracks and sentences` / `reorders tracks within the same parent only`）し、
`add-track form renders exactly once in the all-tracks view` は 文章タブの `+ トラック` ボタン
を撤去したことで成立しなくなったため削除した（追加フォームは chapters タブに 1 つだけあり、
`rejects empty child track name` が同じ検証をカバーしている）。

- [ ] **Step 2: RED を確認する**

Run: `npx playwright test tests/manage.spec.ts --workers=1 --reporter=list -g "Track groups"`
Expected: FAIL — グループ順が `track.order` のみで `基本-1` が `基本-2` の後ろになる

- [ ] **Step 3: group の並び順を pre-order にする**

`:223-228` の `chapterPos` / `groupKey` を差し替え:

```ts
		// Global pre-order position per track so nested groups follow their parent.
		const trackPos = new Map<string, number>();
		for (const ch of flatChapters) {
			for (const t of flattenTrackTree(ch.id, tracks)) {
				trackPos.set(t.id, trackPos.size);
			}
		}
		const chapterPos = new Map(flatChapters.map((c, i) => [c.id, i]));
		const groupKey = (g: TrackGroup): [number, number] => {
			if (!g.track) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
			const pos = chapterPos.get(g.track.chapterId) ?? Number.MAX_SAFE_INTEGER - 1;
			return [pos, trackPos.get(g.track.id) ?? Number.MAX_SAFE_INTEGER];
		};
```

- [ ] **Step 4: トラック CRUD の UI を撤去する**

削除する要素:
- `:1204-1219` の「+ トラックを追加」ボタンと `addTrackForm()` の条件付き描画
- `:1371-1434` の `track-actions` ブロック（並び替え / 編集 / + / 削除）
- `:1333-1356` のトラック改名インラインフォーム
- `:1438-1440` の `addTrackForm()` 描画
- snippet `addTrackForm`（`:882-906`）そのもの
- 関数 `startAddTrack` / `confirmAddTrack` / `cancelAddTrack`（`:441-468`）と state
  `addingTrackToChapterId` / `addingTrackToTrackId` は**この Task で削除**する
  （Task 10 で同じ名前の state は `addingChildTrackToId` 系に置き換わっているが、文章タブ用の
  関数は Task 10 では未削除のまま残っている。**この Step で消す**）

`groupedSentences` の `{@if group.track}` は残すが、中.actions を持たなくなったグループ見出しは
折りたたみボタンのみになる（`track-name` と `(` `N` `文)` の表示は現状のまま）。

- [ ] **Step 5: トラック select を pre-order + インデントにする**

`trackDepth` を追加:

```ts
	/** Depth of a track inside its chapter: 0 = direct child of the chapter. */
	function trackDepth(trackId: string): number {
		let depth = 0;
		let current = tracks.find((t) => t.id === trackId);
		const guard = new Set<string>();
		while (current?.parentId && !guard.has(current.id)) {
			guard.add(current.id);
			depth++;
			const parentId: string | null = current.parentId;
			current = tracks.find((t) => t.id === parentId);
		}
		return depth;
	}
```

新規文フォーム（`:1288-1295`）:

```svelte
									<Select.Content>
										{#each flattenTrackTree(newSentenceChapterId, tracks) as track (track.id)}
											<Select.Item value={track.id}>
												{'　'.repeat(trackDepth(track.id))}{track.name}
											</Select.Item>
										{:else}
											<!-- Storage auto-creates トラック1 when the chapter has none -->
											<Select.Item value="">トラック1</Select.Item>
										{/each}
									</Select.Content>
```

編集フォーム側（`editingSentenceTrackId` を使う同じ構造）も同様に書き換える。
`Select.Trigger` の `data-testid="sentence-form-track"` は**現状維持**する（`pickOption` が
新規・編集の両方で同じ testid を使っているため）。

**アクセシブルネームを壊さないこと**: インデントは全角スペースだけで、item のテキストは
トラック名の後に余白なしで続く。`getByRole('option', { name: '後半' })` はアクセシブルネームを
trim して照合するため、`pickOption(page, 'sentence-form-track', '後半')` は**そのまま通る**。
編集フォームの track 選択テスト（`edit form track selector moves a sentence between tracks`）が
そのまま緑であることを Task の Step 6 で確認する。

- [ ] **Step 6: GREEN を確認する**

Run: `npx playwright test tests/manage.spec.ts --workers=1 --reporter=list`
Expected: 全 PASS。特に既存の `sentence form track selector assigns new sentences to the chosen track` /
`edit form track selector moves a sentence between tracks` / `moving a sentence to a trackless chapter
lands in the auto-created track` が**変更なしで緑**（select のラベル互換性の回帰ガード）

- [ ] **Step 7: `npm run check`**

Expected: 0 エラー

- [ ] **Step 8: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add src/routes/manage/+page.svelte tests/manage.spec.ts
git commit -m "refactor: keep track management in the chapters tab only"
```

---

### Task 13: 全体検証と AGENTS.md 更新

**Files:**
- Modify: `AGENTS.md`
- Test: 全スイート

**Interfaces:**
- Consumes: Task 1〜12 の成果物すべて

- [ ] **Step 1: 全自動検証を通す**

Run: `npm run check && npm test && npx playwright test --workers=1`
Expected: 0 エラー / 全緑

フレーキーが出た場合は**単独再実行**で切り分ける（AGENTS.md の既知の落とし穴:
`practice.spec.ts` と `e2e-full` は並列負荷で稀に落ちる。コード起因の再現はしていない）

- [ ] **Step 2: 390px と axe を確認する**

Run: `npx playwright test tests/a11y.spec.ts tests/responsive.spec.ts --workers=1 --reporter=list`
Expected: 全 PASS。`action-zone` が `rect.bottom <= innerHeight + 1` を満たし、axe serious/critical 0

- [ ] **Step 3: AGENTS.md のデータモデル規約を差し替える**

`## データモデル規約` を:

```markdown
- **章 (ルート専用) → トラック (ネスト可) → 文** の3層。`Chapter.parentId` は型に残るが常に
  `null`（UI から設定する経路が無い）。階層は `Track.parentId` が担う。`Track.chapterId` /
  `Sentence.chapterId` は最上位章を指す冗長フィールド、`Sentence.trackId` は直接の親トラック
- 練習順 = **pre-order** (自文 → 子トラック1配下 → 子トラック2配下)、各トラック内は
  `sentence.order` 昇順。走査は `flattenTrackTree` が正
- `Track.parentId` を更新する API は存在しない（`updateTrack` の引数型から除外 +
  実行時にもキーを削除）。トラックの親は追加時に確定し、サイクルは構造的に発生しない
- インポート/エクスポートは **version 3**。v2 は `migrateToV3` で自動変換して受理、v1 は
  「対応していないバージョンです」で拒否
- 読み込みシム: `tracks` 欠落の旧データ → 章ごとに既定トラック生成 / **子チャプター →
  最上位章直下のトラック** (`tr-from-ch-<章id>`、祖先が近い順に並べて投入) / 全トラックに
  `parentId` を補う。適用後に `saveData` で書き戻し (lazy migration)
- 削除カスケード: 章 → 配下の全トラック + 全文 / トラック → 子孫トラック + 配下の全文
```

- [ ] **Step 4: AGENTS.md のディレクトリ地図と E2E 規約を更新する**

`src/lib/sentences.ts` の行に「階層純関数 (`flattenTrackTree` / `getNodeDescendantTrackIds` /
`getNodeSentences` / `getNodeTrail` / `migrateToV3`)」を追記し、
`src/routes/manage/+page.svelte` の行に「chapters タブ = 章 + トラックの1本の木 +
インライン本文編集（IME ガード付き）」を追記する。

E2E テスト規約に追記:

```markdown
- 練習の入口は `/practice?node=<章id|トラックid>`。進捗行は**章開始時のみ**トラック名付き
  (`基本 · 1 / 12`)、トラック開始時は `1 / 12`。`data-testid="progress"` の内側 DOM
  (`progress-bar` + `<span>` 2 個) は変えない — 11 箇所の完全一致 assert が依存
- 管理タブの track 行は `tree-track-*` の testid。文章タブの `track-name` / `add-track` /
  `edit-track` は**文章タブ専用**で、トラックの CRUD UI は chapters タブにのみ存在する
- インライン本文編集の Enter は IME ガード (`e.isComposing`) を通す。ガードを外すと
  日本語入力で「変換確定のたびに保存」になる
```

運用セクションに「2026-09-27: ロードマップ ③ トラック階層統合を実装（spec/plan は
`docs/superpowers/specs|plans/2026-09-27-track-hierarchy-integration*`）」を追記する。

- [ ] **Step 5: ロードマップ付録を更新する**

`docs/superpowers/specs/2026-09-22-tts-freeze-fix.md:111-119` の ③ に
「✓ 実装完了 (2026-09-27) / 実機ゲート未実施」を反映する。

- [ ] **Step 6: （任意）babel インポートの再生成**

`/home/k319/ダウンロード/babel.txt` を実データで使っている場合のみ:

- `.omo/exports/build_babel_import.py` の出力 version を 3 に変更
- `Track.parentId` は `None` のまま写出（babel.txt はフラットな `24トラック` マーカーのみ）
- `python3 .omo/exports/build_babel_import.py` を実行し、`babel-import.json` が
  コミットされない untracked のままであることを確認（AGENTS.md の禁止物）

**使わない場合はこの Step を飛ばす**（ユーザー判断）。

- [ ] **Step 7: 最終検証**

Run: `npm run check && npm test && npx playwright test --workers=1`
Expected: 0 エラー / 全緑

- [ ] **Step 8: 実機ゲートをユーザーに依頼する報告**

以下をユーザーに伝え、承認を待つ（自動検証は緑でも実機ゲートは別）:

1. 子チャプターを含む既存データがある場合、読み込み後に子トラックへ移行されている
2. 3 段以上のネストしたトラックで連続練習し、並び順 (pre-order) が意図通り
3. 管理タブからのインライン本文編集が実キーボード / IME で使える
   （日本語入力中に「確定」で保存が走らないこと）

- [ ] **Step 9: コミット（ユーザーの明示依頼がある場合のみ）**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-22-tts-freeze-fix.md
git commit -m "docs: record the track hierarchy integration in AGENTS.md"
```

---

## Self-Review

**1. Spec coverage**

| spec のセクション | 担当 Task |
|---|---|
| データモデル（`Track.parentId`、`Chapter.parentId` は null） | 1 |
| 純関数 5 つ（`flattenTrackTree` / `getNodeDescendantTrackIds` / `getNodeSentences` / `getNodeTrail` / `migrateToV3`） | 2, 3, 4, 5 |
| 移行シム（子チャプター → 子トラック、冪等、再採番、write-back） | 5 |
| インポート/エクスポート version 3（v2 自動変換 / v1 拒否） | 7 |
| 削除カスケード（トラック → 子孫） | 6 |
| 参照整合（`updateTrack` の parentId 除外、`updateSentence` の再割当は既存流用） | 6 |
| 練習画面（`?node=`、パンくず固定、進捗行 2 モード、復元） | 9 |
| トップページ（1 本の木、章=合計 / トラック=直属、`?node=` リンク） | 8 |
| 管理画面 chapters タブ（1 本の木、行アクション、並び替え、削除プレビュー） | 10 |
| 管理タブのインライン本文編集（IME ガード、空文字エラー） | 11 |
| sentences タブ（pre-order 並び、階層 select、track CRUD 撤去） | 12 |
| エラー処理 | 9（練習）、8/10（その他は既存流用） |
| テスト計画（ユニット + E2E + 既存 3 本の書き換え） | 各 Task の Step 1 |
| AGENTS.md 更新、ロードマップ更新、実機ゲート | 13 |
| スコープ外（`Chapter.parentId` 削除、ドラッグ&ドロップ、自動遷移、④⑤⑥） | 対象外（明示的に保持） |

**2. Placeholder scan**: `TBD` / `TODO` / 「後で」類なし。`as any` / `@ts-expect-error` は
global 制約で禁止。`findNode(...) as Chapter` のキャストは **UI 側の既知ノード参照**であり、
型抑制ではない（ 型安全でない是你的本意でないなら `opts` に `chapter: Chapter` / `track: Track`
を直接持たせてキャストを消す方が綺麗。実装時に `svelte-check` が通る形を優先する）。

**3. Type consistency**

- `flattenTrackTree(chapterId, tracks)` — Task 2 で定義、Task 3/8/10/12 で使用。一貫
- `getNodeSentences(nodeId, chapters, tracks, sentences)` — Task 3 で定義、Task 8/9 で使用
- `getNodeTrail(nodeId, chapters, tracks)` — Task 4 で定義、Task 9 で使用
- `migrateToV3(data: StorageData)` — Task 5 で定義、Task 7 で使用
- `addTrack(chapterId, name, parentTrackId = null)` — Task 1 でシグネチャ、Task 6 で siblings 計算
- `updateTrack(id, Partial<Omit<Track,'id'|'parentId'>>)` — Task 6 で確定。Task 10 の
  `updateTrack(track.id, { order: other.order })` は `order` のみなので型に合う
- `StorageData` — Task 1 で public 化。Task 5/7 で使用
- `NodeRef` — Task 4 で定義、Task 9 で使用
- `sessionNodeId` — Task 9 で導入。進捗保存と onMount の両方で同じ名前を使う

