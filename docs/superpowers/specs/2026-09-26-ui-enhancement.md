# ②スマホUI強化 — 設計

- 日付: 2026-09-26
- 状態: ユーザー承認済み (設計 1/4・2/4・3/4・4/4 とも承認)
- ロードマップ上の位置: ①TTSフリーズ修正の次
- 前置き: `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` の付録「②UI強化」

## 目的

ロードマップ ② に挙げられた 3 点（類似度画面の即スキップ防止・ボタン常時下部・スマホでキーノードヒント非表示）に、
390px 実測で判明した追加の 5 症状（D–H）と、ユーザー指定の 3 件（練習中のナビ非表示・終了アイコン化・テーマ制御の移設）を統合する。

成功条件:

1. 390px で、練習の全フェーズにおいて**操作ボタンが常にビューポート内に見える**
2. 採点画面は**時間経過では自動で進まない**。Space / Enter / ボタン押下でのみ進行する
3. スマホ幅で `Space` / `R` / `S` / `Esc` のキーボードヒントが出ない
4. 録音中に誤タップ / 誤キー入力しても録音 blob が破棄されない
5. 練習中はグローバルナビ（`おぼえる` / `管理`）が出ない
6. テーマは既定で端末同期。上書きは管理 › 設定からのみ

## 現状の実測（390×844 / dev サーバー / 2026-09-26）

Playwright を 390×844 で実行し、DOM 矩形とスクリーンショットを採取した結果。

| # | 症状 | 実測値 |
|---|---|---|
| A | スキップボタンが画面外 | `top 833 / bottom 877` vs vh 844 → 33px 欠け |
| B | 105px のゴーストスクロール | `docScrollH 949` vs `vh 844` |
| C | スマホに `Esc` `R` `Space` `S` が出る | 4個とも 23px 角 |
| D | 「押して録音」が2行に折り返す | 実測で「押して録」/「音」に分裂 |
| E | 進捗バーが極端に狭い | 章名と `終了` に挟まれて約 90px 幅 |
| F | メイン/サブの視覚的主従が逆 | サブ操作が塗り、主操作相当が枠 |
| G | 日本語に `italic` | `transcribed-text` が斜体 |
| H | カード内の巨大余白 | 内容が中央寄せで上下に 300px 級の余白 |

B の原因: 練習画面のルートが `min-h-dvh` だが、親レイアウトの `header`（`nav.h-14` = 56px）と
`main` の `py-6`（48px）を二重に数えている。総高 = 56 + 48 + 100dvh = 100dvh + 104px。

**トップ画面と管理画面には症状がない**（`docScrollH == vh`、横 overflow 0、44px 未満のタップ対象なし）。
本 spec の変更対象は練習画面・`+layout.svelte`・管理画面のテーマ項目に限定する。

再現スクリプト: `.omo/tools/shoot-390.mjs`（`.omo/` は gitignore 対象・成果物保存用）。

## 設計方針

**1. 練習画面を 3 区画に再構成する。** ヘッダー固定 / 本文のみスクロール / アクション固定。
`min-h-dvh` をやめ、`+layout.svelte` の `main` をフレックスカラムにして練習ルートを `flex-1 min-h-0` にする。
これにより A と B が同時に解消する。

**2. 時間による自動送りを廃止する。** 進行は Space / Enter / ボタン押下という
「ユーザーの明示操作」だけに従い、経過時間には従わない。

**3. 視覚階層を一本化する。** 主操作は常に「全幅・塗りの緑・1個だけ」。
サブ操作は常に「全幅・枠」。進捗は独立した全幅1行。カード（灰色の枠）は撤去し、内容をそのままページ背景の上に出す。

---

## 1. 自動送りの廃止

### 1.1 挙動

採点結果が出た後、**自動では次の文へ進まない**。`次へ` / `もう一度試す` ボタン、または Space / Enter で進む。

- 合格 → `次へ` ボタンまたは Space / Enter
- 不合格 → `もう一度試す` ボタンまたは Space / Enter
- 文字起こしエラー → `{errorRetryLabel}` ボタンまたは Space / Enter

Space / Enter は「ボタンを押す」ことと等価の明示操作として残す。デスクトップのキーボード練習が壊れないため。

### 1.2 削除するもの

| 場所 | 削除対象 |
|---|---|
| `src/lib/constants.ts` | `CORRECT_DWELL_MS` / `INCORRECT_DWELL_MS`（ファイル全体が空になるためファイルごと削除） |
| `src/lib/practice-prefs.ts` | `PracticePrefs` / `PREFS_STORAGE_KEY` / `DEFAULT_PREFS` / `CORRECT_DWELL_MAX_MS` / `INCORRECT_DWELL_MAX_MS` / `clampDwell` / `validatePrefs` / `loadPracticePrefs` / `savePracticePrefs` |
| `src/lib/practice-prefs.ts` | ファイル名を `practice-progress.ts` へリネーム（残る内容は `PracticeProgress` と sessionStorage の 3 関数のみ） |
| `src/routes/manage/+page.svelte:855-879` | `practicePrefs` state / `FAST_DWELL` / `practiceSpeed` / `handleAutoAdvanceChange` / `handlePracticeSpeedChange` |
| `src/routes/manage/+page.svelte:1749-1793` | 「練習の操作」fieldset 全体 |
| `src/routes/practice/+page.svelte:115-118` | `autoAdvance` / `correctDwellMs` / `incorrectDwellMs` の `$state` |
| `src/routes/practice/+page.svelte:127` | `dwellTimer` の `$state` |
| `src/routes/practice/+page.svelte:272-287` | `scheduleDwell` / `cancelDwell` 関数 |
| `src/routes/practice/+page.svelte:756` | `if (autoAdvance) scheduleDwell(correctDwellMs, …)` |
| `src/routes/practice/+page.svelte:760` | `if (autoAdvance) scheduleDwell(incorrectDwellMs, …)` |
| `src/routes/practice/+page.svelte:854-857` | `loadPracticePrefs()` 呼び出し |

`cancelDwell()` は `advanceToNext` / `retrySentence` / `retryFromError` / `beginHold` /
`replaySentence` / `skip` / `stop` の 7 箇所から呼ばれているが、dwell ごと消えるため 7 箇所とも削除する。

`oboeru:practice-ui:v1` に古い値が残っていても読み込むコードが無くなるため、移行処理は不要
（orphan キーとして localStorage に残るだけ）。`oboeru:progress:v1`（セッション復元）は変更しない。

### 1.3 `src/lib/theme.ts` は触らない（§5 で一部変更）

`DEFAULT_THEME = 'system'` は既に端末同期が既定のため据え置き。

---

## 2. 練習画面のレイアウト再構成

### 2.1 `+layout.svelte` の 2 つの変更

```diff
- <div class="flex min-h-dvh flex-col">
+ <div class="flex min-h-dvh flex-col">
      <a class="sr-only focus:not-sr-only …" href="#main-content">メインコンテンツへ</a>
-     <header class="border-b border-border bg-background">
+     {#if pathname !== '/practice'}
+     <header class="border-b border-border bg-background">
          … ナビ …
      </header>
+     {/if}
-     <main id="main-content" tabindex="-1" class="mx-auto w-full max-w-5xl flex-1 px-4 py-6 outline-none">
+     <main id="main-content" tabindex="-1" class="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 py-6 outline-none">
          {@render children()}
      </main>
  </div>
```

- `pathname` は既に 40 / 45 行目で使用済み。追加の依存は不要
- `/` と `/manage` は子要素が 1 つのブロックなので、`main` がフレックスカラムになっても
  `align-items: stretch` で描画は現在と同一（視覚差分ゼロ）
- skip link は全ルートで残す

**練習中はグローバルナビが出ない**ことで縦 56px が回収される。

### 2.2 練習ルートの構造

`src/routes/practice/+page.svelte:912` の `min-h-dvh` をやめ、次の 3 区画にする。

```
div.flex.min-h-0.flex-1.flex-col            ← was: min-h-dvh flex-col gap-6
├─ p.sr-only[role=status][aria-live=polite]  flex-none
├─ header[data-testid=practice-header]      flex.flex-none.items-center.gap-2
├─ div.flex.flex-none.flex-col.gap-1         ← 進捗（独立した全幅1行）
├─ div.flex-1.min-h-0.overflow-y-auto        ← ここだけがスクロール
├─ div[data-testid=action-zone]             flex.flex-none.flex-col.gap-2
├─ AlertDialog ×2
└─ Toaster
```

`gap-6` は撤去し、各 zone が `p-*` と `border-t` で自分のスペーシングを持つ。
`min-h-0` を付けることで、flex 子の高さが `min-height: auto` でコンテンツに押し広げられるのを防ぐ。
これがないと本文がオーバーフローした瞬間にページ全体が伸びてしまう。

### 2.3 ヘッダー（症状 E の解決）

```svelte
<header class="flex flex-none items-center gap-2" data-testid="practice-header">
  <h1 class="min-w-0 flex-1 truncate text-sm font-bold sm:text-base" data-testid="chapter-name">
    {chapterName}
  </h1>
  <Button variant="outline" size="icon" class="size-11 shrink-0"
          aria-label="終了" data-testid="stop-btn" onclick={() => (endDialogOpen = true)}>
    <X class="size-5" />
  </Button>
</header>
```

- 既存の `track-badge` は**撤去**する。進捗行にトラック名が入るため二重表示になる
- 終了ボタンは shadcn のアイコンボタン慣習 `size="icon" class="size-11"`（44px タップ対象）。
  参照するのは「アイコンボタンは `size-11` で 44px を確保する」という慣習だけで、テーマ切替ボタン自体は §5.2 で削除する
- `data-testid="stop-btn"` と `aria-label="終了"` を維持し、アクセス名は保つ

### 2.4 進捗（症状 E の解決）

現状は章名・`終了` と同じ1行に押し込まれて約 90px しかない。独立した全幅1行に移す。

```svelte
<div class="flex flex-none flex-col gap-1" data-testid="progress">
  <Progress value={currentIndex + 1} max={sentences.length} class="h-2 w-full rounded-full"
            aria-label="進捗" data-testid="progress-bar" />
  <div class="flex items-center justify-between text-xs text-muted-foreground">
    <span>{showTrackBadge ? currentTrackName : ''}</span>
    <span data-testid="progress-label" class="tabular-nums">
      {showTrackBadge ? ' · ' : ''}{progress}
    </span>
  </div>
</div>
```

**`data-testid="progress"` は外側のラッパに必ず残す。**
`tests/practice.spec.ts` と `tests/e2e-full.spec.ts` の計 11 箇所が
`getByTestId('progress')` に `toHaveText` で完全一致 assert している
（`1 / 1` / `2 / 2` / `2 / 3` / `1 / 3` / `基本 · 1 / 2` / `応用 · 2 / 2`）。
`Progress` バーはテキストを持 たないため、2 つの `<span>` を正規化結合した
`基本 · 1 / 2` / `1 / 1` が従来と一致し、**無変更で通る**。
`{progress}` の文字列と `showTrackBadge` の分岐条件も変更してはならない。

### 2.5 本文（症状 H の解決）

カード枠（`rounded-xl border border-border bg-muted/40 p-8` の灰色の箱）を撤去し、
`justify-center` を `justify-start` に変更する。内容はページ背景の上にそのまま載せる。

- スコア: `text-5xl`（48px）から **`text-[2.75rem]`（44px）** に。ラベル `類似度` は**スコアの下**へ移動
- diff（`word-diff`）: `text-lg` から **`text-sm`（14px）** に
- 文字起こし（`transcribed-text`）: `italic` を**削除**（症状 G）
- `max-w-full` は維持。`diff-token` / `diff-legend` の scoped style は変更しない

### 2.6 アクションゾーン

以下は**構造の意図**を示した模式図であり、そのままの Svelte 記法ではない
（実際の分岐はフェーズごとの `{#if}` チェーンで書く）。

```text
div.flex.flex-none.flex-col.gap-2.border-t.border-border.bg-background.p-3
  └─ data-testid="action-zone"
     ├─ 主操作のスロット        … 常に 高々 1 個・全幅・variant 既定（塗り）
     │                          … 高さは h-12。ただし record-hold-btn は 4.5rem のまま据え置く
     │                          … recording / transcribing ではスロット自体が空
     └─ サブ操作のスロット      … 0〜2 個・全幅・h-11・variant="outline"（枠）
                                … 最後の一つが常に skip-btn
```

**主操作のマッピング**（常に 1 個・全幅・塗りの緑）:

| フェーズ | 主操作 | サブ |
|---|---|---|
| `show` | `もう一度再生`（`replay-btn`） | `スキップ` |
| `hidden`（ready） | `押して録音`（`record-hold-btn`、4.5rem 高を維持） | `スキップ` |
| `recording` | なし | `スキップ`（**disabled**） |
| `transcribing` | なし | `スキップ` |
| `feedback`（error） | `{errorRetryLabel}`（`error-retry-btn`） | `スキップ` |
| `feedback`（pass） | `次へ`（`next-btn`） | `もう一度聴く` / `スキップ` |
| `feedback`（fail） | `もう一度試す`（`retry-btn`） | `もう一度聴く` / `スキップ` |

`recording` と `transcribing` では主操作のスロットが空になる。この 2 フェーズでは
主操作を包むラッパ要素を出さない（`feedback` フェーズでは `data-testid="feedback-actions"` を付ける）。
`skip-btn` は全フェーズで必ず 1 個だけ出る。

サブ操作は**全幅の縦積み**とする。`tests/responsive.spec.ts:290-297` が
「390px で、コンテナ内の全ボタンが縦積みであること」を契約化しているため。
`sm:` 以上で横並びにしてよいが、E2E の縦積み契約があるため 390px では必ず縦積みを維持する。

### 2.7 症状 D の解決

`record-hold-btn` は microphone アイコン + テキスト + kbd バッジの 3 子要素。
390px では kbd が非表示（§4）になるため折り返す要素はなくなるが、
念のためアイコンに `shrink-0`、ラベルに `whitespace-nowrap` を明示する。

### 2.8 `min-h-40` の扱い

旧カードにあった `min-h-40`（10rem の下限）は撤去する。カード枠が無くなったため下限は不要で、
本文は `flex-1` のスクロール領域に上寄せで配置される。

---

## 3. スキップのフェーズガード

`skip()` は `recording` 中に no-op にする。§2 のアクションゾーン固定によってスキップボタンが
常に画面下に見えるようになり、録音中の誤タップが従来より起きやすくなるため。

```svelte
function skip(): void {
  // 録音中はスキップしない（録音 blob の破棄防止。アクションゾーンが常に可視のため必須）
  if (phase === 'summary' || phase === 'recording') return;
  skippedCount++;
  cancelSpeech();
  advanceToNext();
}
```

- ボタンは `disabled={phase === 'recording'}`。shadcn の Button は `disabled:opacity-50` のみで
  サイズは変わらないので 44px のタップ対象契約は守れる
- `skippedCount` はガード通過後にのみ加算されるので不正カウントは起きない
- キー `S` は `skip()` に集約済みのため同じガードが効く
- `show` / `tts` / `hidden` / `transcribing` / `feedback` は従来どおりスキップ可能
  （`transcribing` 中は既存の再ガード `phase !== 'transcribing'` が効いている）

---

## 4. キーボードヒントの出し分け

### 4.1 判定方法

Tailwind の `sm:`（40rem = 640px）ベース。既存のレスポンシブ処理は `sm:` 12 箇所のみで
CSS 側 media query の前例がゼロのため、既存の慣習に揃える。

### 4.2 実装上の注意（設計上の罠）

`.kbd-hint` は Svelte の scoped `<style>`、つまり **unlayered** なスタイルで
`display: inline-block` を宣言している。Tailwind の `hidden` は `utilities` レイヤーにあり、
カスケード上は unlayered が常に勝つ。**クラス属性に `hidden sm:inline-block` を足しても効かない。**

対処: `.kbd-hint` から `display: inline-block` を削除し、6 箇所の `<kbd class="kbd-hint">` に
`hidden sm:inline-block` を付与する。unlayered 競合が消え、他の 4 プロパティは scoped style に残る。

| 箇所 | ボタン | キー |
|---|---|---|
| `:1019` | `stop-btn` | — （§2.3 でアイコン化するためkbd自体を削除） |
| `replay-btn`（show） | もう一度再生 | `R` |
| `record-hold-btn` | 押して録音 | `Space` |
| `replay-btn`（feedback） | もう一度聴く | `R` |
| `next-btn` | 次へ | `Space` |
| `retry-btn` | もう一度試す | `Space` |
| `skip-btn` | スキップ | `S` |

`kbd` を非表示にしてもボタン本体ラベルは自己完結しているため情報損失はない。

`tests/practice.spec.ts:1030-1042` の kbd テキスト assert は `toContainText`
（`textContent` ベースで可視性を要求しない）のため、390px でも 1280px でも通る。

### 4.3 キーボードの散文指示文

`record-ready-hint`（「Space を押しながら読み上げてね」）は `kbd` 要素ではないため §4.2 の修正では消えない。
スマホ幅では意味を持たないので、`hidden sm:block` で出し分ける。
この要素に scoped ルールは無い（`.kbd-hint` 等の unlayered 競合が無い）ので Tailwind ユーティリティがそのまま効く。

- スマホ（<640px）: 非表示。隣り合う巨大ボタン「押して録音」が自明
- PC（≥640px）: 現在の文言を表示

代替文は追加しない（YAGNI）。

---

## 5. テーマ制御の移設

### 5.1 現状の不具合

`src/lib/theme.ts` の既定は既に `'system'`（端末同期）である。問題は `toggleTheme()` で、
これは押された瞬間に `system` を脱して `light` / `dark` を **localStorage に固定**し、
以降 `matchMedia` の購読を解除する（`syncMediaSubscription` が `removeEventListener` するため
`onSystemChange` も動かなくなる）。ナビのボタンを 1 回押すだけで端末のテーマ変更を追従しなくなる。

### 5.2 変更内容

| 場所 | 変更 |
|---|---|
| `+layout.svelte:58-69` | テーマ切替ボタンを**削除** |
| `src/lib/theme.ts` | `toggleTheme()` を**削除**。`DEFAULT_THEME` / `setTheme` / `getTheme` / `getResolvedTheme` / `subscribeTheme` / `matchMedia` 購読は**変更なし** |
| `src/routes/manage/+page.svelte` 設定タブ | 「表示テーマ」fieldset を**新設**（§1.2 で削除する「練習の操作」と同じ form パターン） |

```svelte
<!-- 管理 › 設定 -->
<fieldset class="setting-row flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3"
          aria-labelledby="theme-heading">
  <legend id="theme-heading" class="px-1 text-sm font-semibold">表示テーマ</legend>
  <div class="flex flex-col gap-1.5">
    <span class="text-sm font-medium">テーマ:</span>
    <RadioGroup.Root value={theme} onValueChange={(v) => setTheme(v as Theme)} class="flex flex-wrap gap-4">
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

- `RadioGroup.Item` の `class="size-11 sm:size-4"` は既存「練習の操作」と同じ慣習（44px タップ）
- `oboeru:theme` に既存の `light` / `dark` が入っていればそれを初期表示する（移行処理不要）
- 320px 幅で 3 つの選択肢が横並びに入らないため `flex-wrap` を付ける

---

## 6. エラー処理

新しい失敗モードは追加しない。

| ケース | 挙動 |
|---|---|
| `oboeru:practice-ui:v1` に古い値が残っている | 読み込むコードが無いので無視。orphan キーのみ |
| 録音中に `S` / スキップタップ | `skip()` が no-op。録音は継続、`skippedCount` も加算されない |
| 極小高のビューポート | 本文が `min-h-0` + `overflow-y-auto` で圧縮。アクションゾーンは `flex-none` で常に残存 |
| `oboeru:theme` に不正値 | `theme.ts` の `loadTheme()` が既に `system` にフォールバックする（変更なし） |
| テーマ切替（`matchMedia` 購読） | `system` 選択時のみ購読。`light` / `dark` 選択時は解除済みのまま（`syncMediaSubscription` の既存挙動） |

## 7. 非目標

- 時間による自動送りを復活させる設定トグル（§1 で完全廃止した）
- `show` / `tts` / `transcribing` フェーズのスキップガード（今回は `recording` のみ）
- `W` 等、新しいキー割り当ての追加
- 「次へ」ボタンへの `scrollIntoView`
- 縦横 orientation 別レイアウト
- 練習画面以外のデザイン変更（トップ・管理は実測で症状なし）
- ①の既知の残余（2 言語目のバックグラウンドウォーム）への追随
- `(pointer: coarse)` によるキーボードヒントの判定（§11 の既知の残余）

---

## 8. テスト計画

### 8.1 ユニット（vitest）

`src/lib/practice-prefs.test.ts` → `src/lib/practice-progress.test.ts` にリネーム。
prefs の describe 群（`loadPracticePrefs` / `savePracticePrefs` / 各種クランプ）だけを削除し、
`PracticeProgress` の describe はそのまま残す。

追加のユニットテストは不要。`skip()` のフェーズガードは 1 行の条件で DOM 依存があり、
E2E で検証する方が費用対効果が高い。

### 8.2 E2E（Playwright）

#### `tests/practice.spec.ts`

| 位置 | 変更 |
|---|---|
| `:10` | `PRACTICE_UI_KEY` 定数を削除 |
| `:42` | seed オプションの `practicePrefs?: {…}` 型を削除 |
| `:263-282` | full pass loop: `next-btn` を明示クリックしてから `summary` 待ち |
| `:284-300` | fail loop: `retry-btn` を明示クリックしてから `record-ready` 待ち |
| `:544` / `:549` | `track-badge` のアサーション **2 行を削除**（§2.3 で `track-badge` を撤去）。直隣の `:545` / `:550` の `progress` アサーションが同じ情報を検証しているため、検証内容のカバレッジは失われない |
| `:1030-1042` | `stop-btn ⊃ Esc` の 1 行を削除（§2.3 でアイコン化）。`R` / `Space` / `S` の assert は残す |
| `:1166-1196` | T9 describe を `practicePrefs` の seed を落とした上で**残す**。describe 名を `Practice — no auto-advance` に変更。これが新デフォルトの契約になる |
| **新規** | 録音中は `skip-btn` が `toBeDisabled()`。かつ `S` キーを押しても `getByTestId('progress')` が変わらない（スキップされない） |

#### `tests/e2e-full.spec.ts`

- `:157`（pass → 次文）の前に `next-btn` クリック
- `:164`（fail → 再試行）の前に `retry-btn` クリック
- `:169`（summary）の前に `next-btn` クリック

#### `tests/io-settings.spec.ts`

- `:504-537` の T9 describe 2 件を削除（削除された機能のテスト）
- `:9` の `PRACTICE_UI_KEY` を削除

#### `tests/responsive.spec.ts`

| 位置 | 変更 |
|---|---|
| `:20` | `PRACTICE_PREFS_KEY` を削除 |
| `:129-137` | `disableAutoAdvance` ヘルパーを削除（feedback が手動操作まで保持されるようになったので不要） |
| `:279` | セレクタを `[data-testid="feedback"]` → `[data-testid="feedback-actions"]` へ |
| **新規** | `[data-testid="action-zone"]` の `rect.bottom <= window.innerHeight + 1` かつ `rect.top >= 0` を show / recording / feedback の 3 フェーズで検証（＝症状 A の机械化） |
| **新規** | 390px で `[data-testid="progress-bar"]` の幅が `>= 0.8 * window.innerWidth`（＝症状 E の机械化） |
| **新規** | 390px で `.kbd-hint` が `toBeHidden()`（＝症状 C の机械化） |
| **新規** | `/practice` に `おぼえる` / `管理` ナビが無く、`/` にはある（＝練習中ナビ非表示の机械化） |

`feedback` 内のボタン幾何アサーション（全幅・縦積み）は**_selector 移動のみ**で、
アサーション内容は変えない。加えて「アクションゾーンがビューポート内」という
従来には無かった検証を追加する。テストの弱化ではない。
（ページ先頭へスクロールした状態で判定する）

#### `tests/a11y.spec.ts`

- `:27` の `PRACTICE_PREFS_KEY` を削除
- `:264-270` の `disableAutoAdvance` ヘルパーを削除
- `switchToDarkFresh`（`:215-219`）は `emulateMedia` + reload のみでナビボタンを叩かないため**無変更**
- §2.1 で `/practice` から `banner` landmark が消える。axe's `region` / `landmark-one-main` /
  `bypass` / `page-has-heading-one` はいずれも **moderate** なので serious/critical 0 の
  契約は守れる見込み（練習画面の全コンテンツは `<main id="main-content">` の中にあり
  landmark として有効。skip link も残る）。
  **これは推論であり、`npm run test:e2e` の実行で実証すること。違反が出た場合は
  `/practice` に `role="banner"` を持つ lightweight なヘッダーを戻す。**
- 管理画面の新規テーマ RadioGroup は既存の 4 タブ走査で axe にかけられる
  （§1.2 で削除する「練習の操作」と同じ RadioGroup パターンなので contrast / target は同等）

#### `tests/theme.spec.ts`

| テスト | 変更 |
|---|---|
| `toggle adds and removes .dark on <html>` | 管理 › 設定の radio 経由に書き替え（`system` → `dark` → `light`） |
| `theme persists across reload` | 同上 |
| `system mode follows prefers-color-scheme` | **無変更**（toggle を使わない） |
| `explicit theme overrides system preference` | 管理 › 設定の radio 経由に書き替え |

#### `tests/shell.spec.ts`

- `:66-68` の「`テーマ切替` ボタンが存在する」を削除し、
  代わりに「`/` にはテーマ切替ボタンが無く、管理 › 設定に 3 択がある」検証へ差し替え
- skip link / favicon / active nav の 3 件は `/` で走るため**無変更**

#### `tests/manage.spec.ts`

直接の依存はない。`getByRole('tab')` の count=4 の契約は変わらない。

### 8.3 検証コマンド

```bash
npm run check      # svelte-check: 0 エラー
npm test           # vitest
npm run test:e2e   # Playwright 全体
```

`practice.spec.ts` と `e2e-full` は並列負荷で稀にフレーキーなので、
落ちた場合は単独再実行して切り分ける（`npx playwright test tests/X.spec.ts --workers=1 --reporter=list`）。

### 8.4 実機ゲート（ユーザー承認）

Android Chrome で以下を確認する。①の spec と併せて一度でよい。

1. 初回モデル DL を含め 10 文以上連続練習して再読込が発生しない（①の完了条件）
2. 全フェーズで操作ボタンが画面下に見える（スクロール不要）
3. スマホ幅で `Space` / `R` / `S` / `Esc` ヒントが出ていない
4. 録音中に誤タップしても採点結果が出ない
5. 練習中に `おぼえる` / `管理` ナビが出ていない
6. 端末のダーク設定を変えるとアプリの配色も追従する
7. 色分け（ライブSTT）が引き続き動作する

---

## 9. ファイル変更一覧

### 削除

- `src/lib/constants.ts`

### リネーム

- `src/lib/practice-prefs.ts` → `src/lib/practice-progress.ts`
- `src/lib/practice-prefs.test.ts` → `src/lib/practice-progress.test.ts`

### 変更

- `src/routes/+layout.svelte` — ナビの practice 非表示 / テーマ切替ボタン削除 / `main` を flex カラム化
- `src/lib/practice-progress.ts` — prefs 群の削除
- `src/lib/practice-progress.test.ts` — prefs describe の削除
- `src/lib/theme.ts` — `toggleTheme()` の削除
- `src/routes/manage/+page.svelte` — 練習の操作の削除 / 表示テーマの追加
- `src/routes/practice/+page.svelte` — 3 区画化 / 自動送り廃止 / スキップガード / kbd 出し分け
- `tests/practice.spec.ts`
- `tests/e2e-full.spec.ts`
- `tests/io-settings.spec.ts`
- `tests/responsive.spec.ts`
- `tests/a11y.spec.ts`
- `tests/theme.spec.ts`
- `tests/shell.spec.ts`
- `AGENTS.md` — §10 参照
- `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` — 付録のロードマップで ② を完了に更新

### 新規

- なし

---

## 10. AGENTS.md の更新

- ディレクトリ地図に `src/lib/practice-progress.ts` を追記
- 「採点パイプライン規約」に **「時間による自動送りなし。`next-btn` / `retry-btn` の明示クリックでのみ進行。Space / Enter は同義」** を追記
- 「E2E テスト規約」に「採点画面は手動進行。テストは時間待ちに依存せず明示クリックする」を追記
- 「運用」に「練習中はグローバルナビを隠す。テーマは管理 › 設定からのみ」を追記
- `2026-09-22-tts-freeze-fix.md` の付録ロードマップで ② を完了に更新

## 11. 既知の残余（known residual）

- **キーボードヒントの判定は幅ベース**。横向きタブレット（≥640px）や狭いデスクトップウィンドウでは
  ヒントが出る。`pointer: coarse` / `hover: none` との併用は将来課題とする
  （Playwright の `emulateMedia` は `hover` / `pointer` を偽装できず、
  検証には `hasTouch` + `isMobile` の別コンテキストが必要になる）
- **`recording` / `transcribing` ではアクションゾーンにスキップしか出ない**。
  3 区画化により zone は常に表示されるため、`recording` 中はボタンのみの帯になる。
  視覚的には「今はスキップできない」ことが伝わるので意図通りとする
- **`data-testid="feedback"` の意味が変わった**。「スコア等の中身」を指すようになり、
  操作ボタンは新設の `feedback-actions` が指す。既存の外部ツール・計測が
  `feedback` で画面判定をしていた場合は追随が必要
