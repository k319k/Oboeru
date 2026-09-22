# Jev 意味一致判定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 音声認識の表記ゆらぎによる誤判定を、Jev (TypeSafe System One) の意味一致判定 (noul) で解消する。最終スコア = max(類似度, noul×100)。

**Architecture:** 正規化はクライアント純関数 (`src/lib/normalize.ts`)、Jev 呼び出しはサーバーproxy (`/api/judge`、キー不露出)。類似度が閾値未満のときだけ Jev を呼び、スコアを持ち上げる。失敗時は完全に既存挙動へフォールバック。

**Tech Stack:** SvelteKit + TypeScript + Svelte 5、vitest、Playwright、OpenRouter `/api/v1/systemone`

**Spec:** `docs/superpowers/specs/2026-09-22-jev-judge-scoring.md`

## Global Constraints

- モデルは `typesafe/jev-1.13` をピン留め (jev-latest は使わない)
- choice/noul のスキーマ厳守: choice には `criteria` マップ必須 (zod 400 の実測あり)。state はオブジェクト・最小構成
- `OPENROUTER_API_KEY` はシークレット/.env のみ (コミット絶対禁止)。クライアントから直接 Jev を呼ばない
- 既存の採点フロー・UI・T13 キーボード操作を壊さない。スコア合成は doTranscribe 内に限定
- `noul` に confidence は無い。否定形マジョリティ投票は禁止 (docs)
- 各タスクで `npm run check` 0エラー + 関連テスト全緑。コミットはタスク単位
- 日本語 UI 文言・日本語報告

---

### Task 1: 正規化 + 採点パス適用

**Files:**
- Create: `src/lib/normalize.ts`
- Modify: `src/routes/practice/+page.svelte` (doTranscribe 内の類似度計算前処理のみ)
- Test: `src/lib/normalize.test.ts`

**Interfaces:**
- Produces: `normalizeJapaneseText(text: string): string` (Task 2/3 は不使用、採点専用)

- [ ] **Step 1: 実装**

```ts
/** Normalize Japanese text for similarity scoring: NFKC, strip
 * punctuation/symbols/whitespace, unify katakana to hiragana. */
export function normalizeJapaneseText(text: string): string {
	const nfkc = text.normalize('NFKC');
	const stripped = nfkc.replace(/[\p{P}\p{S}\s]+/gu, '');
	// Katakana (ァ-ヶ 0x30A1-0x30F6) → Hiragana (0x3041-)
	const hira = stripped.replace(/[\u30A1-\u30F6]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0x60)
	);
	return hira;
}
```

- [ ] **Step 2: ユニットテスト** — 全角/半角、句読点除去、「ア」「あ」統一、英語混在、空文字、記号のみ→空文字
- [ ] **Step 3: doTranscribe 内で正解文と文字起こしの両方に適用してから既存の類似度計算** (呼び出し箇所のみ。diff 表示等は触らない)
- [ ] **Step 4: `npx vitest run src/lib` + `npm run check` 全緑 → commit `feat: japanese text normalization for scoring`**

---

### Task 2: Jev 判定エンドポイント

**Files:**
- Create: `src/lib/jev.ts` (buildJudgeRequest 純関数 + 応答パース純関数)
- Create: `src/routes/api/judge/+server.ts`
- Test: `src/lib/jev.test.ts`

**Interfaces:**
- Produces (Task 3 が依存): `POST /api/judge` body `{reference: string, transcription: string}` →
  成功 `{available: true, noul: number, category: string, confidence: number}` /
  失敗 `{available: false}` (常に HTTP 200)

- [ ] **Step 1: buildJudgeRequest (純関数 — 実測済みボディをそのまま)**

```ts
export const JEV_MODEL = 'typesafe/jev-1.13';
export function buildJudgeRequest(reference: string, transcription: string) {
	return {
		model: JEV_MODEL,
		state: { reference, transcription },
		questions: {
			same_utterance: {
				type: 'noul',
				instructions:
					'Does `transcription` express the same spoken utterance as `reference`? ' +
					'Notation differences that preserve the reading count as identical: kanji vs kana ' +
					'(はじめ = 初め), comma styles (", " vs "、"), trailing punctuation, and minor ' +
					'colloquial variants of the same word (みな = みんな). ' +
					'Different word, different reading, missing or extra content counts as different.',
				criteria: {
					true: 'Same utterance by a native reading, allowing notation and punctuation variants',
					false: 'Different utterance, wrong reading, or missing/extra content'
				}
			},
			difference_kind: {
				type: 'choice',
				instructions: 'Classify the relationship between `reference` and `transcription`.',
				criteria: {
					identical_text: 'Text is character-for-character identical',
					orthography_variant: 'Same words and reading, different spelling/punctuation/kanji choice',
					word_variant: 'Same words but a colloquial or shortened form of one word (みな/みんな)',
					different_utterance: 'Actually different words or meaning'
				}
			}
		}
	};
}
export function parseJudgeResponse(json: unknown):
	{ available: true; noul: number; category: string; confidence: number } | { available: false } {
	// answers.same_utterance.noul (0-1), answers.difference_kind.{choice,confidence} を安全に取り出す。
	// 欠損/型不整合/answers不在 → {available: false}
}
```

- [ ] **Step 2: +server.ts** — POST ハンドラ: body 検証 (reference/transcription 非空文字列) →
  `OPENROUTER_API_KEY` を `$env` から取得 (未設定 → `{available: false}`) →
  `fetch('https://openrouter.ai/api/v1/systemone', ...)` + AbortController 8s →
  429/529/5xx は 500ms 待機で1回リトライ → `parseJudgeResponse` → 応答。
  例外は全て catch して `{available: false}` (console.error 付き)。**常に HTTP 200**
- [ ] **Step 3: ユニットテスト** — buildJudgeRequest の完全形スナップショット (model/state/questions 全フィールド)、
  parseJudgeResponse (正常 / answers欠損 / noul非数値 / choice欠損 → available:false)
- [ ] **Step 4: `npm run check` + `npx vitest run src/lib` 全緑 → commit `feat: jev judge endpoint`**

---

### Task 3: 練習画面統合 + E2E

**Files:**
- Modify: `src/routes/practice/+page.svelte` (doTranscribe 内)
- Test: `tests/practice.spec.ts`

**Interfaces:**
- Consumes: Task 1 の `normalizeJapaneseText`、Task 2 の `/api/judge` 契約

- [ ] **Step 1: 統合** — doTranscribe 内: `sim` 計算後、
  `if (sim >= threshold) → 既存フロー (judge 呼ばない)`。
  `sim < threshold` → `fetch('/api/judge', {method:'POST', body:{reference, transcription}})` →
  `available && noul > 0` なら `finalScore = Math.max(sim, Math.round(noul * 100))`、
  それ以外は `sim`。以降の閾値判定/feedback は既存ロジックをそのまま使う (finalScore を渡す)
- [ ] **Step 2: E2E テスト** — `page.route('**/api/judge', ...)`: (a) noul 0.95 を返すと低類似度の文が
  合格になる (score 表示が持ち上がること)、(b) `{available: false}` を返すと従来どおり不合格、
  (c) 高類似度で合格する場合は judge へのリクエストが 0 回
- [ ] **Step 3: `npx playwright test tests/practice.spec.ts` + `npm run check` + `npx vitest run src/lib` 全緑 →
  commit `feat: jev semantic judge integration in scoring`**

---

### Task 4 (コントローラー実行): デプロイ + 本番検証

- [ ] wrangler secret 登録: `wrangler secret put OPENROUTER_API_KEY` (ユーザー提供キー)
- [ ] push + `npm run build` + `wrangler deploy`
- [ ] 本番スモーク: `curl -X POST https://oboeru...workers.dev/api/judge -d '{"reference":"3階","transcription":"三階"}'` →
  `{"available":true,"noul":≥0.8,...}` を確認。失敗ペア (`こんにちは` vs `おはよう`) → noul 低を確認
- [ ] 完了報告
