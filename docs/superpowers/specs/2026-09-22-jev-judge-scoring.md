# Jev 意味一致判定による採点刷新 — 設計

- 日付: 2026-09-22
- 状態: ユーザー承認済み (実測テスト結果を踏まえ「進めていいよ」)
- 関連: OpenRouter `~typesafe/jev-latest` (実測) / 実装テスト済みペア一式

## 目的

音声認識 (Groq Whisper) の表記ゆらぎ (3階/三階、わからない/解らない、句読点、
はじめ/初め、みな/みんな) で正しく読めても「違います」になる誤判定を、
**Jev (TypeSafe System One) の意味一致判定**で解消する。

## 実測済みの事実 (このspecの根拠 — 2026-09-22 実テスト)

- 経路: `POST https://openrouter.ai/api/v1/systemone` (OpenRouterキー、SDK互換の正式経路)
- モデル: `typesafe/jev-1.13` (ピン留め推奨 — docs) → 実応答 `typesafe/jev-1.13-20260917`
- リクエスト: `{model, state: {reference, transcription}, questions: {same_utterance: noul, difference_kind: choice}}`
  - choice には **`criteria` (選択肢マップ) 必須** (zod検証、実測で確認)
  - state は**オブジェクト推奨・最小構成** (jaggedness: context rot)
- 実測結果 (noul): 3階/三階 **0.98**、わからない/解らない **0.86**、句読点違い (babel実文) **0.93**、
  はじめ/初め+みな/みんな **0.96** (choice: word_variant, conf 0.86) / 別文コントロール **0.02**
- レイテンシ 240–450ms、コスト 1判定 $0.000014–0.000025、バッチングで質問追加はレイテンシ不変
- docs 注意: noul に confidence は無い / CJK は英語同等ではないため confidence重視のルーティング /
  `P(noul)` と否定形の和は1にならない (否定マジョリティ禁止)

## 設計

### 1. 正規化 (`src/lib/normalize.ts` 新規)

`normalizeJapaneseText(text: string): string`
- `String.prototype.normalize('NFKC')` → 句読点・記号・空白除去 (`\p{P}\p{S}` + `\s`, `u` フラグ) →
  カタカナ → ひらがな統一 (charCode 0x60 シフト)
- **採点の類似度計算の直前**に正解文と文字起こしの**両方**に適用 (Jev unavailable時のフォールバック品質 +
  表示スコアの安定化)
- 漢字数字→アラビア変換は**やらない** (Jevが担当、依存ゼロを維持) — 非目標に明記

### 2. Jev 判定エンドポイント (`src/routes/api/judge/+server.ts` 新規)

- `POST { reference: string, transcription: string }`
- サーバー側で OpenRouter `/api/v1/systemone` を呼ぶ (キーは `$env` の **`OPENROUTER_API_KEY`** —
  wrangler secret + ローカル .env。クライアントに露出しない)
- モデル **`typesafe/jev-1.13` 固定** (ピン留め)
- questions (1コールにバッチ):
  - `same_utterance`: noul — instructions は実測で検証済みの文言 (notation variants / colloquial variants
    みな=みんな を same とする、different/missing/extra は different)、criteria {true, false} 付き
  - `difference_kind`: choice — criteria マップ
    `{identical_text, orthography_variant, word_variant, different_utterance}`
- 成功応答: `{ available: true, noul: number, category: string, confidence: number }`
- 失敗応答 (キー未設定 / 4xx/5xx / タイムアウト 8s / レート制限): **`{ available: false }`**
  (HTTP 200 で返し、クライアントはフォールバックするだけ — エラーページにしない)
- リクエストは server-side fetch + AbortController 8s。429/529/5xx は1回のみ短いリトライ (500ms待機)

### 3. 練習画面の統合 (`src/routes/practice/+page.svelte` 修正)

- 採点時: 正規化後の類似度スコア `sim` を計算 (既存フロー)
- **`sim >= threshold` なら Jev を呼ばない** (無駄な呼び出し回避 — 合格確定のため)
- `sim < threshold` のときのみ `/api/judge` を呼び:
  `finalScore = Math.max(sim, Math.round(noul * 100))` (available のとき)
- `available: false` なら `finalScore = sim` (完全に既存挙動)
- 閾値判定・合格/不合格フロー・feedback UI・差分表示は**既存のまま変更しない** (スコア数字だけが上がる)
- retryFailedOnly / 復元 / 進捗保存への影響なし (スコア合成は doTranscribe 内)

## 非目標

- Whisper モデル/プロンプト変更 (ユーザー指示: 現状維持)
- カナ読みベース比較 (kuromoji.js) — Jev+正規化で不十分だった場合の次手
- 設定トグル (Jev ON/OFF) — 自動フォールバックで十分
- Jev Score プリミティブによる発音採点 (将来拡張)

## テスト計画

- ユニット: normalizeJapaneseText (NFKC/記号/カナ、日本語・英語混在、空文字)、
  judge リクエストビルダ (buildJudgeRequest 純関数 — model/state/questions の完全形)
- E2E: `/api/judge` を page.route でモック —
  (a) 低類似度 + noul 0.95 → 合格 (スコア持ち上げ)、(b) judge 失敗 (available:false) → 従来どおり不合格、
  (c) 高類似度 → judge が呼ばれない (リクエスト数 0 をアサート)
- 既存テスト全て無影響 (judge は追加ロジックのため、モック無し環境では available:false フォールバック)

## セキュリティ

- `OPENROUTER_API_KEY` は Workers シークレット + ローカル .env (gitignore済み) のみ。コミット禁止
- クライアントからは /api/judge 経由でのみ Jev を利用 (キー不露出)
