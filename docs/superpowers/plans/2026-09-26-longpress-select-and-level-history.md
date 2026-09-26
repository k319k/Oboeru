# 長押し文字選択修正 + スクロール履歴メーター Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 録音待ち・録音中のボタン領域で長押ししてもテキスト選択が始まらないようにし、録音フェーズに「右端に新しい音が届いて、左へ流れる」スクロール履歴音量メーターを入れる。

**Architecture:** 文字選択の抑止は practice ページの scoped style に 2 要素（`.record-hold-btn` と新規の `.action-zone`）だけを追加する。音量メーターは recorder が 100ms ごとに発火する既存の `onLevel(rms)` を practice ページ内の `levelHistory: number[]` に最大 32 個まで溜め、`justify-end` + `overflow-hidden` の行描画で「最新が右・古いほど左へ消える」を幅の計測なしに実現する。`src/lib/recorder.ts` は変更しない。

**Tech Stack:** SvelteKit 2 (Svelte 5 runes) / Tailwind CSS v4 / lucide-svelte / vitest / Playwright (chromium) / Cloudflare Workers (wrangler)

**Spec:** `docs/superpowers/specs/2026-09-26-longpress-select-and-level-history.md`

---

## Global Constraints

- **UI 文言は日本語**
- **390px 幅で横 overflow 0** / **可視インタラクティブ要素は全て 44px 以上**（WCAG 2.5.8）/ **axe serious・critical 0**（light / dark 両テーマ）
- **`data-testid="record-hold-btn"` の `data-hold-btn` と `aria-label="押している間、録音します"` は必ず残す**
- **`h-dvh`（練習ルート）と `class:py-6={!isPractice}`（`+layout.svelte`）の相互結合を壊さない。** 片方だけを変えると本文の `min-h-0 flex-1` チェーンがクランプせず、document 全体がスクロールして `action-zone` が画面外に出る
- **`data-testid="progress"` の外側ラッパ構造・`{progress}` の文字列・`showTrackBadge` の分岐条件は変更しない**（11 箇所の `toHaveText` 完全一致 assert が依存）
- **`src/lib/recorder.ts` は変更しない。** `SAMPLING_INTERVAL_MS` は 100 のまま
- **`as any` / `@ts-ignore` / `@ts-expect-error` による型エラー抑制は禁止**、**空の catch ブロックは禁止**
- **テストの削除・skip 化・アサーション弱化は禁止。** `level meter renders a non-zero width while recording` は削除せず書き換える
- **`git add -A` / `git add .` は禁止。** 変更したファイルだけを明示指定する
- **コミットは conventional commits（英語・単一行件名）**
- **完了後は `git push` と `npx wrangler deploy` まで実施する**（ユーザー明示依頼）
- **`git commit --amend` / `git reset --hard` / git config の変更は禁止**

### 現在の作業ツリー

ブランチ `feat/remove-live-stt`（`origin` に push 済み、upstream 設定済み）。
作業ツリーはクリーン。`babel-import.json` は `.gitignore` 済み（`git status` に出ない）。

---

## File Structure

| ファイル | 責務 | 本 plan での扱い |
|---|---|---|
| `src/routes/practice/+page.svelte` | 練習画面の 7 フェーズ state machine と UI | `LEVEL_HISTORY_MAX` / `levelHistory` state、`onLevel` _callback の拡張、録音開始時のリセット、`recording` フェーズの meter 差し替え、scoped style への `.action-zone` 追加と `-webkit-touch-callout` 追加、アクション zone の class に `action-zone` を追加 |
| `tests/practice.spec.ts` | 練習画面 E2E | level meter テストの書き換え、文字選択抑止 describe の新規追加 |
| `AGENTS.md` | プロジェクトの運用規約 | レイアウト規約表の class 列更新、文字選択抑止の行追加 |
| `src/lib/recorder.ts` | 録音・無音検知・レベル通知 | **変更しない**（`SAMPLING_INTERVAL_MS = 100`、`onLevel` はそのまま使う） |

---

## Task 1: 文字選択の抑止

**Files:**
- Modify: `src/routes/practice/+page.svelte`（scoped style とアクション zone の class）
- Test: `tests/practice.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: なし（本タスクが最初のタスク）
- Produces:
  - `src/routes/practice/+page.svelte` の scoped style に `.action-zone` ルールが存在し、`user-select: none` / `-webkit-user-select: none` / `-webkit-touch-callout: none` を宣言する
  - `.record-hold-btn` に `-webkit-touch-callout: none` が加わる
  - アクション zone の class 属性が `action-zone flex flex-none flex-col gap-2 border-t border-border bg-background p-3` になる
  - `data-testid="action-zone"` は変更なし（既に存在）
  - `sentence-text` / `diff-token` / `transcribed-text` は選択可能なまま（変更しない）

- [ ] **Step 1: 失敗するテストを書く**

`tests/practice.spec.ts` の `test.describe('Practice — T13 push-to-talk', …)` ブロックの**後**、
次のコメントブロックごと追加する:

```ts
// ---------------------------------------------------------------------------
// Long-press text selection: the record controls must not start a selection.
// Reproduced with a 1.2s touch hold (CDP Input.dispatchTouchEvent) — a real
// finger drift expands the range into visible text selection with Android's
// selection handles, which competes with the press.
// ---------------------------------------------------------------------------
// ⚠ 以下のコードは**実行すると通らない**。`cs.webkitTouchCallout` は (a) DOM lib に型が無く
// (b) Chromium が `-webkit-touch-callout` をパース時に捨てるので常に空文字。
// CDP タッチ経路も空振り。Step 2 の訂正コメントと AGENTS.md「既知の落とし穴」を参照。
// 実際の tests/practice.spec.ts は computed `user-select` + マウス長押＋ドラッグの
// 挙動テストの 2 本に置き換えてある。

test.describe('Practice — text selection is suppressed on the record controls', () => {
	test('the hold button and the action zone refuse text selection', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		for (const id of ['record-hold-btn', 'action-zone']) {
			const style = await page.getByTestId(id).evaluate((el) => {
				const cs = getComputedStyle(el);
				return { userSelect: cs.userSelect, touchCallout: cs.webkitTouchCallout };
			});
			expect(style.userSelect, `${id}: user-select`).toBe('none');
			expect(style.touchCallout, `${id}: -webkit-touch-callout`).toBe('none');
		}
	});

	test('sentence text and diff tokens stay selectable', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('sentence-text')).toBeVisible();

		// The suppression is scoped to the record controls; the sentence itself
		// must remain copyable.
		const userSelect = await page
			.getByTestId('sentence-text')
			.evaluate((el) => getComputedStyle(el).userSelect);
		expect(userSelect).not.toBe('none');
	});
});
```

`seedPractice` と `mockTts` は同じファイル内の既存ヘルパー。
`seedPractice(page)` を引数なしで呼ぶと既定の 1 文（`おはようございます。`）が seed される。

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list -g "text selection is suppressed"`
Expected: FAIL。`record-hold-btn` の `userSelect` は `none` だが
`touchCallout` は空文字（宣言が無い）ので `expect(style.touchCallout).toBe('none')` で失敗する。
`action-zone` は `userSelect` が `auto` なので最初の assert で失敗する。

> **訂正（Task 1 実行後の実測）**: この Step の `cs.webkitTouchCallout` は
> **通りえない**。DOM lib に型が無く（`as any` 禁止）、Chromium の CSS パーサが
> `-webkit-touch-callout` をパース時に捨てるので `getPropertyValue` でも常に空文字になる。
> 実際の Task 1 ではこの assert をやめ、computed `user-select` の検証 +
> マウス長押＋ドラッグの挙動テストに置き換えた。CDP タッチ経路も空振りなので
> 使っていない。詳細は `AGENTS.md`「既知の落とし穴」と task-1-report.md。

- [ ] **Step 3: `.record-hold-btn` に `-webkit-touch-callout: none` を追加する**

`src/routes/practice/+page.svelte` の scoped `<style>` にある `.record-hold-btn` ブロック内で、
既存の

```css
		cursor: pointer;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
```

のうち `cursor: pointer;` の直後に `-webkit-touch-callout: none;` を 1 行挿入する
（実際のファイルには `cursor: pointer;` が無ければ `touch-action: none;` の直後に入れる）:

```css
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
```

- [ ] **Step 4: `.action-zone` ルールを新規追加する**

同じ scoped `<style>` の末尾（`.kbd-hint` ブロックの閉じ `}` の直後、`<style>` の `</style>` の直前）に追加する:

```css
	/* 長押しでのテキスト選択とコンテキストメニューを抑止する。録音操作中は
	   意図しない選択が押下の妨げになる。ボタンとアクション zone にだけ適用し、
	   文テキストと差异トークンは選択可能なまま残す。 */
	.action-zone {
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}
```

scoped style は unlayered なので `user-select` の宣言は Tailwind のユーティリティに
優先して効く。class 属性にユーティリティを足す必要はない。

- [ ] **Step 5: アクション zone の class に `action-zone` を追加する**

`data-testid="action-zone"` を持つ要素の class 属性を、
`class="flex flex-none flex-col gap-2 border-t border-border bg-background p-3"` から
`class="action-zone flex flex-none flex-col gap-2 border-t border-border bg-background p-3"` に変更する。

**注意**: この class 文字列は `AGENTS.md` の「practice 画面のレイアウト規約」表に
1 文字ずつ一致する形で記載されている。Step 7 で AGENTS.md も更新する。

- [ ] **Step 6: 検証する**

Run: `npm run check`
Expected: エラー 0

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list 2>&1 | tail -20`
Expected: PASS

Run: `npx playwright test tests/responsive.spec.ts tests/a11y.spec.ts --workers=1 --reporter=list 2>&1 | tail -20`
Expected: PASS。特に `responsive.spec.ts` の `[data-testid="action-zone"]` の
`rect.bottom <= innerHeight + 1` アサーションが引き続き通ること
（class の先頭に 1 語足しただけなので幾何は変わらない）。

- [ ] **Step 7: AGENTS.md を更新する**

「practice 画面のレイアウト規約」節にある表の action-zone 行の class 列を、
`flex flex-none flex-col gap-2 border-t border-border bg-background p-3` から
`` `action-zone flex flex-none flex-col gap-2 border-t border-border bg-background p-3` `` に変更する。

さらに「録音中はスキップ不可」の行の直後に 1 行追加する:

```
- **長押しでテキスト選択が始まらない。** 録音ボタン (`.record-hold-btn`) と下部アクションゾーン (`.action-zone`) は `user-select: none` + `-webkit-touch-callout: none`。録音操作を長押しで妨害しないため。`sentence-text` と `diff-token` は選択可能なまま残す
```

- [ ] **Step 8: コミットする**

```bash
git add src/routes/practice/+page.svelte tests/practice.spec.ts AGENTS.md
git status --short
```

意図した 3 ファイルだけがステージされていることを確認してから:

```bash
git commit -m "fix: suppress text selection and the callout menu on the record controls"
```

---

## Task 2: スクロール履歴音量メーター

**Files:**
- Modify: `src/routes/practice/+page.svelte`（state、定数、`onLevel`、録音開始時のリセット、`recording` フェーズの DOM）
- Test: `tests/practice.spec.ts`

**Interfaces:**
- Consumes: Task 1（アクション zone に `action-zone` クラスが付き、文字選択が抑止されている状態）
- Produces:
  - `src/routes/practice/+page.svelte` に module scope の `const LEVEL_HISTORY_MAX = 32;` が存在する
  - `let levelHistory: number[] = $state([]);` が存在する（古い順に古い→新しい、最大 32）
  - `r.onLevel` 回调が `recordingLevel` に加えて `levelHistory` を末尾に追加する
  - 録音開始時（`recordingLevel = 0` と並べて）に `levelHistory = []` をリセットする
  - `recording` フェーズに `data-testid="level-history"` を持つ要素が存在し、その内側に `<span>` が 0〜32 個並ぶ
  - `data-testid="level-meter"` は同じコンテナに付け替えられ、`data-testid="level-meter-fill"` と `data-testid="level-value"` は**削除される**
  - `levelPct` は `$derived` として残り、コンテナの `aria-label` にだけ使われる
  - `src/lib/recorder.ts` は無変更

- [ ] **Step 1: 失敗するテストを書き換える**

`tests/practice.spec.ts` の `test('level meter renders a non-zero width while recording', …)` を、
次のテストで**置き換える**（削除しない。意図「無音でないことの検証」を新しい可視的実証に換える）:

```ts
	test('level history grows and reacts while recording', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		// fake-media produces a tone, so at least one bar must exceed the 3px floor.
		await page.waitForFunction(() => {
			const bars = document.querySelectorAll('[data-testid="level-history"] span');
			return (
				bars.length >= 3 &&
				[...bars].some((b) => parseFloat((b as HTMLElement).style.height) > 3)
			);
		});

		const count = await page.getByTestId('level-history').locator('span').count();
		expect(count).toBeGreaterThanOrEqual(3);
		expect(count).toBeLessThanOrEqual(32);

		await page.keyboard.up('Space');
	});
```

**注意**: 置き換えたあとも、直後の `test.describe` の閉じ括弧と後続のコードはそのまま残す。
`level-value` / `level-meter-fill` を参照する他のテストが無いことを先に確認する:

Run: `grep -n "level-value\|level-meter-fill" tests/`
Expected: 置き換え対象_assert 以外にヒットが無いこと（`a11y.spec.ts` と `responsive.spec.ts` はヒットしない）。

- [ ] **Step 2: テストが赤になることを確認する**

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list -g "level history grows"`
Expected: FAIL。`[data-testid="level-history"]` が存在しないため `page.waitForFunction` が
timeout する。

- [ ] **Step 3: 定数と state を追加する**

`src/routes/practice/+page.svelte` の script で、`let recordingLevel: number = $state(0);` の
**直後**に次の 2 行を追加する:

```ts
	/** 録音レベルの履歴。古い順に古い→新しい。最大 LEVEL_HISTORY_MAX 個 (32 × 100ms = 3.2 秒)。 */
	let levelHistory: number[] = $state([]);
```

`let recordingLevel` の**前**（同じスクリプトの module scope、定数の並びの最後）に定数を追加する:

```ts
/** スクロール履歴メーターが保持するサンプル数。recorder の onLevel は 100ms ごと
 *  (recorder.ts の SAMPLING_INTERVAL_MS) なので 32 個 = 3.2 秒ぶん。 */
const LEVEL_HISTORY_MAX = 32;
```

- [ ] **Step 4: `onLevel` 回调を拡張する**

`r.onLevel = (rms) => { … };` を次のように置き換える:

```ts
				r.onLevel = (rms) => {
					recordingLevel = rms;
					levelHistory = [...levelHistory, rms].slice(-LEVEL_HISTORY_MAX);
				};
```

新しい `rms` を足してから `.slice(-LEVEL_HISTORY_MAX)` で末尾だけを残す。
先に `slice(-(LEVEL_HISTORY_MAX - 1))` すると `LEVEL_HISTORY_MAX` が 1 のとき
`slice(-0)` = `slice(0)` となり既存全件が返って上限が消失し、無限成長する。

- [ ] **Step 5: 録音開始時に履歴をリセットする**

`recordingLevel = 0;` がある箇所（`beginHold` 付近）の直後に 1 行追加する:

```ts
		recordingLevel = 0;
		levelHistory = [];
```

`recordingLevel = 0;` は `grep -n "recordingLevel = 0" src/routes/practice/+page.svelte` で
1 箇所だけのはずなので、その唯一の箇所に追加する。

- [ ] **Step 6: `recording` フェーズのメーターを置き換える**

`data-testid="level-meter"` を持つ `<div>` ブロック（`role="img"` と `aria-label` を含む、
`level-meter-fill` と `level-value` を内包する要素）を丸ごと削除し、
次の要素に置き換える:

> **注意（Task 2 実装後のレビューで判明）**: この行の `w-full` だけでは不十分で、
> **親の `sentence-recording`（`data-testid="sentence-recording"`）にも
> `w-full` を付けること**。`items-center` により `sentence-recording` の cross size は
> fit-content に解決され、fit-content は min-content（`8×32 + 3×31 + 8×2 = 365px`）を
> 下回れない。`w-full` が無いと 320px / 360px で 365px のまま中央寄せではみ出し、
> `overflow-hidden` が clip する前に行が viewport 外へ出る（320px 実測:
> 行は -22.5..342.5、最新棒も画面外）。
> `level-meter` にも `min-w-0` を付ける（row 方向の flex item になった場合に
> min-content が再び勝つための将来防御）。
> 検証: `npx playwright test tests/responsive.spec.ts -g "level history stays inside"`
> — 4 viewport 全て緑。単に `w-full` を外すと 320/360px で赤になる。

```svelte
						<div
							class="flex h-[72px] w-full items-center justify-end gap-[3px] overflow-hidden rounded-lg bg-muted/40 p-2"
							data-testid="level-history"
							data-testid-level="meter"
							role="img"
							aria-label={`録音レベル ${levelPct}%`}
						>
							{#each levelHistory as level, i (i)}
								<!--
									高さはコンテンツボックス (h-[72px] - p-2*2 = 56px) に収める。
									係数 224 = 56 / 0.25 で、level 0.25 で満高 = levelPct
									(min(100, round(level * 400))) が 100% に到達する点と一致。
									Math.min(56) により overflow は構造的に起きない。
								-->
								<span
									class="w-2 shrink-0 rounded-sm"
									style:height={`${Math.max(3, Math.min(56, Math.round(level * 224)))}px`}
									style:background={i >= levelHistory.length - 6
										? 'var(--primary)'
										: `color-mix(in oklab, var(--primary) ${Math.round(
												(i / Math.max(1, levelHistory.length - 1)) * 100
											)}%, var(--muted-foreground))`}
								></span>
							{/each}
						</div>
```

**注意**: 1 つの要素に `data-testid` を 2 つ書けない。`data-testid="level-history"` を
内側の行に付け、外側のラッパに既存の `data-testid="level-meter"` を残す。
最終形の構造は次のとおり:

```svelte
						<div class="flex w-full flex-col gap-1" data-testid="level-meter">
							<div
								class="flex h-[72px] w-full items-center justify-end gap-[3px] overflow-hidden rounded-lg bg-muted/40 p-2"
								data-testid="level-history"
								role="img"
								aria-label={`録音レベル ${levelPct}%`}
							>
								{#each levelHistory as level, i (i)}
								<!--
									高さはコンテンツボックス (h-[72px] - p-2*2 = 56px) に収める。
									係数 224 = 56 / 0.25 で、level 0.25 で満高 = levelPct
									(min(100, round(level * 400))) が 100% に到達する点と一致。
									Math.min(56) により overflow は構造的に起きない。
								-->
									<span
										class="w-2 shrink-0 rounded-sm"
										style:height={`${Math.max(3, Math.min(56, Math.round(level * 224)))}px`}
										style:background={i >= levelHistory.length - 6
											? 'var(--primary)'
											: `color-mix(in oklab, var(--primary) ${Math.round(
													(i / Math.max(1, levelHistory.length - 1)) * 100
												)}%, var(--muted-foreground))`}
									></span>
								{/each}
							</div>
						</div>
```

**外側の `data-testid="level-meter"` ラッパを保つ理由**: 既存の外側フックを
将来の変更に備えて保持するため。`level-meter-fill` と `level-value` の 2 つの内側
testid は**削除**される（Step 1 のテスト書き換えが先）。

`levelPct` はこの `aria-label` にしか使われなくなるが、削除すると未使用で lint が鳴るため
`$derived` として残す。

- [ ] **Step 7: 検証する**

Run: `npm run check`
Expected: エラー 0。特に `levelPct` が未使用だと警告されないこと

Run: `npm test`
Expected: PASS

Run: `npx playwright test tests/practice.spec.ts --workers=1 --reporter=list 2>&1 | tail -20`
Expected: PASS

Run: `npx playwright test --workers=1 --reporter=list 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 8: 390px 実測と目視確認**

`/tmp/` に計測スクリプトを書いて Playwright を直接動かす。
`.omo/tools/shoot-390.mjs` の WAV ヘッダは壊れているので使わないこと
（正しい WAV は `tests/tts-mock.ts` の `silentWavBytes()` と同じ形式的を作る）。

録音フェーズに到達する手順:
1. `**/api/tts` を `silentWavBytes()` の WAV で fulfill
2. `**/api/transcribe` を `{ "text": "おはようございます。" }` で fulfill
3. `**/api/judge` を `{ "available": false }` で fulfill
4. `oboeru:v1` に 1 章 + トラック + 1 文を seed
5. `/practice?chapter=ch-ja-01` へ移動し `record-ready` を待つ
6. `keyboard.down('Space')` → `sentence-recording` を待つ → 900ms 待つ → 撮影

実測して報告に書くこと:

| 項目 | 期待値 |
|---|---|
| `[data-testid="level-history"] span` の個数 | 1 以上 32 以下 |
| `[data-testid="level-history"] span` の**いずれかが** 3px より大きい | （fake device は 500ms ごとに 1 本だけ音を出す断続 beep なので、固定時刻の末尾 1 本では判定不能） |
| `documentElement.scrollWidth - clientWidth` | 0 |
| `[data-testid="action-zone"]` の `rect.bottom` | `<= innerHeight + 1` |
| スクリーンショット | 右端に新しい棒、左に向かって古い棒が小さい/灰色 |

スクリーンショットは Read 工具で**画像として読み**、棒が右から左へ流れているか、
視覚的に破綻していないかを目視確認する。

- [ ] **Step 9: コミットする**

```bash
git add src/routes/practice/+page.svelte tests/practice.spec.ts
git status --short
git commit -m "feat: replace the level bar with a scrolling level history meter"
```

---

## Task 3: ドキュメント更新・全体検証・push・デプロイ

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-09-26-longpress-select-and-level-history.md`

**Interfaces:**
- Consumes: Task 1（文字選択抑止）、Task 2（スクロール履歴メーター）
- Produces: なし（ドキュメント＋リリース操作）

- [ ] **Step 1: AGENTS.md にレベルの行を追加する**

「練習中はグローバルナビが出ない」「録音中はスキップ不可」「390px ではキーボードヒント非表示」
の行がある箇所の近くに 1 行追加する:

```
- **録音中はスクロール履歴メーターを出す。** `recording` フェーズは `data-testid="level-history"` の縦棒 32 本（`justify-end` + `overflow-hidden` で最新が右・古いほど左へ消える）。1 本 100ms ぶん = 3.2 秒履歴。`recorder.ts` の `SAMPLING_INTERVAL_MS` は 100 のまま
```

Task 1 Step 7 で「録音中はスキップ不可」の直後に追加した文字選択の行の**さらに後**に置く。

- [ ] **Step 2: spec の「実測結果」節を実装後の値に更新する**

`docs/superpowers/specs/2026-09-26-longpress-select-and-level-history.md` の
「現状の実測」節は**変更しない**（変更前の状態を記録しているため）。
ただし「完了条件」に 1 項目追加する:

```diff
  8. デプロイ後のスモーク（`GET /` 200、`POST /api/judge` が `available: true`）
+9. マウス長押＋ドラッグで `record-ready-hint` の `document.getSelection().rangeCount` が 0、対照の `sentence-text` は 1 以上になること（`record-hold-btn` とアクション zone の中心は Chromium が button 内側を選択しないため**測らない**。CSS は computed `user-select` で確認する）
```

- [ ] **Step 3: 全体を検証する**

Run: `npm run check`
Expected: `svelte-check found 0 errors and 0 warnings`

Run: `npm test`
Expected: PASS

Run: `npm run test:e2e 2>&1 | tail -20`
Expected: 全て PASS
`practice.spec.ts` は並列負荷で稀にフレーキーなので、落ちたら単独再実行する:
`npx playwright test tests/practice.spec.ts --workers=1 --reporter=list`

- [ ] **Step 4: 実機相当の長押し検証（マウス長押＋ドラッグ）**

  `/tmp/` にスクリプトを書いて、**デスクトップ幅（既定 1280×720）**のコンテキストで
  **マウス長押し＋ドラッグ**（`mouse.move` → `mouse.down` → 一定距離の `mouse.move` を数回 →
  `mouse.up`）を **2 要素**に対して行い、`document.getSelection().rangeCount` を読み取る。
  対照の `sentence-text` と、抑止の判定を担う `record-ready-hint` だけである。

  | 試行 | フェーズ | 期待値 | 測る理由 |
  |---|---|---|---|
  | `sentence-text`（対照・選択可能なまま） | `show` | **1 以上** | 対照。0 だとジェスチャ自体が空振り |
  | `record-ready-hint`（アクション zone 内の散文） | `hidden`（録音準備完了） | **0** | 宣言を消すと 1 になるので**検出できる唯一のケース** |

  **`record-hold-btn` とアクション zone の中心は測らない。** Chromium は `<button>` ウィジェット内の
  テキストを選択しないので、宣言を消しても 0 のままになる（恒真）。
  CSS の回帰は computed `user-select` のテストが担う。

  **幅の注意（重要）**: `record-ready-hint` は `src/routes/practice/+page.svelte:1191` の
  `class="hidden ... sm:block"` なので **640px 未満には存在しない**。
  390px で `getByTestId('record-ready-hint')` を待っても **30s でタイムアウトする**。
  よって**この判別はデスクトップ幅で行う**。

  **390px で行うのは computed `user-select` の確認だけ**にする
  （`record-hold-btn` / `action-zone` / `sentence-text`）。
  390px の実行可能な確認は「宣言が存在すること」までで、
  挙動の判別（0 になること）は 640px 以上で行う。

  **フェーズ注意**: `record-ready-hint` は `show` フェーズに存在しない。
  対照の `sentence-text` は `show` フェーズで採り、
  `record-ready-hint` は TTS 終了を待って `hidden` フェーズ（`record-ready` 可視）で採る。

  **対照ケースを必ず実行する。** `sentence-text` が 1 以上になることを先に確認し、
  初めて 0 が「抑止が効いている」証拠になる。ジェスチャ自体が常に 0 なら何も証明にならない。

  **CDP のタッチ経路は使ってはいけない。** `Input.dispatchTouchEvent` は
  Chromium のこのビルドでは選択可能テキストに対しても `rangeCount` が 0 になるため、
  修正前でも 0 で**恒真**（＝空振り検証）になる。マウス経路だけが識別力を持つ。

  **なお `record-hold-btn` とアクション zone の中心は宣言を消しても 0 のまま**になる。
  Chromium は `<button>` ウィジェットの内側では CSS に関係なく選択が始まらないため。
  この 2 つの CSS を守るのは computed `user-select` のテストであり、
  宣言の欠落を検出する役割は `record-ready-hint` が担う。

  スクリーンショットも撮って `record-hold-btn` と `action-zone` の
  周辺に選択ハイライトが出ていないことを目視確認する。

- [ ] **Step 5: コミットする**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-26-longpress-select-and-level-history.md
git status --short
git commit -m "docs: record the level history meter and selection suppression contracts"
```

- [ ] **Step 6: push する**

```bash
git push
```

Expected: `main` → `feat/remove-live-stt` の push として `origin` に反映される

- [ ] **Step 7: 本番ビルドしてデプロイする**

```bash
rm -rf .svelte-kit/output
npm run build
npx wrangler deploy
```

Expected: `✔ done` が出て、Worker Version ID が表示される

- [ ] **Step 8: デプロイ後のスモーク**

Cloudflare edge の伝播遅延があるため、entry のハッシュが変わるまで数回リトライする。

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://oboeru.k319-k319-k319-k319.workers.dev/
curl -s -X POST https://oboeru.k319-k319-k319-k319.workers.dev/api/judge \
  -H "Content-Type: application/json" \
  -d '{"reference":"3階","transcription":"三階"}'
```

Expected: 1 行目は `200`、2 行目は `{"available":true,"noul":0.8 以上,...}`

さらに本番を 390px で実測して以下を確認する:

| 項目 | 期待値 |
|---|---|
| `[data-testid="level-history"]` が録音フェーズに存在 | 存在する |
| 可視の `.kbd-hint` | 0 個（②の回帰確認） |
| `[data-testid="action-zone"]` の `rect.bottom` | `<= innerHeight + 1`（②の回帰確認） |
| `record-hold-btn` の computed `user-select` | `none` |
| `action-zone` の computed `user-select` | `none` |
| `sentence-text` の computed `user-select` | `none` 以外（選択可能なまま） |

`action-zone` の computed `-webkit-touch-callout` は**確認しない。**
Chromium の CSS パーサが宣言を落とすため常に空文字で、この行は必ず失敗する。
宣言の存在と検証不能な点は `AGENTS.md`「既知の落とし穴」に記録済み。
iOS 専用プロパティとしての実効は本番自動テストでは確認できない。

スクリーンショットを撮って目視確認する（棒が右から左へ流れているか、
外部ナビが出ていないか、進捗バーが全幅か）。

---

## Self-Review

### 1. Spec カバレッジ

| Spec の節 | 担当タスク |
|---|---|
| §1.1 `.record-hold-btn` に `-webkit-touch-callout: none` | Task 1 Step 3 |
| §1.1 `.action-zone` ルールを新規追加 | Task 1 Step 4 |
| §1.2 class への `action-zone` 追加 | Task 1 Step 5 |
| §1.3 対象外（sentence / diff は選択可能なまま） | Task 1 Step 1 の 2 つ目のテストで保証 |
| §1.4 scoped style のカスケード | Task 1 Step 4 のコメント |
| §2.1 `LEVEL_HISTORY_MAX` / `levelHistory` / `onLevel` 拡張 / リセット | Task 2 Step 3・4・5 |
| §2.2 描画（`justify-end` + `overflow-hidden` / 高さ / 色 / aria） | Task 2 Step 6 |
| §2.3 `w-56` → `w-full` | Task 2 Step 6 |
| §3.1 level meter テストの書き換え | Task 2 Step 1・2 |
| §3.2 文字選択抑止の新規テスト | Task 1 Step 1・2 |
| §3.3 検証コマンド | 各タスクの最終ステップ + Task 3 Step 3 |
| §3.4 390px 実測 | Task 2 Step 8 + Task 3 Step 4・8 |
| §4 エラー処理 | コード上の副作用なし（Step 3〜6 で充足） |
| §5 非目標 | 遵守（`recorder.ts` を触らない / 追加機能なし） |
| §6 既知の残余（reduced-motion を抑制しない / 3.2 秒の窓） | 実装判断。AGENTS.md には residuals を書かない（spec に留在済み） |
| §7 ファイル変更一覧 | 全タスクの Files 節と一致 |
| §8 完了条件 1〜8 | 各タスクの検証 + Task 3 Step 6〜8 |

ギャップなし。

### 2. Placeholder スキャン

- TBD / TODO / FIXME なし
- 「同様に」「Task N と同じ」の省略なし（全ステップに実コードあり）
- 型の未定義参照なし（`LEVEL_HISTORY_MAX` は Task 2 Step 3 で定義し、Step 4 から使用）

### 3. 型の一貫性

- `levelHistory: number[]` は Step 3 で定義、Step 4 の `slice` と Step 6 の `{#each}` で使用
- `LEVEL_HISTORY_MAX: number` は Step 3 で定義、Step 4 の `.slice(-LEVEL_HISTORY_MAX)` で使用
- `levelPct` は既存（`$derived`）。Step 6 の `aria-label` で使用。`$derived` として残す指示あり
- `data-testid="level-meter"` は Step 6 の外側ラッパに残す。`level-meter-fill` / `level-value` は削除
- Task 1 のテストが参照する `record-hold-btn` / `action-zone` / `sentence-text` はすべて既存または Step 5 で追加

### 4. タスク境界の妥当性

- Task 1（文字選択）は単独で検証可能。Task 2（メーター）と独立している
- Task 2（メーター）は単独で検証可能。Task 1 の class 追加に依存しない
- Task 3 はドキュメント＋リリース操作。コード変更は AGENTS.md と spec のみ
