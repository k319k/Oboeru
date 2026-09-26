# Live STT (vosk) 除去 + 録音後フィードバック一本化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Android 実機の OOM クラッシュ主因である vosk ライブSTT 一式（`src/lib/livestt/` 7ファイル・`/models/` プロキシ・`stt:fetch`・画面/録音/アラインメントの live 配線・関連テスト）を完全削除し、色分けを「録音後 Whisper 採点＋差分トークン」に一本化する。

**Architecture:** ライブラリ層（alignment / recorder）の削除 → 画面（practice / トップ）→ テスト更新 → インフラ（livestt ディレクトリ・models ルート・スクリプト・設定）→ ドキュメント の順で依存が切れてから物理削除する。`doTranscribe`・`/api/transcribe`・`diffTokens`・T13 プッシュトゥトーク・レベルメーターは無傷で残す。

**Tech Stack:** SvelteKit + Svelte 5 + TypeScript、vitest、Playwright、Vite 6。vosk-browser は全面的に外す。

## Global Constraints

- `npm run check` は **0 エラー** 必須。`npm test`（vitest）と Playwright を各タスクで通す
- E2E 単体デバッグは `npx playwright test tests/X.spec.ts --workers=1 --reporter=list`
- **維持**: `/api/transcribe`・`src/lib/transcribe.ts`・`doTranscribe`（practice :876）・`alignment.ts` の `tokenizeSentence`/`ProgressAligner`/`feed`/`getMatched`・`diffTokens`（practice L193-219）・レベルメーター（L1291-1306）・release-hint・T13 プッシュトゥトーク・`tests/e2e-full.spec.ts`（L281-303 の `/api/transcribe` contract テスト、名前は「live STT」だが維持）
- **`?e2e=1` は live 削除後消費者ゼロ → 分岐・パラメータごと撤去**（practice・トップ・テスト）
- eclipse: `tests/fixtures.ts` の `stubSttModelProxy`（`**/models/**`→503）は除去するが、spec 側の `import { test, expect, type Page } from './fixtures'` は壊さない（`Page` 型の再エクスポートを維持）
- UI文言は日本語。コミット・プッシュ・デプロイは **ユーザー明示依頼時のみ**（`babel-import.json` は含めない）
- 各削除範囲は編集直前に必ず再読してアンカーを確認する（同一ファイル内の先行削除で行番号がずれるため）

---

### Task 1: alignment.ts から live 専用デコレーションを除去

**Files:**
- Modify: `src/lib/alignment.ts:19-28`（`GhostState`、ヘッダの Vosk 言及）, `:116-134`（`feedPartial`）
- Modify: `src/lib/alignment.test.ts:138-175`（feedPartial describe）, `:193-198`（空リスト edge-case 内の feedPartial 断言）

**Interfaces:**
- Consumes: 既存 `ProgressAligner`（`feed` / `getMatched`）
- Produces: `ProgressAligner` から `feedPartial` と `GhostState` が消える。`tokenizeSentence` / `feed` / `getMatched` / `diffTokens` は無変更

- [ ] **Step 1: ヘッダコメントと GhostState を削除**

`src/lib/alignment.ts` 冒頭コメントの Vosk 言及（~L8）を削除し、`GhostState` interface（L22-28 付近）ごと除去する。**`feed` / `getMatched` は触らない。**

- [ ] **Step 2: `feedPartial` メソッド削除**

`src/lib/alignment.ts` の `feedPartial(text: string): GhostState | null`（L116-134）を削除する。

- [ ] **Step 3: テスト側を削除**

`src/lib/alignment.test.ts`:
- `describe('ProgressAligner feedPartial', ...)`（L138-175）を丸ごと削除
- 空リスト edge-case（L193-198）内の `expect(aligner.feedPartial('hello')).toBeNull();`（L196）を削除

- [ ] **Step 4: ユニットテスト実行**

Run: `npm test -- src/lib/alignment.test.ts` または `npm test`
Expected: 全 PASS（削除した分以外変わらない）

### Task 2: recorder.ts から 16kHz タップを除去

**Files:**
- Modify: `src/lib/recorder.ts:19-20`（ライブSTT コメント）, `:22`（`FRAME_BUFFER_SIZE`）, `:24-39`（`FRAME_TAP_WORKLET`）, `:102-109`（`onAudioFrame` option）, `:171-229`（16kHz タップブロック）, `:245-256`（cleanup 内の frame disposal）
- Modify: `src/lib/recorder.test.ts:430-548`（onAudioFrame describe）

**Interfaces:**
- Consumes: `startRecording`（`autoStop` / `onProgress` / `onLevel`）
- Produces: `StartRecordingOptions` から `onAudioFrame` が消える。`isSilent`・`selectMime`・録音 blob 生成・無音自動停止は無変更

- [ ] **Step 1: 定数・worklet・コメントを削除**

`src/lib/recorder.ts`:
- L19-20 のライブSTT コメント＋`LIVE_SAMPLE_RATE` 削除
- L22 の `FRAME_BUFFER_SIZE` 削除
- L24-39 の `FRAME_TAP_WORKLET` 削除

- [ ] **Step 2: `onAudioFrame` option 削除**

`src/lib/recorder.ts:102-117` の `StartRecordingOptions` から `onAudioFrame`（L103-109）を削除。

- [ ] **Step 3: 16kHz タップ実装ブロック削除**

`src/lib/recorder.ts:171-229`（フレームタップのセットアップ全体: `frameCtx`/`frameTeardown`/`frameTapDisposed`/`if (options.onAudioFrame)` ブロック）を削除。

- [ ] **Step 4: cleanup を単純化**

`src/lib/recorder.ts:245-256` の `cleanup()` から `frameTapDisposed = true;`（L250）、`frameTeardown?.()`（L251）、`void frameCtx?.close();`（L255）を削除。`source.disconnect()`・`analyser.disconnect()`・`audioCtx.close()` は維持。

- [ ] **Step 5: onAudioFrame テスト削除**

`src/lib/recorder.test.ts:430-548` の `describe('startRecording — onAudioFrame', ...)` を丸ごと削除。**他の describe（`isSilent`/`selectMime`/無音自動停止）は維持。**

- [ ] **Step 6: ユニットテスト実行**

Run: `npm test -- src/lib/recorder.test.ts` または `npm test`
Expected: 全 PASS

### Task 3: practice/+page.svelte から live を完全除去

**Files:**
- Modify: `src/routes/practice/+page.svelte`（下記の各区間）

**Interfaces:**
- Consumes: `doTranscribe`（:876 維持）、`diffTokens`（L193-219 維持）、`tokenizeSentence`/`ProgressAligner`（import L17 維持 — L209 の diffTokens で使用）
- Produces: `createLiveStt`/`terminateLiveStt`/`LiveSttEngine`/`LiveWord`/`MockWordStep`/`warmLiveModel`/`liveMode`/`liveTokens`/`liveMatched`/`liveChips`/`liveGhost`/`liveEngine`/`liveAligner`/`liveAttemptId`/`ghostTimer`/`pendingGhost`/buildE2eScript/acquireLiveEngine が存在しなくなる。`page` import（`$app/state` L3）は **L1043 の chapterId 取得で引き続き使用** → 維持

- [ ] **Step 1: import 削除**

`src/routes/practice/+page.svelte:18,20,21` の livestt 系 import（`createLiveStt, terminateLiveStt` / `LiveSttEngine, LiveWord` / `MockWordStep`）を削除。**L17 の alignment import は維持。**

- [ ] **Step 2: live state 群削除**

`L134-152`:
- L134-152 のコメント＋`liveMode`/`liveTokens`/`liveMatched`/`liveChips`/`liveGhost`（L136-140）
- `useEffect` 外の非リアクティブ配線 `liveEngine`/`liveAligner`/`liveAttemptId`/`ghostTimer`/`pendingGhost`（L142-147）
- L149-151 の ghost debounce/sample rate コメント＋`LIVE_GHOST_DEBOUNCE_MS`/`LIVE_SAMPLE_RATE`

- [ ] **Step 3: startRecording から onAudioFrame 配線を除去**

L414-419 付近の `startRecording({ autoStop: false, onAudioFrame: ... })` → `startRecording({ autoStop: false })` に戻す。L416-418 のコメントも整理。

- [ ] **Step 4: recording フェーズの `engine.start` ブロック削除**

L438-446 付近の「live engine 起動」（`engine.start(LIVE_SAMPLE_RATE)`・`engineAttempt`・`liveAttemptId`・`liveMode = 'off'`）ブロックを削除。録音開始処理本体は維持。

- [ ] **Step 5: live ハンドラ群削除（L511-600）**

- L511-513 コメント＋L515-522 `clearLiveGhost`＋L524-537 `handleLiveWord`＋L539-550 `handleLivePartial`＋L553-560 `disposeLiveEngine`
- L563 `E2E_MISMATCH_WORD`＋L566-585 `buildE2eScript`＋L588-600 `acquireLiveEngine`

- [ ] **Step 6: hidden フェーズの live 初期化削除**

L795-831 の hidden フェーズ effect にて:
- live リセット＆エンジン取得（L799-829: `liveAttemptId`/`liveTokens`/`liveMatched`/`liveChips`/`clearLiveGhost`/`liveMode`/`liveAligner`/`acquireLiveEngine`/`.then`/`.catch` の連鎖）を削除
- **`void warmMic();`（L831）は残す**（T13 マイクウォーム、live とは別）

- [ ] **Step 7: recording/summary/unmount effect の dispose 除去**

- L837-842: recording フェーズ effect 内 `disposeLiveEngine()`（L842）を削除（"blob discarded" コメントは整理）
- L853-857: summary 到達 effect 内 `disposeLiveEngine()`（L857）を削除（`releaseWarmMic` 等があれば維持）
- L862-868: unmount effect 内 `disposeLiveEngine()` と `void terminateLiveStt();`（L868）を削除（`releaseWarmMic` は維持）

- [ ] **Step 8: warmLiveModel 全撤去**

- L953-957 `startSession` 内の `warmLiveModel();`（L956）呼び出し削除
- L966-972 `warmLiveModel` 関数削除（e2e チェック L968 含む）

- [ ] **Step 9: live マークアップ削除**

L1308-1334 の `live-word-stream` ブロック（word-slot / word-chip / word-ghost / `live-off-notice`）を削除。**L1335 の `release-hint` は維持。** 上の段落（レベルメーター L1291-1306）も維持。

- [ ] **Step 10: live CSS 削除**

L1635-1676 の `.word-slot` / `.word-slot.match` / `.word-slot.ghost` / `.word-chip`（word-reveal animation 参照含む）を削除。他の CSS は維持。

- [ ] **Step 11: 型チェック**

Run: `npm run check`
Expected: 0 エラー（`ProgressAligner`/`tokenizeSentence` は diffTokens で未使用でないことを確認。もし check で unused が出たら当該行を精査）

### Task 4: トップページのモデル事前ウォーム除去

**Files:**
- Modify: `src/routes/+page.svelte:3`, `:5`, `:7`, `:9`, `:23-46`, `:92-102`

**Interfaces:**
- Produces: `WarmState`/`warmState`/`warmPercent`/`warm-indicator`（データtestid）が消える。`goto`/`getChildren`/`getTotalSentenceCount` は維持

- [ ] **Step 1: import 整理**

`src/routes/+page.svelte`:
- L3 `import { page } from '$app/stores';` 削除（使用は L30 の e2e チェックのみ）
- L5 `import { createLiveStt } from '$lib/livestt/engine';` 削除
- L7 lucide import から `Loader2` を削除
- L9 `import { onMount } from 'svelte';` 削除

- [ ] **Step 2: warm 状態と onMount 削除**

L23-25 の `WarmState`/`warmState`/`warmPercent` と L27-46 の `onMount(() => {...})` を削除。

- [ ] **Step 3: warm-indicator マークアップ削除**

L92-102 の `{#if warmState === 'loading'}` ブロック（`warm-indicator` p タグ）を削除。

- [ ] **Step 4: 型チェック**

Run: `npm run check`
Expected: 0 エラー

### Task 5: E2E テスト更新（fixtures / practice.spec / responsive.spec / a11y.spec）

**Files:**
- Modify: `tests/fixtures.ts`（stub 除去）
- Modify: `tests/practice.spec.ts:934-1021`（T8 describe 削除）
- Modify: `tests/responsive.spec.ts:9-15`（ヘッダ）, `:34-44`（LIVE_SEED 削除）, `:260-278`（録音テスト書き換え）
- Modify: `tests/a11y.spec.ts:13,20`（ヘッダ）, `:43-54`（LIVE_SEED 削除）, `:385-426`（録音+live テスト）, `:572-610`（reduced-motion）

**Interfaces:**
- Consumes: `gotoWithSeed`/`startHold`/`holdAndRelease`/`mockTtsApi`/`mockTranscribe` ヘルパー（全維持）
- Produces: `tests/fixtures.ts` は `export { test, expect }; export type { Page } from '@playwright/test';` のみ残る

- [ ] **Step 1: fixtures.ts を再エクスポート化**

`tests/fixtures.ts` 全体（L1-21）を下記に置換:

```ts
export { test, expect } from '@playwright/test';
export type { Page } from '@playwright/test';
```

- [ ] **Step 2: practice.spec.ts の T8 ブロック削除**

`tests/practice.spec.ts:934-1021`（L934-936 ヘッダコメント＋L938 describe 開き〜L1020-1021 閉じ）を丸ごと削除。L1031 以降の `holdAndRelease` ヘルパーは **維持**。

- [ ] **Step 3: responsive.spec.ts — ヘッダ・LIVE_SEED・録音テスト更新**

- L9-15 ヘッダコメントを通常録音テストの記述に書き換え（`?e2e=1` mock live 言及を除去）
- L34-44 の `LIVE_SEED`＋説明コメント削除
- L260-278 のテストを下記へ置換し、テスト名を `practice recording — no overflow, tap targets >= 44px` に変更:

```ts
	test('practice recording — no overflow, tap targets >= 44px', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?chapter=child-1');

		// T13 push-to-talk: hold Space to enter (and stay in) the recording phase.
		await startHold(page);
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });

		await expectNoHorizontalOverflow(page, '/practice recording');
		await expectTapTargets(page, '/practice recording');

		await page.screenshot({ path: `${SCREENSHOT_DIR}/practice-recording.png`, fullPage: true });
	});
```

- [ ] **Step 4: a11y.spec.ts — ヘッダ・LIVE_SEED・録音テスト更新**

- L13 / L20 ヘッダコメントから mock live / live word stream 言及を除去
- L43-45 コメント＋L46-54 `LIVE_SEED` 削除
- L385-426 のテストを下記（`practice recording — light & dark`）へ置換:

```ts
	test('practice recording — light & dark', async ({ page }) => {
		await gotoWithSeed(page, SEED);
		await mockTtsApi(page);
		await page.goto('/practice?chapter=child-1');
		// T13 push-to-talk: recording runs only while Space is held.
		await startHold(page);
		// The recording phase is static (only the timer/level meter ticks)
		// once the stop button appears — safe to scan.
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });

		await logTapTarget(page, '[data-testid="stop-btn"]', 'practice recording light');
		await expectNoSeriousCritical(page, '/practice recording light');
		await expectTapTargets(page, '/practice recording light');

		// Release before the reload so the next keydown is not flagged as
		// auto-repeat (Playwright keeps the key pressed across navigation).
		await page.keyboard.up('Space');
		await switchToDarkFresh(page);
		await startHold(page);
		await expect(page.getByTestId('stop-btn')).toBeVisible({ timeout: 10000 });
		await logTapTarget(page, '[data-testid="stop-btn"]', 'practice recording dark');
		await expectNoSeriousCritical(page, '/practice recording dark');
		await expectTapTargets(page, '/practice recording dark');
	});
```

- [ ] **Step 5: a11y.spec.ts — reduced-motion テスト更新**

L572-610 の reduced-motion テストを下記へ置換（live 由来の word-slot/word-chip 検証を外し、**T13 録音パルス `.animate-pulse` とフィードバック `celebration-pop` は維持**）:

```ts
	test('prefers-reduced-motion removes recording pulse / celebration-pop', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await gotoWithSeed(page, SEED);
		await disableAutoAdvance(page);
		await mockTtsApi(page);
		await mockTranscribe(page, 'こんにちは。');
		await page.goto('/practice?chapter=child-1');

		const animName = (sel: string) =>
			page.evaluate((s) => {
				const el = document.querySelector(s);
				return el ? getComputedStyle(el).animationName : null;
			}, sel);

		// T13: the recording pulse belongs to the recording phase (hold Space).
		await startHold(page);
		await expect(page.getByTestId('recording-timer')).toBeVisible({ timeout: 10000 });
		expect(await animName('.animate-pulse')).toBe('none');
		logEvidence('reduced-motion: recording pulse → none ✓');

		// Release past the 0.5s short-tap guard → pass feedback; the score
		// celebration animation must be disabled under reduced motion.
		await page.waitForFunction(() => {
			const m = document
				.querySelector('[data-testid="recording-timer"]')
				?.textContent?.match(/(\d+\.\d+)/);
			return m ? parseFloat(m[1]) >= 0.7 : false;
		});
		await page.keyboard.up('Space');
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });
		expect(await animName('[data-testid="score"]')).toBe('none');
		logEvidence('reduced-motion: celebration-pop → none ✓');
	});
```

- [ ] **Step 6: E2E 更新分を実行**

Run: `npx playwright test tests/practice.spec.ts tests/responsive.spec.ts tests/a11y.spec.ts --workers=1 --reporter=list`
Expected: 全 PASS（a11y が reducered モード・録音フェーズの DOM の変化で更新必要箇所があれば、テストを正当に更新）

### Task 6: livestt 一式・models ルート・スクリプト・設定を物理削除

**Files:**
- Delete: `src/lib/livestt/`（engine.ts / model-loader.ts / model-loader.test.ts / mock-engine.ts / types.ts / urls.ts / engine.test.ts の 7 ファイル）
- Delete: `src/routes/models/[file]/+server.ts`（models ルート丸ごと 1 ファイル）
- Delete: `scripts/fetch-stt-models.mjs`
- Modify: `package.json`（`stt:fetch` L14、`vosk-browser` L19）+ lockfile
- Modify: `.gitignore:17-18`（`.stt-models/` とコメント）
- Modify: `vite.config.ts`（MODEL_ARCHIVE_NAMES import L6、`STT_MODEL_FILES` L8、`sttModelDevServer` L10-50、plugins L53、node:fs/path import L1-2）

**Interfaces:**
- Consumes: Task 3・4 で livestt import が全て切れている（残るのは models ルート自身と vite.config）
- Produces: リポジトリから `$lib/livestt`・`/models/`・`.stt-models/`・`stt:fetch` が完全消滅

- [ ] **Step 1: ディレクトリとルート削除**

```bash
rm -rf src/lib/livestt src/routes/models scripts/fetch-stt-models.mjs
```

- [ ] **Step 2: package.json から vosk-browser を除去（lockfile 更新）**

`package.json` の L14（`"stt:fetch"`）と L19（`"vosk-browser"`）を削除し、`npm install` で `package-lock.json` を整合させる。

- [ ] **Step 3: .gitignore から .stt-models/ を除去**

`.gitignore:17-18`（`# STT model archives ...` コメント＋`.stt-models/`）を削除。

- [ ] **Step 4: vite.config.ts を単純化**

- L1-2 の `node:fs`/`node:path` import 削除
- L6 の `MODEL_ARCHIVE_NAMES` import 削除
- L8 の `STT_MODEL_FILES` 削除
- L10-50 の `sttModelDevServer()` 関数削除
- L53 を `plugins: [tailwindcss(), sveltekit()]` に変更

- [ ] **Step 5: 全チェック**

Run: `npm run check && npm test`
Expected: 0 エラー・全 PASS（vite.config / package.json の変更で diff が静塵化）

### Task 7: ドキュメント更新（README / AGENTS.md）

**Files:**
- Modify: `README.md:93-120`（`## ライブSTT` 節）
- Modify: `AGENTS.md:3,16,40,44,83,91`

- [ ] **Step 1: README のライブSTT節削除**

`README.md:93-120`（`## ライブSTT (録音中のリアルタイム文字起こし)` 節全体 ＋ `### ローカル開発` ブロック）を削除。`## 使い方`（L122）以降は維持。冒頭説明（L3）に変更は不要。

- [ ] **Step 2: AGENTS.md 更新**

- L3 から `録音中のリアルタイム単語色分け (vosk-browser / ライブSTT) 付き。` を削除
- L16 の `ライブSTTのローカルモデル: npm run stt:fetch ...` 行削除
- L40 の `src/lib/livestt/` ディレクトリ地図行削除
- L44 の `src/routes/api/models/[file]/+server.ts` 行削除（実パスは `src/routes/models/`）
- L83 のコミット禁止物列挙から `.stt-models/` 削除
- L91 の実機チェック残務から「ライブ色分け」を除去

- [ ] **Step 3: 残余参照スキャン**

Run: `grep -rn "livestt\|vosk\|stt:fetch\|stt:upload\|.stt-models\|/models/" --include=*.{ts,svelte,mjs,json,md,gitignore} src tests *.json *.md vite.config.ts .gitignore 2>/dev/null`
Expected: ヒットなし（docs/superpowers の過去計画・設計文書は履歴として残す）

### Task 8: 最終検証

**Files:**
- なし（検証のみ）

- [ ] **Step 1: 全スイート実行**

Run: `npm run check && npm test && npm run test:e2e`
Expected: check 0 エラー、vitest 全 PASS、Playwright 全 PASS（既知のフレーキー件で落ちたら該当 spec を単独再実行して確認）