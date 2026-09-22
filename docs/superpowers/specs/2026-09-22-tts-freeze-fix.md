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

## 検証 (完了条件)

1. `npm run check` 0エラー / `npm test` / `npm run test:e2e` 全緑
2. **実機ゲート (ユーザー承認)**: Android Chrome で初回DL含め 10文以上連続練習 →
   再読込ゼロ、色分け動作を確認

## 付録: 全体ロードマップとスタック決定 (後続サブプロジェクト参照)

本サブプロジェクト外だが、ブレストで確定した事項:

- **順序**: ①フリーズ修正 (本spec) → ②UI強化 (類似度画面の即スキップ防止・ボタン常時下部・
  スマホでキーボンドヒント非表示) → ③PWA (Android) → ④トラック×子チャプター統合 (名称はトラック) →
  ⑤AI TTS + クラウド音声配信 → ⑥クラウド同期
- ④を⑥より前に入れる (同期は最終データモデル確定後)。⑤は③と噛み合う (生成済み音声の配信が
  PWAオフライン再生にも効く)
- **スタック**: インフラは Cloudflare 全面 (Workers / D1 or KV / R2)。AI (採点等) は
  OpenRouter またはローカル。TTS はコスト節約のため **OpenRouter `Grok Voice TTS 1.0` で
  生成1回 → クラウドに保存して配信** (正確なモデルIDと仕様は⑤で要確認)
