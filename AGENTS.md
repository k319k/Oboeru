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
- `src/lib/history.ts` — **練習履歴の永続化 + 集計**。キー `oboeru:history:v1` = `{version: 1, sessions, sentences}`、履歴セクションの開閉だけ別キー `oboeru:history-ui:v1` (データと同キーに混ぜない)。書き込み `recordSentenceAttempt` / `finalizeSession`、読み出し `loadHistory()`、開閉状態 `loadHistoryUiState` / `saveHistoryUiState`、純関数 `computeNodeStats` / `computeStreak(stats, sessions, now)` / `formatRelativeDay`。**全操作が `try/catch` で自前のエラーを握り潰す** (ストレージを拒否するブラウザでも練習は動く — 落ちるのは履歴だけ)。`clearHistory()` は**無い** (UI が無い export は死んだコードになるので、履歴消去 UI を足すときに初めて追加する)
  - **`loadHistory()` はモジュールキャッシュを返さず、毎回ストレージから読み直す。** だから呼び出し側は「読んだ内容」をそのまま信用できる (テストも localStorage を直書きして `loadHistory()` 経由で検証できる)。キャッシュ `cache` を使うのは**書き込み経路だけ** — `recordSentenceAttempt` は採点ごと (1 文ごと) に呼ばれるので、毎回全履歴を parse + stringify し直すと 1 セッション 20 文 × 200KB 弱の read/write が 20 回走る
  - **`persist()` は `localStorage.setItem` を呼ぶ前に `cache = data` とする。** だからクォータ超過で書き込みが失敗してもメモリ上の記録は残る — **成功したように見せてリロードで消える** (これが「保存できなくても練習は壊れない」の実装)。逆に `cache` が温まった後に別タブ / テストの直書き / devtools でストレージを書き換えても、次の `finalizeSession` は古い `cache` を stringfy して**その書き換えを消す**。だからモジュールは「テーブルの直後」と「同じタブ内の自前の書き込み」だけに信用し、他所からの更新を仮定しない。`history.test.ts` が `beforeEach` で `vi.resetModules()` して取り直すのはこのキャッシュを隔離するため
- `src/routes/+page.svelte` — トップページ (章を根とする1本の木。**章行・トラック行ともサブツリー合計**、`/practice?node=` へのリンク)。**文数・言語バッジ・`練習` ボタンの判定はすべて `getNodeSentences` の 1 系統** — `$derived.by` の `sentencesByNode` (ノード id → 文配列) を 1 度だけ作って全ての行が参照し、合格/苦手/未着手は同じ配列を `$derived.by` の `statsByNode` が `computeNodeStats` に渡す。別の subset で数えると「`0文` なのに `練習` ボタン」等の矛盾が壊れた `trackId` の章で起きる。**自ノードの文だけ数える (直属のみ) 実装へ戻してはいけない** — `getNodeSentences` はトラックにも**サブツリー**を返すので、直属に絞ると「自身の文が無く子トラックだけを持つトラック」が `0文` という矛盾した表示のまま生きている `練習` ボタンになる (`top.spec.ts` の `every row counts the subtree it would actually practise` と `a track is startable when only a descendant track holds sentences` がこの契約)
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

## 練習履歴の記録規約 (`src/lib/history.ts` の API を呼ぶ側)

- **文統計は `doTranscribe` の採点確定点だけ** — `completedCount++` と passed / failed の更新のあと、`phase = 'feedback'` の直前に 1 回だけ `recordSentenceAttempt(s.id, finalScore, Date.now())`。渡のは **Jev 合成後の `finalScore`** (`sim` ではない) なので、記録値と判定値は必ず一致させる。スキップは記録しない (採点されないので当然)
- **セッション record の `finalizeSession` は `settleSession()` 経由で 3 箇所から呼ばれる**: 進捗 `$effect` の `summary` 分岐 / `onDestroy` / `retryFailedOnly()` (再試行セッションをはじめる直前)。書いたら必ず `sessionStartedAt = null` にし、書かない早期 return (`completedCount === 0`) も `null` で終わるので**三重計上は起きない**
- **`onDestroy` は reload / タブを閉じた時に発火しない** (JS realm が破棄されるだけで Svelte の destroy hook が走らない)。だから summary での確定は必須で、`onDestroy` が受け持つのは SvelteKit のリンク遷移やブラウザの「戻る」で**セッション途中離脱**した時だけ。「リロードしても必ず記録される」ではない
- **`retryFailedOnly()` は `startSession()` を呼ばない**ので `beginSession()` で `sessionStartedAt` を再スタンプする。忘れると再試行セッションの `startedAt` / `durationMs` が前のセッションの時計を継承する
- **1 文も採点しなかったセッションは記録されない。** `settleSession()` は `completedCount === 0` で `sessionStartedAt = null` にして return する — 「1 文目で閉じた」「全部スキップした」は履歴に残らない。これは仕様で、Throw ではない。文を採点したうえで中断したセッションは `endedEarly: true` として残る
- **合格状態は保存しない。合格は「直近 `SCORE_WINDOW` (= 10) 回の平均」から導出する。** `SentenceStat` は `attempts` / `scores: number[]` (古い順・最大 10 件) / `lastPracticedAt` の 3 つだけ。`computeNodeStats` が `meanScore(stat.scores) >= threshold` で判定する。**`lastScore` は存在しない** — 直近 1 回だけで判定すると「1 回正解しただけで合格」「9 回合格したあとの 1 失敗で不合格」が両方起きる (ユーザーの報告。実測: `[40×9, 95]` が合格、`[95×9, 40]` が不合格)。閾値を下げると過去の合格記録が「合格」に戻る — 進捗が動くのが正しい
- **`HistoryData.version` は 1 のまま。絶対に上げるな。** `loadHistory()` は version 不一致で**既定値へ縮退**するので、上げるとユーザーが積んだ練習履歴 (セッション行 + 全文統計) が**全部消える**。2026-10-01 に `lastScore` → `scores` に変えたとき、version は据え置きで**読み取り側シム** (`readScores()`) で吸収した: `scores` が配列でないが `lastScore` が数値のエントリは `scores: [lastScore]` として読む。`mean([x]) === x` なので**デプロイで画面は一切変わらない** (合格判定・ドット・表示平均すべて同一)。2 件目以降の試行から初めて窓が効く。**フィールドを改名したら必ずこのシムを足す** — 「新フィールドを足して旧フィールドを消す」の顺手は履歴を全消去する
- **`scores` TrimBoth 面**。書き込み側 (`recordSentenceAttempt`) と読み込み側 (`readScores`) の**両方**で `SCORE_WINDOW` に切る。書き込み側を切 없다고 localStorage が際限なく膨らむ (読み込み側が再クリップするから、`loadHistory()` の戻り値だけ見て_WINDOW のテストを書くと**書き込み側の欠落検出に失敗する** — 実測済み)。読み込み側を切らないと手編集・将来値の値が判定 feeds する
- **`avgScore` は「文ごとの平均の平均」** (文を等 weight で)。全サンプルを pooled すると 1 文だけ 10 回練習した章でその 1 文が章の平均を支配する。`minSamples` は採点済み文の `scores.length` の**最小値** (`直近 N 回` の N)。最大値だと「1 文だけ 10 回・残り 19 文は 1 回」で過大に見える。`avgLastScore` という名前は**もう無い**
- **`直近 N 回` は `minSamples = 1` でも表示する。** 「根拠が 1 回しかない」ことが用户在知る唯一の方法で、`平均 87%` だけだと 1 回の閾値クリアと 10 回の安定が同じ数字で出る。空配列 (`scores: []`) なら平均 0 → 苦手 (合格を**作ってしまう**方向ではない)
- **`最終 … · 苦手 … · 直近 N 回` の行は truncate しない (390px 実測)。** 章行のテキスト列は 390px で **172px** しかなく (展開トグルと `練習` ボタンが横幅を取る)、`最終 今日 · 苦手 2 文 · 直近 1 回` は 202px 必要 — `truncate` を付けると **30-70px 切り取られ、`直近 N 回` は常に画面から消えていた** (ページ全体の横溢れは出ないので `expectNoHorizontalOverflow` には見えません。**clip は scrollWidth > clientWidth で測ること**)。折り返しで解決 (章カード 92px → 112px、`documentElement` の overflow は 0 のまま)
- **章行とトラック行の文数の基準は混ぜない — 両方ともサブツリー。** `statsByNode` は `sentencesByNode` の値をそのまま `computeNodeStats` に渡すので、行の分母 `M` は `/practice?node=` が実際に回すセッション長と一致し、ドット数とも一致する。`canPractice()` も同じ基準。**章行にはドットが出ない** — `computeNodeStats` が `isChapter` でドット出力そのものを抑止し、章行は進捗バー + `N/M 合格` に集約される。「直属のみ」集計に戻さない
- **ドット順 = 練習順。** `computeNodeStats` は渡された配列を並び替えない (`sentence.order` だけでソートするとトラックが交互に混ざり、子の 1 文が親のドットの真ん中に入る)。章行のラベルは `M文` (サブツリーが空のとき) か `N/M 合格 · P%` の 2 形態で、**`M文` は空ノード専用** — 文を持つノードが `0文` と読むと `練習` ボタンと矛盾する。トップ行の文言は E2E で `toHaveText` 完全一致 assert されているので文言変更はテスト更新が要る
- **`history` を読む `$effect` は content ロードの `$effect` と分離してある。** 統合して「ロードした直後に `history` を派生させる」と、その effect が自分の書き込みに依存する形になり hydration 中に `effect_update_depth_exceeded` で落ちる。`streak` が `$derived` なのも同じ理由 (derived には書き込みが無い)
- **ドットの色は「静的 base + 条件付き上書き」にしない。** Tailwind は全ての色 utility を単一の `utilities` レイヤーに同じ詳細度で入れるので、**勝者は生成 CSS のソース順**であってテンプレートの属性順ではない。ドットの `bg-border` (静的) + `class:bg-amber-500` の形は実測で `bg-border` が勝ち、**苦手と未着手がピクセル同一の灰色**になっていた (2026-10-01 の全体レビューで実測。`data-dot` 属性を読む既存テストは全部緑のままだった)。3 色とも条件付きにして、**常に 1 つだけ存在する**:`class:bg-border={dot === 'untouched'} class:bg-success={dot === 'passed'} class:bg-amber-500={dot === 'hard'}`。色の検証は `getComputedStyle(el).backgroundColor` で**クラス/値レベル**で行う (属性レベルの検証ではこのバグを検出できない)
- **同じ罠が `src/routes/manage/+page.svelte:1514-1516` と `:1645-1647` にある** (`text-muted-foreground` + `class:text-destructive` の文字数カウンター。実測で `text-muted-foreground` が勝ち、上限超過が赤にならない)。2026-10-01 時点で**未修正** (本ブランチ以前の既存バグ)。触るときは 3 色全てを条件付きにする
- **連続日数は「今日が何も採点する前でも途切れない」** (`computeStreak` が今日の日付が無いときは 1 日だけ戻って数え直す)。アプリを開いただけでの連続切れは UX として意図している。`連続 N 日` ピルは `totalAttempts > 0` のときだけ出る (ログ行だけ仍有・文統計が 0 のときはピルを出さない)
- **履歴の導出は「読む側」で検証する。** 文統計は 1 文ごと、セッション行は 1 セッションごと — この非対称な書き込みに対して、**行フィールドのテストは 1 つずつしか行われていなかった**。`最終/苦手` の行 / `さらに表示` のページング / のべ文数 / ピルの可視ゲート / 2 行目の `MM/DD HH:MM · N 文 合格 · 平均 P% · スキップ K` は 2026-10-01 まで**アサーションが 1 つもなかった**ため、`totalScore: 0` や `skipped: 0` のような破壊が E2E 180 件緑のまま通っていた。履歴の表示を触るときは `tests/history.spec.ts` の該当テスト (**クラス/値レベルのアサーション**) を足すこと。属性レベルのアサーション (`data-dot` や testid の有無) では、描画される値が変わっても緑のままになる
- **連続日数は文統計だけで数えない。** `SentenceStat.lastPracticedAt` は**各文の直近 1 回**しか持たないので、同じ章を 5 日連続で練習すると 3 文すべての stamp が今日になり、日集合が 1 要素に潰れる (修正前は `days: 1, 0, 0, 0, 0` を実測)。`computeStreak` は**文統計の日と `sessions[].startedAt` の日の和集合**を使う (`computeStreak(stats, sessions, now)` — 第 2 引数は省略不可)。同じ文を繰り返すのが本命の用法では文統計側に日が残らないので、セッション行が「日ごとのログ」を担う。和集合は損失ゼロ — タブ強制終了で失われたセッション行は、その日の文統計でカバーされる
- **`totalAttempts` は文統計の `attempts` 合計のまま**。セッション行の `attempted` 合計にはしない (行はタブ強制終了で失われることがあるが、文統計は採点ごとに必ず書かれる)
- **復元セッションの `startedAt` は `saved.savedAt`**。`applyRestore()` は `startSession()` で「いま」にスタンプした後で `sessionStartedAt = saved.savedAt` に上書きする。计数器だけ復元して時計を復元しないと、20 分前のセッションが 4 秒と表示される (`durationMs` はこの stamp から計算される)
- **`passedSentences` は「このマウント内」の合格数**。`practice-progress.ts` は `passedIds` を永続化しないので、リロード復元したセッションではリロード前の合格が `attempted` には数えられながら `passedSentences` には含まれない (**受け入れる制約**。復元テスト `a resumed session keeps the original start time` が `passedSentences === 1` を明示的に pin している)
- **`endedEarly` は「summary に到達せず終わったか」** — 仕様（`docs/superpowers/specs/2026-10-01-practice-history-design.md:77`）の定義そのもの。`終了` ボタンは `endedEarly = true` を立て、`onDestroy` は `settleSession(true)` を呼ぶ (引数 `abandoned`)。**クライアントサイド遷移で離脱した行も `途中で終了` を出す** (summary 到達済みの破棄では `sessionStartedAt` が `null` なので書き込みは起きない — 誤検出しない)。E2E `abandoning a session with the browser Back button still records it` が `endedEarly === true` を pin している
- **章を消しても履歴は残る。** セッション record は開始時の `nodeName` を写し、`+page.svelte` の `sessionName()` は現在のノード名を優先し、消えていれば stored 名 + `(削除済み)` を出す。`(削除済み)` は名前の**兄弟要素** (行全体の `truncate` の中に埋めない) なので、`消した章 (削除済み)` を 1 つの `toContainText` で照合してはいけない
- **履歴はデバイスローカルのまま。** 管理画面の export は `{version: 3, chapters, tracks, sentences}` のみで履歴を含まない。ロードマップ⑥ のクラウド同期にも**含めない** (練習実績はマージ不能 — last-write-wins で消える)

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
14. 履歴を種するテストは `tests/helpers.ts` の `seedHistory` を使う (`gotoWithSeed` は `oboeru:v1` しか書かないので、`seedHistory` は**自分の reload を持つ** — `gotoWithSeed` の**後**に呼ぶ)。**種した履歴は書き込み経路の存在を証明しない** ので、`tests/history.spec.ts` の主経路は Space で実際にセッションを回している (localStorage 直書きだと「アプリが書いた」のか「テストが書いた」のか区別がつかず、書き込み経路を丸ごと消しても緑のままになる)。`holdAndRelease` も spec ごとにローカルコピーで、共通化していない。44px の tap target スイープは `tests/a11y.spec.ts` と `tests/responsive.spec.ts` の**別々 2 実装** (同じセレクタ/ログを重複写成) なので、片方から import できない

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
- 2026-09-27: ロードマップ ③ トラック階層統合を実装 (子チャプターを廃止し `Track.parentId` の木に統一。練習は `/practice?node=` で章/トラックどちらからでも開始、トップページと管理 › チャプターは同じ木を表示)。spec は `docs/superpowers/specs/2026-09-27-track-hierarchy-integration-design.md`、計画は `docs/superpowers/plans/2026-09-27-track-hierarchy-integration.md`。自動検証 (`npm run check` / `npm test` / `npx playwright test --workers=1`) は全緑、**実機ゲートは未実施** — 子チャプターを含む既存データの移行結果、3 段ネストの並び順、管理タブのインライン編集の実 IME をユーザー確認するまで「実機ゲート込み」で完了とみなさない。
- 2026-09-29: ④ の実機ゲートを **Android Chrome で 4/5 クリア**（ユーザー実機確認 — Ludo の発音が良い / `preservesPitch` が話速スライダーで効いている / 数字（`3階`→さんかい）が正しい / リロードを跨いで即再生される）。デプロイ `0f3305cd` は `POST /api/tts` → `200 audio/wav` (24kHz/mono/16bit)、ワーカーは `outcome=ok`・`console.error` ゼロ。**残りは iOS Safari の ②（話速 0.5・1.0・2.0 でピッチが崩れない）と ④（8 日以上使わずに音声が維持されるか、iOS ITP 7 日ルール）。⑤ の PWA（ホーム画面追加）は ITP 7 日ルールを明示的に免除する。初回生成は Worker 経由で約 3.3 秒、2 回目以降は IndexedDB 命中で即再生
- ロードマップ順 (2026-09-27 見直し) は ①フリーズ → ②UI強化 (済) → ③トラック階層統合 (済) → ④AI TTS (**済、2026-09-29**。Gemini `google/gemini-3.8-flash-lite-tts` を **OpenRouter 経由**で使用。R2 での事前生成配信は棄却し、音声はクライアント IndexedDB のキャッシュに保持) → ⑤PWA (Android) → ⑥クラウド同期。理由は付録 `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` 参照
- 2026-09-29: ロードマップ ④ Gemini TTS 移行を実装 (spec は `docs/superpowers/specs/2026-09-29-gemini-tts-migration-design.md`)。自動検証 (`npm run check` / `npm test`) は全緑、**実機ゲートは未実施** — ① Android Chrome と iOS Safari で読み上げが鳴る (`preservesPitch` が効いている) / ② 話速スライダー 0.5・1.0・2.0 でピッチが崩れない / ③ リロードを跨いで音声が即再生される (IndexedDB 経路) / ④ リロードを跨いで **8 日以上使わずに**も音声が維持されるか (iOS ITP 7 日ルール。⑤のホーム画面 PWA 追加で免除されるならその旨) / ⑤ `ttsRate` の 0.9 が実際に最適か (試聴は 1 文のみで確定していない。既定値は 1.0 のまま) をユーザー確認するまで「実機ゲート込み」で完了とみなさない
