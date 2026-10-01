# 練習履歴の記録とトップページへの表示 — 設計

- 日付: 2026-10-01
- 状態: レビュー 반영済み（サブエージェントレビュー 5 blocking を修正）
- 関連: `src/routes/+page.svelte` / `src/routes/practice/+page.svelte` / `src/lib/practice-progress.ts` / `src/lib/sentences.ts`
- ロードマップ: ⑤PWA の**前**に実施。`docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` の付録に追記する

## 背景

**練習結果（スコア・合格/不正・誤読）は現在、どこにも永続化されていない。**
`src/routes/practice/+page.svelte:61` のコメント自身が `memory only, not persisted` と明記している。
数値はコンポーネント内の `$state` にのみ存在し、`summary` フェーズで進捗レコードごと削除される
（`practice/+page.svelte:829-831`）。永続化されているのはセッション途中リロード復帰用のスナップショット
（`practice-progress.ts`、sessionStorage `oboeru:progress:v1`、30 分 TTL）で、`currentIndex` と集計カウンタ
3 個だけ。文ごとの合格記録は復元されない（`applyRestore()` は `passedIds` / `failedEntries` を空のままにする,
`practice/+page.svelte:787-797`）。

結果として「ここまでどれだけ勉強したか」が残らない。サーバー側の永続化も存在しない
（`wrangler.jsonc:1-10` の binding は `ASSETS` のみ。D1 / KV / R2 宣言なし。`src/routes/api/` は
`transcribe` / `tts` / `judge` の 3 つでいずれも保存しない）。

本 spec は「記録するデータモデル」を定義し、トップページに進捗・ストリーク・苦手文・過去セッションの
ログを表示する。PWA ⑤ の前にやる理由: 履歴は PWA のオフライン資産にならない（localStorage であり
Cache Storage ではない）ため、Service Worker のキャッシュ戦略を縛らない。

## 目的

- 進捗を途切れさせない（どこまでやったかが残る）
- ストリークで継続を維持できる
- 苦手文が**特定**できる（復習アクションは非目標）
- 過去セッションを遡って見れる

## 成功条件

1. 練習を 1 回終えると、トップページに章/トラックの進捗・最終練習日・苦手文数が反映される
2. リロードしてもその状態が残る（localStorage）
3. 認識閾値（設定の `threshold`）を下げると、合格数が即座に増える
4. ストリークが「今日練習していなくても連続日数が読める」（0 日も `連続 0 日` として出す）
5. 過去セッションのログが新しい順に見れる
6. `npm run check` 0 エラー / `npm test` / `npx playwright test --workers=1` 全緑
7. axe serious/critical 0、390px で破綻しない

## 決定事項

| # | 決定 | 理由 |
|---|---|---|
| 1 | 表示場所は**トップページ**。章/トラックの行に進捗、ページ上部にストリークピル、ページ最下部に折りたたみ履歴セクション | トップが練習の入口であり、「どこから続けるか」の判断がトップで完結する |
| 2 | **章行 = 集約**（進捗バー + 合格数 + 平均 + 最終練習日 + 苦手文数）。**トラック行 = ドット**（1 文 = 1 ドット） | 実測で 390px の 1 行には約 12 ドットしか入らない（展開トグルと練習ボタンが横幅を取る）。32 文で 3 行、100 文で 9 行に膨らむため、章ではドットをやめる。practice 順はトラックに委譲する |
| 3 | 保持は**セッション直近 500 件 + 文統計は削除しない** | 500 × 約 200B = 100KB、1000 文統計 × 約 80B = 80KB、合計約 180KB で localStorage 5MB に収まる。無期限保存は quota 超過で「黙って消える」危険がある |
| 4 | **合格状態は保存しない**。`lastScore` だけ保存し、合格/苦手/未着手は `lastScore` と現在の `threshold` から**導出**する | 閾値を下げると合格判定が緩まる、というユーザー意図に追従して進捗が動く。合格フラグを保存すると過去の進捗が黙って書き換わる |
| 5 | `nodeId` + `nodeName` の両方を保存する。表示は「現在の値 → 保存値 + ` (削除済み)`」の 2 段 | 章を削除しても「`(削除済み)`」だけより「`日本語基礎 (削除済み)`」の方が情報量がある。保存コスト 10KB |
| 6 | 履歴は**デバイスローカル**。ロードマップ ⑥ の同期対象に**含めない** | 練習実績はマージが不可能（last-write-wins で上書きされる）。メタデータ（章/トラック/文）と違い undo できない。**⑥ の引数** |
| 7 | **行**の平均スコアは `lastScore` の平均。**履歴ログ行**の平均は `totalScore / attempted`（既存 summary と同じ定義） | `bestScore` の平均では全部 100 に寄って「今の自分の状態」が読めない。2 つの平均は別の物 |
| 8 | 履歴セクションの**開閉状態は localStorage に記憶**する | 既存の `collapsed`（章の開閉、`+page.svelte:19`）は refresh でリセットする中途半端な実装。同じ轍を踏まない |
| 9 | **行の文数は「そのノードで練習したときのセッション長」と一致させる**。章もトラックも `getNodeSentences`（= サブツリー）基準。`canPractice` も同じ基準なので、`0文` の行に練習ボタンが出る矛盾が起きない（2026-10-01 レビューで発見。従来は章=サブツリー / トラック=直属で別 subset だった） | AGENTS.md が禁じる「`0文` なのに `練習` ボタン」の矛盾。直属文の無い中間トラック（`tests/top.spec.ts:191` が「祖先は全部開始可能」と固定）が realistic な入力で、空のトラックを押すとサブツリー分のセッションが始まるのに `0文` と出ていた |
| 10 | **復習アクションは付けない**（session 内 summary の既存 `retry-failed-btn` はそのまま） | 用途は苦手文の特定まで。「間違えた文だけやり直す」は既に summary に存在する |
| 11 | **`SentenceStat` は `lastScore` と `lastPracticedAt` だけ**持つ。`passes` / `bestScore` は持たない | 決定事項 4 で合格は導出するので両方とも死んだフィールドになる。書かれるが読まれないコードは作らない |
| 12 | 履歴セクション見出しの件数は**記録済みセッション件数**。累積の単位は「のべ N 文」 | `sessions.length` と混同しない。文の累計は `attempts`（試行回数）合計なので「文」ではなく「のべ」 |

## データモデル

`src/lib/history.ts` を**新設**する。`types.ts` には置かない — 設定/コンテンツとは別の concern であり、
`practice-progress.ts` と同じ「自己完結した永続化モジュール」という既存の型付けがあるため。

```ts
export interface SessionRecord {
  id: string;              // generateId()（sentences.ts:10-12 を export して再利用）
  nodeId: string;          // セッション開始ノードの id（章 or トラック）
  nodeName: string;        // 開始時点の表示名。ノード削除後も履歴行で名前を出せる
  startedAt: number;       // epoch ms
  endedAt: number;         // epoch ms
  durationMs: number;
  attempted: number;       // 採点試行回数（再挑戦も加算。既存 completedCount と同じ定義）
  passedSentences: number; // distinct 合格文数。**このマウント内**の passedIds.length（復元セッションは §既知の制限 を参照）
  totalScore: number;      // 採点された finalScore の合計
  skipped: number;         // 既存 skippedCount
  endedEarly: boolean;     // summary に到達せず終了したか（既存 endedEarly を流用）
}

export interface SentenceStat {
  attempts: number;        // 採点された回数（のべ 횟수 の表示に使う）
  lastScore: number;       // 直近の finalScore。合格/苦手/未着手はここから導出する
  lastPracticedAt: number; // epoch ms
}

export interface HistoryData {
  version: 1;
  sessions: SessionRecord[];               // 新しい順
  sentences: Record<string, SentenceStat>; // key = sentenceId
}
```

`id` は `src/lib/sentences.ts:10-12` の `generateId()` を **export して再利用**する（車輪の再発明をしない）。

### 合格状態は導出（3 状態だけ）

`HistoryData.sentences` は `Record<string, SentenceStat>`。文 id で引くと 3 状態のいずれかになる:

| 状態 | 条件 | ドット色 |
|---|---|---|
| `untouched` | `sentences[id]` が無い | `bg-border` |
| `passed` | `lastScore >= threshold` | `bg-success` |
| `hard` | `lastScore < threshold` | amber |

`threshold` は現在値なので、閾値の変更が過去の進捗に正しく反映される。
孤立した文統計（削除済みの文）は現在の文一覧と交差合わせるだけなので無視され、掃除は不要。

## 保存層 (`src/lib/history.ts`)

`practice-progress.ts` と同じ契約 — **保存できなくても練習は壊れない**。全操作が `try/catch` で
自前のエラーを握り潰す。

| 関数 | 役割 |
|---|---|
| `loadHistory(): HistoryData` | 読み込み。JSON 破損 / 非オブジェクト / `version` 不一致は**既定値で縮退**（`{version:1, sessions:[], sentences:{}}`）。セッション列を 500 件に切断、counter は非負整数にクランプ |
| `recordSentenceAttempt(sentenceId, score, at): void` | 文統計を 1 件 upsert。`attempts++`、`lastScore = score`、`lastPracticedAt = at` |
| `finalizeSession(record): void` | `sessions` の先頭に `unshift`、500 件超で `slice(0, 500)` |
| `loadHistoryUiState(): HistoryUiState` | 履歴セクションの開閉状態（別キー `oboeru:history-ui:v1`） |
| `saveHistoryUiState(state): void` | 開閉状態を書き込む |

純粋関数も同じモジュールに置く（`computeNodeStats` / `computeStreak` / `formatRelativeDay`）。

**モジュール内に in-memory キャッシュを 1 つ持つ。** `recordSentenceAttempt` は採点ごと（= 1 文ごと）に
呼ばれるので、毎回 localStorage を parse + stringify すると 1 セッションで 20 文 × 約 200KB の
read/write が走る。キャッシュはモジュール読み込み時に 1 度だけ `loadHistory()` し、write 時は
キャッシュを mutate してから 1 回だけ stringify する。

`clearHistory()` は**設けない**。UI が無い export は一度も呼ばれない死んだコードになる（YAGNI）。
消去 UI を入れるときに「履歴を消去」として追加する。

## 集計 (`computeNodeStats`)

`src/lib/history.ts` の純関数。トップページが 1 回だけ呼び、全行が参照する。

```ts
export type DotState = 'passed' | 'hard' | 'untouched';

export interface NodeStats {
  total: number;               // この行が表示する文数（下記「表示集合」）
  passed: number;              // passed の文数
  practiced: number;           // 1 回でも採点された文数（= untouched でない文数）
  hard: number;                // hard の文数
  avgLastScore: number | null; // 採点された文の lastScore 平均。0 件なら null
  lastPracticedAt: number | null; // 表示集合内の lastPracticedAt の最大値
  dots: DotState[];            // 章は空配列、トラックは渡された順序（= practice 順）のまま
}

export function computeNodeStats(
  sentences: Sentence[],                 // この行が表示する文（= 表示集合）
  isChapter: boolean,
  stats: Readonly<Record<string, SentenceStat>>,
  threshold: number
): NodeStats
```

### 表示集合 — 1 系統、サブツリー一本

集計する対象は**その行が文数を表示しているのと同じ集合**にする。それは `getNodeSentences(nodeId, …)`
が返すもの、つまり**そのノードで練習したときに実際に回ってくる文**:

| 行 | 表示集合 | `練習` ボタンの基準 |
|---|---|---|
| 章 | `getNodeSentences(chapterId, …)` = サブツリー全体 | `canPractice` = 同じ集合が非空 |
| トラック | `getNodeSentences(trackId, …)` = サブツリー全体（**直属ではない**） | `canPractice` = 同じ集合が非空 |

**これが重要**: `getNodeSentences` はトラックに対してもサブツリーを返す
（`sentences.ts:589-596` — `getNodeDescendantTrackIds` のスコープで絞っている）。かつ
`/practice?node=` も `getNodeSentences` を回ogenes ので、**行の `M` は実際のセッション長と一致する**。

旧的設計（章=サブツリー / トラック=直属）では、直属文の無い中間トラックが `0文` の横で練習ボタンを
出していた（押すとサブツリー分のセッションが始まる）。AGENTS.md が禁じる「`0文` なのに `練習` ボタン」
の矛盾そのものなので廃止した。`ownCount()` / `chapterTotal()` は削除し、`NodeStats.total` に一本化する。

`total` / `passed` / `hard` / `avgLastScore` / `lastPracticedAt` / `dots` は**全て同じ集合**で統一する。
集約は 1 系統のみ（`displaySentencesByNode` のような中間 map は不要 — `nodeSentences()` が既に
その役割を持つ）。

`dots` は `isChapter` なら `[]`、トラックなら**渡された配列の順序そのまま**（= practice 順 = pre-order）で
`DotState[]` にする。**`sentence.order` でソートし直さない** — `getNodeSentences` が pre-order を返すのに、
グローバルな `order` ソートは別トラックの文を割り込ませる（親トラックの行が `passed, hard, passed` になる）。
表示順序の所有者は呼び出し側。
`total === 0` のときは `dots` も `[]`（空行を作らない）。

### 1 系統の規約

`src/routes/+page.svelte` の既存の `sentencesByNode`（`:48-57`）をそのまま使い、`statsByNode` を
`$derived.by` で 1 度だけ作る。**合格数・総数・平均・苦手数・最終練習日・ドット列の全て**をここから
供給する。`nodeStats(id)` は `statsByNode.get(id)` を引くだけ。`displaySentencesByNode` のような
中間 map は作らない — `nodeSentences()` が既にその役割を持つ。

`ownCount()` / `chapterTotal()` は**削除**する（呼び出し元が無く、同じ数値は `NodeStats.total` から取れる）。

`canPractice()` は**書き換えない**。`nodeSentences(nodeId).length > 0` は行の `M > 0` と完全に一致するので
2 系統にならない。

## トップページ UI

### ページ上部 — ストリークピル

既存の `<h1>おぼえる</h1>` と説明 `<p>` の直後。

```
┌──────────────────────────────────┐
│ 連続 5 日 · のべ 128 文            │
└──────────────────────────────────┘
```

- 連続日数 = **文統計の `lastPracticedAt` の日 ∪ セッション行の `startedAt` の日**をローカル日の集合にし、**今日を含む**降順連続の長さ。
  **和集合 MUST**（2026-10-01 の全体レビューで修正）。文統計だけの集合だと、同じ 3 文を 5 日連続で練習した場合に
  各文の直近 stamp が全部今日になって集合が 1 要素に潰れ、ヘッドラインが `連続 1 日` のままになる
  （修正前を実測: `days: 1, 0, 0, 0, 0`）。同じ章の繰り返しは暗記アプリの本命の用法。セッション行は append-only で
  各行が自分の `startedAt` を持つので日ごとのログになる。和集合は損失ゼロ — タブ強制終了で失われた行は
  その日の文統計でカバーされる。シグネチャ: `computeStreak(stats, sessions, now)`（第 2 引数は省略不可）
- **0 日でも描画する**（`連続 0 日`）。5 日連続で練習していた人が 6 日目に開いてピルが消えるのは通常の
  ストリーク UX と逆で、「継続を保つ」目的を壊す。0 日 = 昨日まで練習して今日はまだ、という情報が残る
- のべ文数 = **全文統計の `attempts` 合計**。`sessions` の合計ではない（セッション record はタブ強制終了で
  失われることがあるが、文統計は採点ごとに必ず書かれるのでドリフトしない）。単位は「のべ」（再挑戦を含む）
- `attempts` 合計が 0（何も練習していない）のときだけ**ピル非表示**

### 章行

```
┌────────────────────────────────────────┐
│ ⌄  日本語基礎          [ja]      [練習] │
│    24/32 合格 · 87%                     │
│    ████████████░░░░░░░░                │
│    最終 昨日 · 苦手 2 文                │
└────────────────────────────────────────┘
```

`24/32 合格 · 87%` の行は既存の `chapter-card-count`（`32文`）を**置き換える**。言語バッジは従来どおり
同じ行に置く。その下に進捗バー、さらに下に `最終 … · 苦手 …` の 1 行。
`chapterLanguages` / `canPractice` などの既存ロジックは変えない。

`total === 0` のとき（`canPractice` が false で練習ボタンなし）は `32文` という**従来文言のまま**表示する。
`0/0 合格` は情報がない。

### トラック行

```
┌──────────────────────────────────────┐
│    ひらがな                    [練習] │
│    12/12 合格 · 94%                   │
│    最終 昨日                           │
│    ■■■■■■■■■■■■                       │
└──────────────────────────────────────┘
```

`track-card-count`（`12文`）を `12/12 合格 · 94%` に置き換える（`total === 0` は従来文言のまま）。
ドットは表示集合 = **サブツリー**（practice 順 = pre-order）。直属文の無い中間トラックは
`0/1 合格 · 0%` + ドット 1 個になり、押いた時のセッション長と一致する。

ドットは `flex flex-wrap gap-[3px]`。1 行に約 12 個入り（実測。展開トグルと練習ボタンが横幅を取る）、サブツリーが 12 文を超えても折り返すだけで
破綻しない（子トラックを持つ親トラックはドット Preliminary になるが、それは章と同じトレードオフ）。
色: `passed` = `bg-success` / `hard` = amber / `untouched` = `bg-border`。
  **3 色とも条件付きクラスにして、静的な base クラスを並べてはいけない**（2026-10-01 の全体レビューで実測）。
  Tailwind の色 utility は全部 `utilities` レイヤーの同一詳細度なので、勝者は生成 CSS のソース順であって
  テンプレート上の属性順ではない。`class="… bg-border"` + `class:bg-amber-500` の形では実測で `bg-border` が勝ち、
  **苦手と未着手がピクセル同一の灰色**になっていた（`data-dot` を読む既存テストは全部緑のままだった）。
  検証は `getComputedStyle(el).backgroundColor` でクラス/値レベルで行うこと。

**ドットは常に描く**（未着手ノードは全部灰）。variant D を選んだ価値が「灰 = どこが未着手か」
なので、`{#if practiced > 0}` でゲートすると (a) fresh install で「未着手」の情報が一切出ず、
(b) 1 文だけ練習した瞬間に 20 個のドットが突然出現する。どちらも不自然な挙動。
「最終 … · 苦手 …」の行だけは `practiced > 0` でゲートする（空データ表示を避けるため）。

### ページ最下部 — 折りたたみ履歴セクション

```
▸ 練習履歴 (36)
  ├ 展開時:
  │  10/01 07:12 · 日本語基礎                  ← ノード名は 1 行目で truncate
  │  24 文 合格 · 平均 87% · スキップ 1        ← 成绩は 2 行目（省略しない）
  │  09/30 21:40 · 漢字
  │  12 文 合格 · 平均 94%
  │  09/28 08:02 · 消えた章  (削除済み)        ← (削除済み) は truncate の外側
  │  4 文 合格 · 平均 81% · 途中で終了
  │  …
  │  [さらに表示 (残り 16 件)]
```

**1 行目と 2 行目に分ける理由**: ノード名はユーザーが命名するので長さの制御が効かない（英語名の長い
章で 390px の横スクロールが実測で起きた）。1 行目全体を `truncate` すると
「(削除済み)」という唯一の消滅シグナルが一緒に消えるので、**名前は `truncate`、`(削除済み)` は
`shrink-0` の兄弟要素として clip の外**に置く。成绩（合格文数・平均・スキップ・途中で終了）は
情報なので truncate せず 2 行目に折り返す。

- 見出しは実 `<button>`（`aria-expanded` / `aria-controls` 付き）。**高さは 44px 以上**にする
  （`tests/a11y.spec.ts:105-112` の `expectTapTargets` が可視 `button` に 44px を要求する）
- 既定は折りたたみ。開閉状態は `oboeru:history-ui:v1` に記憶（既存 `collapsed` は記憶しないので別キー）
- 初期表示は最新 20 件。`さらに表示`（実 `<button>`、44px 以上）で全件（最大 500 件）表示する
- セッションが 1 件も無ければセクションごと描画しない
- ノード名は「現在の章/トラック一覧から `nodeId` で解決 → 無ければ `nodeName` + ` (削除済み)`」
- 平均 = `round(totalScore / attempted)`（**セッション単位**。行の `avgLastScore` とは別の物）。
  `attempted === 0` の行は作らない。`endedEarly` の行には「途中で終了」を添える
- 見出しの件数 = `sessions.length`

## 書き込みポイント

`src/routes/practice/+page.svelte` のみから書く。読み取りはトップページのみ。

### 文統計 — 採点が確定した瞬間（1 文ごとに 1 回）

`doTranscribe` の採点確定ブロック（**`practice/+page.svelte:747-755`**）の直後、`phase = 'feedback'` の前。

```
score = finalScore;
totalScore += finalScore;
completedCount++;
if (finalScore >= threshold) { … passedIds / failedEntries … } else { … }
   ↓ ここに追加
recordSentenceAttempt(s.id, finalScore, Date.now());
```

`totalScore +=` は `:748` のみ、`completedCount++` は `:749` のみに存在し、`retrySentence()`（`:256`）も
`retryFromError()`（`:282`）も `doTranscribe` を通るので、**確定は経路 1 本**。Jev が fallback した
（`finalScore === sim`）場合もここを通る。

### セッションレコード — アンマウント時 + 再挑戦開始時

`onMount`（`practice/+page.svelte:854-907`）は cleanup を返しておらず、`onDestroy` も無いので **新設**する（`:696-700` の `$effect` cleanup は `releaseWarmMic` だけ）。

`sessionStartedAt` は **1 つのヘルパーでスタンプする**:

```ts
function beginSession(): void {
  sessionStartedAt = Date.now();
}
```

- `startSession()`（`:782-785`）で `beginSession()` を呼ぶ（復元時も新课もここを通る）
- **`retryFailedOnly()`（`:321-333`）でも `beginSession()` を呼ぶ**。ここが第 1 の罠: `retryFailedOnly` は
  `startSession()` を**呼ばない**（`sessionReady` を触らず `phase = 'show'` を代入するだけ）。
  ここを直さないと再挑戦セッションの `startedAt` / `durationMs` が 1 つ前のセッションの開始時刻の
  まま書かれ、ガード（`sessionStartedAt !== null`）を通して**静かに不正データを書く**
- **確定は `summary` 到達時と `onDestroy` の両方**。`onDestroy` だけだと、summary に到達してから
  リロードやタブを閉じた場合そのセッションが**永久に失われる**（summary で既に
  `clearPracticeProgress()` を呼ぶので、次のマウントは `completedCount === 0` で early return する）。
  ロードマップ⑤ は PWA (Android)、⑥ はクラウド同期で、タブを背景に入れるのが既定の挙動
- 二重計上は起きない。`settleSession()` は末尾で `sessionStartedAt = null` にするので 2 回目の呼び出しは
  no-op。`retryFailedOnly()` は settle → リセット → `beginSession()` の順
- `retryFailedOnly()` は先頭で現行セッションを確定してから `:326-331` のリセットを実行し、続けて
  `beginSession()` で再スタンプする
- `attempted === 0` のセッションは記録しない（開いてすぐ閉じただけの閲覧を履歴に載せない）
- 記録対象は `sessionNodeId` が解決済みで `sessionStartedAt !== null` のときだけ

**既知の残余**:
- OS にタブを強制終了させた場合（`onDestroy` も `summary` も走らない）、**そのセッション行だけ消える**
  （文統計は採点ごとに書かれているので失われない）。1 文も採点していないなら残るべきものが無いので実害は無い
- **リロード復元したセッションの行は `passedSentences` を控えめに書く**（2026-10-01 の全体レビューで記録）。
  `practice-progress.ts` は `passedIds` を永続化しないので復元時の `passedIds` は空で、
  `attempted` / `totalScore` はリロード前後の両方を含むのに `passedSentences` は復元後の合格だけを数える。
  `startedAt` は `applyRestore` が `saved.savedAt` に上書きするので `durationMs` は正しく、矛盾は合格文数だけ。
  `passedIds` の永続化はスコープ外（実害は見た目だけ）。E2E `a resumed session keeps the original start time` が
  `passedSentences === 1` を pin している
- **`endedEarly` は「終了」ボタンで停止した時だけ立つ**。ブラウザ「戻る」などのクライアントサイド遷移で離脱した
  セッションの行は `途中で終了` を出さない（最後まで終えた行と区別できない）

## エラー処理

| ケース | 挙動 |
|---|---|
| localStorage が書けない（プライベートモード / quota 超過） | 全 write API が `try/catch` で黙って no-op。練習は正常に続行。トップページは 0 のまま表示され、エラーは出さない |
| 破損 JSON / 非オブジェクト / `version` 不一致 | `loadHistory()` が既定値へ縮退してから読み進める。既存データを破壊しない |
| counter が NaN / 負数 / 小数 | 非負整数にクランプ（`practice-progress.ts:27-31` と同じ） |
| 文が削除された | 統計は孤児になるが、集約は現在の文一覧と交差合わせるだけなので無視される |
| 章/トラックが削除された | 履歴行は `nodeName (削除済み)`。集計は他ノードに影響しない |
| クロスタブ同期 | `storage` イベントで他タブの変更を拾わない。非目標（1 タブ運用） |

## テスト計画

### 既存テストの更新（**必ず必要** — 挙動変更なので正当な更新として行う）

`32文` / `10文` / `2文` / `1文` の文言を `N/M 合格 · X%` に**置き換える**ため、以下の 5 アサーションは
必ず落ちる。正当な新フォーマットへの更新が必要（テストの削除・skip 化・弱化はしない）:

| ファイル:行 | 現行 assert | 更新後 |
|---|---|---|
| `tests/top.spec.ts:52` | `getByText('10文')` | 既定データが未着手なので `0/10 合格 · 0%`（`total > 0` なので新フォーマット） |
| `tests/top.spec.ts:158` | `chapter-card-count` に `toHaveText('2文')` | `toContainText('0/2 合格')` |
| `tests/top.spec.ts:159` | `track-card-count` に `toHaveText('1文')` | `toContainText('0/1 合格')` |
| `tests/top.spec.ts:160` | 同上（別トラック） | `toContainText('0/1 合格')` |
| `tests/e2e-full.spec.ts:215` | `toContainText('1文')` | `toContainText('0/1 合格')` |

`chapter-card-count` / `track-card-count` の **testid は残す**（別 testid を新設して既存文字列を
二重に出さない）。`toHaveText` ではなく `toContainText` にするのは、言語バッジ等同要素が
同じコンテナに入るため。

`tests/practice.spec.ts` / `responsive.spec.ts` / `shell.spec.ts` / `smoke.spec.ts` /
`manage.spec.ts` は本次変更で壊れない（practice は DOM 変更なし。他はトップの文数文字列を
assert していない）。

### ユニット (`src/lib/history.test.ts`、vitest)

- `loadHistory` — ラウンドトリップ / 未記録時の既定 / 破損 JSON / 非オブジェクト / `version` 不一致
- `loadHistory` — `sessions` が 500 件超なら 500 件に切断し**新しい順**を保つ
- `loadHistory` — counter の NaN / 負数 / 小数を非負整数にクランプ
- `recordSentenceAttempt` — 初回転 / `attempts` 増加 / `lastScore` 上書き / `lastPracticedAt` 更新
- `finalizeSession` — 先頭に挿入される / 501 件目で最古が落ちる
- 全 write API — localStorage が例外を投げても**例外が伝播しない**
- **キャッシュ** — 2 回続けて `recordSentenceAttempt` を呼んでも之前的な文統計が消えない
  （in-memory キャッシュが read-modify-write で壊していないことの検証）
- `computeNodeStats` — `total` が渡した文配列長と一致 / `threshold` を下げると `passed` が増え
  `hard` が減る / `stats[id]` が無い文は `untouched` / `practiced === 0` で `avgLastScore` が `null` /
  孤立した統計が無視される / 表示集合内の `lastPracticedAt` の最大値を返す
- `computeNodeStats` — `isChapter: true` で `dots` が `[]`、`isChapter: false` で `order` 昇順の
  `DotState[]` / `total === 0` で `dots` が `[]`

### E2E (Playwright)

- 練習を 1 回完走 → リロード → トップページに `0/2 合格` 形式と進捗バーが出る
- **シードした履歴で**閾値を下げてリロード → 合格数が練習せずに増える
- トラック行のドット列が練習順（`order` 昇順）に並ぶ
- `total === 0` の章/トラックは `0文` の従来文言のまま
- 履歴セクションの開閉状態がリロード跨ぎで維持される
- 履歴セクションが最新 20 件を表示し、`さらに表示` で増える
- セッションが 1 件も記録されていない場合、履歴セクションごと非表示
- 章/トラックを削除した後 → そのノードの履歴行が `nodeName (削除済み)` になり、他のノードの集計に影響しない
- **新規 a11y テスト**: `oboeru:history:v1` と `oboeru:history-ui:v1` をシードした状態で
  トップページを light/dark スキャン + `expectTapTargets`
  （`tests/a11y.spec.ts:281-295` の既存トップスキャンは `gotoWithSeed(page, SEED)` でしかシードせず、
  **履歴を一切持たないため新 UI が一度も axe に掛からない**。この新規テストが必要）
- 履歴キーのシード/消去ヘルパー: `tests/helpers.ts:7-18` の `gotoWithSeed` は `oboeru:v1` しか
  書かない。`seedHistory(page, data)` のような補助を追加する
- `progress` / `summary-*` の testid は触らない

## 注意点 / 既存コードとの相互作用

- **`practice/+page.svelte:61` の `memory only, not persisted` コメントは実装時に削除**する（嘘になる）
- `averageScore`（`practice/+page.svelte:159-161`）は session 内 `totalScore / completedCount`。
  `SessionRecord` は**同じ定義**を保存するので、summary と履歴ログの数値が食い違わない
- `passedIds` は session 内で distinct な合格 id。`SessionRecord.passedSentences` はその長さ。
  文統計には合格状態を持たない（導出する）ので、`passes` のような混同点自体が無い
- `retryFrom` 設定で「もう一度試す」から再採点した場合も `doTranscribe` を通るので
  文統計の `attempts` は試行回数だけ積まれる（正しい）
- `sentences.ts:589-596` の `getNodeSentences` はトラックにもサブツリーを返す。**これが正** —
  `/practice?node=` も `getNodeSentences` を回るので、行の `M` は実際のセッション長と一致する。
 従来の `ownCount()` が直属で絞っていたのは別 subset の誤りだった（決定事項 9）。
  行の `total` にもドットにも `getNodeSentences` の結果をそのまま使う
- AGENTS.md のレイアウト規約（`h-dvh` / `action-zone`）は `/practice` 側の話。トップページは通常の
  document スクロールなので影響を受けない
- AGENTS.md のディレクトリ地図に `src/lib/history.ts` を追記する

## ロードマップへの影響

- ⑤PWA: 履歴は localStorage であり Cache Storage ではない。Service Worker のキャッシュ対象に含まれない。
  PWA 化しても履歴の永続性は失われない
- ⑥クラウド同期: **履歴は同期対象に含めない**（決定事項 6）。メタデータ（章/トラック/文）だけを同期し、
  履歴はデバイスローカルに残す

## 非目標

- 苦手文からの**復習セッションの開始**（特定のみ。summary の既存 retry はそのまま）
- スコア推移グラフ・折れ線
- 履歴のエクスポート/インポートへの取り込み（`validateImportJson` の version bump はしない）
- 履歴を他タブと同期する（`storage` イベント）
- 履歴の消去 UI（`clearHistory()` も設けない。付けるなら同时に UI を入れる）
- 練習内容の録音音声の履歴
- 管理画面の履歴タブ（表示場所はトップページに統一）
