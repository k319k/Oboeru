# TTS読み上げ中のフリーズ→再読込修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vosk モデルDL/WASMロードのメモリバーストが TTS 再生と衝突して Android Chrome がタブを再読込する問題を、モデルDLのストリーミング化とトップページ事前ウォームで解消する。

**Architecture:** `loadModelUrl` のJSチャンク配列蓄積 (2〜3コピー = 90MB超) を `Response.body.tee()` + `TransformStream` のストリーム処理に置換。重いWASM展開は練習開始前のトップページで `createLiveStt` シングルトン (`modelPromises`) を共有し、TTSが鳴らない画面で済ませる。言語は `last-lang` で記憶しデフォルト `ja`。

**Tech Stack:** SvelteKit + TypeScript + Svelte 5、vitest、Playwright、vosk-browser (Cache API 永続化済み)

**Spec:** `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md`

## Global Constraints

- 色分け (ライブSTT) は**必須・廃止しない**。ON/OFFトグルやデフォルトOFFは追加しない
- `terminateLiveStt()` (練習アンマウント時のモデル解放) は現状維持
- キャッシュ破損・quota・プライベートウィンドウ時も**メモリ上Blobで必ず継続** (フォールバックを壊さない)
- 各タスクで `npm run check` 0エラー + ユニットテスト全緑。E2E は最終タスクで全緑確認
- コミットは実施前にユーザー確認 (AGENTS.md: 明示依頼時のみ)。メッセージは conventional commits・英語・単一行
- 日本語 UI 文言・日本語完了報告。E2E は `?e2e=1` 以外で実モデルDLを発生させない

---

### Task 1: モデルDLのストリーミング化

**Files:**
- Modify: `src/lib/livestt/model-loader.ts:36-71` (cache-miss パスのみ)
- Test: `src/lib/livestt/model-loader.test.ts`

**Interfaces:**
- Produces (不変の契約、Task 3 が消費): `loadModelUrl(lang: 'ja' | 'en', onProgress?: (p: {loaded: number; total: number | null}) => void, signal?: AbortSignal): Promise<string | null>` — 成功時 blob URL、失敗時 null

- [ ] **Step 1: 実装 — チャンク配列を廃し tee + TransformStream に置換**

`src/lib/livestt/model-loader.ts` の cache-miss ブロック (`const reader = response.body.getReader();` から `return URL.createObjectURL(blob);` まで) を以下に置換:

```ts
		// Stream both destinations from a single fetch: the archive goes to the
		// Cache API while a byte-counting TransformStream feeds the Blob. No JS
		// chunk array is ever materialized (the old code held 2-3 copies ~90MB
		// in the JS heap, which spiked memory during TTS playback on Android).
		const [cacheStream, blobStream] = response.body.tee();

		const persist = (async () => {
			try {
				const cache = await caches.open(CACHE_NAME);
				await cache.put(url, new Response(cacheStream));
			} catch {
				// Cache write failed (quota / private window) — memory blob still works.
			}
		})();

		const totalHeader = response.headers.get('content-length');
		const total = totalHeader ? Number(totalHeader) : null;

		let loaded = 0;
		const counted = blobStream.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					loaded += chunk.byteLength;
					onProgress?.({ loaded, total });
					controller.enqueue(chunk);
				}
			})
		);

		const blob = await new Response(counted).blob();
		await persist;
		return URL.createObjectURL(blob);
```

- [ ] **Step 2: テストの契約を確認・更新**

`src/lib/livestt/model-loader.test.ts` の既存断言 (progress 配列 / blob URL / cache永続 / put失敗無視 / HTTP error / abort / timeout) は**そのまま通るはず** (ストリーム契約は同じ)。以下を確認し、不足があれば追加:

- cache-hit テスト: fetch が呼ばれない (`expect(fetchMock).not.toHaveBeenCalled()`)
- ストリームが2ブランチとも正しく消費され、cache に完全ボディが入る (`persists the download...` の `store.has(...)` + サイズ)

- [ ] **Step 3: 検証**

Run: `npm run check` と `npm test`
Expected: svelte-check 0エラー、`model-loader.test.ts` 全緑

- [ ] **Step 4: コミット** (ユーザー確認後)

```bash
git add src/lib/livestt/model-loader.ts src/lib/livestt/model-loader.test.ts
git commit -m "fix: stream stt model download instead of buffering in memory"
```

---

### Task 2: 前回練習言語の記憶モジュール

**Files:**
- Create: `src/lib/last-lang.ts`
- Test: `src/lib/last-lang.test.ts`

**Interfaces:**
- Produces (Task 3/4 が消費):
  - `getLastLang(): 'ja' | 'en'` — 未記録・不正値は `'ja'`
  - `setLastLang(lang: 'ja' | 'en'): void` — localStorage キー `oboeru:last-lang:v1` に書く
  - **SSR/Node で import しても throw しない** (`typeof localStorage === 'undefined'` ガード)

- [ ] **Step 1: 失敗テストを書く** (`src/lib/last-lang.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLastLang, setLastLang } from './last-lang';

const KEY = 'oboeru:last-lang:v1';

function stubStorage(initial: Record<string, string>) {
	const store = new Map(Object.entries(initial));
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	});
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('last-lang', () => {
	it('defaults to ja when nothing is stored', () => {
		stubStorage({});
		expect(getLastLang()).toBe('ja');
	});

	it('falls back to ja for invalid stored values', () => {
		stubStorage({ [KEY]: 'fr' });
		expect(getLastLang()).toBe('ja');
	});

	it('round-trips a stored language', () => {
		stubStorage({});
		setLastLang('en');
		expect(getLastLang()).toBe('en');
	});

	it('does not throw when localStorage is unavailable (SSR)', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(() => getLastLang()).not.toThrow();
		expect(() => setLastLang('ja')).not.toThrow();
	});
});
```

- [ ] **Step 2: 失敗確認**

Run: `npx vitest run src/lib/last-lang.test.ts`
Expected: FAIL (`./last-lang` が存在しない)

- [ ] **Step 3: 実装** (`src/lib/last-lang.ts`)

```ts
/**
 * Remembers the language of the last practice session so the top page can
 * warm the matching STT model before practice starts (freeze-fix).
 */

const KEY = 'oboeru:last-lang:v1';
const LANGS = ['ja', 'en'] as const;

export type LastLang = (typeof LANGS)[number];

function isLastLang(value: unknown): value is LastLang {
	return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

export function getLastLang(): LastLang {
	try {
		const raw = localStorage.getItem(KEY);
		return isLastLang(raw) ? raw : 'ja';
	} catch {
		return 'ja';
	}
}

export function setLastLang(lang: LastLang): void {
	try {
		localStorage.setItem(KEY, lang);
	} catch {
		// SSR/private mode — best effort.
	}
}
```

- [ ] **Step 4: 通過確認**

Run: `npx vitest run src/lib/last-lang.test.ts && npm run check`
Expected: PASS + 0エラー

- [ ] **Step 5: コミット** (ユーザー確認後)

```bash
git add src/lib/last-lang.ts src/lib/last-lang.test.ts
git commit -m "feat: remember last practice language for model warm-up"
```

---

### Task 3: トップページでのモデル事前ウォーム + 準備インジケータ

**Files:**
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: Task 1 の `createLiveStt` (シングルトン共有)、Task 2 の `getLastLang`
- Produces: トップページマウント時に `ja`/`en` モデルを **非同期・非ブロッキング**でウォーム (練習の `acquireLiveEngine` は同じ Promise を再利用)

- [ ] **Step 1: 実装** — script 内にウォーム状態と $effect を追加:

```svelte
<script lang="ts">
	import { page } from '$app/stores';
	import { Loader2 } from '@lucide/svelte';
	import { createLiveStt } from '$lib/livestt/engine';
	import { getLastLang } from '$lib/last-lang';
	import { onMount } from 'svelte';

	type WarmState = 'idle' | 'loading' | 'ready' | 'error';
	let warmState = $state<WarmState>('idle');
	let warmPercent = $state<number | null>(null);

	onMount(() => {
		// E2E drives the practice page with ?e2e=1 and mocks the engine; the top
		// page must not trigger a real model download there.
		if (import.meta.env.DEV && page.url.searchParams.get('e2e') === '1') return;
		// The studio/dev models proxy answers 503 without .stt-models/ — warm
		// silently no-ops (createLiveStt resolves null), so this is safe in dev.
		warmState = 'loading';
		createLiveStt({
			lang: getLastLang(),
			onProgress: (p) => {
				warmPercent = p.total ? Math.round((p.loaded / p.total) * 100) : null;
			}
		})
			.then(() => {
				warmState = 'ready';
			})
			.catch(() => {
				warmState = 'error';
			});
	});
</script>
```

`$app/stores` の `page` を onMount 内で読む (1回きりの判定なので非リアクティブでよい)。現在の `+page.svelte` は store import が無いため、`import { page } from '$app/stores'` と `import { onMount } from 'svelte'` を追加すること。既存の `$effect` で `chapters`/`sentences` をロードしている箇所は変えない。

- [ ] **Step 2: インジケータ UI** — `<h1>` 直後に追加:

```svelte
{#if warmState === 'loading'}
	<p
		class="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground"
		data-testid="warm-indicator"
		aria-live="polite"
	>
		<Loader2 class="size-4 animate-spin" />
		録音アシストを準備中…
		{#if warmPercent !== null}{warmPercent}%{/if}
	</p>
{/if}
```

- [ ] **Step 3: 検証**

Run: `npm run check` + `npm test`
Expected: 0エラー、既存ユニット全緑 (ウォームは `createLiveStt` 経由なので E2E モック経路に影響しない)

- [ ] **Step 4: コミット** (ユーザー確認後)

```bash
git add src/routes/+page.svelte
git commit -m "feat: warm stt model on top page before practice"
```

---

### Task 4: 練習画面 — 言語記憶 + DEVメモリログ

**Files:**
- Modify: `src/routes/practice/+page.svelte` (import 追加 + 2か所)

**Interfaces:**
- Consumes: Task 2 の `setLastLang`

- [ ] **Step 1: import 追加**

```ts
import { setLastLang } from '$lib/last-lang';
```

(`createLiveStt` の import は既に存在: `src/routes/practice/+page.svelte:18`)

- [ ] **Step 2: setLastLang 呼び出し** — `acquireLiveEngine(s)` 呼び出し直前に追加 (録音アタンプト開始時に言語を確定して保存):

`src/routes/practice/+page.svelte:794` の直前 (録音開始処理の冒頭) に:

```ts
		setLastLang(s.language);
```

- [ ] **Step 3: DEV限定メモリログ** — フェーズ遷移を追跡する `$effect` を追加 (script の任意の場所):

```ts
	$effect(() => {
		if (!import.meta.env.DEV) return;
		const heap = (performance as { memory?: { usedJSHeapSize?: number } }).memory
			?.usedJSHeapSize;
		console.debug(
			`[memlog] phase=${phase} heap=${heap ? `${Math.round(heap / 1e6)}MB` : 'n/a'}`
		);
	});
```

- [ ] **Step 4: DEV限定モデル進捗ログ** — `acquireLiveEngine` 内の `createLiveStt({ lang: s.language })` (`:593`) を変更:

```ts
		return createLiveStt({
			lang: s.language,
			onProgress: import.meta.env.DEV
				? (p) => console.debug('[memlog] model', p)
				: undefined
		});
```

- [ ] **Step 5: 検証**

Run: `npm run check` + `npm test` + `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list`
Expected: 0エラー、全緑 (`setLastLang` は localSeed 済みテスト環境でも無害)

- [ ] **Step 6: コミット** (ユーザー確認後)

```bash
git add src/routes/practice/+page.svelte
git commit -m "fix: track last practice language and log heap in dev"
```

---

### Task 5: 全体検証 + 実機ゲート案内

**Files:**
- 変更なし (検証のみ)

- [ ] **Step 1: フルスイート**

Run: `npm run check` → 0エラー / `npm test` → 全緑 / `npm run test:e2e` → 全緑
Expected: 上記3つ全てパス。practice.spec が並列でフレーキーする場合は単独再実行 (既知の挙動)

- [ ] **Step 2: DEV手動確認 (任意)**

Run: `npm run dev` → トップページに 準備中インジケータが表示される (`.stt-models` 未導入なら即 ready/エラーで消える)。`?e2e=1` 付きトップではインジケータが出ないこと

- [ ] **Step 3: 完了報告 + 実機ゲート依頼**

報告内容:
- ストリーミング化でJSヒープのチャンク配列 (約45MB) が消えたこと
- トップページウォームでWASM展開がTTS再生と衝突しなくなったこと
- 実機確認依頼: **Android Chrome で初回DL含め 10文以上連続練習 → 再読込ゼロ、色分け動作**
  (発生時の切り分け材料: Devツール `console` の `[memlog]`、`chrome://crashes`)

- [ ] **Step 4: コミット** (ユーザー確認後 — `docs` コミットも含むならこのタイミング)

```bash
git add docs/superpowers/specs/2026-09-22-tts-freeze-fix.md
git commit -m "docs: add tts freeze-fix spec"
```