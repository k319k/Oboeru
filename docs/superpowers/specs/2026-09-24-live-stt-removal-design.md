# Live STT (vosk) 除去 + 録音後フィードバック一本化 設計

日付: 2026-09-24
状態: 承認済み

## 背景

Android 実機 (Chrome 153 / Android 10 / OPPO A103OP) で練習録音中の OOM クラッシュが再発していた。原因候補として vosk モデル (~90MB) の常駐が主因と判断。調査の結果:

- **Web Speech API は Android では不採用確定**: `SpeechRecognition` と `MediaRecorder` の同時起動を実機で検証。MediaRecorder がマイクを握っている間、SpeechRecognition は `onstart` 後に音声無しで `onend` する (error なし)。Chromium issue 41403126 として既知の制約で、公式解 (`SpeechRecognition.start(audioTrack)` / オンデバイス認識) は両方とも Android 未対応。
- **vosk-browser は認識品質が低く、かつモデル常駐のメモリ負荷が大きい** (大きいタスク: ユーザー「正直vosk全然仕事してくれてないので削除で。」)

決定: **リアルタイム単語色分け (ライブSTT) を全廃する**。Web Speech API も併用しない。単語フィードバックは既存の「録音後の Whisper 採点 + 差分色分け」に一本化する。

## 対象: 削除

### ライブラリ
- `src/lib/livestt/` 一式を削除:
  - `engine.ts` — vosk-browser モデル管理 + `VoskLiveSttEngine`
  - `model-loader.ts` — Cache API ベースのモデルDL
  - `urls.ts` — モデルURL定義
  - `mock-engine.ts` — E2E 用スクリプト駆動エンジン
  - `types.ts` — `LiveWord` / `LiveSttEngine` / `ModelLoadProgress`
  - `engine.test.ts` / `model-loader.test.ts` — 上記のユニットテスト

### API
- `src/routes/models/[file]/+server.ts` — STT モデル配信プロキシ (許可リスト制)

### スクリプト・設定
- `scripts/fetch-stt-models.mjs` — `stt:fetch` の実体
- `package.json` — `stt:fetch` スクリプト、`vosk-browser` 依存を削除
- `.gitignore` — `.stt-models/` 関連コメント (17-18行) を削除
- `vite.config.ts` — `/models/` dev 配信ミドルウェア (`sttModelDevServer()`) を除去

### 画面
- `src/routes/+page.svelte` (トップ):
  - `createLiveStt` import とモデル事前ウォーム (`warmState` / `warmPercent` / `onMount` 内の呼び出し)
  - `warm-indicator` マークアップ (L92-102)
- `src/routes/practice/+page.svelte`:
  - `$lib/livestt/*` の import (L18, 20, 21)
  - live state 群: `liveMode` / `liveTokens` / `liveMatched` / `liveChips` / `liveGhost` / `liveEngine` / `liveAligner` / `liveAttemptId` / `ghostTimer` / `pendingGhost` / `LIVE_GHOST_DEBOUNCE_MS` / `LIVE_SAMPLE_RATE`
  - 録音フィードハンドラ: `onAudioFrame` tap 配線 (L418), 録音開始時の `engine.start` (L440-446)
  - 単語受信ハンドラ: `clearLiveGhost` / `handleLiveWord` / `handleLivePartial` / `disposeLiveEngine` (L515-561)
  - E2E スクリプト: `E2E_MISMATCH_WORD` / `buildE2eScript` / `acquireLiveEngine` (L563-599)
  - フェーズ遷移: hidden フェーズの live 初期化 (L802-829), 退出・summary・アンマウントの `disposeLiveEngine` / `terminateLiveStt` (L842, 857, 866-868)
  - ウォーム: `warmLiveModel` (L953-972)
  - マークアップ: `live-word-stream` ブロックと `live-off-notice` (L1308-1334)
  - CSS: `.word-slot` / `.word-chip` 関連 (L1639-1677)

### テスト (削除)
- `tests/practice.spec.ts` — `describe('Practice — T8 live words')` 全体 (L938-1007)
- `tests/responsive.spec.ts` — L260-276 (mock live stream)
- `tests/a11y.spec.ts` — L385-425 (live light/dark), L578-594 (live reduce-motion)
- `tests/fixtures.ts` — `stubSttModelProxy` フィクスチャ (L4, 7-20)。`**/models/**` への 503 スタブ。モデルリクエスト自体が消えるため、フィクスチャ定義と自動適用 (test の base) の両方を除去する
- `src/lib/recorder.test.ts` — `onAudioFrame` (16kHz tap) テスト (L430-542) ※recorder 本体のテストは維持

## 対象: 整理 (参照除去 / デッドコード化)

- `src/lib/recorder.ts` — `onAudioFrame` option (L19-20, 102-109) と 16kHz tap context/worklet (L171-204) を除去。recorder 本体 (録音 blob 生成) は維持
- `src/lib/alignment.ts` — `ProgressAligner` のうち live 専用の `feedPartial` / `GhostState` (L23-28, L116-134) を除去。`tokenizeSentence` / 逐次 `feed` / `diffTokens` (録音後差分色分け) は**維持**
- `src/lib/alignment.test.ts` — live 専用の `feedPartial` テスト (L138-176) を削除。exact/fuzzy/kana folding/lookahead 等の他テストは維持

## 維持対象 (変更しない)

- `src/lib/transcribe.ts` — Whisper 採点 (Groq)。**採点パイプラインは今回の対象外**
- `src/routes/api/transcribe/+server.ts` — Whisper プロキシ
- `src/routes/api/tts/+server.ts` / `src/routes/api/judge/+server.ts`
- 録音後の採点フィードバック: `doTranscribe` → `similarity` → Jev → 差分色分け (diffTokens)。**これを「唯一の色分け」とする**
- レベルメーター (`level-meter`, recorder 由来) — 録音中の視覚フィードバックとして維持
- `record-ready` 画面とテスト全般 (録音準備画面)

## テスト方針

- **削除**: live 専用の E2E・ユニットテスト（上記対象）
- **挙動変更の正当化**: live 機能の削除に伴うテスト削除であり、アサーション弱化ではない
- **維持**: 採点パイプライン / recorder / alignment (feed 系) / practice のキーボード・採点フロー / a11y (live 以外) / responsive (live 以外)
- **検証**: `npm run check` (0 エラー)、`npm test` (ユニット)、`npx playwright test tests/practice.spec.ts tests/a11y.spec.ts tests/responsive.spec.ts` を worker=1 で実行し全パスを確認

## 挙動変化 (ユーザーに届く差分)

- 練習画面の「ライブ表示なしで練習します」(live-off-notice) 表示は**削除**される (ライブモード自体が無くなるため)
- トップ画面の「録音アシストを準備中…」(warm-indicator) は表示されなくなる
- 録音中はレベルメーターのみ。単語色分けは録音を離した後の採点フィードバックでのみ提示
- モデル DL も無くなるため、初回起動の待ち時間・OOM リスクも解消

## 適用範囲外 (将来課題として記録のみ)

- 録音後フィードバックの UX 改善 (例: Whisper 待ち時間表示や単語色分けの見せ方の改良) は本設計対象外
- サーバー側ストリーミング STT (OpenAI Realtime / Deepgram) による真のリアルタイム化は検討対象外 (必要になったら別設計で)