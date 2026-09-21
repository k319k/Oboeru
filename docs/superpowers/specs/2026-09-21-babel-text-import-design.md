# バベルの塔テキスト取り込み — 設計

- 日付: 2026-09-21
- 状態: 承認済み (ユーザー承認 2026-09-21)
- 関連: `~/develop/the-tower-of-babel` (ソースプロジェクト)

## 目的

The-tower-of-babel 暗記アプリ (単一HTML・音声同期型) の**テキスト内容のみ**を
Oboeru に取り込み、既存の練習フロー (TTS読み上げ → Space押下録音 → 採点) で
英→日→英→日 の順に暗記練習できるようにする。

## 非目標 (スコープ外)

- 音声ファイル (MP3) の統合・保存・再生
- アプリ (src/) への変更 — 既存のインポート機能のみで完結
- 曲の区切りで途中まで切れている文のマージ (例: "...came to be built in")
- anqi 版 (`sugatri-local`) への対応 (同形式なので後で同手順を流用可)

## ソースデータ

`/home/k319/develop/the-tower-of-babel-anqi/sugatri-local/index.html` の `const textData` (ユーザー指定: こちらを信頼できるソースとする。初版の segments.json は音声順のため同言語連続があったが、こちらは**完璧な英日ペア82組**)

```js
const textData = [
    { id: 1, english: "Once upon a time there was a very tall tower.", japanese: "むかし、とても高い塔がそびえていました。" },
    ...
];
```

- 82ペア = 英82 + 日82。**英→日→英→日 に展開すると完全交互 164文**

## 成果物

`/home/k319/develop/Oboeru/babel-import.json` (コミットしない・インポート用の一時ファイル)

```json
{
  "version": 1,
  "chapters": [
    { "id": "ch-babel", "name": "バベルの塔", "parentId": null, "order": 99 }
  ],
  "sentences": [
    { "id": "babel-001", "chapterId": "ch-babel", "text": "Once upon a time there was a very tall tower.", "language": "en", "order": 1 },
    { "id": "babel-002", "chapterId": "ch-babel", "text": "むかし、とても高い塔がそびえていました。", "language": "ja", "order": 2 }
  ]
}
```

- **`version: 1` は必須** — manage の `validateImportJson` が `obj.version !== 1` で拒否する (初版失敗の原因)

### 仕様

| 項目 | 値 |
|---|---|
| chapter.id | `ch-babel` |
| chapter.name | `バベルの塔` |
| chapter.order | `99` (既存チャプターの後ろに表示) |
| sentence.id | `babel-001` … `babel-164` (0埋め3桁) |
| sentence.order | 1 … 164 (各ペアを 英→日 で展開: item i の en = 2i-1、ja = 2i) |
| language | 平仮名/カタカナ/漢字を含む → `ja`、それ以外 → `en` |
| text | segments.json の text を trim (空行・空白のみの行は除外) |

- インポートは ID マージ (既存は上書き、新規は追加) — `src/routes/manage/+page.svelte` の `handleImport`
- 万一 ID 衝突時は上書きされるため、`ch-babel` / `babel-NNN` は既存データと衝突しにくい命名

## 生成方法

Python ワンオフスクリプト `.omo/exports/build_babel_import.py` (gitignore 対象の .omo 配置、再実行可能)。
ジェネレータの要点: lines を trim → 空除外 → language 判定 → 上記スキーマで出力。

## 検証

1. JSON パース成功 + manage の `validateImportJson` と同じチェック (**version === 1**、chapters: id/name、sentences: id/chapterId/text) を満たす
2. 件数: chapters 1件 / sentences 164件 (= 82ペア × 2)
3. 交互パターン: **完全交互 EJ × 82** (ペア展開により保証)
4. 重複テキストがあれば件数を報告 (そのまま残す — 物語中のセリフの繰り返し)

## 導入手順 (ユーザー操作)

1. Oboeru を開く → 管理画面 → データのインポート
2. `babel-import.json` を選択
3. 「1件のチャプター、184件の文章をインポートしました」を確認
