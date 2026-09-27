# トラック階層統合 — 設計 (Track Hierarchy Integration)

- 日付: 2026-09-27
- 状態: ブレスト済み (構造・練習単位・データモデル・移行・各画面・並び順を順に決定)
- ロードマップ: `2026-09-22-tts-freeze-fix.md:107` の付録 ③ (順序変更後の ③)
- 関連: `2026-09-21-tracks-data-model.md` (3層データモデルの導入。本 spec が「子チャプター」を廃止し「トラックの階層」に置き換える)
- スコープ外: AI TTS + クラウド音声配信 / PWA (Android) / クラウド同期 — いずれも別サブプロジェクト

## 背景と目的

現状「章の中のまとまり」が 2 種類ある。

- `Chapter { parentId }` — 子**チャプター** (階層可能・無限再帰)
- `Track { chapterId }` — 章直下のフラット1段

どちらも「章の中の文のまとまり」であり、章の階層とトラックの階層が同じ役割を二重に持つ。加えて
`getChapterSentences` は章直下の文しか集めないため、**子チャプターの文は練習対象にすらならない**
(トップページの親カードバッジだけが子孫文数を集計している状態)。

本 spec はこれを 1 種類の入れ物「トラック」に統合し、ネストしたトラックのどこからでも練習を
開始できるようにする。副次的に ④AI TTS が前提とする「音声生成の粒度 (文単位か、トラック単位か、
トラックごとにボイスを変えるか)」を確定させる。

## 決定事項

| # | 決定 |
|---|---|
| 1 | **章はルート専用**。階層はトラックが持つ。章の `parentId` は型に残るが常に `null` |
| 2 | **どのノード (章 / トラック) でも練習を開始できる**。URL は `/practice?node=<id>` |
| 3 | ヘッダは**開始ノードのパンくずを固定表示**。進捗行のトラック名は**章開始時のみ**表示 |
| 4 | `Sentence` は `chapterId` + `trackId` を**保持したまま** (冗長だが既存クエリを流用) |
| 5 | ストレージキーは `oboeru:v1` のまま。子チャプターは**読み込みシムで子トラックへ自動変換**。エクスポート/インポートは `version: 3` (v2 も自動変換して受理) |
| 6 | **並び順は pre-order**。トラックの自文と子トラックを**両方同時に**持てる |
| 7 | トップページ = 章とトラックを**1本の木に同居**。管理 chapters タブ = 同じく 1本の木 + インライン本文編集 |

## データモデル

```ts
// types.ts
export interface Chapter {
  id: string;
  name: string;
  parentId: string | null;  // 廃止予定。UI から設定できず、常に null
  order: number;
}

export interface Track {
  id: string;
  chapterId: string;        // 最上位章。所属章を間接的に指定する冗長フィールド
  name: string;
  order: number;            // 同一親 (章 or 親トラック) 内での順序
  parentId: string | null;  // NEW。親トラック。null なら章直下
}

export interface Sentence {
  id: string;
  chapterId: string;        // 最上位章 (track.chapterId と同じ冗長値)
  trackId: string;          // NEW ではない。直接の親トラック
  text: string;
  language: 'ja' | 'en';
  order: number;            // トラック内の順序
}
```

- ストレージ: 既存キー `oboeru:v1`、JSON は `{chapters, tracks, sentences}` のまま
- 章の階層は無制限だったものを**1段 (ルートのみ) に制限**。`flattenChapterTree` は pre-order の
  まま残す (1段なので order 昇順に等しい)。`collectChapterIds` も退化するが、
  下流で別用途に使うため残す
- `getChapterTracks(chapterId, tracks)` は **`flattenTrackTree` の薄いラッパー**に置き換える
  (「章の全トラック」= 章直下 + 子孫を pre-order で返す。フラットデータでは従来と同一結果)

### 禁止事項

- 章の行に「子チャプター追加」「折り畳み」を出さない (ルート専用のため存在しない)
- `Track.parentId` に自分自身や子孫トラックを指定しない (UI も型も提供しない)

## 移行 (読み込みシム)

既存ローカルデータに子チャプターが含まれている可能性があるため、読み込み時に変換する。

```
移行前:  [1章]
          ├ [トラック1: 10文]
          └ [子章A: 5文]
                └ [子章A の子章B: 2文]

移行後:  [1章]
          ├ [トラック1: 10文]        parentId: null
          ├ [子章A → トラック: 5文]  parentId: null
          └ [子章B → トラック: 2文]  parentId: null
```

規則:

1. `parentId !== null` の章を**再帰的に**検出する
2. その章を**最も近い祖先章の直下にあるトラック**へ変換する
   - id: `tr-from-ch-<元章id>` (衝突しない接頭辞)
   - name: 元章の `name` をそのまま使う
   - order: 変換済みの同一親トラックの末尾 + 1
   - parentId: `null` (章直下) / 祖先章の id が `chapterId`
3. **その子章を `chapterId` に持っていた既存トラックは、祖先章へ移植する**（`chapterId` を
   祖先章 id に差替え、同一親トラックの末尾に並べる）。細分组と文の並びを保つ
   - **`parentId` は保持する**（兄弟化しない）。v2 データはトラックに階層が無かったため
     `parentId` は常に欠落 → 結果として祖先章の直下に来る。万一階層を持つデータが混ざって
     いても深さを潰さない方が情報を失わない
4. **祖先の章が解決できない章**（`parentId` が存在しない章を指す / 章同士が cycle）は、
   **削除せず `parentId: null` のルート章として残す**。変換もトラック化もしない
   （消すと生成トラックの `chapterId` がストアに存在しない章を指し、到達不能 = 文が UI に出ない）
5. 変換対象章の配下にある `Sentence` のうち、**移植後も有効な `trackId` を持つものは `chapterId` を
   祖先章 id に差替えるだけ**。新トラック `tr-from-ch-<章id>` へ移すのは
   トラックを持たないもの（壊れた参照 / 旧チャプター形式）だけ
6. 元の `tracks` に `parentId` が無い場合は `null` を補う
7. 変換は**冪等**。`tr-from-ch-` 始まりのトラックが既に存在して id が衝突する場合は
   `<元章id>-<n>` と連番を付けて再採番する
8. 適用後に `saveData` で書き戻す (lazy migration)。既存の `tracks` 欠落シム
   (`defaultTrackFor`, `sentences.ts:61`) と同じ方針

### インポート/エクスポート

- エクスポート: `{version: 3, exportedAt, chapters, tracks, sentences}`
- インポート受理: **v3** (そのまま) / **v2** (上記 1〜5 の変換を適用してから upsert) / v1 は
  従来どおり「対応していないバージョンです」で拒否
- v2 変換は**ディスク JS 内で行わない**。`validateImportJson` は「version が 2 または 3」で
  必須フィールド検証のみ行い、変換は upsert 前に別の純関数 `migrateToV3(data)` を通す
- 成功メッセージは v3 と同じ形式 (「N件のチャプター、N件のトラック、N件の文章をインポートしました」)

## 純関数 (`sentences.ts` に追加/変更)

| 関数 | 役割 |
|---|---|
| `flattenTrackTree(chapterId, tracks): Track[]` | 章直下 + 子孫トラックを pre-order で平坦化 |
| `getNodeDescendantTrackIds(nodeId, tracks): Set<string>` | ノード自身 + 子孫トラックの id 集合 |
| `getNodeSentences(nodeId, chapters, tracks, sentences): Sentence[]` | 章なら配下全トラックの葉、トラックなら自文 + 子孫トラックの葉を pre-order で集める |
| `getNodeTrail(nodeId, chapters, tracks): Node[]` | パンくず用 `[{type, id, name}]` (章から nid まで) |
| `migrateToV3(data): StorageData` | 子チャプター → 子トラック変換 (§移行) |

`StorageData` は `{ chapters: Chapter[]; tracks: Track[]; sentences: Sentence[] }` を指す
(`sentences.ts` の `loadData` が持つローカル型を public 化して使う)。追加する純関数は
**すべて引数から受け取る純関数**で、ストレージを読み書きしない。呼び出し側が読み込んだ
snapshot を渡す (既存 `getChapterSentences` は内部で `loadTracks()` するが、それは storage
モックでテストはできる（ただしストレージ副作用がある）)。新関数は storage 非依存にして
「階層ロジックを localStorage 無しで単体テストできる」状態を保つ。

- 並び順: pre-order でトラックの**グループごと**に並べ、group 内は `sentence.order` 昇順。
  既存 `getChapterSentences` の二段ソートと同じ形で、トラックの位置を
  `flattenTrackTree` の index に置き換えたもの
- `getChapterSentences` は**削除しない**。`getNodeSentences(chapterId, …)` へ委譲する薄い
  ラッパーにして既存テストと呼び出し元 (practice) の差分を最小にする
- 未知の `trackId` は既存と同じく**破棄せず末尾** (`UNKNOWN_TRACK_ORDER` 相当)

### 参照整合

- `updateSentence` の trackId 越境修復は**流用**。新 chapter に属さないトラックを指したら
  その章の先頭トラックへ再割当 (checks 済み: `sentences.ts:269-297`)
- **サイクル防止**: トラックの親を変更する API は提供しない。`Track.parentId` を更新する
  経路を設けないことで、UI 側のチェックを 不要にする。移動は「トラックを追加する時点で親が決まる」
  方式のみ (既存データに `parentId` を作るのは移行シムだけが担当)
- `updateTrack` の既存引数 `Partial<Omit<Track, 'id'>>` から `parentId` を**除外した型**
  (`Omit<Track, 'id' | 'parentId'>`) にして、不正な経路を型で封じる

## 削除カスケード

| 操作 | 対象 |
|---|---|
| 文の削除 | その文のみ (現状どおり) |
| トラックの削除 | **子孫トラック** + 自トラックの文 + 子孫トラックの文 |
| 章の削除 | 配下の全トラック + 全文 (現状どおり) |

- AlertDialog の確認文言に「子孫トラック」を含める (章の文言は現状で既に「すべての子孫チャプター・含まれる文章を削除しますか？」)
- 削除の確認プレビューに**削除されるトラック数と文数**を出す

## 練習画面

### 入口

- URL: `/practice?node=<id>`
- 解決順: `chapters` に同じ id があれば章、無ければ `tracks` にあればトラック。両方無ければ
  現状と同様の「章が見つかりません」summary エラー
- ヘッダ (`data-testid="practice-header"` 内の `chapter-name`) は**開始ノードのパンくず固定表示**:
  - 章から開始 → `1章`
  - トラックから開始 → `1章 › トラック1`
- パンくずの各要素は**クリック不可** (navigate するとセッションが飛ぶ。静的テキスト)

### 収集と並び順

- セッションの文は `getNodeSentences(nodeId, …)` で集める
- 復元は `loadPracticeProgress(nodeId)` (キーは `oboeru:progress:v1` のまま。既存データは
  章開始のセッションなのでそのまま使える)

### 進捗行の 2 モード

`data-testid="progress"` の内側ラッパ構成は**変更しない** (innerHTML 最大の既存契約。11 箇所の
完全一致 assert が依存している)。変わるのは span の中身だけ。

| 開始ノード | 進捗行のテキスト |
|---|---|
| 章 | `基本 · 1 / 12` (現状どおり。`showTrackBadge` の相当が true) |
| トラック | `1 / 12` (トラック名の span を空にする) |

判定条件は現行の `showTrackBadge = chapterTrackCount > 1 && currentTrackName !== ''`
(`practice/+page.svelte:147`) を **章開始knot の場合を追加** したもの:

```
showTrackBadge = startedFromChapter && chapterTrackCount > 1 && currentTrackName !== ''
```

- トラック開始時はヘッダのパンくずに現在のトラック名が入っているので、進捗行では出さない
- **章に子トラックが無く配下トラックが 1 本だけ**の章 (既存の既定データもこれで 2 span 合成は
  `1 / 2` のまま) も既存の分岐と同じ結果になる

## トップページ

章とトラックを**1本の木**に同居させる。インデント規則は 1 種類だけ。

```
▼ 1章  [ja]  15文              ← 言語バッジ + 配下の合計文数
    ▼ トラック1   10文  [練習]
        トラック1-1  5文  [練習]   ← トラックも子を持つ
    ▶ 2章  [en]  10文
```

- 章の行: 言語バッジ (`ja`/`en`) + **配下の合計文数** (自トラックの文 + 子孫トラックの文)。
  現在の「直接文の文数」から意味が変わる
- トラックの行: **自トラックの文のみ**の数 (子孫は子トラックの行に出るので二重計上しない)。
  これが「章 = 合計、トラック = 直属」という 1 段差别の読み取り規則になる
- 各ノードに「練習」ボタンを置く。**そのノードの配下 (自文 + 子孫トラック) に 1 文以上あれば有効**。
  現在の「章は直接文を持つ場合だけボタン」のロジックを置き換える
- 折り畳み状態は章・トラックで共通 (既存の `expandedChapters` 相当をノード id 集合に一般化)
- 言語バッジは「章に複数言語の文がある章」を表すので**章の行にだけ**出す。
  トラックの行には出さない
- a11y: 折り畳みボタンは `aria-expanded` のみ（`aria-controls` は折り畳み時に制御対象の
  DOM が消えるため axe `aria-valid-attr-value` に落ちる）。練習ボタンは
  「<ノード名> の練習を開始」を `aria-label` に持つ

## 管理画面 (chapters タブ)

`chapters` タブを**章 + トラックの 1 本の木**に拡張する。既存の再帰 snippet
(`chapterNode`, `manage/+page.svelte:981`) をノード再帰に置き換える。

### 行のアクション

| ノード | アクション |
|---|---|
| 章 | 折り畳み / **+子トラック** / ↑↓(同一親 = ルート内で隣接) / 改名 / 削除 |
| トラック | 折り畳み / **+子トラック** / ↑↓(**同一親内で隣接**) / 改名 / 削除 |

- 入力は全て**インラインフォーム** (ダイアログを使わない) を維持。`+子トラック` の
  インライン入力は既存の `new-child-chapter-name` / `confirm-add-child` の testid 流用ではなく
  新規 `new-child-track-name` / `confirm-add-track`
- `addTrack(chapterId, name, parentTrackId)` に拡張。`+子トラック` を押したノードについて
  - 章の行なら `chapterId` = その章、`parentTrackId` = `null`
  - トラックの行なら `chapterId` = `track.chapterId` (**自ノードの chapterId を流用**。子孫の章へ
    締められない)、`parentTrackId` = そのトラックの id
- 並び替えは**同一親内の隣接スワップ** (既存の `moveTrack` と同じ方式。`getChapterTracks` を
  `getSiblings(parentId)` に置き換える。境界ボタン disabled も同じ)

### インライン本文編集 (簡易)

- **トラック行の展開時**に、**そのトラックの直属の文**が 1 件ずつ `<textarea rows={2}>` で並ぶ
- **章行には出さない**。章の「直属の文」は配下トラックの行が同じ文を表示するため、二重に出る
  (1 文につき編集框が 2 つ成立してしまう)。章は展開すると配下トラックが並ぶだけ
- **Enter または blur で即 `updateSentence(id, { text })`**。専用ダイアログ・モード切替・
  新しい状態変数は不要 (専用の draft state のみ持つ)
- 1 行 `input` ではなく **textarea 2 行**: babel の英文明のように長い文が実在し、1 行では
  横スクロールして全体が見えない
- **IME ガード必須**: 日本語入力中に Enter で変換を確定したときの keydown
  (`KeyboardEvent.isComposing` が true) は**保存に使わない**。ガードを外すと「変換確定のたびに
  保存」が走り、実機では半途中のテキストで確定するので必須。ガードは E2E で再現しづらいので
  実装レビューで必ず確認する
- 文は 1 文 = 1 段落なので **改行は許可しない**。Enter は保存に使い、`preventDefault` する
- 空文字は保存せず inline error (既存の「トラック名は必須です」模式に倣う。入力値は空のまま残す)
- 各 textarea に `aria-label` (例: `文 3: これらの人びとは…`) — axe serious/critical 0 維持のため
- 文の削除・言語変更・並び替えは `sentences` タブのまま (スコープ外)

### sentences タブ

文の一覧と CRUD のみ。トラックの**所属変更**は木を見て決める。

- 文フォームの「章」select はルート（order 昇順）のみに簡略化 (階層が無いため)
- 文フォームの「トラック」select は**選択中の章のトラックを `flattenTrackTree` の pre-order 順**に
  並べる。階層は**深さに応じた全角スペースのインデント**で表現する (深さ 1 = `　`、深さ 2 = `　　`)。
  項目テキストは**トラック名のまま**なので、スクリーンリーダーの読み上げと既存の
  `getByRole('option', { name: '後半' })` による選択テストがそのまま使える
  (階層が分かるラベルの接尾辞は**付けない** — アクセシブルネームが壊れるため)
- 「章」select を変えたら「トラック」select は pre-order の先頭トラックへリセット (既存の挙動)

## エラー処理

| ケース | 挙動 |
|---|---|
| `?node=` 無し / 未知の id | 既存の summary エラー表示 |
| ノードの配下に 1 文も無い | 既存の summary エラー表示 (`chapter with no sentences` と同文) |
| 名の重複 | **許容する** (既存の章・トラック名の重複禁止なし) |
| 空文字のノード名 / 本文 | インラインエラー。保存しない |
| 移行シムの失敗 | 例外を握りつぶさず読込エラーとして扱う (空配列で黙って上書きしない) |

## テスト計画

### ユニット (`sentences.test.ts`)

- `flattenTrackTree`: 章直下 + 子孫を pre-order で返す / 兄弟は order 昇順 / 深さ 3 でも可
- `getNodeSentences`: 章から → 子孫トラックの文を pre-order で全収集 / トラックから → 自文 + 子孫
  / 同一トラックの文は `order` 昇順 / 未知 trackId は末尾
- `getNodeTrail`: 章から → 1 要素 / 子孫トラックから → 章→親→自 の 3 要素 / 未知 id → 空
- 移行シム: 子章 1 段 → 親章直下のトラック化 / 子章 2 段 (孫) → 最も近い祖先章の直下へ /
  文の `chapterId`・`trackId` 差替え / 既存トラックに `parentId` を補う /
  **冪等性** (2 回適用しても結果が変わらない) / id 衝突時の再採番 /
  既存データ (子チャプターなし) では**章と文が完全に不変**、トラックは `parentId: null` が
  補われるだけ (v3 入力なら 3 つとも完全不変)
- `migrateToV3`: v2 入力 → v3 出力 / v3 入力は素通し

「`updateTrack` に `parentId` を渡せないこと」は型で担保する (vitest では検証しない。
`npm run check` の 0 エラーが条件)。

### E2E

- **top**: 木の行にトラックが出現する / 深层のトラックも練習開始できる /
  章バッジが配下の合計文数になる / 折畳みでトラックが隠れる
- **practice**: `?node=<trackId>` で開始できヘッダが `1章 › トラック1` になる /
  進捗行が `1 / 12` 形式 (トラック開始) と `基本 · 1 / 12` 形式 (章開始) の両モード /
  復元が `?node=` でも効く / 未知 `node` は summary エラー
- **manage**: 木からトラックを追加・改名・並び替え・削除できる /
  子トラックの追加 / 兄弟順序の境界ボタン disabled / 削除確認に子孫数が出る /
  **インライン本文編集** (展開 → textarea に input → Enter で保存 → リロードしても保持 /
  空文字はエラー) / トラックの select が pre-order のインデント付きで並び、
  子孫を選んで文を移動できる
- **io-settings**: v3 エクスポート / v3 インポート / **v2 インポートが受理され v3 として保存される** /
  v1 インポートは拒否 (既存テストの更新)
- **既存の書き換え (削除ではない)**: `manage.spec.ts` の `Chapter nesting`
  (`adds child and grandchild, renders with increasing indentation` /
  `collapses and expands nested children`) は子**チャプター**の生成を前提としているので、
  子**トラック**を生成するテストへ書き換える。`top.spec.ts` の
  `nested chapters are displayed as a tree with children indented` と
  `parent card badge aggregates descendant sentence counts` も同様にトラック主体へ更新

## スコープ外

- AI TTS / クラウド音声配信 (④)、PWA (⑤)、クラウド同期 (⑥)
- トラックのドラッグ&ドロップ並び替え (↑↓ スワップのみ。既存方式を維持)
- トラックの移動 (別親への付け替え)。`parentId` を更新する API を設けないことで整合を保つ
- 自動遷移 (既に削除済み。採点後は明示クリックのみ)
- `Chapter.parentId` フィールドの**削除**。型に残す (値は常に null)。章の階層が復活する可能性を
  完全には捨てないので、廃止の判断は次回の統合で再検討する

## 既知の残余

- **練習中の本文差し替え**: 別タブで本文を書き換えると `sessionStorage` の進捗 index が
  ずれうる。既存の `sentences` タブの編集でも同じ挙動で、本 spec では変えない
- **章の `parentId` の死んだフィールド**: 型に残したまま値が常に null。`flattenChapterTree` と
  `collectChapterIds` も実質 1 段前提の退化コードになる。削除は別 spec の候補
- **babel インポートの再生成**: `.omo/exports/build_babel_import.py` を version 3 に更新して
  `babel-import.json` を再生成する必要がある (同ファイルはコミット禁止)。
  babel.txt はフラットな `24トラック` マーカーのみのため `parentId` は付けない
- **章の `parentId` の多層データの残存**: 移行シムは**読み込み時**に走るため、
  エクスポート済み JSON に子チャプターが残っていても v3 変換で直る

## AGENTS.md の更新 (実装と同じ PR で)

- **データモデル規約**: 「章 → トラック → 文」を「章 (ルート専用) → トラック (ネスト可) → 文」に
  差し替え。`Track.parentId` / `Sentence.chapterId` の冗長の意味 / インポートは version 3
  (v2 も自動変換して受理、v1 は拒否) / 削除カスケードの深さ対応
- **ディレクトリ地図**: `sentences.ts` に追加した純関数 4 つ (`flattenTrackTree` /
  `getNodeDescendantTrackIds` / `getNodeSentences` / `getNodeTrail` / `migrateToV3`) と
  `manage/+page.svelte` の「chapters タブ = 1本の木」
- **E2E テスト規約**: 進捗行が章開始 (`基本 · 1 / 12`) とトラック開始 (`1 / 12`) の 2 モードに
  分かれたこと。`progress` の完全一致 assert は章開始ケースのみ残す
- **運用**: 練習の入口が `/practice?chapter=` から `/practice?node=` に変わった

## 検証 (完了条件)

1. `npm run check` 0 エラー
2. `npm test` (vitest) 全緑
3. `npm run test:e2e` 全緑
4. **実機ゲート (ユーザー承認)**: Android Chrome で
   - 子チャプターを含む既存データがある場合、読み込み後に子トラックへ移行されている
   - 3 段以上のネストしたトラックで連続練習し、並び順 (pre-order) が意図通り
   - 管理タブからのインライン本文編集が実キーボード/ IME で使える
