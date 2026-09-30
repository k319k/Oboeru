# TTS読み上げ中のフリーズ→再読込修正 — 設計

- 日付: 2026-09-22
- 状態: ユーザー承認済み (設計1/2・2/2とも承認)
- 関連: `src/lib/livestt/model-loader.ts` / `src/lib/livestt/engine.ts` / `src/routes/practice/+page.svelte` / `src/routes/+page.svelte`

## 目的

Android Chrome で練習中、**TTS読み上げ中に画面がフリーズしてタブが再読込される**バグを修正する。
ユーザー報告 (実測): 最初の数文以内で毎回発生、色分け (ライブSTT) は動作済みの状態で発生。

成功条件: Android実機で初回モデルDLを含め 10文以上連続練習しても再読込が発生しない。
色分けは引き続き動作すること。

## 原因シナリオ (コード根拠)

フェーズ順は `show → tts → hidden → recording`。

1. 文1の `hidden` フェーズで vosk モデル (45MB zip) のダウンロードが開始される
   (`practice/+page.svelte` の hidden フェーズ処理 → `loadModelUrl`)
2. 現行の `model-loader.ts` はダウンロード全バイトを **JS配列に蓄積** (`chunks.push`) →
   `new Blob(chunks)` で複製 → `cache.put`。JSヒープ上に 2〜3 コピー (90MB超) が同時に滞在
3. その後 `createModel` (vosk-browser) が zip を MEMFS 展開 + WASM ヒープへロード
   (タブプロセス全体で 100〜300MB 級と推測)
4. この重い一連の処理が **文2〜3の TTS 再生中にランディング**し、
   Android Chrome がレンダラープロセスを kill → タブ自動再読込 (復元ダイアログ表示)

TTS クライアント (`tts.ts`) 自体は健全 (リークなし・タイムアウトあり)。メモリバーストと
TTS再生の衝突が本命。

## 設計

### 1. モデルDLのストリーミング化 (`src/lib/livestt/model-loader.ts` 修正)

現状 (チャンク配列方式) を廃し、`response.body.tee()` で分岐:

- 枝1: `cache.put(url, new Response(枝1))` — ネイティブ側でキャッシュへ直書き
- 枝2: `TransformStream` でバイト数をカウントして `onProgress` を維持し、
  `new Response(枝2).blob()` でネイティブ側にバッファ

JS配列への全量蓄積が消え、ピークメモリが約半減。

- エラーハンドリングは現行のまま: 失敗時 `null` (caller が色分けオフに劣化)、
  タイムアウト 60s、`AbortSignal` 対応、cache 書き込み失敗は無視してメモリBlob継続
- キャッシュヒット時の `cached.blob()` は現行のまま (単一コピー)

### 2. トップページでの事前ウォーム (`src/routes/+page.svelte` 追加)

- トップページマウント時に、前回練習言語 (§3) のモデルを **非同期・非ブロッキング**で
  事前ロードする。TTS が鳴っていない画面で重い処理を完結させるのが狙い
- `createLiveStt` の既存シングルトン (`engine.ts` の `modelPromises`) を使うため、
  練習開始時に二重DLは起きない。練習画面の `acquireLiveEngine` は同じ Promise を
  await するだけ (現行ロジック不変、録音はブロックしない)
- トップページに控えめな準備状態インジケータ (「録音アシストを準備中…」+ `onProgress` の%)
- ウォーム失敗時は静かにドロップ (インジケータ消滅)。練習画面の既存フォールバックが再試行
- 練習画面アンマウント時の `terminateLiveStt()` (メモリ解放) は**現行維持**。
  トップに戻るたびに再ロードが走るが、キャッシュヒットならDLなし・WASM展開のみで、
  重い処理は常に「TTS無しの画面」で完結する

### 3. 前回練習言語の記憶 (`src/lib/last-lang.ts` 新規)

- `getLastLang(): 'ja' | 'en'` / `setLastLang(lang)`。localStorage キー `oboeru:last-lang:v1`
- `setLastLang` は練習ページマウント時 (言語判定済みのタイミング) に呼ぶ。未記録時 `getLastLang()` は `'ja'`
- トップページのウォームが参照

### 4. デバッグ支援 (dev限定)

- `import.meta.env.DEV` のみ: フェーズ遷移時に `performance.memory.usedJSHeapSize` と
  モデルロード進捗を `console.debug`。本番ビルドには含まれない

## エラー処理

| ケース | 挙動 |
|---|---|
| ウォーム失敗 (ネットワーク断・タイムアウト) | 静かに終了、インジケータ消滅。練習画面で既存フォールバックが再試行 |
| Cache quota 超過 | `cache.put` 失敗を無視しメモリBlob継続 (現行同様) |
| モデル取得失敗 | `null` → 色分けなしで練習続続 (現行同様) |
| E2E/モック | `createLiveStt` の `engine` 注入経由で実DLは発生しない |

## 非目標

- 色分けの ON/OFF 設定トグル (B案不採用 — 要件: 色分けは必須)
- vosk-browser のバージョンアップ (別チケット)
- TTS プロバイダ変更 → サブプロジェクト⑤ (AI TTS + クラウド配信)
- PWA / Service Worker → サブプロジェクト③
- データモデル改修 (トラック統合) → サブプロジェクト④

## テスト計画

- ユニット (vitest):
  - `model-loader`: tee ストリームの進捗イベント、正常終了時の blob 内容、
    abort/タイムアウト時 `null`、キャッシュヒットパス (fetch が呼ばれない)
  - `last-lang`: 保存/読込/未記録時デフォルト `ja`
- E2E (Playwright): 既存テストは原則無変更でグリーン維持。トップページウォームは
  engine 注入モック経由 (実DLしない)

## 既知の残余 (known residual)

トップページのウォームは `getLastLang()` の言語のみを対象とする。ユーザーが初めて**もう一方の言語**で練習を開始した場合、その言語のモデルDL+WASM展開が練習開始時・TTSと重なって発生する (ストリーミング化でJSヒープのピークは半減するが、zip展開自体は残る)。判断: 実機ゲート (Android Chrome、10文以上連続練習、`[memlog]` と `chrome://crashes` を監視) で再現するかを確認し、再現した場合のみ2言語目のバックグラウンドウォームを follow-up として実装する。

## 検証 (完了条件)

1. `npm run check` 0エラー / `npm test` / `npm run test:e2e` 全緑
2. **実機ゲート (ユーザー承認)**: Android Chrome で初回DL含め 10文以上連続練習 →
   再読込ゼロ、色分け動作を確認

## 付録: 全体ロードマップとスタック決定 (後続サブプロジェクト参照)

本サブプロジェクト外だが、ブレストで確定した事項:

- **順序 (2026-09-27 見直し)**: ①フリーズ修正 (本spec) → ✓**②UI強化 — 実装完了 (2026-09-26) / 実機ゲート未実施**
  (類似度画面の即スキップ防止・ボタン常時下部・スマホでキーボードヒント非表示。仕様は
  `docs/superpowers/specs/2026-09-26-ui-enhancement.md`、計画は
  `docs/superpowers/plans/2026-09-26-ui-enhancement.md`。手動遷移化・練習中ナビ非表示・
  テーマ3択の移設も同時に実装済み。自動検証 (`npm run check` / `npm test` / `npm run test:e2e`) は全緑。
  実機ゲート 7 項目はユーザー承認待ちで未実施 — ① と同じく「実機ゲート込み」で完了とみなす)
  → ✓**③トラック×子チャプター統合 — 実装完了 (2026-09-27) / 実機ゲート未実施**
  (名称はトラック。子チャプターを廃止し `Track.parentId` の木に統一。練習は
  `/practice?node=<章id|トラックid>` で章/トラックどちらからでも開始し、トップページと
  管理 › チャプターは同じ木を表示。仕様は
  `docs/superpowers/specs/2026-09-27-track-hierarchy-integration-design.md`、計画は
  `docs/superpowers/plans/2026-09-27-track-hierarchy-integration.md`。インポート/エクスポートは
  version 3 (v2 自動変換)、旧データの子チャプターは読み込みシムがトラックへ移行する。
  自動検証 (`npm run check` / `npm test` / `npx playwright test --workers=1`) は全緑。
  実機ゲート 3 項目 — 既存子チャプターデータの移行結果 / 3 段ネストの並び順 / 管理タブ
  インライン編集の実 IME — はユーザー承認待ちで未実施)
  → ✓**④AI TTS — 実装完了 (2026-09-29)** (Gemini `google/gemini-3.8-flash-lite-tts` を
  **OpenRouter 経由**で使用。R2 での事前生成配信は棄却し、音声はクライアント IndexedDB の
  キャッシュに保持。**実機ゲート未実施** — Android Chrome / iOS Safari での pitch 保持と
  リロード跨ぎ再生はユーザー承認待ち。自動検証 (`npm run check` / `npm test` /
  `npx playwright test --workers=1`) は全緑。仕様は
  `docs/superpowers/specs/2026-09-29-gemini-tts-migration-design.md`、計画は
  `docs/superpowers/plans/2026-09-29-gemini-tts-migration.md`、実測は `docs/research/` の
  3 レポート)
  ⑤PWA (Android) → ⑥クラウド同期
- 順序変更の理由 (旧: ③PWA → ④統合 → ⑤TTS → ⑥同期):
  - 統合 → TTS: 文の粒度とトラック構造が確定しないと「どの粒度で音声を生成・キャッシュするか」
    (文単位か章単位か、トラックごとにボイスを変えるか) が決められない。データ形を先に固定する
  - TTS → PWA: 配信先が wasm ストリーミング録音 (現在の `/api/tts` 応答) ではなく
    事前生成音声の URL に変わる。PWA の Service Worker キャッシュ戦略を設計する前に
    キャッシュ対象の正体が確定している必要がある
    **訂正 (2026-09-29)**: 事前生成 URL にも R2 にもならず、キャッシュは
    **IndexedDB の生 PCM** になった。⑤ PWA の Service Worker は `/api/tts` の WAV を
    対象にしなくてよい (IndexedDB は SW からは読めず、Cache Storage とは別系統)
  - TTS → 同期: 生成済み音声が同じ「同期データ」の一員になる。音声の扱い
    (PWA オフライン資産としてローカル保持か、同期対象に含めるか) を統合と併せて決める
  - 同期を最後に置くのは不変 (最終データモデル確定後にしないと二重実装になる)
- **スタック**: インフラは Cloudflare 全面 (Workers / D1 or KV / R2)。AI (採点等) は
  OpenRouter またはローカル。TTS も OpenRouter 経由。
  2026-09-27 に公式仕様を確認済み: `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  に `response_format: {type: "audio"}` を投げれば base64 音声 (既定 `audio/wav` = 24kHz/mono/16bit RIFF+PCM) が返る。
  RIFF ヘッダ付きのままで R2 に保存すれば変換ゼロ。複数セグメント結合時のみ `audio/l16` を使い 44 バイトを落とす。
  出力上限 16,384 音声トークン (≈10.9分) かつ入力 8,192 トークンなので長文は文単位分割。1リクエストの複数話者は最大2話者。
  キーは `GEMINI_API_KEY` として `$env/dynamic/private` に保持 (クライアント不露出を維持)。
  **未確認**: Vertex AI 版の有無、3.8 系のレート制限、生成音声の再配信ライセンス条項 → ④の着手時に実測確認する
- **訂正 (2026-09-29 — 上の記述は ④の実装で置き換わった。「R2」「`GEMINI_API_KEY`」
  「`gemini-3.8-flash-tts`」を前提に設計し直さないこと)**:
  - **モデル**: `gemini-3.8-flash-tts` → **`google/gemini-3.8-flash-lite-tts` にピン留め**。
    flash ではなく lite を選んだ根拠 (日本語 3.8 の品質実測・コスト) は
    `docs/research/2026-09-28-gemini-38-tts-japanese-evaluation.md` と
    `docs/research/2026-09-28-gemini-tts-cost-optimization.md`
  - **キー**: `GEMINI_API_KEY` → **`OPENROUTER_API_KEY`**。Jev 判定と**同じ 1 本**を
    `$env/dynamic/private` に持つ (クライアント不露出は維持)
  - **配信**: 「R2 に保存して配信」→ **棄却**。R2 バケットもビルド時プリフェッチも無い。
    音声は**クライアントの IndexedDB** (`oboeru-tts`、64 MiB 上限の自前 LRU) に生 PCM で
    保存し、再訪時・リロード跨ぎでもネットワークを叩かない。R2 化の利点だった
    「2026-12-31 の値上げ前に全生成すれば永久に回避できる」は得られないが、同じ文の
    2 回目以降の課金はキャッシュで無い
  - **エンドポイント**: `generativelanguage.googleapis.com` の base64 `audio/wav` ではなく
    `POST https://openrouter.ai/api/v1/audio/speech` に `response_format: "pcm"` を要求し、
    `audio/pcm;rate=…;channels=…` を受けてサーバ側で RIFF/WAV 化する (`src/lib/pcm-wav.ts`)
  - **スタイル指定**: `provider.options['google-ai-studio'].speech_metadata` に置く。
    top-level `instructions` は 200 を返すが黙って捨てられる
  - **話速は生成パラメータに無い**。数値レートを受け付けないため、話速は再生時の
    `playbackRate` (`preservesPitch = true`) で変える — 生成し直さないので課金も容量も
    変わらない。生成キャッシュキーにも `speakingRate` を含めない
  - **1 文 = 1 リクエストはそのまま** (応答にタイムスタンプが無いので分割も結合も不可)。
    ボイスは 1 種 (`Ludo`) — 言語は入力テキストから Gemini 自身が判定する
  - **課金は従量** (`lite-tts` Standard で 10 秒あたり $0.0015、1 文あたり約 $0.002〜0.005)。
    実測の内訳と 2027 年の値上げ影響の詳細は `docs/research/2026-09-28-gemini-tts-cost-optimization.md`
  - **未確認のまま残すもの**: 話速の最適値 (実装の既定は 1.0 = `src/lib/settings.ts` の
    `DEFAULTS.ttsRate`。試聴は 1 文のみで 0.9 案は未検証)、Vertex AI 版の有無、
    生成音声の再配信ライセンス条項、iOS ITP の 7 日ルールで 8 日以上開かなかった場合の
    IndexedDB 生存 (PWA 化 = ロードマップ⑤ で解消)
