# おぼえる (Oboeru) — AGENTS.md

音声で文章を練習する SvelteKit アプリ (Cloudflare Workers)。TTS読み上げ → Space押下中録音 (プッシュトゥトーク) → Groq Whisper 文字起こし → 正規化+類似度+**Jev意味一致判定**で採点。

## セットアップ

```bash
npm install
```

`.env` (作成、コミット禁止):
- `GROQ_API_KEY` — 文字起こし (無いと採点不可)
- `GOOGLE_TTS_API_KEY` — 読み上げ (無いとTTS 503、録音練習は可能)
- `OPENROUTER_API_KEY` — Jev判定 (無いと類似度のみのフォールバック採点)

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
- `src/lib/practice-progress.ts` — セッション途中再開の永続化 (sessionStorage `oboeru:progress:v1`、30分 TTL)
- `src/routes/practice/+page.svelte` — 練習画面 (7フェーズstate machine、T13プッシュトゥトーク、doTranscribe 採点+Jev統合)
- `src/routes/manage/+page.svelte` — 管理画面 (章ツリー、トラックCRUD、文CRUD、インポートv2/エクスポート)
- `src/routes/api/{transcribe,tts,judge}/+server.ts` — サーバーproxy (キーは `$env/dynamic/private`、クライアント不露出)
- `tests/` — Playwright E2E (シードは localStorage 直書き)

## practice 画面のレイアウト規約

`/practice` は「3 区画 + definite height」の app shell である。外側から順に:

| 区画 | class | 役割 |
|---|---|---|
| practice root | `mx-auto flex h-dvh w-full max-w-2xl flex-col py-4` | definite height の器。縦 padding は这里が所有者 |
| header | `flex flex-none` (`data-testid="practice-header"`) | 章名 + 終了アイコン (アイコンのみ) |
| progress | `flex flex-none flex-col gap-1` (`data-testid="progress"`) | 全幅 1 行。`progress-bar` + `<span>` 2 個 |
| 本文 | `flex min-h-0 flex-1 flex-col overflow-y-auto` (`data-testid="practice-body"`) | **ここだけが内部スクロール** |
| action-zone | `flex flex-none flex-col gap-2 border-t border-border p-3` (`data-testid="action-zone"`) | 主操作 1 + サブ 0〜2 + `skip-btn`。常にビューポート内に見える |

- **`h-dvh` と `src/routes/+layout.svelte` の `class:py-6={!isPractice}` は相互結合。戻してはいけない。** `h-dvh` を `min-h-*` にすると本文の `min-h-0 flex-1` チェーンが clamp せず、document 全体がスクロールして `action-zone` が画面外に出る。`<main>` 側に `py-*` を足すのも同じ壊し方 (root の 100dvh がビューポートを超えて document スクロールが戻る)。横 padding は `<main>`、縦だけ root が持つ、という役割分担も維持する
- **練習中はグローバルナビが出ない。** `+layout.svelte` の `<header>` (`おぼえる` / `管理`) は `pathname === '/practice'` で条件付き非表示。`skip link` (`#main-content`) は全ルートで残る
- **録音中はスキップ不可。** `recording` フェーズでは `skip-btn` が `disabled` で、`skip()` 自体も no-op (誤タップで取了录入を捨てないため)。判定は `isRecording = $derived.by(() => phase === 'recording')` を使う。`feedback-actions` 内の `skip-btn` では `phase` が `'feedback'` へ narrowing されるため、`phase === 'recording'` を直接書くと svelte-check の "no overlap" エラーになる
- **390px ではキーボードヒント非表示。** `kbd-hint` は `hidden sm:inline-block`、散文の指示文 `record-ready-hint` も `hidden sm:block` (640px 未満で消す)。**注意**: `.kbd-hint` の scoped style には `display` を書いていない。書くと unlayered scoped style が Tailwind の `utilities` レイヤーに勝って `hidden` が効かない

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
- **時間による自動送りなし。** 採点後の遷移は `next-btn` / `retry-btn` の明示クリック (または Space / Enter) のみ。`oboeru:practice-ui:v1` の autoAdvance / dwell 設定は削除済み。**E2E は時間待ちに依存せず明示クリックする** (実運用の挙動に合わせる)

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
7. `data-testid="progress"` は 11 箇所で `toHaveText` 完全一致 assert されている。外側ラッパの中に `progress-bar` と `<span>` 2 個が入る。2 span の結合結果が `基本 · 1 / 2` / `1 / 1` と一致すること。practice 画面の progress DOM を触るときは文字列と `showTrackBadge` の分岐条件を維持する
8. `action-zone` は 390px で `rect.bottom <= innerHeight + 1` を満たすこと
9. 録音中は `skip-btn` が `disabled`、かつ `S` キーでスキップされない
10. `oboeru:practice-ui:v1` の Preferences を seed する步骤は不要 (同キーは削除済み。シードの書き換えは localStorage 直書きだけで足りる)

## 既知の落とし穴

- `practice.spec.ts` (〜:153) と `e2e-full` full-flow は並列負荷で**稀にフレーキー** (隔離実行・再実行で必ず解決、コード起因の再現なし)。フルスイートで1件落ちたらまず単独再実行
- `src/lib/components/ui/badge/index.ts` は LSP が誤検出する (svelte-check は 0 エラーが真実)
- コミット禁止物: `.env` / `.omo/` / `.superpowers/` / `babel-import.json` / `test-results/`
- 録音採点の文字起こしは Groq Whisper。表記ゆらぎ (3階/三階、あらそう/争う) は Jev+正規化で吸収済み — モデル変更は不要 (ユーザー決定済み)

## 運用

- コミット/プッシュ/デプロイは**ユーザー明示依頼時のみ**。conventional commits (英語、単一行件名)
- テストの削除・skip化・アサーション弱化は禁止 (挙動変更時は正当に更新し報告)
- UI文言は日本語。レスポンシブ 390px 維持、axe serious/critical 0 維持
- 練習中はグローバルナビを隠す。テーマは既定で端末同期・上書きは管理 › 設定の「表示テーマ」fieldset の 3 択 (`端末に合わせる` / `ライト` / `ダーク`) のみ。ナビに切替ボタンを置かない。`src/lib/theme.ts` の `toggleTheme()` は削除済み (押すと `system` を脱して端末変更を追従しなくなるのが原因)。`/practice` からテーマを一切変えられない (端末設定に従う)
- 実機チェック残務 (ユーザー承認ゲート): Firefox デスクトップ / Android Chrome でのマイク許可
