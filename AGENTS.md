# おぼえる (Oboeru) — AGENTS.md

音声で文章を練習する SvelteKit アプリ (Cloudflare Workers)。TTS読み上げ → Space押下中録音 (プッシュトゥトーク) → Groq Whisper 文字起こし → 正規化+類似度+**Jev意味一致判定**で採点。録音中のリアルタイム単語色分け (vosk-browser / ライブSTT) 付き。

## セットアップ

```bash
npm install
```

`.env` (作成、コミット禁止):
- `GROQ_API_KEY` — 文字起こし (無いと採点不可)
- `GOOGLE_TTS_API_KEY` — 読み上げ (無いとTTS 503、録音練習は可能)
- `OPENROUTER_API_KEY` — Jev判定 (無いと類似度のみのフォールバック採点)

ライブSTTのローカルモデル: `npm run stt:fetch` (.stt-models/ に ~90MB、コミット禁止)

## コマンド

| コマンド | 用途 |
|---|---|
| `npm run dev` | 開発サーバー (localhost:5173) |
| `npm run check` | svelte-check — **必ず 0 エラー** |
| `npm test` | vitest (ユニット) |
| `npm run test:e2e` | Playwright 全体 |
| `npx playwright test tests/X.spec.ts --workers=1 --reporter=list` | 単体デバッグ |
| `npm run build && npx wrangler deploy` | デプロイ |

デプロイ後スモーク: `curl -X POST https://oboeru.k319-k319-k319-k319.workers.dev/api/judge -H "Content-Type: application/json" -d '{"reference":"3階","transcription":"三階"}'` → `{"available":true,"noul":≥0.8,...}` とサイト 200。

## ディレクトリ地図

- `src/lib/sentences.ts` — **ストレージ単一モジュール** (キー `oboeru:v1`、`{chapters, tracks, sentences}`)。CRUD、旧データ読み込みシム、`getChapterSentences` 二段ソート、削除カスケード
- `src/lib/types.ts` — `Chapter` / `Track` / `Sentence` / `Settings`
- `src/lib/default-sentences.ts` — 既定データ (ja-01..10, en-01..10 + 既定トラック)
- `src/lib/normalize.ts` — `normalizeJapaneseText` (正規化の正src: NFKC → 記号/空白除去 → カタカナ→ひらがな)
- `src/lib/similarity.ts` — 上記正規化を内蔵した Levenshtein 類似度 (0-100)
- `src/lib/jev.ts` — `buildJudgeRequest` / `parseJudgeResponse` 純関数
- `src/lib/alignment.ts` — 差分トークン (feedback の色分け)
- `src/lib/livestt/` — vosk-browser ライブSTT (engine / model-loader / mock-engine / urls)
- `src/routes/practice/+page.svelte` — 練習画面 (7フェーズstate machine、T13プッシュトゥトーク、doTranscribe 採点+Jev統合)
- `src/routes/manage/+page.svelte` — 管理画面 (章ツリー、トラックCRUD、文CRUD、インポートv2/エクスポート)
- `src/routes/api/{transcribe,tts,judge}/+server.ts` — サーバーproxy (キーは `$env/dynamic/private`、クライアント不露出)
- `src/routes/api/models/[file]/+server.ts` — STTモデル配信proxy (許可リスト制)
- `tests/` — Playwright E2E (シードは localStorage 直書き)

## データモデル規約

- **章 → トラック → 文** の3層。`Sentence.trackId` 必須。練習順 = `track.order` → `sentence.order` の二段ソート
- **インポート/エクスポートは version 2 のみ**: `{version: 2, chapters, tracks, sentences}`。`validateImportJson` は v1 を「対応していないバージョンです」で拒否。choice/noul のJev判定で使うため sentence の `trackId` 欠落は絶対に許さない
- 旧形式 (tracks 無し) のローカルデータは読み込みシムが章ごとに既定トラック (id `tr-<chapterId>`、名前 `トラック1`) へ自動収容 → 既存シード/E2Eは無影響
- 削除カスケード: 章削除 → 子孫章+その章のトラック+文。トラック削除 → 所属文
- `updateSentence` は chapter/track の整合を自動修復する (他章の trackId が来たら章の先頭トラックに再割当)

## 採点パイプライン規約

- 正規化は `similarity()` 内部で完結 (呼び出し側で二重正規化しない)
- スコア合成 (doTranscribe 内): `sim >= threshold` なら **Jev不呼出** (合格確定)。`sim < threshold` → `POST /api/judge` → `finalScore = Math.max(sim, Math.round(noul * 100))`
- `/api/judge` は**常に HTTP 200**: 成功 `{available:true, noul, category, confidence}` / 全失敗 (キー未設定・タイムアウト10s・429/529/5xx リトライ1回後) `{available:false}` → クライアントは sim のまま継続
- judge 呼び出し後は transcribe と同一の再ガード (`phase`/`currentIndex`) を挟む (スキップとの競合防止)

## Jev (TypeSafe System One) API 規約

- エンドポイント: `POST https://openrouter.ai/api/v1/systemone`、モデルは **`typesafe/jev-1.13` にピン留め** (jev-latest 不使用)
- `choice` 型の質問には **`criteria` マップ必須** (無いと zod 400 — 実測)。`state` はオブジェクト最小構成 (context rot 防止)
- `noul` に confidence は無い。`P(noul)` と否定形の和は 1 にならない → **否定形マジョリティ投票は禁止**
- CJK は「英語同等ではない」(公式docs) → 実コンテンツでテストし confidence を見てルーティング
- キー `OPENROUTER_API_KEY` は wrangler secret + .env のみ。コミット禁止・クライアントコードから直接呼ばない

## E2E テスト規約 (重要な経験則 — 違反すると原因不明の赤になる)

1. キーボードでプッシュトゥトークを駆動するテストは、**最初の Space keydown の前に必ず `record-ready` の可視待ち**を入れる。hydration 前に発火した keydown はワンショットで消失する (practice.spec.ts がパスパターン)
2. reload の前には必ず `keyboard.up('Space')` — 押しっぱなしで遷移すると次の down が `event.repeat=true` になり repeat ガードに握りつぶされる
3. `mockTranscribe` は `mockJudgeFallback` (`**/api/judge` → `{available:false}`) をデフォルト適用済み — **キーが .env にあっても実 OpenRouter を叩かない**。Jev をテストするときだけ後から route 登録でオーバーライド (後登録が優先)
4. transcribe モックは `delayMs` で transcribing フェーズを確保してからアサート
5. シードは `{chapters, tracks?, sentences}` 直書き — `tracks` 欠落はシムが救うが、トラックをテストするなら明示する
6. 短押しガード: 保持 < 500ms は採点されない。ホールドはタイマー ≥ 0.7s で解放 (holdAndRelease ヘルパー)

## 既知の落とし穴

- `practice.spec.ts` (〜:153) と `e2e-full` full-flow は並列負荷で**稀にフレーキー** (隔離実行・再実行で必ず解決、コード起因の再現なし)。フルスイートで1件落ちたらまず単独再実行
- `src/lib/components/ui/badge/index.ts` は LSP が誤検出する (svelte-check は 0 エラーが真実)
- コミット禁止物: `.env` / `.stt-models/` / `.omo/` / `.superpowers/` / `babel-import.json` / `test-results/`
- 録音採点の文字起こしは Groq Whisper。表記ゆらぎ (3階/三階、あらそう/争う) は Jev+正規化で吸収済み — モデル変更は不要 (ユーザー決定済み)

## 運用

- コミット/プッシュ/デプロイは**ユーザー明示依頼時のみ**。conventional commits (英語、単一行件名)
- テストの削除・skip化・アサーション弱化は禁止 (挙動変更時は正当に更新し報告)
- UI文言は日本語。レスポンシブ 390px 維持、axe serious/critical 0 維持
- 実機チェック残務 (ユーザー承認ゲート): Firefox デスクトップ / Android Chrome でのマイク許可・ライブ色分け・モデルDL失敗フォールバック
