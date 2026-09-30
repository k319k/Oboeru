# おぼえる (Oboeru) — AGENTS.md

音声で文章を練習する SvelteKit アプリ (Cloudflare Workers)。TTS読み上げ → Space押下中録音 (プッシュトゥトーク) → Groq Whisper 文字起こし → 正規化+類似度+**Jev意味一致判定**で採点。

## セットアップ

```bash
npm install
```

`.env` (作成、コミット禁止):
- `GROQ_API_KEY` — 文字起こし (無いと採点不可)
- `OPENROUTER_API_KEY` — **Jev 判定と読み上げ (TTS) で共有する 1 本のキー**。Jev 判定が無いと類似度のみのフォールバック採点、TTS が無いと `/api/tts` が 503 (練習ページは「TTS エラー: TTS API キーが未設定です」) で読み上げが失敗する。どちらかが使用寿命|Consumed になると他方が黙って落ちるが、個人利用ではキーを分ける価値がないため共有している (Spec §Gap の決定)

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

- `src/lib/sentences.ts` — **ストレージ単一モジュール** (キー `oboeru:v1`、`{chapters, tracks, sentences}`)。CRUD、`migrateToV3` 読み込みシム (lazy write-back)、削除カスケード。階層純関数 (`flattenTrackTree` / `getNodeDescendantTrackIds` / `getNodeSentences` / `getNodeTrail` / `getChapterTracks` / `flattenChapterTree`) もここ
- `src/lib/types.ts` — `Chapter` / `Track` / `Sentence` / `Settings`
- `src/lib/default-sentences.ts` — 既定データ (ja-01..10, en-01..10 + 既定トラック `tr-ch-ja-01` / `tr-ch-en-01`、どちらも `parentId: null`)
- `src/lib/normalize.ts` — `normalizeJapaneseText` (正規化の正src: NFKC → 記号/空白除去 → カタカナ→ひらがな)
- `src/lib/similarity.ts` — 上記正規化を内蔵した Levenshtein 類似度 (0-100)
- `src/lib/jev.ts` — `buildJudgeRequest` / `parseJudgeResponse` 純関数
- `src/lib/alignment.ts` — 差分トークン (feedback の色分け)
- `src/lib/pcm-wav.ts` — PCM→WAV の純関数 (`pcmToWav` / `parsePcmContentType` / `DEFAULT_SAMPLE_RATE=24000` / `DEFAULT_CHANNELS=1`)。**`Buffer` 禁止** — `DataView` + `Uint8Array` のみ。`src/routes/+layout.svelte` → `src/lib/tts.ts` が**直接 import** するのでブラウザ bundle に入る (`tts-cache.ts` とは独立で、`tts-cache.ts` はこのモジュールを import しない。ヘッダ付けはサーバ `api/tts` と再生時 `tts.ts` の責務)
- `src/lib/tts-cache.ts` — IndexedDB 永存キャッシュ (`cacheKeyOf` / `readCachedPcm` / `writeCachedPcm` / `pruneOldest`、64MiB 上限の自前 LRU)。**透過的最適化** — 全操作が自前のエラーを握り潰して「キャッシュミス」に縮退する (IndexedDB 不可のプライベートモードでも練習は動く)。DB は初回 read/write で lazy open、`indexedDB` をモジュール先頭で触らない、`$app/environment` を import しない (vitest の node 環境で `browser` が false になりテスト不能になる)
- `src/lib/practice-progress.ts` — セッション途中再開の永続化 (sessionStorage `oboeru:progress:v1`、30分 TTL)。**`chapterId` フィールドには章ではなくセッションのノード id (章 or トラック) が入る** (トラックの概念導入以前の名残。復元の一致判定はその id で行う)
- `src/routes/+page.svelte` — トップページ (章を根とする1本の木。章行はサブツリー合計、トラック行は直属のみ、`/practice?node=` へのリンク)。**文数・言語バッジ・`練習` ボタンの判定はすべて `getNodeSentences` の 1 系統** — `$derived.by` の `sentencesByNode` (ノード id → 文配列) を 1 度だけ作って全ての行が参照する。別の subset で数えると「`0文` なのに `練習` ボタン」等の矛盾が壊れた `trackId` の章で起きる。トラック行の「直属のみ」は自ノードの結果を `s.trackId === trackId` で抜く
- `src/routes/practice/+page.svelte` — 練習画面 (`?node=<章id|トラックid>` が唯一の入口。ヘッダはパンくず固定、7フェーズstate machine、T13プッシュトゥトーク、doTranscribe 採点+Jev統合)
- `src/routes/manage/+page.svelte` — 管理画面 (chapters タブ = 章 + トラックの1本の木 + トラックのインライン本文編集 (IME ガード付き) / sentences タブ = 文の一覧と階層 select (トラックの CRUD は無い) / 設定 / データ。インポート v3 + v2 自動変換)
- `src/routes/api/{transcribe,tts,judge}/+server.ts` — サーバーproxy (キーは `$env/dynamic/private`、クライアント不露出)
- `tests/` — Playwright E2E (シードは localStorage 直書き)

## practice 画面のレイアウト規約

`/practice` は「3 区画 + definite height」の app shell である。外側から順に:

| 区画 | class | 役割 |
|---|---|---|
| practice root | `mx-auto flex h-dvh w-full max-w-2xl flex-col py-4` | definite height の器。縦 padding はここが所有者 |
| header | `flex flex-none items-center gap-2 pb-3` (`data-testid="practice-header"`) | パンくず (`章 › … › 自身`、開始ノードで固定) + 終了アイコン (アイコンのみ) |
| progress | `flex flex-none flex-col gap-1` (`data-testid="progress"`) | 全幅 1 行。`progress-bar` + `<span>` 2 個 |
| 本文 | `flex min-h-0 flex-1 flex-col overflow-y-auto` (`data-testid="practice-body"`) | **ここだけが内部スクロール** |
| action-zone | `action-zone flex flex-none flex-col gap-2 border-t border-border bg-background p-3` (`data-testid="action-zone"`) | 主操作 1 + サブ 0〜2 + `skip-btn`。常にビューポート内に見える |

- **`h-dvh` と `src/routes/+layout.svelte` の `class:py-6={!isPractice}` は相互結合。戻してはいけない。** `h-dvh` を `min-h-*` にすると本文の `min-h-0 flex-1` チェーンが clamp せず、document 全体がスクロールして `action-zone` が画面外に出る。`<main>` 側に `py-*` を足すのも同じ壊し方 (root の 100dvh がビューポートを超えて document スクロールが戻る)。横 padding は `<main>`、縦だけ root が持つ、という役割分担も維持する
- **練習中はグローバルナビが出ない。** `+layout.svelte` の `<header>` (`おぼえる` / `管理`) は `pathname === '/practice'` で条件付き非表示。`skip link` (`#main-content`) は全ルートで残る
- **録音中はスキップ不可。** `recording` フェーズでは `skip-btn` が `disabled` で、`skip()` 自体も no-op (誤タップで録音した音声を捨てないため)。判定は `isRecording = $derived.by(() => phase === 'recording')` を使う。`feedback-actions` 内の `skip-btn` では `phase` が `'feedback'` へ narrowing されるため、`phase === 'recording'` を直接書くと svelte-check の "no overlap" エラーになる
- **長押しでテキスト選択が始まらない。** 録音ボタン (`.record-hold-btn`) と下部アクションゾーン (`.action-zone`) は `user-select: none` + `-webkit-touch-callout: none`。録音操作を長押しで妨害しないため。`sentence-text` と `diff-token` は選択可能なまま残す
- **録音中はスクロール履歴メーターを出す。** `recording` フェーズは `data-testid="level-history"` の縦棒 32 本（1 本 100ms ぶん = 3.2 秒履歴）。`justify-end` + `overflow-hidden` で最新が右・古いほど左で消える。**親 `sentence-recording` の `w-full` は省略不可**（`items-center` の親により fit-content に解決され、`min-content` 365px が親をはみ出すため）。棒の高さは `Math.max(3, Math.min(224, Math.round(level * 896)))` px でコンテンツボックス（`h-[240px]` − `p-2`×2 = 224px）を超えない。`level-meter` の `min-w-0` は現状 load-bearing ではないが将来の防御で残す
- **録音フェーズの表示は選択不可にする。** `.recording-status` と `[data-testid='release-hint']` に `user-select: none`。録音しながら指を上へ滑らせると 173px 上の「離すと採点します」に着地して「します」が選択され、Android の選択ハンドル＋検索バブが飛ぶ。ライブ表示なのでコピーする価値は無い。`show` の文と `feedback` の差分トークンは選択可能なまま残す
- **押して録音は全幅・80px。** 下のスキップ（全幅 44px）より細かったため、主操作の全幅・塗り convention に揃えた。`display: flex` + `width: 100%`（`display: block` にするとアイコンとラベルが中央揃えにならない）
- **録音フェーズだけ本文を縦中央寄せにする。** 本文（`practice-body` の内側 div）に `class:my-auto` を付ける。`justify-content: center` ではない — 親が `overflow-y-auto` の縦フレックスなので centering するとコンテンツが親より高いとき上端がスクロールで到達不能になる。`margin-block: auto` は free space がなければ 0 に解決され overflow 時は上寄せに戻る。`recording` だけ（内容は 384px で 390×844 の body 659px に対し上寄せだと下 275px が空く）。`feedback` は内容が高いので上寄せのまま
- **390px ではキーボードヒント非表示。** `kbd-hint` は `hidden sm:inline-block`、散文の指示文 `record-ready-hint` も `hidden sm:block` (640px 未満で消す)。**注意**: `.kbd-hint` の scoped style には `display` を書いていない。書くと unlayered scoped style が Tailwind の `utilities` レイヤーに勝って `hidden` が効かない

## データモデル規約

- **章 (ルート専用) → トラック (ネスト可) → 文** の3層。`Chapter.parentId` は型に残るが常に `null` (UI から設定する経路が無い)。階層は `Track.parentId` が担う。`Track.chapterId` / `Sentence.chapterId` は最上位章を指す冗長フィールド、`Sentence.trackId` は直接の親トラック
- 練習順 = **pre-order** (自文 → 子トラック1配下 → 子トラック2配下)、各トラック内は `sentence.order` 昇順。走査は `flattenTrackTree` が正。章の文の並びも `getNodeSentences` が pre-order で返す (`track.order` だけのソートは入れ子で破綻する)
- `Track.parentId` を更新する API は存在しない (`updateTrack` の引数型から除外)。トラックの親は追加時に確定し、サイクルは構造的に発生しない。`addChapter(name, parentId)` はシグネチャに残っているが UI から `null` しか渡らない
- インポート/エクスポートは **version 3** (`{version: 3, chapters, tracks, sentences}`)。`validateImportJson` は v2 も受理して `migrateToV3` で変換、v1 は「対応していないバージョンです」で拒否。choice/noul の Jev 判定で使うため sentence の `trackId` 欠落は絶対に許さない
- **トラック id の重複検査はグローバル** (章をまたいでも拒否 / 「トラック id が重複しています」)。下流は id をグローバルに照合する (`getNodeSentences` は `tracks.find`、`deleteTrack` は id だけを受け取る) ので、章をまたいだ重複は「別々のノード」に見えず、`deleteTrack` のカスケードが他章のトラックと文まで巻き込む。正当な id は `generateId()` 由来で章をまたいで衝突しないので入力で弾く。io-settings の `the same track id in two different chapters is rejected` がその契約
- **章スコープの純関数契約**: `flattenTrackTree(chapterId, …)` と `getNodeDescendantTrackIds(trackId, tracks, chapterId)` は**必ず章を跨がない**。後者の `chapterId` は**省略不可** (省略可にすると、他章の同名 id を親として辿り `deleteTrack` が他章を消す — 2026-09-27 のレビューで実測)。`getNodeSentences` / `getNodeTrail` は章とトラックの両方を受け付ける
- 読み込みシム `migrateToV3` (冪等・`loadData` から呼び、差分があれば `saveData` で書き戻し): `tracks` 欠落の旧データ → 章ごとに既定トラック生成 / **子チャプター → 最上位章直下のトラック** (`tr-from-ch-<章id>`、祖先が近い順に投入。その章の既存トラックは祖先章へ追従、順序は後続) / 全トラックに `parentId` を補う。祖先が解決できない子チャプターはルート章のまま残す (**落とすと配下が到達不能になる**)、`parentId` が存在しないトラックを指す場合は `null` に修復
- 読み込みシムの**入れ子トラックは `chapterId` だけ差し替え `parentId` は保持**する (深さを潰さない / 兄弟化しない)。冪等性アサーションだけだと `t.parentId = null` を混入しても緑になるので、移植後の値を直接アサートするテストを維持すること
- 削除カスケード: 章削除 → 配下の全トラック + 全文 / トラック削除 → 子孫トラック + 配下の全文 (**どちらもその章の中だけ**)。削除ダイアログは**件数プレビュー**を両方に出す — トラックは「N件のトラックと M件の文章を削除しますか？」、章は「このチャプター配下の N件のトラックと M件の文章を削除しますか？」 (`delete-track-preview` / `delete-chapter-preview`。「子孫チャプター」は廃止済み概念なので書いてはいけない)
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
- **`state` には必ず正規化済みテキストを渡す** (`buildJudgeRequest` が `similarity.ts` の `normalize` を通す)。句読点・空白・全角半角・英字大小・カタカナ/ひらがな差を読み上げ差として Jev に見せると誤判定になる (「これらの人びとは, 天までとどく塔を…」と「これらの人々は天まで届く塔を…」が別文と判定された実例)。Jev は渡された `state` の文字列しか見ないので、**除去はクライアント側でしかできない** — instructions に「無視して」と書いただけでは効かない。`difference_kind` は現状 UI 未使用で、`answers` に存在することが `parseJudgeResponse` の available 条件であるため必須
- `noul` に confidence は無い。`P(noul)` と否定形の和は 1 にならない → **否定形マジョリティ投票は禁止**
- CJK は「英語同等ではない」(公式docs) → 実コンテンツでテストし confidence を見てルーティング
- キー `OPENROUTER_API_KEY` は wrangler secret + .env のみ。コミット禁止・クライアントコードから直接呼ばない
- **Jev と TTS は同じキーを共有する** (個人利用でキーを分ける価値がないという Spec §Gap の決定)。共有には副作用がある: **TTS の大量消費が Jev の利用枠 / クレジットを無言で奪う**。どちらかが使用量上限や 429 / 402 に当たると、judge 側は `{available:false}` (= 類似度のみのフォールバック採点) に**ユーザーへ何も知らせずに**落ちる。TTS 側で 429 やリトライが出始めたら、Jev も同じ使い捨てになっている可能性として疑うこと。鍵を分けない判断 (`ENV_OPENROUTER_API_KEY` を judge と tts で分ける等) が出る段階では、先に 2 つのエンドポイントが出す同一文言の `OPENROUTER_API_KEY is not set` (`api/judge` と `api/tts` の stderr) の出所を見分ける

## TTS (Gemini via OpenRouter) 規約

- エンドポイント: `POST https://openrouter.ai/api/v1/audio/speech`、モデルは **`google/gemini-3.8-flash-lite-tts` にピン留め**。キーは Jev と **同じ `OPENROUTER_API_KEY`** (Groq キーでも別キーでもない)。`response_format: 'pcm'` を要求し、返ってきた `audio/pcm;rate=…;channels=…` を `pcm-wav.ts` で RIFF/WAV にして 200 で返す
- **`speech_metadata` は必ず `provider.options['google-ai-studio']` 配下**。top-level の `instructions` は **HTTP 200 を返してから黙って捨てられる** (スタイル指定が効かない)。Gemini は `input` をそのまま読むので、地の文への演出指示はテキストではなく `speech_metadata` に入れる
- **話速は生成ではない。** 話速はクライアントの `HTMLAudioElement.playbackRate` + `preservesPitch = true` で、`speak()` の `options.rate` 経由。生成キー (`cacheKeyOf`) に `speakingRate` を含めない (話速ごとに同じ文を生成し直し、課金と容量を二重に払う)。`speakingRate` はリクエスト互換のため受け付けるが値は無視する
- **1 文 = 1 リクエスト。** Gemini TTS の応答にタイムスタンプが無く、前後の継ぎ目が分かる形で分割できないため、複数文をまとめて生成して結合する実装はしない
- ボイスは 1 種 (`Ludo`) のみ。許可リストは `$lib/tts-voices` の `CURATED_VOICES` が正で、`/api/tts` は `isAllowedVoiceName` で弾く。`languageCode` / `gender` / 言語別のボイス表は Google Cloud TTS の概念で廃止済み。設定に残った旧 Google 声名は `resolveVoice` が黙って既定へ落とす
- リトライ: 429 / 500 / 502 / 503 / 529 と **`402` のうち `limit_source` が `openrouter_in_flight_budget` のものだけ**。待ち時間は `Retry-After` (delta-seconds と HTTP-date の両形式) を優先し、無いときだけ `BACKOFF_MS`。`Retry-After` も試行タイムアウトも `TTS_BUDGET_MS` (= 10s + 1s + 2s = 13s) でクランプする。**401/403/402 の credit 枯渇はリトライしない** (無意味に 13 秒もユーザーの時間を奪う)
- クライアントの `FETCH_TIMEOUT_MS = 15_000` はサーバの `TTS_BUDGET_MS = 13_000` より長い。ここ反过来ればクライアントが打ち切ってサーバだけがفاقする
- 音声は **R2 ではなくクライアントの IndexedDB** に保存する (R2 案は棄却)。`/api/tts` が WAV を返し、`tts.ts` がヘッダ 44 バイトを落として生 PCM として `writeCachedPcm` する。再生時は `readWavHeader` で生 PCM と WAV を見分け、前者にだけ `pcmToWav` でヘッダを付け直す (両方に付けると再生時の最初の 1 サンプルのクリックノイズになる)
- キャッシュは**保存出来なくてもよい**。`isTtsCacheAvailable()` が false / IndexedDB が壊れている / write が reject された — 全て「ネットワークへフォールバック」に縮退する
- `TTS_MODEL` / `TTS_STYLE` は `$routes/api/tts` と `$lib/tts-cache` のキー prefix に**二重定義**されている ( 片方を変えると静かに古い音声が再生される )。共通化はしない — `tts-cache.ts` はブラウザ側なので route モジュールを import できない。**コメントでのみ結合を注記する**

## E2E テスト規約 (重要な経験則 — 違反すると原因不明の赤になる)

1. キーボードでプッシュトゥトークを駆動するテストは、**最初の Space keydown の前に必ず `record-ready` の可視待ち**を入れる。hydration 前に発火した keydown はワンショットで消失する (practice.spec.ts がパスパターン)
2. reload の前には必ず `keyboard.up('Space')` — 押しっぱなしで遷移すると次の down が `event.repeat=true` になり repeat ガードに握りつぶされる
3. `mockTranscribe` は `mockJudgeFallback` (`**/api/judge` → `{available:false}`) をデフォルト適用済み — **キーが .env にあっても実 OpenRouter を叩かない**。Jev をテストするときだけ後から route 登録でオーバーライド (後登録が優先)
4. transcribe モックは `delayMs` で transcribing フェーズを確保してからアサート
5. シードは `{chapters, tracks?, sentences}` 直書き — `tracks` 欠落はシムが救うが、トラックをテストするなら明示する。`Track.parentId` を書かなかったトラックはルート扱い (省略 ≠ 不正)
6. 短押しガード: 保持 < 500ms は採点されない。ホールドはタイマー ≥ 0.7s で解放 (holdAndRelease ヘルパー)
7. `data-testid="progress"` は 16 箇所で `toHaveText` 完全一致 assert されている。外側ラッパの中に `progress-bar` と `<span>` 2 個が入る。2 span の結合結果が `基本 · 1 / 2` / `1 / 1` と一致すること。practice 画面の progress DOM を触るときは文字列と `showTrackBadge` の分岐条件を維持する
8. `action-zone` は 390px で `rect.bottom <= innerHeight + 1` を満たすこと
9. 録音中は `skip-btn` が `disabled`、かつ `S` キーでスキップされない
10. `oboeru:practice-ui:v1` の Preferences を seed する手順は不要 (同キーは削除済み。シードの書き換えは localStorage 直書きだけで足りる)
11. 練習の入口は `/practice?node=<章id|トラックid>` のみ (パラメータ無しは「ID が指定されていません」で summary へ)。進捗行は**章開始時だけ**トラック名付き (`基本 · 1 / 12` — さらにその章がトラック 2 個以上のときのみ `showTrackBadge`)。トラック開始時はトラック名がパンくずにあるので進捗行は素の `1 / 12`
12. 管理タブの track 行は `tree-track-*` 系 (`tree-track-row` / `tree-track-name` / `tree-track-up` / `tree-track-down` / `tree-track-edit` / `tree-track-delete` / `tree-edit-track-name` / `add-child-track` / `delete-track-preview`)。トラックの CRUD は **chapters タブにのみ**存在し、sentences タブに残るのは読み取り専用の `track-group` / `track-name` と、階層 select の `sentence-form-track` だけ
13. インライン本文編集 (`inline-sentence-text`) の Enter は IME ガード (`e.isComposing || e.keyCode === 229`) を通す。ガードを外すと日本語入力で「変換確定のたびに半確定テキストを保存」になる。blur ハンドラは event を渡さないので、確定だけは blur 経由で保存される設計

## 既知の落とし穴

- `practice.spec.ts` (〜:153) と `e2e-full` full-flow は並列負荷で**稀にフレーキー** (隔離実行・再実行で必ず解決、コード起因の再現なし)。フルスイートで1件落ちたらまず単独再実行
- `src/lib/components/ui/badge/index.ts` は LSP が誤検出する (svelte-check は 0 エラーが真実)
- コミット禁止物: `.env` / `.omo/` / `.superpowers/` / `babel-import.json` / `test-results/`
- 録音採点の文字起こしは Groq Whisper。表記ゆらぎ (3階/三階、あらそう/争う) は Jev+正規化で吸収済み — モデル変更は不要 (ユーザー決定済み)
- **長押しの文字選択抑止は自動テストで完全には検証できない。** Chromium の CSS パーサは `-webkit-touch-callout` をパース時に落とす（`CSS.supports('touch-callout')` は false、CSSOM からも消える）ので、iOS Safari 専用のプロパティとして宣言は残すが Chromium では検証不能。挙動は**マウス長押＋ドラッグ**なら Chromium でも検証できる（`user-select: none` の要素は `getSelection().rangeCount === 0`、選択可能な要素は 1）。CDP のタッチ経路は選択可能テキストでも 0 になるため空振り。**ただし 2 つ陷阱がある**: (1) Chromium は `<button>` ウィジェットの内側では CSS に関係なく選択が始まらないため、`record-hold-btn` や action zone の中心は**判定に使えない**（宣言を消しても 0 のまま）。検出するのは `record-ready-hint` のような**非 button の散文**。ただし `record-ready-hint` は `hidden sm:block` なので**判別ケース（散文）は `sm:` 以上の幅でしか観測できない**。390px 実機では computed `user-select` の確認に留まる。(2) `CSS.supports('user-select')` も false になるので `CSS.supports` による判別は不可

## 運用

- コミット/プッシュ/デプロイは**ユーザー明示依頼時のみ**。conventional commits (英語、単一行件名)
- テストの削除・skip化・アサーション弱化は禁止 (挙動変更時は正当に更新し報告)
- UI文言は日本語。レスポンシブ 390px 維持、axe serious/critical 0 維持
- 練習中はグローバルナビを隠す。テーマは既定で端末同期・上書きは管理 › 設定の「表示テーマ」fieldset の 3 択 (`端末に合わせる` / `ライト` / `ダーク`) のみ。ナビに切替ボタンを置かない。`src/lib/theme.ts` の `toggleTheme()` は削除済み (押すと `system` を脱して端末変更を追従しなくなるのが原因)。`/practice` からテーマを一切変えられない (端末設定に従う)
- 実機チェック残務 (ユーザー承認ゲート): Firefox デスクトップ / Android Chrome でのマイク許可
- 2026-09-27: ロードマップ ③ トラック階層統合を実装 (子チャプターを廃止し `Track.parentId` の木に統一。練習は `/practice?node=` で章/トラックどちらからでも開始、トップページと管理 › チャプターは同じ木を表示)。spec は `docs/superpowers/specs/2026-09-27-track-hierarchy-integration-design.md`、計画は `docs/superpowers/plans/2026-09-27-track-hierarchy-integration.md`。自動検証 (`npm run check` / `npm test` / `npx playwright test --workers=1`) は全緑、**実機ゲートは未実施** — 子チャプターを含む既存データの移行結果、3 段ネストの並び順、管理タブのインライン編集の実 IME をユーザー確認するまで「実機ゲート込み」で完了とみなさない
- ロードマップ順 (2026-09-27 見直し) は ①フリーズ → ②UI強化 (済) → ③トラック階層統合 (済) → ④AI TTS (**済、2026-09-29**。Gemini `google/gemini-3.8-flash-lite-tts` を **OpenRouter 経由**で使用。R2 での事前生成配信は棄却し、音声はクライアント IndexedDB のキャッシュに保持) → ⑤PWA (Android) → ⑥クラウド同期。理由は付録 `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` 参照
- 2026-09-29: ロードマップ ④ Gemini TTS 移行を実装 (spec は `docs/superpowers/specs/2026-09-29-gemini-tts-migration-design.md`)。自動検証 (`npm run check` / `npm test`) は全緑、**実機ゲートは未実施** — ① Android Chrome と iOS Safari で読み上げが鳴る (`preservesPitch` が効いている) / ② 話速スライダー 0.5・1.0・2.0 でピッチが崩れない / ③ リロードを跨いで音声が即再生される (IndexedDB 経路) / ④ リロードを跨いで **8 日以上使わずに**も音声が維持されるか (iOS ITP 7 日ルール。⑤のホーム画面 PWA 追加で免除されるならその旨) / ⑤ `ttsRate` の 0.9 が実際に最適か (試聴は 1 文のみで確定していない。既定値は 1.0 のまま) をユーザー確認するまで「実機ゲート込み」で完了とみなさない
