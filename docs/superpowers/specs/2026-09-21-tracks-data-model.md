# トラック構造 — 設計 (Tracks Data Model)

- 日付: 2026-09-21
- 状態: ユーザー承認済み (モックアップ `tracks-mock-v1` で構想確認、「すすめていいよ」)
- 関連: `2026-09-21-babel-text-import-design.md` (v1 — 本specで置き換え)
- ソーステキスト: `/home/k319/ダウンロード/babel.txt` (24〜27トラック付き最新版)

## 目的

チャプターの中に**トラック**を持ち、トラックの中に文が属する構造にする。
babel.txt の「24トラック」等の区切りをトラックとして取り込み、英→日順に暗記練習する。

## データモデル

```ts
// types.ts 追加
export interface Track {
  id: string;
  chapterId: string;
  name: string;      // 例: トラック24
  order: number;     // 章内のトラック順
}

// Sentence 変更
export interface Sentence {
  id: string;
  chapterId: string;
  trackId: string;   // NEW
  text: string;
  language: 'ja' | 'en';
  order: number;     // **トラック内**の順序
}
```

- ストレージ: 同一キー `oboeru:v1`、JSON は `{chapters, tracks, sentences}`
- **練習順 = track.order 昇順 → sentence.order 昇順** の二段ソート
  (`getChapterSentences` 内で track を join してソート)

## 互換性ポリシー

- **インポート/エクスポートは version 2 のみ**。v1 は「対応していないバージョンです」で拒否
- ストレージ読み込み時、`tracks` 欠落の旧データは**章ごとに既定トラック「トラック1」を自動生成して全文を収容**する読み込みシム (既存チャプター/テストシードを壊さないための最小措置。初回保存後は新形式で永続化)

## 管理画面 (フル統合)

- 文リストを**トラック別グループ表示**: グループ見出し `[トラック名] (N文)` + ↑↓/編集/削除
- トラックCRUD: 追加 (章ごと) / 編名 / 削除 (中の文も削除・AlertDialog確認) / 並び替え (隣接スワップ)
- 文の追加・編集フォームに**トラック選択セレクタ** (章選択に連動、既定 = その章の先頭トラック)
- チャプター削除: 配下のトラックもカスケード削除
- エクスポート: `{version: 2, exportedAt, chapters, tracks, sentences}`
- インポート: v2検証 (tracks 配列必須、各 track の id/chapterId/name は文字列、sentence の trackId は文字列) + IDマージ
- 成功メッセージ: 「N件のチャプター、N件のトラック、N件の文章をインポートしました」

### UI/UX 品質要件 (ユーザー指摘: 「UI/UXはもっとがんばって」)

- 既存のデザインシステムに完全準拠 (shadcn-svelte コンポーネント、`--lang-ja/--lang-en` トークン、Button/AlertDialog/Badge 慣習)
- トラック見出しは落ち着いたグループヘッダ (gray-50背景・角丸・アコーディオン的トグル)、hover 状態、タップターゲット ≥44px
- a11y: グループに `role="group"` + `aria-label`、削除は AlertDialog、キーボード操作維持
- レスポンシブ 390px で崩れないこと / axe serious-critical 0 維持

## 練習画面

- セッションの文リストは二段ソート済み (`getChapterSentences` が返す順)
- ヘッダ進捗表示に**現在のトラック名**: `トラック25 · 3 / 12` (バッジ + テキスト)
- 復元 (chapterId + index) は仕組み不変 (index は二段ソート済み配列へのインデックス)

## babel.txt パーサ (インポートファイル生成)

- トラックマーカー: `^(\d+)トラック$` → Track `{name: "トラック${n}", order: 出現順}`
- 空行区切りブロック = 1単位: ブロック内の行を CJK 判定で EN行群/JA行群に分け、
  それぞれスペース結合して 1文ずつ (EN → JA の順で文追加)
- ENのみブロック (擬似語 "SMIRGY MUF BA DOOGLE," 等) → EN文のみ。最終行 "GUCHA GOO (The End)" も同様に取り込む
- 出力: `babel-import.json` (version 2) — 管理画面からインポートして使う

## テスト計画

- ユニット (sentences.test.ts): track CRUD、二段ソート、削除カスケード、読み込みシム、addSentence の既定トラック
- E2E: io-settings (v2 エクスポート/インポート往復、v1拒否)、manage (トラック追加/編名/削除/グループ表示)、practice (複数トラック章の順序 + トラックバッジ表示)
- 既存テスト: シムにより原則無影響 (v1インポートを期待する io-settings の version テストのみ更新)
