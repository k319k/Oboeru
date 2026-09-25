# ②スマホUI強化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 練習画面のスマホUIを実測で判明した 8 症状（A–H）すべてから解放し、時間による自動送りを廃止して「ボタンまたは Space/Enter で 1 段ずつ進む」練習フローにする。

**Architecture:** 練習画面を「ヘッダー固定 / 本文のみスクロール / アクション固定」の 3 区画に再構成し、`+layout.svelte` の `main` をフレックスカラム化して練習ルートを `flex-1 min-h-0` にする。自動送り（dwell タイマー）は関数と localStorage スキーマごと削除する。視覚階層は「主操作 = 全幅・塗り・1 個」「サブ = 全幅・枠」に統一する。

**Tech Stack:** SvelteKit 2 (Svelte 5 runes) / Tailwind CSS v4 / shadcn-svelte (bits-ui) / lucide-svelte / vitest / Playwright (chromium)

**Spec:** `docs/superpowers/specs/2026-09-26-ui-enhancement.md`

---

## Global Constraints

これらの条件は全タスクに適用される。

- **UI 文言は日本語**。文言を変更するタスクでは、変更箇所と理由をコミットメッセージに報告すること
- **390px 幅で横 overflow 0**（`documentElement.scrollWidth <= clientWidth` かつ `body.scrollWidth <= clientWidth`）
- **可視なインタラクティブ要素は全てタップ対象 >= 44px**
- **axe serious / critical 違反 0**（light / dark 両テーマ）
- **`data-testid="progress"` は外側ラッパに必ず残す。** `tests/practice.spec.ts` と `tests/e2e-full.spec.ts` の計 11 箇所が `toHaveText` で完全一致 assert している（`1 / 1` / `2 / 2` / `2 / 3` / `1 / 3` / `基本 · 1 / 2` / `応用 · 2 / 2`）。`{progress}` の文字列と `showTrackBadge` の分岐条件は変更しない
- **`data-testid="record-hold-btn"` の `data-hold-btn` 属性と `aria-label="押している間、録音します"` は必ず残す**（ポインタハンドラと a11y が依存）
- **テストの削除・skip 化・アサーション弱化は禁止。** 削除対象機能のテストを消すのは正統なので、その場合は「何を消したか・なぜカバレッジが失われていないか」をコミットメッセージに書く
- **行番号ではなく検索アンカー（文字列）で位置を指定する。** 同じファイル内の別タスクの編集で行番号がずれるため
- **コミットは conventional commits（英語・単一行件名）。** 各タスク末尾のコミットはユーザーが Superpowers ワークフローを承認しているため実行する。**`git push` とデプロイは絶対に行わない**（明示依頼時のみ）
- **コミット対象を限定する。** このブランチには未コミットの別作業（live-STT 除去）が残っている。`git status --short` で自分のファイルだけを `git add` すること

### 現在の作業ツリー状態（2026-09-26 時点・重要）

ブランチ `feat/remove-live-stt` に **29 件の未コミット変更**がある（`src/lib/livestt/` 全体の削除、`src/lib/last-lang.ts` の削除、`scripts/fetch-stt-models.mjs` の削除、`src/routes/+page.svelte` と `src/routes/practice/+page.svelte` の変更など）。

本 plan のタスクは `src/routes/practice/+page.svelte` を編集するが、**これは既に他作業の未コミット変更を含むファイル**である。したがって:

- `git add` は**自分の編集したファイルだけ**を対象にし、`git add -A` / `git add .` は絶対に使わない
- 各コミット後の `git status --short` で、想定外のファイルが入っていないことを必ず確認する
- 他作業のファイル（`src/lib/livestt/*` など）には触れない

---

## File Structure

| ファイル | 責務 | 本 plan での扱い |
|---|---|---|
| `src/routes/+layout.svelte` | アプリシェル（ナビ・スキップリンク・`<main>`） | 練習中ナビの非表示・テーマ切替削除・`main` を flex カラム化 |
| `src/routes/practice/+page.svelte` | 練習画面の 7 フェーズ state machine と UI | 3 区画化・自動送り廃止・スキップガード・kbd 出し分け・視覚階層 |
| `src/lib/practice-progress.ts` | セッション途中再開の永続化（sessionStorage） | `practice-prefs.ts` からリネームし progress 専用に縮小 |
| `src/lib/constants.ts` | dwell 定数のみ | ファイル削除 |
| `src/lib/theme.ts` | テーマの状態管理と localStorage 永続化 | `toggleTheme()` 削除のみ（他は不変） |
| `src/routes/manage/+page.svelte` | 章 / トラック / 文 / 設定 / データの CRUD | 「練習の操作」削除・`src/lib/theme.ts` の `setTheme` を使う |
| `tests/responsive.spec.ts` | 390px のレイアウト契約 | アクションゾーン / kbd / 進捗バー / ナビ非表示の検証を追加 |
| `tests/practice.spec.ts` | 練習画面 E2E | 明示クリック化・`track-badge` 削除・スキップ無効の検証を追加 |
| `tests/theme.spec.ts` / `tests/shell.spec.ts` | テーマ E2E | ナビの toggle を管理 › 設定の radio に移し替え |

---

## Task 1: 時間による自動送りの廃止

**Files:**
- Delete: `src/lib/constants.ts`
- Rename + Modify: `src/lib/practice-prefs.ts` → `src/lib/practice-progress.ts`
- Rename + Modify: `src/lib/practice-prefs.test.ts` → `src/lib/practice-progress.test.ts`
- Modify: `src/routes/practice/+page.svelte`（import / state / `scheduleDwell` / `cancelDwell` / 2 箇所の呼び出し / `onMount`）
- Modify: `src/routes/manage/+page.svelte`（import / state / ハンドラ 2 個 / 「練習の操作」fieldset）
- Modify: `tests/practice.spec.ts`（seed ヘルパ / 2 箇所の wait / T9 describe）
- Modify: `tests/e2e-full.spec.ts`（3 箇所にクリック追加）
- Modify: `tests/io-settings.spec.ts`（T9 describe 削除）
- Modify: `tests/responsive.spec.ts`（`PRACTICE_PREFS_KEY` と `disableAutoAdvance` 削除）
- Modify: `tests/a11y.spec.ts`（`PRACTICE_PREFS_KEY` と `disableAutoAdvance` 削除）

**Interfaces:**
- Consumes: なし（本タスクが最初のタスク）
- Produces:
  - `src/lib/practice-progress.ts` が export: `loadPracticeProgress(chapterId: string, now?: number): PracticeProgress | null` / `savePracticeProgress(progress: PracticeProgress): void` / `clearPracticeProgress(): void`、型 `PracticeProgress`
  - `src/lib/practice-progress.ts` から `PracticePrefs` / `loadPracticePrefs` / `savePracticePrefs` は**廃止**
  - localStorage キー `oboeru:practice-ui:v1` は**どこからも読まれない**（orphan 化）
  - 採点画面は時間経過では進まない。`next-btn` / `retry-btn` / `error-retry-btn` のクリックまたは Space / Enter でのみ進行する

- [ ] **Step 1: E2E を先に「手動進行」期待へ書き替える（赤にする）**

`tests/practice.spec.ts` の定数を削除する。`const PRACTICE_UI_KEY = 'oboeru:practice-ui:v1';` の行を丸ごと削除。

`SeedOptions` から `practicePrefs` を削除する:

```ts
interface SeedOptions {
	tracks?: SeedTrack[];
	sentences?: SeedSentence[];
	settings?: {
		threshold?: number;
		ttsRate?: number;
		voiceURI?: string | null;
		retryFrom?: 'tts' | 'rerecord';
	};
}
```

`seedPractice` の `addInitScript` から practicePrefs の受け渡しを外す（`practiceUiKey` / `practicePrefs` の 2 箇所と、
`if (practicePrefs) { localStorage.setItem(practiceUiKey, JSON.stringify(practicePrefs)); }` のブロック）:

```ts
	await page.addInitScript(
		({ storageKey, settingsKey, chapters, tracks, sentences, settings }) => {
			localStorage.setItem(
				storageKey,
				JSON.stringify({ chapters, tracks, sentences })
			);
			localStorage.setItem(settingsKey, JSON.stringify(settings));
		},
		{
			storageKey: STORAGE_KEY,
			settingsKey: SETTINGS_KEY,
			chapters,
			tracks: opts.tracks,
			sentences,
			settings
		}
	);
```

`full pass loop` テストの `summary` 待ちの前に `next-btn` クリックを追加する。
（`await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });` の 1 行上に差し込む）:

```ts
		// The session no longer auto-advances: the user must press 次へ.
		await page.getByTestId('next-btn').click();
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });
```

`fail loop` テストの `record-ready` 待ちの前に `retry-btn` クリックを追加する:

```ts
		// The failing feedback no longer auto-retries.
		await page.getByTestId('retry-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
```

T9 describe を「seed しない版」に書き替える。
`test.describe('Practice — T9 autoAdvance off', …)` 内の
`await seedPractice(page, { practicePrefs: {…}, sentences: […] });` を
`practicePrefs` だけを外した `seedPractice(page, { sentences: […] })` にする。
describe 名を `Practice — no auto-advance` に変更する。

`tests/e2e-full.spec.ts` に 3 箇所のクリックを追加する:
- 文 1 が pass した後、`await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。', { timeout: 10000 });` の**前**に `await page.getByTestId('next-btn').click();`
- fail 後に `await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });` を待つ行の**前**に `await page.getByTestId('retry-btn').click();`
- `await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });` の**前**に `await page.getByTestId('next-btn').click();`

- [ ] **Step 2: 動かない補助コードを削除する**

`tests/responsive.spec.ts`: `const PRACTICE_PREFS_KEY = 'oboeru:practice-ui:v1';` を削除し、
`/** Turn auto-advance off so a feedback phase persists until manual action. */` から
`async function disableAutoAdvance(page: Page) { … }` までの関数全体を削除する。
`tests/a11y.spec.ts` にも同名の定数と関数があるので同様に削除する。

- [ ] **Step 3: テストが「赤」になることを確認する**

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list 2>&1 | tail -40`

Expected: 多数 FAIL。具体的には
`full pass loop` / `fail loop` が `next-btn` / `retry-btn` のクリックで timeout し、
`Practice — no auto-advance` が「2.5s 経ってもfeedback がある」assert で FAIL する
（現在の実装は 800ms の correct dwell で自動 진행するため）。

- [ ] **Step 4: `src/lib` の prefs 層を progress 専用に縮める**

`git mv src/lib/practice-prefs.ts src/lib/practice-progress.ts` と
`git mv src/lib/practice-prefs.test.ts src/lib/practice-progress.test.ts` を実行する。

`src/lib/practice-progress.ts` を次の内容で**全置換**する:

```ts
/**
 * Mid-session progress storage.
 *
 * A single dedicated key, intentionally OUTSIDE the Settings schema
 * (`oboeru:settings:v1`) — same pattern as theme.ts — so a page reload can
 * offer to resume the session. Lives in sessionStorage for the tab session
 * only and expires after 30 minutes.
 */

export interface PracticeProgress {
	/** Chapter the session belongs to (restore only matches the same chapter). */
	chapterId: string;
	/** Sentence index to resume at (0-based). */
	currentIndex: number;
	/** Scored attempts so far (attempts, not distinct sentences). */
	completedCount: number;
	/** Accumulated similarity score over scored attempts. */
	totalScore: number;
	skippedCount: number;
	/** Epoch ms when the snapshot was written. */
	savedAt: number;
}

const PROGRESS_STORAGE_KEY = 'oboeru:progress:v1';
const PROGRESS_MAX_AGE_MS = 30 * 60 * 1000;

function nonNegInt(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	return Math.floor(value);
}

/** Read the saved progress, or null when absent / foreign / stale / invalid. */
export function loadPracticeProgress(chapterId: string, now: number = Date.now()): PracticeProgress | null {
	try {
		const raw = sessionStorage.getItem(PROGRESS_STORAGE_KEY);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (obj.chapterId !== chapterId) return null;
		if (typeof obj.savedAt !== 'number' || !Number.isFinite(obj.savedAt)) return null;
		if (now - obj.savedAt > PROGRESS_MAX_AGE_MS) return null;
		return {
			chapterId,
			currentIndex: nonNegInt(obj.currentIndex),
			completedCount: nonNegInt(obj.completedCount),
			totalScore: nonNegInt(obj.totalScore),
			skippedCount: nonNegInt(obj.skippedCount),
			savedAt: obj.savedAt
		};
	} catch {
		return null;
	}
}

/** Persist the mid-session progress snapshot (sessionStorage — tab lifetime). */
export function savePracticeProgress(progress: PracticeProgress): void {
	try {
		sessionStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
	} catch {
		// Storage unavailable — nothing to clear.
	}
}

/** Remove the saved progress (reached summary / chose to start over). */
export function clearPracticeProgress(): void {
	try {
		sessionStorage.removeItem(PROGRESS_STORAGE_KEY);
	} catch {
		// Storage unavailable — nothing to clear.
	}
}
```

`src/lib/constants.ts` を `git rm` で削除する。

`src/lib/practice-progress.test.ts` から practicePrefs に関する describe と
`import { CORRECT_DWELL_MS, INCORRECT_DWELL_MS } from './constants';`、
`import { loadPracticePrefs, savePracticePrefs, type PracticePrefs } from './practice-prefs';`
を削除する。`PracticeProgress` の describe だけを残す。

- [ ] **Step 5: `src/routes/practice/+page.svelte` から dwell を削除する**

`practice-prefs` からの import を `practice-progress` に変名し、
`PracticePrefs` 関連の import は消す。`loadPracticeProgress` / `savePracticeProgress` /
`clearPracticeProgress` は引き続き使う。

`let dwellTimer: ReturnType<typeof setTimeout> | null = $state(null);` を削除する。

dwell 用の state 3 つを削除する:

```ts
	let autoAdvance: boolean = $state(true);
	let correctDwellMs: number = $state(800);
	let incorrectDwellMs: number = $state(2000);
```

`/** Dwell-time transition, guarded so skip/stop during the wait is respected. */` から
`cancelDwell` 関数の終わりまでを削除する（`scheduleDwell` と `cancelDwell` の両方）。

採点結果の分岐を、dwell をschedule しない形に変更する
（`if (finalScore >= threshold) { … } else { … }` ブロック内）:

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
			// No dwell: the user advances with the 次へ / もう一度試す button
			// (or Space / Enter). Time alone never moves the session forward.
			phase = 'feedback';
```

`onMount` の
`const prefs = loadPracticePrefs(); autoAdvance = prefs.autoAdvance; correctDwellMs = prefs.correctDwellMs; incorrectDwellMs = prefs.incorrectDwellMs;`
を削除する。

`cancelDwell()` を呼んでいる 7 箇所の呼び出しを全て削除する
（`advanceToNext` / `retrySentence` / `retryFromError` / `beginHold` / `replaySentence` / `skip` / `stop` 内の `cancelDwell();` 行）。

- [ ] **Step 6: `src/routes/manage/+page.svelte` から「練習の操作」を削除する**

`loadPracticePrefs` / `savePracticePrefs` / `PracticePrefs` の import を削除する。

`// --- Practice operation (T9: oboeru:practice-ui:v1) ---` のコメントから
`function handlePracticeSpeedChange(…) { … }` の終わりまでを削除する
（`let practicePrefs` / `const FAST_DWELL` / `let practiceSpeed` /
`function handleAutoAdvanceChange` / `function handlePracticeSpeedChange` の 5 つ）。

`<!-- Practice operation (T9) -->` のコメントから
対応する `</fieldset>` までを削除する（`legend` が `練習の操作` であるfieldset）。

- [ ] **Step 7: 検証する**

Run: `npm run check`
Expected: エラー 0。`practice-ui` / `PracticePrefs` / `dwell` 関連の参照エラーがないこと。

Run: `npm test`
Expected: PASS（`practice-progress.test.ts` の progress describe のみが走る）

Run: `npx playwright test tests/practice.spec.ts tests/e2e-full.spec.ts tests/responsive.spec.ts tests/a11y.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: 全て PASS

- [ ] **Step 8: コミットする**

```bash
git add src/lib/practice-progress.ts src/lib/practice-progress.test.ts src/routes/practice/+page.svelte src/routes/manage/+page.svelte tests/practice.spec.ts tests/e2e-full.spec.ts tests/io-settings.spec.ts tests/responsive.spec.ts tests/a11y.spec.ts
git status --short -- src/lib tests
```

`git rm` と `git mv` は削除・リネームを既にステージしている。
`git status --short` で `src/lib/constants.ts` が `D` としてステージされていることを確認する。

```bash
git commit -m "refactor: remove time-based auto-advance from the practice flow"
```

---

## Task 2: 練習中のグローバルナビ非表示と main の flex カラム化

**Files:**
- Modify: `src/routes/+layout.svelte`
- Test: `tests/responsive.spec.ts`

**Interfaces:**
- Consumes: Task 1（不要だが、本タスクは単独でも成立する）
- Produces: `/practice` には `おぼえる` / `管理` のリンクが存在しない。`/` には存在する。`<main id="main-content">` は `display: flex; flex-direction: column`

- [ ] **Step 1: 失敗するテストを書く**

`tests/responsive.spec.ts` に新しいテストを追加する。
ファイル末尾の `test.describe` ブロック内（ practising describe）ではなく、
`MANAGE_TABS` の loop がある describe の**前**に独立した describe を追加する。
検索アンカー `test.use({ viewport: { width: 390, height: 844 } });` を探してその直後に挿入する:

```ts
test.describe('App shell — practice hides the global nav', () => {
	test('/practice has no global nav; / still does', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await page.goto('/practice?chapter=child-1');
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
```

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/responsive.spec.ts --workers=1 --reporter=list -g "practice hides the global nav"`
Expected: FAIL。`/practice` に `おぼえる` が 1 件あるため `toHaveCount(0)` が失敗する。

- [ ] **Step 3: `+layout.svelte` を変更する**

`<header class="border-b border-border bg-background">` を
`{#if pathname !== '/practice'}` で囲む。対応する `</header>` の直後に `{/if}` を置く:

```svelte
	{#if pathname !== '/practice'}
		<header class="border-b border-border bg-background">
			<nav
				class="mx-auto flex h-14 w-full max-w-5xl items-center gap-1 px-4"
				aria-label="メインナビゲーション"
			>
				… 既存の中身をそのまま …
			</nav>
		</header>
	{/if}
```

`<main>` の class に flex カラムの属性を追加する:

```svelte
	<main
		id="main-content"
		tabindex="-1"
		class="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 py-6 outline-none"
	>
		{@render children()}
	</main>
```

- [ ] **Step 4: 検証する**

Run: `npm run check`
Expected: エラー 0

Run: `npx playwright test tests/responsive.spec.ts tests/shell.spec.ts tests/manage.spec.ts tests/top.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: 全て PASS。特に `shell.spec.ts` の skip link / active nav / favicon と
`responsive.spec.ts` の manage 全 4 タブが緑のまま（`main` の flex カラム化が
`/` と `/manage` の描画を変えていないことの実証）

- [ ] **Step 5: コミットする**

```bash
git add src/routes/+layout.svelte tests/responsive.spec.ts
git commit -m "feat: hide the global nav during practice and make main a flex column"
```

---

## Task 3: 練習画面を 3 区画に再 구성し、操作ボタンを下部固定ゾーンへ移す

**Files:**
- Modify: `src/routes/practice/+page.svelte`（ルート div・practice view テンプレート全体）
- Test: `tests/responsive.spec.ts`

**Interfaces:**
- Consumes: Task 1（自動送り廃止）、Task 2（`main` が flex カラム）
- Produces:
  - ルートに `data-testid="action-zone"` を持つ要素が存在する
  - `feedback` フェーズで `data-testid="feedback-actions"` を持つ要素が主操作・サブ操作・スキップを全幅縦積みで包む
  - `data-testid="record-ready"` はアクションゾーン内の `record-hold-btn` を包む
  - `data-testid="feedback"` はスコア・diff・凡例・文字起こしのみを指す（ボタンを含まない）
  - `summary` フェーズは `flex-1 min-h-0 overflow-y-auto` のラッパの中にあり縦にスクロールする

- [ ] **Step 1: 失敗するテストを書く**

`tests/responsive.spec.ts` の practice feedback テスト
（`test('practice feedback — no overflow, action buttons stacked full-width', …)`）を
以下の形に置き換える。`[data-testid="feedback"]` を読んでいた部分を
`[data-testid="feedback-actions"]` に差し替え、加えて 2 つの検証を追加する:

```ts
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
```

同じ「アクションゾーンがビューポート内」の検証を、practice show のテストにも追加する。
show フェーズのテストの最後に差し込む:

```ts
		const zone = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="action-zone"]');
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
		});
		expect(zone, '/practice show: action-zone not found').not.toBeNull();
		expect(zone?.bottom ?? Infinity).toBeLessThanOrEqual((zone?.vh ?? 0) + 1);
```

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/responsive.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: FAIL。`[data-testid="action-zone"]` が存在しないため
`action-zone not found` で落ちる。

- [ ] **Step 3: ルートの高さとスクロール領域を作り直す**

`src/routes/practice/+page.svelte` のルート div を置き換える。
検索アンカー `<div class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 py-6">`
を削除し、次で置き換える:

```svelte
<div class="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col px-4 py-4">
```

`summary` 分岐をスクロール領域で包む。
`{#if phase === 'summary'}` の直後に `<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">` を挿入し、
対応する `{/if}` の直前に `</div>` を挿入する。

- [ ] **Step 4: practice view のテンプレートを置き換える**

`<!-- ==================== PRACTICE VIEW ==================== -->` の
`{:else}` ブロックの中身（practice-header から skip 行まで）を、
次のコードで**丸ごと置き換える**。既存の `</div>` の閉じ合わせに注意すること
（`summary` ラッパ / header / スクロール領域 / アクションゾーン / ルートの 5 層）。

```svelte
		<header class="flex flex-none items-center gap-2 pb-3" data-testid="practice-header">
			<h1 class="min-w-0 flex-1 truncate text-sm font-bold sm:text-base" data-testid="chapter-name">
				{chapterName}
			</h1>
			{#if showTrackBadge}
				<Badge class="max-w-28 shrink-0 truncate" data-testid="track-badge">
					{currentTrackName}
				</Badge>
			{/if}
			<div class="flex min-w-0 flex-1 flex-col items-center gap-1" data-testid="progress">
				<Progress
					value={currentIndex + 1}
					max={sentences.length}
					class="h-2 w-full rounded-full"
					aria-label="進捗"
					data-testid="progress-bar"
				/>
				<span class="text-xs text-muted-foreground tabular-nums">
					{#if showTrackBadge}{currentTrackName} · {progress}{:else}{progress}{/if}
				</span>
			</div>
			<Button
				variant="outline"
				class="h-11 shrink-0 px-4"
				onclick={() => (endDialogOpen = true)}
				data-testid="stop-btn"
			>
				終了 <kbd class="kbd-hint">Esc</kbd>
			</Button>
		</header>

		<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div
				class="flex min-h-40 flex-1 flex-col items-center justify-center gap-4 pb-4"
			>
				{#if phase === 'show' || phase === 'tts'}
					{#if currentSentence}
						<p class="text-xs font-medium text-muted-foreground" data-testid="phase-hint">
							{phase === 'show' ? '聴いてね' : '読み上げ中'}
						</p>
						<p class="text-center text-2xl font-medium leading-relaxed" data-testid="sentence-text">
							{currentSentence.text}
						</p>
					{/if}
				{:else if phase === 'hidden'}
					{#if micConnecting}
						<p
							class="flex items-center gap-2 text-base text-muted-foreground"
							data-testid="sentence-hidden"
						>
							<Loader2 class="animate-spin" size={18} aria-hidden="true" /> マイクを準備中…
						</p>
					{:else if micError}
						<p class="text-sm text-destructive" data-testid="error-message">
							マイクの使用が拒否されました
						</p>
					{:else if shortPressHint}
						<p class="text-sm font-medium text-destructive" data-testid="short-press-hint">
							もう少し長く押してね
						</p>
					{/if}
				{:else if phase === 'recording'}
					<div class="flex flex-col items-center gap-4" data-testid="sentence-recording">
						<p class="flex items-center gap-2 text-base text-muted-foreground">
							<span
								class="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-destructive"
								aria-hidden="true"
							></span>
							録音中
						</p>
						<p class="flex items-baseline gap-2 text-sm text-muted-foreground tabular-nums">
							<span data-testid="recording-timer">
								{(recordingElapsedMs / 1000).toFixed(1)} 秒
							</span>
							<span class="text-xs" data-testid="max-duration-note">最長30秒で自動採点</span>
						</p>
						<div
							class="flex w-56 flex-col gap-1"
							data-testid="level-meter"
							role="img"
							aria-label={`録音レベル ${levelPct}%`}
						>
							<div class="h-3 w-full overflow-hidden rounded-full bg-muted">
								<div
									class="h-full rounded-full bg-primary"
									style:width={`${levelPct}%`}
									data-testid="level-meter-fill"
								></div>
							</div>
							<span class="text-xs text-muted-foreground tabular-nums" data-testid="level-value">
								レベル {levelPct}%
							</span>
						</div>
						<p class="text-sm font-medium" data-testid="release-hint">離すと採点します</p>
					</div>
				{:else if phase === 'transcribing'}
					<p
						class="flex items-center gap-2 text-base text-muted-foreground"
						data-testid="sentence-transcribing"
					>
						<Loader2 class="animate-spin" size={18} aria-hidden="true" /> 聞き取ってるよ…
					</p>
				{:else if phase === 'feedback'}
					{#if errorMessage}
						<p class="text-center text-sm text-destructive" data-testid="error-message">
							{errorMessage}
						</p>
					{:else if score !== null}
						<div class="flex flex-col items-center gap-4 text-center" data-testid="feedback">
							<div class="flex flex-col items-center">
								<p class="text-sm font-medium text-muted-foreground" data-testid="score-label">
									類似度
								</p>
								<p
									class="score text-5xl font-bold tabular-nums"
									class:pass={score >= threshold}
									class:fail={score < threshold}
									class:celebrate={score >= threshold}
									data-testid="score"
								>
									{score}%
								</p>
							</div>
							{#if diffTokens}
								<p class="max-w-full text-lg leading-loose" data-testid="word-diff">
									{#each diffTokens as token, i (i)}
										<span
											class="diff-token"
											data-status={token.status}
											data-testid="diff-token">{token.text}</span
										>
									{/each}
								</p>
								<p class="diff-legend" data-testid="diff-legend">
									<span class="legend-item">
										<span class="legend-swatch" data-status="match" aria-hidden="true"></span>
										正しく読めた
									</span>
									<span class="legend-item">
										<span class="legend-swatch" data-status="mismatch" aria-hidden="true"></span>
										聞き取りに差
									</span>
									<span class="legend-item">
										<span class="legend-swatch" data-status="unread" aria-hidden="true"></span>
										未読
									</span>
								</p>
							{/if}
							{#if transcribedText}
								<p class="text-sm text-muted-foreground italic" data-testid="transcribed-text">
									「{transcribedText}」
								</p>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
		</div>

		<!-- 下部アクションゾーン: 常にビューポート内に見える -->
		<div
			class="flex flex-none flex-col gap-2 border-t border-border bg-background p-3"
			data-testid="action-zone"
		>
			{#if phase === 'feedback' && score !== null && !errorMessage}
				<div
					class="flex flex-col items-stretch gap-2"
					data-testid="feedback-actions"
				>
					{#if score >= threshold}
						<Button class="w-full" data-testid="next-btn" onclick={advanceToNext}>
							次へ <kbd class="kbd-hint">Space</kbd>
						</Button>
					{:else}
						<Button class="w-full" data-testid="retry-btn" onclick={retrySentence}>
							もう一度試す <kbd class="kbd-hint">Space</kbd>
						</Button>
					{/if}
					<Button
						variant="outline"
						class="h-11 w-full"
						data-testid="replay-btn"
						onclick={replaySentence}
					>
						<Volume2 /> もう一度聴く <kbd class="kbd-hint">R</kbd>
					</Button>
					<Button variant="outline" class="h-11 w-full" onclick={skip} data-testid="skip-btn">
						スキップ <kbd class="kbd-hint">S</kbd>
					</Button>
				</div>
			{:else}
				{#if phase === 'show'}
					<Button class="w-full" data-testid="replay-btn" onclick={replaySentence}>
						<Volume2 /> もう一度聴く <kbd class="kbd-hint">R</kbd>
					</Button>
				{:else if phase === 'hidden' && micError}
					<Button class="w-full" data-testid="error-retry-btn" onclick={retryMic}>
						マイクをもう一度許可
					</Button>
				{:else if phase === 'hidden' && !micConnecting && !micError}
					<div class="flex flex-col items-center gap-3" data-testid="record-ready">
						<p class="text-base font-medium" data-testid="record-ready-hint">
							Spaceを押しながら読み上げてね
						</p>
						<button
							type="button"
							class="record-hold-btn"
							data-hold-btn
							data-testid="record-hold-btn"
							aria-label="押している間、録音します"
							onpointerdown={startPointerHold}
							oncontextmenu={(e) => e.preventDefault()}
						>
							<Mic class="size-5 shrink-0" aria-hidden="true" />
							<span class="whitespace-nowrap">押して録音</span>
							<kbd class="kbd-hint">Space</kbd>
						</button>
					</div>
				{:else if phase === 'feedback' && errorMessage}
					<Button class="w-full" data-testid="error-retry-btn" onclick={retryFromError}>
						{errorRetryLabel}
					</Button>
				{/if}
				<Button variant="outline" class="h-11 w-full" onclick={skip} data-testid="skip-btn">
					スキップ <kbd class="kbd-hint">S</kbd>
				</Button>
			{/if}
		</div>
```

**重要**: `data-testid="record-ready"` はアクションゾーン側に移す。
本文側の `{:else if phase === 'hidden'}` ブロックには
`micConnecting` / `micError` / `shortPressHint` の表示だけが残り、
录音ボタンはアクションゾーンの `{:else}` 側の `{:else if}` チェーンに追加される。
`recording` フェーズでは `{:else if phase === 'hidden' && …}` が真にならないので
録音ボタンは現れず、`skip-btn` だけになる。

- [ ] **Step 5: 検証する**

Run: `npm run check`
Expected: エラー 0

Run: `npm test`
Expected: PASS

Run: `npx playwright test tests/responsive.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: PASS

Run: `npx playwright test --workers=1 --reporter=list 2>&1 | tail -40`
Expected: 全て PASS。`practice.spec.ts` の
`full pass loop` / `fail loop` / `T9 autoAdvance off`（→ `no auto-advance`）と
`a11y.spec.ts` の practice 4 フェーズが緑になること。
`tests/practice.spec.ts:1000-1028` の「短押し 500ms ガード」のテストも
`record-ready` がゾーン側にあるため `toBeVisible()` は通るはず。

- [ ] **Step 6: 実測で 390px を確認する**

Run: `node .omo/tools/shoot-390.mjs 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const e of JSON.parse(s)){if(e.label?.startsWith('!!')){console.log('FAIL',e.label);continue;}console.log('== '+e.label+'  docScrollH='+e.docScrollH+' vh='+e.vh+'  overflow='+e.hOverflow);if(e.offscreen?.length)console.log('   offscreen: '+e.offscreen.map(o=>o.id+'('+o.top+'..'+o.bottom+')').join(', '));}})"`

Expected: practice の各フェーズで `offscreen` に `skip-btn` / `action-zone` が現れない。
`docScrollH` が `vh` と等しくなる（ゴーストスクロールの解消）。
スクリーンショットは `/tmp/opencode/oboeru-shots/out/` に出力されるので、
`04-practice-show.png` と `06-practice-feedback.png` を `vision` ツールで読んで
見た目が崩れていないことを確認する。

- [ ] **Step 7: コミットする**

```bash
git add src/routes/practice/+page.svelte tests/responsive.spec.ts
git commit -m "feat: split the practice screen into fixed header, scrolling body and fixed action zone"
```

---

## Task 4: 視覚階層の仕上げ（終了アイコン・進捗の独立行・カード撤去・タイプサイズ）

**Files:**
- Modify: `src/routes/practice/+page.svelte`
- Test: `tests/practice.spec.ts`、`tests/responsive.spec.ts`

**Interfaces:**
- Consumes: Task 3（3 区画とアクションゾーン。视觉的階層の「主=塗り・サブ=枠」は Task 3 Step 4 の
  variant 指定で確定済みで、本タスクでは触らない）
- Produces:
  - `stop-btn` は `aria-label="終了"` のアイコンボタン（44px）。`kbd` を含まない
  - `data-testid="track-badge"` は**存在しない**
  - `progress` は独立した全幅1行で、`progress-bar` の幅が 390px 時に `>= 0.8 * innerWidth`
  - カード枠（`rounded-xl border border-border bg-muted/40 p-8`）が存在しない。本文は上寄せ
  - `score` の font-size は 44px。`word-diff` は 14px。`transcribed-text` に `italic` が無い

- [ ] **Step 1: 失敗するテストを書く**

`tests/responsive.spec.ts` の practice show テストに、進捗バーの幅の検証を追加する。
検索アンカー `/practice show: the header nav must not overflow` を含む expect の**後**に挿入する:

```ts
		const barWidth = await page.evaluate(() => {
			const el = document.querySelector('[data-testid="progress-bar"]');
			return el ? el.getBoundingClientRect().width : 0;
		});
		expect(
			barWidth,
			'/practice show: the progress bar must span the full width at 390px'
		).toBeGreaterThanOrEqual((await page.evaluate(() => window.innerWidth)) * 0.8);
```

`tests/practice.spec.ts` の `track-badge` アサーション 2 行を削除する。
削除する行は
`await expect(page.getByTestId('track-badge')).toHaveText('基本');` と
`await expect(page.getByTestId('track-badge')).toHaveText('応用');`。
直隣の `await expect(page.getByTestId('progress')).toHaveText('基本 · 1 / 2');` と
`…'応用 · 2 / 2');` は**残す**（同じ情報を検証している）。

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/responsive.spec.ts --workers=1 --reporter=list -g "progress bar must span"`
Expected: FAIL。現状の進捗バーは約 90px しかなく 312px の閾値に届かない。

- [ ] **Step 3: `lucide-svelte` に `X` が import されているか確認する**

Run: `grep -n "from 'lucide-svelte'" src/routes/practice/+page.svelte`

Expected: 既存の import 行に `Volume2` / `Mic` / `Loader2` 等が並んでいる。
`X` が無ければ同じ import に `X` を追加する。

- [ ] **Step 4: ヘッダーを書き換える（終了アイコン化 + 進捗の独立 + `track-badge` 撤去）**

practice-header のブロックを丸ごと置き換える:

```svelte
		<header class="flex flex-none items-center gap-2 pb-3" data-testid="practice-header">
			<h1 class="min-w-0 flex-1 truncate text-sm font-bold sm:text-base" data-testid="chapter-name">
				{chapterName}
			</h1>
			<Button
				variant="outline"
				size="icon"
				class="size-11 shrink-0"
				aria-label="終了"
				data-testid="stop-btn"
				onclick={() => (endDialogOpen = true)}
			>
				<X class="size-5" />
			</Button>
		</header>

		<div class="flex flex-none flex-col gap-1" data-testid="progress">
			<Progress
				value={currentIndex + 1}
				max={sentences.length}
				class="h-2 w-full rounded-full"
				aria-label="進捗"
				data-testid="progress-bar"
			/>
			<div class="flex items-center justify-between text-xs text-muted-foreground">
				<span>{showTrackBadge ? currentTrackName : ''}</span>
				<span class="tabular-nums">{showTrackBadge ? ' · ' : ''}{progress}</span>
			</div>
		</div>
```

**`data-testid="progress"` は進捗ブロック全体の外側に付き、
その内側に `progress-bar` と 2 つの `<span>` が入る配置にする。**
`Progress` バーはテキストを持たないため、`toHaveText` の結合結果は
`基本 · 1 / 2` / `1 / 1` と従来と一致する（11 箇所の既存 assert が無変更で通る）。

- [ ] **Step 5: カード枠を撤去して本文を上寄せする**

スクロール領域の内側の要素の class を、
`class="flex min-h-40 flex-1 flex-col items-center justify-center gap-4 pb-4"` から
`class="flex flex-col items-center justify-start gap-4 py-4"` に変更する
（`min-h-40` と `flex-1` を外し、`justify-center` を `justify-start` にする）。

- [ ] **Step 6: 本文のタイプ事項を調整する**

`score` の `<p>` の class を
`class="score text-5xl font-bold tabular-nums"` から
`class="score text-[2.75rem] font-bold tabular-nums"` に変更する。

`score-label`（`類似度`）を `score` の**下**へ移動する。
`data-testid="feedback"` 内の該当ブロックを

```svelte
							<div class="flex flex-col items-center">
								<p
									class="score text-[2.75rem] font-bold tabular-nums"
									class:pass={score >= threshold}
									class:fail={score < threshold}
									class:celebrate={score >= threshold}
									data-testid="score"
								>
									{score}%
								</p>
								<p class="text-sm font-medium text-muted-foreground" data-testid="score-label">
									類似度
								</p>
							</div>
```

に置き換える（`score-label` を `score` の後ろへ）。

`word-diff` の class を `class="max-w-full text-lg leading-loose"` から
`class="max-w-full text-sm leading-loose"` に変更する。

`transcribed-text` の class から `italic` を削除する（`text-sm text-muted-foreground` にする）。

- [ ] **Step 7: 検証する**

Run: `npm run check`
Expected: エラー 0

Run: `npx playwright test tests/responsive.spec.ts tests/practice.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: PASS。特に `practice.spec.ts` の `progress` の 11 箇所の assert が緑。

Run: `node .omo/tools/shoot-390.mjs 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const e of JSON.parse(s)){if(e.label?.startsWith('!!')){console.log('FAIL',e.label);continue;}console.log('== '+e.label+'  docScrollH='+e.docScrollH);if(e.offscreen?.length)console.log('   offscreen: '+e.offscreen.map(o=>o.id).join(', '));}})"`

Expected: practice の各フェーズで `offscreen` に出るのは**ナビ Doctrine だけ**
（`/practice` にはナビが無いので空になるはず）。スクリーンショットを `vision` で確認し、
進捗バーが全幅になり、スコアが 44px で上寄せになっていることを確認する。

- [ ] **Step 8: コミットする**

```bash
git add src/routes/practice/+page.svelte tests/practice.spec.ts tests/responsive.spec.ts
git commit -m "feat: icon-only stop button, full-width progress row and a flat top-aligned score area"
```

---

## Task 5: 録音フェーズ中はスキップを無効化する

**Files:**
- Modify: `src/routes/practice/+page.svelte`（`skip()` と `skip-btn`）
- Test: `tests/practice.spec.ts`

**Interfaces:**
- Consumes: Task 3（アクションゾーンに `skip-btn` が常に出ている）
- Produces: `phase === 'recording'` の間、`skip()` は no-op。`skippedCount` は加算されない。`skip-btn` は `disabled`

- [ ] **Step 1: 失敗するテストを書く**

`tests/practice.spec.ts` に新しい describe を追加する。
ファイル末尾（`Practice — Jev judge` describe の**前**）に挿入する:

```ts
// ---------------------------------------------------------------------------
// Recording phase: skip is blocked (the action zone is always visible, so a
// mis-tap during recording would otherwise discard the take).
// ---------------------------------------------------------------------------

test.describe('Practice — skip is disabled while recording', () => {
	test('skip button is disabled and S does not skip during recording', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。' }],
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});

		// AGENTS.md の E2E 規約: the FIRST Space keydown must be preceded by a
		// visible record-ready wait, otherwise the keydown fires before hydration
		// attaches the document listener and is silently lost.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		await expect(page.getByTestId('skip-btn')).toBeDisabled();

		const before = await page.getByTestId('progress').textContent();
		await page.keyboard.press('s');
		await page.waitForTimeout(500);
		expect(await page.getByTestId('progress').textContent()).toBe(before);
		await expect(page.getByTestId('sentence-recording')).toBeVisible();

		await page.keyboard.up('Space');
	});
});
```

`setupPractice` は `tests/practice.spec.ts` 内で既に定義されている既存ヘルパー
（`seedPractice` + `mockTts` + `mockTranscribe` + `goto` をまとめたもの）。
新たに `startHold` を定義してはいけない（`tests/practice.spec.ts` には
`holdAndRelease` しか無く、それは `record-ready` を待たないため本テストには使えない）。

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list -g "skip is disabled while recording"`
Expected: FAIL。`skip-btn` が `disabled` ではないため `toBeDisabled()` が失敗する。

- [ ] **Step 3: `skip()` にフェーズガードを追加する**

`function skip(): void {` の直後を次のように置き換える:

```ts
	function skip(): void {
		// Never skip mid-take: the action zone is always visible, so a mis-tap
		// during recording would otherwise discard the captured audio.
		if (phase === 'summary' || phase === 'recording') return;
		skippedCount++;
		cancelSpeech();
		advanceToNext();
	}
```

アクションゾーン内の `skip-btn`（2 箇所ある）を、どちらも
`disabled={phase === 'recording'}` を持つように変更する:

```svelte
					<Button
						variant="outline"
						class="h-11 w-full"
						disabled={phase === 'recording'}
						onclick={skip}
						data-testid="skip-btn"
					>
						スキップ <kbd class="kbd-hint">S</kbd>
					</Button>
```

- [ ] **Step 4: 検証する**

Run: `npm run check`
Expected: エラー 0

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add src/routes/practice/+page.svelte tests/practice.spec.ts
git commit -m "fix: block skip while recording so a mis-tap cannot discard the take"
```

---

## Task 6: スマホでキーボードヒントを非表示にする

**Files:**
- Modify: `src/routes/practice/+page.svelte`（scoped style の `.kbd-hint` と 6 箇所の `<kbd>` / `record-ready-hint`）
- Test: `tests/responsive.spec.ts`

**Interfaces:**
- Consumes: Task 3（アクションゾーンに kbd を含む `skip-btn` がある）
- Produces: 390px で `.kbd-hint` が `display: none`。`record-ready-hint` も 390px で非表示。1280px では両方が表示される

- [ ] **Step 1: 失敗するテストを書く**

`tests/responsive.spec.ts` の practice show テストの末尾（進捗バーの assert の後）に追加する:

```ts
		// Keyboard hints are meaningless without a keyboard.
		await expect(page.locator('.kbd-hint').first()).toBeHidden();
		await expect(page.getByTestId('record-ready-hint')).toBeHidden();
```

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/responsive.spec.ts --workers=1 --reporter=list 2>&1 | tail -20`
Expected: FAIL。`.kbd-hint` が 390px でも可視なため `toBeHidden()` が失敗する。

- [ ] **Step 3: unlayered な scoped style が Tailwind に勝つのを解消する**

`src/routes/practice/+page.svelte` の scoped `<style>` にある
`.kbd-hint {` ブロックから `display: inline-block;` の 1 行を削除する
（他のプロパティは残す）。

削除後の `.kbd-hint` は次の形になる:

```css
	.kbd-hint {
		padding: 0.05rem 0.45rem;
		border: 1px solid color-mix(in oklab, var(--foreground) 18%, transparent);
		border-bottom-width: 2px;
		border-radius: 0.375rem;
		background: var(--background);
		color: var(--muted-foreground);
		font-family: inherit;
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1.5;
		white-space: nowrap;
	}
```

**これが無いとクラス属性に足した `hidden` が scoped style に負けて効かない。**

- [ ] **Step 4: 6 箇所の `<kbd>` に Tailwind の responsive クラスを付ける**

`class="kbd-hint"` を `class="kbd-hint hidden sm:inline-block"` に置き換える。
置き換える対象は `show` フェーズFermats の `replay-btn` / アクションゾーンの
`record-hold-btn` / `feedback-actions` の `replay-btn` / `next-btn` / `retry-btn` /
`skip-btn` の合計 6 箇所。

`record-hold-btn` のものは class 属性が `class="record-hold-btn"` なので、
`class="record-hold-btn"` の中に `<kbd class="kbd-hint">Space</kbd>` として現れる。
kbd 側だけを書き換える。

`record-ready-hint` の `<p>` の class に `hidden sm:block` を追加する:

```svelte
						<p class="hidden text-base font-medium sm:block" data-testid="record-ready-hint">
							Spaceを押しながら読み上げてね
						</p>
```

- [ ] **Step 5: 検証する**

Run: `npm run check`
Expected: エラー 0

Run: `npx playwright test tests/responsive.spec.ts tests/practice.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: PASS。特に `tests/practice.spec.ts` の kbd テキスト assert
（`replay-btn` ⊃ `R` / `record-hold-btn` ⊃ `Space` / `skip-btn` ⊃ `S`）が
1280px の Playwright 既定 viewport で緑であること
（`toContainText` は `textContent` ベースで可視性を要求しないため、
`stop-btn` 以外の 3 件は 390px でも通る）。

- [ ] **Step 6: コミットする**

```bash
git add src/routes/practice/+page.svelte tests/responsive.spec.ts
git commit -m "feat: hide keyboard hints below the sm breakpoint"
```

---

## Task 7: テーマ制御を管理 › 設定の 3 択へ移す

**Files:**
- Modify: `src/routes/+layout.svelte`（テーマ切替ボタンの削除）
- Modify: `src/lib/theme.ts`（`toggleTheme()` の削除）
- Modify: `src/routes/manage/+page.svelte`（設定タブに「表示テーマ」を新設）
- Test: `tests/theme.spec.ts`、`tests/shell.spec.ts`

**Interfaces:**
- Consumes: Task 1（manage の「練習の操作」fieldset が削除されている）
- Produces:
  - `/` と `/manage` に `テーマ切替` ボタンが無い
  - 管理 › 設定 に `theme-system` / `theme-light` / `theme-dark` の 3 つの RadioGroup.Item がある
  - `src/lib/theme.ts` は `toggleTheme` を export しない
  - 既定は `system`（端末追従）。`oboeru:theme` の既存値は引き継がれる

- [ ] **Step 1: 失敗するテストを書き直す**

`tests/shell.spec.ts` の `theme toggle button is present with aria-label テーマ切替` テストを、
次の 2 テストに置き換える:

```ts
	test('no theme toggle in the global nav; the 3-way control lives in manage › 設定', async ({
		page
	}) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'テーマ切替' })).toHaveCount(0);

		await page.goto('/manage');
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByRole('group', { name: '表示テーマ' })).toBeVisible();
		await expect(page.getByTestId('theme-system')).toBeVisible();
		await expect(page.getByTestId('theme-light')).toBeVisible();
		await expect(page.getByTestId('theme-dark')).toBeVisible();
	});
```

`tests/theme.spec.ts` の 3 つのテストを、次の共有ヘルパーと
4 つのテストに置き換える:

```ts
import { test, expect, type Page } from './fixtures';

/** Open manage › 設定 and return the 3 theme radio buttons. */
async function openThemeControls(page: Page) {
	await page.goto('/manage');
	await page.getByRole('tab', { name: '設定' }).click();
	await expect(page.getByTestId('theme-system')).toBeVisible();
}

test.describe('Theme', () => {
	test('defaults to system; selecting dark then light pins the theme', async ({ page }) => {
		await openThemeControls(page);
		const html = page.locator('html');

		// Default (system → light in headless Chromium) → no .dark
		await expect(html).not.toHaveClass(/dark/);
		await expect(page.getByTestId('theme-system')).toBeChecked();

		await page.getByTestId('theme-dark').click();
		await expect(html).toHaveClass(/dark/);

		await page.getByTestId('theme-light').click();
		await expect(html).not.toHaveClass(/dark/);
	});

	test('theme persists across reload', async ({ page }) => {
		await openThemeControls(page);
		await page.getByTestId('theme-dark').click();
		await expect(page.locator('html')).toHaveClass(/dark/);

		await page.reload();
		await expect(page.locator('html')).toHaveClass(/dark/);
		await page.getByRole('tab', { name: '設定' }).click();
		await expect(page.getByTestId('theme-dark')).toBeChecked();
	});

	test('system mode follows prefers-color-scheme', async ({ page }) => {
		// Emulate the OS preference before navigation so the FOUC script sees it
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto('/');

		const html = page.locator('html');
		await expect(html).toHaveClass(/dark/);

		// Switching the OS preference while in system mode updates live
		await page.emulateMedia({ colorScheme: 'light' });
		await expect(html).not.toHaveClass(/dark/);
	});

	test('explicit theme overrides system preference', async ({ page }) => {
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.goto('/');
		await page.waitForLoadState('networkidle');
		const html = page.locator('html');

		// system + dark OS → dark
		await expect(html).toHaveClass(/dark/);

		await page.getByRole('tab', { name: '設定' }).click();
		await page.getByTestId('theme-light').click();
		await expect(html).not.toHaveClass(/dark/);

		// OS changes no longer affect the explicit choice
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(html).not.toHaveClass(/dark/);
	});
});
```

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/theme.spec.ts tests/shell.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: FAIL。`theme-system` などの testid が存在しないため、
`theme-system` の waiting で timeout する。`no theme toggle` は現在ボタンが
存在するため `toHaveCount(0)` で失敗する。

- [ ] **Step 3: `+layout.svelte` からテーマ切替ボタンを削除する**

`{/* テーマ切替 */}` に相当する `<div class="ml-auto">…<Button …>` ブロックを
丸ごと削除する。`Moon` / `Sun` の import も未使用になるため削除する。
`toggleTheme` の import も削除する（他で使っていないことを確認してから）。

Run: `grep -n "toggleTheme\|Moon\|Sun" src/routes/+layout.svelte`
Expected: 削除対象がこれらのみであることを確認してから削除する。

- [ ] **Step 4: `src/lib/theme.ts` から `toggleTheme()` を削除する**

```ts
/**
 * Toggle between explicit light/dark based on the currently resolved theme.
 * A user click leaves `system` and pins an explicit preference.
 */
export function toggleTheme(): void {
	setTheme(resolved === 'dark' ? 'light' : 'dark');
}
```

というブロック（doc comment を含む）を削除する。
`setTheme` / `getTheme` / `getResolvedTheme` / `subscribeTheme` /
`DEFAULT_THEME` / `syncMediaSubscription` / `matchMedia` 購読は**変更しない**。

- [ ] **Step 5: 管理 › 設定に「表示テーマ」を新設する**

`src/routes/manage/+page.svelte` の script 顶部で
`import { getTheme, setTheme, type Theme } from '$lib/theme';` を追加する
（`$lib/theme` の import が無ければ同じ場所に追加する）。

`let theme = $state<Theme>(getTheme());` を追加する。
`settings` の `$state` の近くに置き、
`practicePrefs` を削除した跡の位置（`function handleRetryFromChange` の直後）に
テーマの状態とハンドラを追加する:

```ts
	let theme = $state<Theme>(getTheme());

	function handleThemeChange(next: string): void {
		setTheme(next as Theme);
		theme = getTheme();
	}
```

`subscribeTheme` / `getResolvedTheme` はこの画面では使わないので import しない
（`getTheme` と `setTheme`、`Theme` 型だけを import する）。
`$state` の初期値は `getTheme()` で初期化しているので
`oboeru:theme` に既存の `light` / `dark` が入っていればそれが反映される。
外部からのテーマ変化を購読する必要はない（テーマを変更する経路は
この設定画面だけ）。

`retryFrom` の fieldset の**後**に「表示テーマ」の fieldset を追加する:

```svelte
			<fieldset
				class="setting-row flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3"
				aria-labelledby="theme-heading"
			>
				<legend id="theme-heading" class="px-1 text-sm font-semibold">表示テーマ</legend>
				<div class="flex flex-col gap-1.5">
					<span class="text-sm font-medium">テーマ:</span>
					<RadioGroup.Root
						value={theme}
						onValueChange={handleThemeChange}
						class="flex flex-wrap gap-4"
					>
						<Label class="flex items-center gap-2 font-normal">
							<RadioGroup.Item value="system" data-testid="theme-system" class="size-11 sm:size-4" />
							端末に合わせる
						</Label>
						<Label class="flex items-center gap-2 font-normal">
							<RadioGroup.Item value="light" data-testid="theme-light" class="size-11 sm:size-4" />
							ライト
						</Label>
						<Label class="flex items-center gap-2 font-normal">
							<RadioGroup.Item value="dark" data-testid="theme-dark" class="size-11 sm:size-4" />
							ダーク
						</Label>
					</RadioGroup.Root>
				</div>
			</fieldset>
```

- [ ] **Step 6: 検証する**

Run: `npm run check`
Expected: エラー 0。特に `as Theme` のキャストが不要だと警告されないこと
（`onValueChange` の引数は `string` なのでキャストは**必要**）。

Run: `npx playwright test tests/theme.spec.ts tests/shell.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: PASS

Run: `npx playwright test tests/manage.spec.ts tests/a11y.spec.ts --workers=1 --reporter=list 2>&1 | tail -30`
Expected: PASS。特に `a11y.spec.ts` の管理画面 4 タブの axe 走査で
新しい RadioGroup が serious/critical を出さないこと。

- [ ] **Step 7: コミットする**

```bash
git add src/routes/+layout.svelte src/lib/theme.ts src/routes/manage/+page.svelte tests/theme.spec.ts tests/shell.spec.ts
git commit -m "feat: move the theme control into manage settings as a 3-way system/light/dark choice"
```

---

## Task 8: ドキュメント更新と全体検証

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md`（付録のロードマップ）

**Interfaces:**
- Consumes: Task 1〜7 のすべて
- Produces: なし（ドキュメントのみ）

- [ ] **Step 1: `AGENTS.md` を更新する**

「ディレクトリ地図」節の `src/lib/...` の列挙に
`- `src/lib/practice-progress.ts` — セッション途中再開の永続化 (sessionStorage `oboeru:progress:v1`、30分 TTL)`
を追加する。

「採点パイプライン規範」節に 1 行追加する:

```
- **時間による自動送りなし。** 採点後の遷移は `next-btn` / `retry-btn` の明示クリック（または Space / Enter）のみ。`oboeru:practice-ui:v1` の autoAdvance / dwell 設定は削除済み。**E2E は時間待ちに依存せず明示クリックする**（実運用の挙動に合わせる）
```

「E2E テスト規程」節に 1 行追加する:

```
- `data-testid="progress"` は 11 箇所で `toHaveText` 完全一致 assert されている。practice 画面の progress DOM を触るときは文字列と `showTrackBadge` の分岐条件を維持する
- `action-zone` は 390px で `rect.bottom <= innerHeight + 1` を満たすこと。录制中は `skip-btn` が `disabled`
```

「運用」節に 1 行追加する:

```
- 練習中はグローバルナビを隠す。テーマは既定で端末同期・上書きは管理 › 設定の 3 択のみ（ナビに切替ボタンを置かない）
```

- [ ] **Step 2: ロードマップを更新する**

`docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` の付録にある
`- **順序**: ①フリーズ修正 (本spec) → ②UI強化 (…) → ③PWA (Android) → …`
の `②UI強化` の部分を、完了임을示す形（ Strike through または `✓` 表現）に更新する。

- [ ] **Step 3: 全体を検証する**

Run: `npm run check`
Expected: `svelte-check` が 0 エラー

Run: `npm test`
Expected: PASS

Run: `npm run test:e2e 2>&1 | tail -30`
Expected: 全て PASS。
`practice.spec.ts` と `e2e-full.spec.ts` は並列負荷で稀にフレーキーなので、
落ちた場合は単独で再実行して切り分ける:
`npx playwright test tests/practice.spec.ts --workers=1 --reporter=list`

Run: `git status --short`
Expected: 本 plan が意図したファイルだけが未コミットになっている。
他の作業（live-STT 除去）のファイルが新たに_COMMIT_ されていないことを
`git show --stat HEAD` で確認する。

- [ ] **Step 4: コミットする**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-22-tts-freeze-fix.md
git commit -m "docs: record the manual-advance contract and the hidden practice nav"
```

- [ ] **Step 5: 実機ゲートの提示（ユーザー承認待ち）**

以下をユーザーに提示し、Android Chrome での実機確認を依頼する。
**このゲートを跨がないでください**（デプロイ・プッシュは行わない）:

1. 初回モデル DL を含め 10 文以上連続練習して再読込が発生しない
2. 全フェーズで操作ボタンが画面下に見える（スクロール不要）
3. スマホ幅で `Space` / `R` / `S` / `Esc` ヒントが出ない
4. 録音中に誤タップしても採点結果が出ない
5. 練習中に `おぼえる` / `管理` ナビが出ていない
6. 端末のダーク設定を変えると配色も追従する
7. 色分け（ライブSTT）が引き続き動作する

---

## Self-Review

### 1. Spec カバレッジ

| Spec の節 | 担当タスク |
|---|---|
| §1 自動送りの廃止 | Task 1 |
| §2.1 `+layout.svelte`（ナビ非表示 / main の flex カラム化） | Task 2 |
| §2.2 3 区画の構造 / summary のスクロールラッパ | Task 3 |
| §2.3 ヘッダー（終了アイコン / `track-badge` 撤去） | Task 4 |
| §2.4 進捗の独立行 | Task 4 |
| §2.5 本文（カード撤去 / 44px / 14px / italic 削除 / 上寄せ） | Task 4 |
| §2.6 アクションゾーンのマッピング（9 行） | Task 3 |
| §2.7 症状 D（`shrink-0` / `whitespace-nowrap`） | Task 3（`record-hold-btn` の class） |
| §2.8 `min-h-40` の撤去 | Task 4 |
| §3 スキップのフェーズガード | Task 5 |
| §4.1 `sm:` ベース判定 | Task 6 |
| §4.2 unlayered (style) との競合解消 | Task 6 |
| §4.3 `record-ready-hint` の出し分け | Task 6 |
| §5.1 `toggleTheme` の不具合 | Task 7 Step 4 |
| §5.2 3 択の移設 | Task 7 |
| §6 エラー処理 | コード上の副作用なし（Task 1〜7 で充足） |
| §7 非目標 | 遵守（何も追加しない） |
| §8.1 ユニットの prefs describe 削除 | Task 1 Step 4 |
| §8.2 E2E 全 7 ファイル | Task 1（practice / e2e-full / io-settings / responsive / a11y）、Task 2・3・4・6（responsive）、Task 5（practice）、Task 7（theme / shell） |
| §8.3 検証コマンド | 各タスクの Step 最終 + Task 8 Step 3 |
| §8.4 実機ゲート | Task 8 Step 5 |
| §9 ファイル変更一覧 | 全タスクの Files 節 |
| §10 AGENTS.md 更新 | Task 8 Step 1 |
| §11 既知の残余 | 実装しない（非目標 §7 に記載済み） |

ギャップなし。

### 2. Placeholder スキャン

- TBD / TODO / FIXME なし
- 「同上」「Task N と同じ」の省略なし（Task 3 Step 4 は全コードを提供、
  Task 7 Step 5 は full markup を提供）
- 型・関数名は全タスクで一致:
  - `PracticeProgress` / `loadPracticeProgress` / `savePracticeProgress` / `clearPracticeProgress`（Task 1 が定義、後続は使用しない）
  - `Theme` / `getTheme` / `setTheme`（Task 7 で使用。`subscribeTheme` は使用しない）
  - `data-testid="action-zone"` / `feedback-actions` / `progress` / `progress-bar`（Task 3・4・6 で一致）
  - `showTrackBadge` / `currentTrackName` / `progress`（Task 4 のヘッダーで使用、既存の `$derived` 名）

### 3. 型の一貫性

- `skip-btn` は Task 3 で 2 箇所（`feedback-actions` 内と `{:else}` 側）に作られ、
  Task 5 で**両方に** `disabled={phase === 'recording'}` を付ける指示がある ✓
- `error-retry-btn` は Task 3 で 2 箇所（mic エラーと文字起こしエラー）に出現 ✓
- `record-ready` は Task 3 で本文からアクションゾーンへ移動する。
  `getByTestId('record-ready')` を待つ既存の `holdAndRelease`（`tests/practice.spec.ts:942`）も
  `tests/responsive.spec.ts` / `tests/a11y.spec.ts` の hold ヘルパーも可視待ちなので移動後も通る ✓
- Task 5 のテストは既存ヘルパー `setupPractice` を使う（`seedPractice` + mock + `goto` の bundle）。
  `tests/practice.spec.ts` に `startHold` は存在しないため 새로定義しない ✓

### 4. タスク境界の妥当性

- Task 1 はソースとテストが不可分（テストが旧挙動を符号化しているため）なので統合 ✓
- Task 2 は `+layout.svelte` のみ。他に副作用しないので単独でレビュー可能 ✓
- Task 3 はテンプレート構造の一括置換。半身にすると throwaway 步骤になるため統合 ✓
- Task 4 は Task 3 の出力の視覚調整。`track-badge` 撤去が `practice.spec.ts` の
  2 行削除を伴うので一緒にレビューする単位が正しい ✓
- Task 5・6・7 はそれぞれ独立したユーザー可視の挙動変更 ✓
- Task 8 はドキュメント + 全統合検証 ✓
