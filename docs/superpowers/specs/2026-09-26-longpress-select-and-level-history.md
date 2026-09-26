# 長押し時の文字選択バグ修正 + スクロール履歴音量メーター — 設計

- 日付: 2026-09-26
- 状態: ユーザー承認済み
- 前置き: `docs/superpowers/specs/2026-09-26-ui-enhancement.md`（②スマホUI強化）の後続。デプロイ済みの ② に対する追加修正
- 関連: `src/routes/practice/+page.svelte` / `tests/practice.spec.ts` / `AGENTS.md`

## 目的

実機（Android Chrome）で確認された 2 件の不具合を修正する。

1. **長押し録音のボタンにActs 指を触れると、勝手にテキスト選択が始まる**。録音の押下操作が妨げられる
2. **録音フェーズが退屈**。音量，平均の細いバー 1 本と「レベル N%」の文字列しかなく、画面の大半が白いまま

成功条件:

1. 録音待ち・録音中のボタン領域で長押ししてもテキスト選択・コンテキストメニューが出ない
2. `feedback` の差异テキストと `show` フェーズの文テキストは**選択可能なまま**（意図的に対象外）
3. 録音中に「右端に新しい音 arrived し、左へ流れる」スクロール履歴メーターが表示される
4. 既存 44px タップ契約・390px 横 overflow 0・axe serious/critical 0・`npm run check` 0 エラーを維持

## 現状の実測（2026-09-26 / dev サーバー / 390×844）

### バグ 1: テキスト選択

**訂正（Task 1 実行中の実測による）**: 当初この節は「CDP `Input.dispatchTouchEvent` で
1.2 秒長押し → `rangeCount` が **1**」と記録していたが、**この測定値は正しくない**。
Chromium のこの headless ビルドでは CDP のタッチ経路が**選択可能な要素に対しても
`rangeCount` を 0 のままに保つ**ため、`rangeCount: 1` はCDP経路では再現しない。
以下の表は訂正後の実測（**マウス長押＋ドラッグ**経路）である。

| 試行 | `getSelection().rangeCount` | `getSelection().toString()` |
|---|---|---|
| ボタン上で 1.2 秒長押し（CDP タッチ） | 0 | `""` — **CDP 経路は選択を作らない（空振り）** |
| ボタン直下 24px で 1.2 秒長押し（CDP タッチ） | 0 | `""` — 同上 |
| 任意の `<div>` をマウス長押＋ドラッグ | 1 | 選択される（マウス経路は有効） |
| 任意の `<button>` をマウス長押＋ドラッグ | 0 | **CSS に関係なく選択されない**（後述の罠） |

つまり **CDP タッチ経路では元のバグを再現できない**（対照ケースも 0）。
実機（Android Chrome）で起きている事象は自動化環境では観測できず、
自動テストで代替できるのは**マウス長押＋ドラッグ経路**だけである。

**検証経路の能力和上限**:

| 経路 | 抑止の検出 | 備考 |
|---|---|---|
| computed `user-select` | ○（宣言の存在） | CSS の回帰としては十分 |
| マウス長押＋ドラッグ（非 button の散文） | ○（挙動） | `record-ready-hint` が対象 |
| マウス長押＋ドラッグ（`<button>` 内側） | × | Chromium は button 内側で CSS に関係なく選択しない |
| CDP `Input.dispatchTouchEvent` | × | 選択可能テキストでも 0 → 恒真 |

選択範囲の生成自体は実機では起きている（指が微小に動くと範囲が拡張し、テキスト選択と
Android の選択ハンドルが操作を妨げる）。ただし **その指数を Chromium で再現することはできない**
ため、「自動テストが通った」は「実機でも直った」の証明にはならない。

原因（コード根拠）:

- `src/routes/practice/+page.svelte:1386-1387` — `user-select: none` は **`.record-hold-btn` にだけ**ある
- **`-webkit-touch-callout` の宣言が 0 件**（`src/` 全体 grep でヒットなし）。これが iOS の長押しメニューと Android の選択ハンドルの出所
- アクション zone には何も宣言されていない

### 現状の level-meter

`src/routes/practice/+page.svelte:1060-1076` の実測値。

| 要素 | 実測 |
|---|---|
| `level-meter` コンテナ | 224 × 32 px（`w-56`） |
| `level-meter-fill` | 4 × 12 px（level 2% のためほぼ空） |
| `level-value` テキスト | `レベル 2%` |

録音フェーズの残りはすべて空白。スクリーンショットでも確認済み。

### `onLevel` のサンプリングレート

`src/lib/recorder.ts:12` の `SAMPLING_INTERVAL_MS = 100`、`recorder.ts:212` の
`setInterval(checkSilence, SAMPLING_INTERVAL_MS)` で **100ms ごと**に `onLevel(rms)` が呼ばれる。
ユーザーが想定していた「1セル 50ms」は現実に存在しない。`recorder.ts` を変更せずに 100ms をそのまま使う方針で確定した。

## 設計方針

**1. 文字選択の抑止は録音操作の領域に限定する。** ボタンとアクション zone の 2 要素だけ。
sentence と差异は選択可能なまま残す。

**2. 音量は「履歴」として見せる。** 瞬時値を 100ms ごとに 32 個まで保持し、
最新を右端に置いて左へ流す。`justify-end` + `overflow-hidden` により画面幅の計測なしで
幅に追従する。

---

## 1. 文字選択の抑止

### 1.1 変更対象は 2 要素のみ

| 要素 | 変更 |
|---|---|
| `.record-hold-btn`（既に scoped style に存在） | 既存の `user-select: none` / `-webkit-user-select: none` に **`-webkit-touch-callout: none`** を追加 |
| `.action-zone`（**新規に scoped style と class を追加**） | `user-select: none` / `-webkit-user-select: none` / `-webkit-touch-callout: none` |

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

### 1.2 class への `action-zone` 追加

アクション zone の class に `action-zone` を先頭に追加する。

```diff
- class="flex flex-none flex-col gap-2 border-t border-border bg-background p-3"
+ class="action-zone flex flex-none flex-col gap-2 border-t border-border bg-background p-3"
```

`AGENTS.md` の「practice 画面のレイアウト規約」表の action-zone 行の class 列もこれに合わせて更新する
（表は「class 名がコードと一字一致すること」を AGENTS.md 内で自己規約化しているため）。

### 1.3 明示的に対象外とするもの

- `sentence-text`（`show` / `tts` フェーズの文）
- `diff-token` / `transcribed-text`（`feedback` フェーズ）
- 练习動作のない本文領域

これらは選択可能なまま残す。練習アプリでのコピー需要は無いが、仕様上は
選択をdisable する根拠が無い。

### 1.4 scoped style のカスケード

`+page.svelte` の scoped `<style>` は unlayered なので、`user-select` の宣言は
Tailwind のユーティリティに優先して効く。`.action-zone` は scoped style 側で
宣言するため、class 属性にユーティリティを足す必要はない。

---

## 2. スクロール履歴メーター

### 2.1 データ

`src/routes/practice/+page.svelte` に追加する state:

```ts
	/** 録音レベルの履歴。古い順に古い→新しい。最大 LEVEL_HISTORY_MAX 個 (3.2 秒ぶん)。 */
	let levelHistory: number[] = $state([]);
```

`recorder.ts` の `onLevel` 回调で `recordingLevel` を代入している 1 箇所に、履歴を追記する:

```ts
				r.onLevel = (rms) => {
					recordingLevel = rms;
					levelHistory = [...levelHistory.slice(-(LEVEL_HISTORY_MAX - 1)), rms];
				};
```

録音開始時のリセットは、既存の `recordingLevel = 0` がある箇所に並べる:

```ts
		recordingLevel = 0;
		levelHistory = [];
```

定数は module scope の `const LEVEL_HISTORY_MAX = 32;` として置く。
`32 × 100ms = 3.2 秒`。

**`src/lib/recorder.ts` は変更しない。** サンプリング周期 100ms のまま、
practice 页面内で完結させる。

### 2.2 描画

現在の単一バー（`level-meter-fill` と `level-value`）を、次の要素で置き換える:

```svelte
						<div
							class="flex h-[72px] w-full items-center justify-end gap-[3px] overflow-hidden rounded-lg bg-muted/40 p-2"
							data-testid="level-history"
							role="img"
							aria-label={`録音レベル ${levelPct}%`}
						>
							{#each levelHistory as level, i (i)}
								<span
									class="w-2 shrink-0 rounded-sm"
									style:height={`${Math.max(3, Math.round(level * 260))}px`}
									style:background={i >= levelHistory.length - 6
										? 'var(--primary)'
										: `color-mix(in oklab, var(--primary) ${Math.round(
												(i / Math.max(1, levelHistory.length - 1)) * 100
											)}%, var(--muted))`}
								></span>
							{/each}
						</div>
```

**設計上の要点**:

- **`justify-end` + `overflow-hidden`** が肝。最新サンプルが常に右端に留まり、
  古い棒は左へ押し出されて消える。これにより**画面幅の計測が不要**になり、
  320px でも 430px でも自然に追従する（`32 本 × (8px + 3px) = 352px` なので
  390px 幅でちょうど 1 回分の履歴が収まる）
- 高さは `Math.max(3, level * 260)` px。3px は「無音でも棒が見える」下限
- 色は末尾 6 本を `--primary`（緑）、それより前の棒は `--primary` から
  `--muted` へ線形補間した `color-mix` で、左に向かって灰色になる
- `role="img"` + `aria-label` は現状の `level-meter` から引き継ぐ
  （スクリーンリーダー向けの数値 Contract）
- `data-testid="level-meter"` は**コンテナに付け替える**（外から見た hook を保つ）
- `data-testid="level-meter-fill"` と `data-testid="level-value"` は**削除**

`levelPct` は `aria-label` にしか使われなくなるが、`$derived` として残す
（a11y の契約。未使用にすると lint が鳴る）。

### 2.3 既存の `level-meter` コンテナ外形

`w-56`（224px 固定）だったのを `w-full` に広げる。390px 幅では
`main` の `px-4` を引いて約 358px ある。

---

## 3. テスト

### 3.1 `tests/practice.spec.ts:732-749` の書き換え

`level meter renders a non-zero width while recording` は削除せず**書き換える**。
現状のアサーションは `level-meter-fill` の `style.width > 0` と
`level-value` の `/レベル \d+%/` で、どちらも新デザインに存在しない。
意図（「無音でないことの検証」）は保持し、可視的実証に置き換える。

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

### 3.2 新規: 文字選択の抑止

`tests/practice.spec.ts` の T13 describe の後に追加する:

```ts
// ---------------------------------------------------------------------------
// Long-press text selection: the record controls must not start a selection.
// The gesture is reproduced with a mouse long press + drag. The CDP touch path
// is NOT usable: it leaves rangeCount at 0 even on selectable text, so it is
// vacuously true.
// ---------------------------------------------------------------------------

test.describe('Practice — text selection is suppressed on the record controls', () => {
	test('the hold button and the action zone declare user-select: none', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		for (const id of ['record-hold-btn', 'action-zone']) {
			const userSelect = await page
				.getByTestId(id)
				.evaluate((el) => getComputedStyle(el).userSelect);
			expect(userSelect, `${id}: user-select`).toBe('none');
		}
	});

	test('a long press with a drag selects nothing on the record controls', async ({ page }) => {
		// Positive control first: the same gesture over `sentence-text` must
		// select, otherwise the 0s below prove nothing.
		//   sentence-text        → >= 1
		//   record-ready-hint    → 0   (plain prose; guards the .action-zone rule)
		//   action-zone (centre) → 0   (cannot discriminate: it is the hold button)
		//   record-hold-btn      → 0   (cannot discriminate: <button> widgets
		//                                  never select in Chromium)
	});
});
```

### 3.3 検証コマンド

```bash
npm run check      # svelte-check: 0 エラー
npm test           # vitest
npm run test:e2e   # Playwright 全体
```

### 3.4 390px 実測（目視確認を含む）

録音フェーズでスクリーンショットを撮り、次を確認する:

- 棒が右端に新しい音 arrived し、左へ流れる
- 棒が 8px 幅で 32 本見える（390px 幅）
- 無音時は 3px の平坦な線になる
- 縦横 overflow 0
- アクション zone が `rect.bottom <= innerHeight + 1` を満たす

さらに実機相当の検証として、**マウス長押＋ドラッグ**（`mouse.move` → `mouse.down` →
一定距離の `mouse.move` を数回 → `mouse.up`）で `document.getSelection().rangeCount` を読む。

| 対象 | 期待値 | 判別力 |
|---|---|---|
| `record-ready-hint`（アクション zone 内の散文） | **0** | ○ 宣言を消すと 1 になるので検出できる |
| `record-hold-btn` | **0** | × `<button>` 内側は CSS に関係なく 0 |
| アクション zone の中心 | **0** | × 中心が hold button なので |
| `sentence-text`（対照） | **1 以上** | 対照。0 だとジェスチャ自体が空振り |

**CDP `Input.dispatchTouchEvent` は使わない。** Chromium のこのビルドでは選択可能テキストに
対しても 0 のままなので、修正前でも 0 で恒真になる。この spec の「現状の実測」節も訂正済み。

**幅の注意**: この節は 390px 実測の節だが、判別ケースの `record-ready-hint` は
`src/routes/practice/+page.svelte:1191` の `class="hidden ... sm:block"` なので
**640px 未満には存在しない**（390px で待つと 30s タイムアウトする）。
よって**判別はデスクトップ幅（既定 1280×720）で行い、390px では computed `user-select`
の確認だけ**を行う。`record-ready-hint` は `show` フェーズにも存在しないので、
対照の `sentence-text` は `show` フェーズ、残り 3 要素は `hidden` フェーズで採る。

なお、この自動テストが通ることは「宣言が存在して Chromium では抑止される」ことの証明であって、
**「実機（Android Chrome）で長押しが直った」ことの証明ではない**。実機での確認は別途必要。

---

## 4. エラー処理

新しい失敗モードは追加しない。

| ケース | 挙動 |
|---|---|
| 録音開始直後（履歴 0 個） | `{#each}` が空なので何も描かれない。次の `onLevel`（100ms 後）で最初の棒が現れる |
| 無音 | 全棒が 3px の下限で平坦になる。「録音は動いているが音が入っていない」ことが伝わる |
| `levelHistory` の肥大 | `slice(-(LEVEL_HISTORY_MAX - 1))` で常に 32 以下に保たれる |
| `-webkit-touch-callout` 非対応ブラウザ | 未知のプロパティとして無視される。`user-select: none` は残るため主要ブラウザでは抑止される |
| `-webkit-touch-callout` が存在しないブラウザ | Chromium は宣言をパース時に落とす（CSSOM にも残らない）ので、宣言を検証する手段が無い。`user-select: none` は残るため主要ブラウザでは抑止される。「`rangeCount` を 0 にする」ことを証拠にする検証は**しない**（CDP タッチ経路は選択可能テキストでも 0 になるため恒真）。§3.4 のマウス長押＋ドラッグのみを使う |

## 5. 非目標

- 録音の波形ファイル生成・ポッドキャスト対応
- `recorder.ts` の `SAMPLING_INTERVAL_MS` 変更（100ms のまま）
- 音量正規化 / AGC / ノイズゲート
- 一時停止・一時停止解除の波形表示
- メーター内の合格 / 不合格の色分け
- `sentence-text` / `diff-token` の選択抑止（§1.3 で意図的に対象外）
- `prefers-reduced-motion` での棒の静止化（§6 で判断理由を書く）

## 6. 既知の残余

**`prefers-reduced-motion` で棒の動きを静止化しない。**
棒の高さは CSS animation ではなく JS の `style:height` で動くため、
`app.css` の `prefers-reduced-motion` ブロック（`animation: none` を `.score.celebrate`
等に適用しているもの）には掛からず、`tests/a11y.spec.ts:538-570` の reduced-motion
検証（`animationName === 'none'`）も通過する。

動きを抑制すると目的（録音されたかどうかの即座の可視確認）が失われるため、
**意図的に抑制しない**。これは accessibility と機能のトレードオフとして
ここに明記する。

**3.2 秒を超えると古い履歴は押し出される。** 最長 30 秒の録音でも最後の
3.2 秒しか見えないが、「今音が silent かどうか」を確認するという目的に対しては
十分である。全体の録音を見たい用途は本 spec の範囲外。

## 7. ファイル変更一覧

### 変更

- `src/routes/practice/+page.svelte`
  - `LEVEL_HISTORY_MAX` 定数、`levelHistory` state
  - `r.onLevel` 回调の 1 行拡張、録音開始時のリセット
  - `recording` フェーズの `level-meter` 差し替え
  - scoped style に `.action-zone` を追加、`.record-hold-btn` に `-webkit-touch-callout: none` を追加
  - アクション zone の class に `action-zone` を追加
- `tests/practice.spec.ts`
  - `level meter renders a non-zero width while recording` を書き換え
  - 文字選択抑止の describe を新規追加
- `AGENTS.md`
  - レイアウト規約表の action-zone の class 列に `action-zone` を追加
  - 「録音中はスキップ不可」の行の近くに、文字選択抑止の行を追加

### 変更しない

- `src/lib/recorder.ts`（サンプリング 100ms のまま）
- `src/lib/constants.ts` / `src/lib/alignment.ts`
- `src/routes/+layout.svelte`（`h-dvh` と `class:py-6={!isPractice}` の相互結合を維持）
- `src/routes/manage/+page.svelte`
- 他の E2E テスト

## 8. 完了条件

1. `npm run check` 0 エラー
2. `npm test` 緑
3. `npm run test:e2e` 緑
4. 390px 実測で棒が右→左に流れることを確認（スクリーンショット目視）
5. マウス長押＋ドラッグで `getSelection().rangeCount` が 0（`record-ready-hint` / `record-hold-btn` / アクション zone）、かつ対照の `sentence-text` は 1 以上。CDP タッチ経路は恒真なので使わない
6. アクション zone が `rect.bottom <= innerHeight + 1`
7. コミットして **push とデプロイまで完了**（ユーザー明示依頼）
8. デプロイ後のスモーク（`GET /` 200、`POST /api/judge` が `available: true`）
