# Google Cloud TTS への移行設計

- 日付: 2026-09-11
- ステータス: 承認済み(2026-09-11、ユーザー承認)

## 1. 背景と目的

`おぼえる` は SvelteKit + Cloudflare Workers 上で動く日本語/英語学習アプリ。読み上げに Web Speech API(`speechSynthesis`)を使っていたが、Firefox では `onend`/`onerror` が発火せず「タイムアウトしました (5000ms)」エラーが発生する。

ユーザー決定により、**Google Cloud Text-to-Speech(無料枠)に全面移行**する。フォールバックなし(Google TTS のみ)。API キーはユーザーが用意済み(`GOOGLE_TTS_API_KEY`)。

## 2. アーキテクチャ

サーバー経由プロキシ方式を採用。キーはサーバー(Workers Secret)にのみ存在し、ブラウザに露出しない。既存の `/api/transcribe`(GROQ)と同じパターン。

```
practice ページ               SvelteKit/Workers            Google
┌──────────┐   POST /api/tts  ┌──────────────┐   REST   ┌──────────────┐
│ speak()  │ ───────────────→ │ /api/tts     │ ───────→ │ text:synthesize│
│ (tts.ts) │ ←─────────────── │ (キーはSecret)│ ←─────── │ (MP3 base64)  │
│ Audio再生│   audio/mpeg     └──────────────┘          └──────────────┘
└──────────┘
```

- ❌ 却下: ブラウザ直呼び(キー露出)
- ❌ 却下: 音声キャッシュ層(個人利用では過剰、YAGNI)

新規 npm 依存は不要(クライアント: fetch + HTMLAudioElement、サーバー: fetch)。

## 3. コンポーネント

### 3.1 `src/lib/tts.ts` — 全面書き換え

- `speak(text: string, lang: string, options?: { rate?: number; voiceURI?: string | null }): Promise<void>`
  - `fetch('/api/tts', { method: 'POST', body: JSON.stringify({ text, lang, voiceName, speakingRate }) })`
  - 応答 `audio/mpeg` を Blob 化 → `URL.createObjectURL` → `HTMLAudioElement` で再生 → `ended` で resolve
  - タイムアウト: fetch 10s + 再生 30s(どちらも超過で reject、再生中オーディオを停止)
- `cancelSpeech(): void` — 再生中・待機中のオーディオを停止
- `listVoices()` を廃止し、**厳選 6 声の静的リスト** `CURATED_VOICES` をエクスポート
  - 形式: `{ id: string; languageCode: string; name: string; gender: 'male' | 'female' }`
  - 声の選択ロジック: `resolveVoice(lang, storedVoiceURI)` — stored がその言語の声なら採用、違う言語/未知ならその言語のデフォルト声(リスト先頭)を採用
- Node.js(vitest)で import しても throw しない(現行同様、呼び出し時チェック)

### 3.2 `src/routes/api/tts/+server.ts` — 新規

- POST ボディ: `{ text: string; lang: string; voiceName: string; speakingRate: number }`
- Google REST:
  `POST https://texttospeech.googleapis.com/v1/text:synthesize`
  ヘッダ: `X-Goog-Api-Key: <GOOGLE_TTS_API_KEY>`
  ボディ:
  ```json
  {
    "input": { "text": "<text>" },
    "voice": { "languageCode": "ja-JP", "name": "ja-JP-Neural2-B" },
    "audioConfig": { "audioEncoding": "MP3", "speakingRate": 1.0 }
  }
  ```
- 応答 `{ audioContent: "<base64>" }` をデコードし `audio/mpeg` で返す
- キー未設定(`env.GOOGLE_TTS_API_KEY` が空)→ `503`「TTS API キーが未設定です」(transcribe と同じ契約)
- `speakingRate` は 0.25〜4.0 にクランプ
- テキスト長制限: 400 文字以内(超えたら 400)。per-request 文字での無料枠消費を防ぐ

### 3.3 管理画面(`src/routes/manage/+page.svelte`)

- `listVoices()` の動的リストを `CURATED_VOICES` の静的リストに置換
- 音声選択 UI: 日本語/英語でグループ化した Select(`value` = 声名)。現在値がリスト外ならデフォルト表示
- プレビュー再生・声の追加/詳細表示は追加しない(YAGNI)

### 3.4 練習ページ(`src/routes/practice/+page.svelte`)

- 既存の `speak(text, lang, { rate, voiceURI })` 呼び出しを維持(シグニチャ不変)
- `voiceURI` の実体が Google 声名になる(呼び出し側変更なし)
- TTS 失敗時の既存トースト表示を維持(録音練習フローは継続)

### 3.5 設定(localStorage `oboeru:settings:v1`)

- **スキーマ変更なし**。既存 `voiceURI` フィールドに Google 声名(例: `ja-JP-Neural2-B`)を保存
- 旧 Web Speech URI が保存済みの場合はリスト外 → 言語ごとのデフォルト声に自動フォールバック(移行コード不要)

## 4. リクエスト/レスポンス仕様(`/api/tts`)

| 項目 | 値 |
|---|---|
| POST `/api/tts` | `{ text, lang, voiceName, speakingRate }` |
| 成功 200 | `Content-Type: audio/mpeg`、MP3 バイナリ |
| キー未設定 | 503 `{ error: "TTS API キーが未設定です" }` |
| 400 文字超 / 不正パラメータ | 400 |
| Google API エラー | 502(上流エラーをそのまま) |
| タイムアウト | 408(Workers 側 30s 内に Google 応答なし) |

## 5. 声のラインナップ

| 言語 | 声 | デフォルト |
|---|---|---|
| ja-JP | `ja-JP-Neural2-B`(女性) / `ja-JP-Neural2-C`(男性) / `ja-JP-Neural2-D`(女性) | Neural2-B |
| en-US | `en-US-Neural2-A`(男性) / `en-US-Neural2-C`(女性) / `en-US-Neural2-F`(女性) | Neural2-C |

- Neural2 は Google Cloud TTS の無料枠(月 4M 文字、Standard は月 1M 文字)の対象
- 声の性別は Google 公式ドキュメントの記載に基づき、実装前に最終確認する
- アプリは日英両対応のため、文の言語に合わない保存声は無視してデフォルト声を使う(現行より厳密)

## 6. エラーハンドリング

| ケース | 挙動 |
|---|---|
| キー未設定 | 503 → トースト「TTS API キーが未設定です」 |
| fetch タイムアウト(10s) | トースト「TTS に接続できませんでした」 |
| 音声再生エラー/再生タイムアウト(30s) | トースト「音声の再生に失敗しました」 |
| TTS 失敗時 | 録音練習フローは継続(現行と同じ) |

## 7. テスト

- `src/lib/tts.test.ts`: 全面書き直し
  - `resolveVoice()` の選択ロジック(保存声が言語一致/不一致/未知/リスト外)
  - `speak()` の fetch 呼び出し・Blob 再生・エラー分岐(グローバルの `fetch` / `Audio` をモック)
- E2E(`tests/practice.spec.ts` / `tests/e2e-full.spec.ts` / `tests/recording-regression.spec.ts`):
  - `speechSynthesis` の `Object.defineProperty` モックを削除
  - `page.route('**/api/tts', ...)` で**小さい無音 MP3** を返す方式へ変更
  - TTS 呼び出し回数はルート intercept 側(Node コンテキスト)でカウント
  - 外部キー不要で通る(現行と同じ)
- `recording-regression.spec.ts` は計画上「凍結」だったが、モック方式の更新のみ行い**テストの意図(録音フロー回帰)は維持**する。削除・skip はしない
- 全既存テストの削除・skip は禁止(更新して維持)

## 8. デプロイ手順(ユーザー操作、実装後に実施)

```bash
# ローカル: .env に GOOGLE_TTS_API_KEY(設定済み)
npx wrangler secret put GOOGLE_TTS_API_KEY   # Cloudflare Workers 用
npx wrangler deploy
```

## 9. 非目標(やらないこと)

- TTS 音声のキャッシュ/事前生成
- 声のプレビュー再生 UI
- 多言語対応の拡張(ja/en のみ)
- Web Speech API との併用・フォールバック(フォールバックなしが確定)
- コミット・プッシュ(ユーザー明示依頼時のみ)