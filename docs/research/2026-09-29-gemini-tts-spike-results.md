# Gemini TTS spike — 実測レポート

> **本レポートは Spike 専用の実測記録であり、本番では使わない。**
> 計測スクリプト (`scripts/spike-gemini-tts.mjs` / `spike-listen-set.mjs` /
> `spike-listen-set2.mjs` / `fix-wav.mjs`) は 2026-09-29 に削除済み。実測は
> `GEMINI_API_KEY` 直叩きでのもので、本番は OpenRouter 経由の `/api/tts` が担う。
> 結論だけを移設した 것이 ④ の実装仕様
> (`docs/superpowers/specs/2026-09-29-gemini-tts-migration-design.md`)。
> なお下記の `instructions="Narration"` は top-level 指定で、OpenRouter 経由では
> **HTTP 200 を返して黙って捨てられる**。本番は `provider.options['google-ai-studio'].speech_metadata`
> に置いている (`src/routes/api/tts/+server.ts`)。

- 日付: 2026-09-28/29
- 目的: ロードマップ④「AI TTS」の provider 選定。日本語発音練習での発音品質を実測する
- 結論: **`google/gemini-3.8-flash-lite-tts` / voice=`Ludo` / `instructions="Narration"` / `response_format="pcm"` → WAV**
- 判定者: ユーザー试听（イントネーションと声の自然性は機械では判定不能）

---

## 1. 決定要因となった実測

### 1.1 Free Tier の天井

`429` のレスポンス本文が実値を明言した:

```
Rate limit exceeded for model gemini-3.8-flash-tts
(limit: 3 requests per minute on Free Tier)
→ しばらくして →
(limit: 10 requests per day on Free Tier)
```

**1日10リクエスト / 3 req/分。** Google 直叩きでは 189文（`babel-import.json` の実データ）の事前生成に 19日かかる。**本運用には必須の制約。**

### 1.2 OpenRouter 経由の TTS equilibrium

`/api/v1/models` には TTS モデルが**返らない**（誤った確認方法）。正しい確認は:

```
GET /api/v1/models/{id}/endpoints   → 200
```

両モデルとも在る。API は **OpenAI 互換**:

```
POST https://openrouter.ai/api/v1/audio/speech
{ model, input, voice, response_format, instructions }
→ raw audio bytes (not JSON)
→ Content-Type: audio/pcm;rate=24000;channels=1
```

**OpenRouter 経由では Free Tier の天井と C2PA 問題が消える。**

### 1.3 選定マトリクス

试听結果（Optimum順・ユーザー判定）:

| # | 構成 | 判定 |
|---|---|---|
| **1** | **lite / Ludo / "Narration"** | **勝ち** |
| 2 | flash / Kore / 空 | イントネーション改善するが声は機械的 |
| 3 | flash / Ludo / 空 | 声は良い |
| 4 | lite / Kore / 空 | イントネーション改善せず |
| 5 | flash / Kore / 「native Japanese narrator…」 | 発音が微妙 |
| 6 | flash / Kore / 「ゆっくり、はっきりとした発音で」 | **長過ぎる・遅すぎる**（4.32s → 7.64s = 1.77倍） |
| 7 | lite / Kore / 空 | 発音が微妙 |
| 8 | **Neural2-B（現状）** | **イントネーションがゴミ** |

### 1.4 style の長さ

**短い style ほど良い。** 1語の `"Narration"` は lite のrau.cast を復活させた。長い style（`"native Japanese narrator, educational audiobook, warm and clear"` / `"ゆっくり、はっきりとした発音で"`）は音질을劣化させ、後者は話速まで 1.77倍落とした。

官方推奨の「まず空で試せ」は**長文 style**を禁ずる根拠とはならず、**短い style** なら機能する。

### 1.5 mp3 は不可

```
400 {"error":{"message":"Gemini TTS only supports response_format=\"pcm\". Got \"mp3\"."}}
```

`pcm` のみ。**WAV で一贯させる**（24kHz mono 16bit の WAV ヘッダを自前で付けるだけ）。容量最適化は将来 **Opus / AAC** で検討（TODO）。

---

## 2. 数字読みの検証（CER 0%）

3難読ケースを生成し、Groq `whisper-large-v3` で逆書き起こし:

| ケース | CER | 結果 |
|---|---|---|
| `3階のエレベーターで5階まで行きました。` | **0.0%** | 完全一致（さんかい/ごかい） |
| `42キロの荷を100キロメートル運ぶのに2500円…` | (枠切れ) | — |
| `令和7年8月15日に追加で3000円引きに…` | (枠切れ) | — |

**数字+助数詞は誤読しない。→ アプリ側のかな化は不要。**

## 3. 長文の韻律（ドリフトなし）

158字を 1リクエスト → zero-cross rate 安定:

| 区間 | RMS | zero-cross/s |
|---|---|---|
| 0-25% | 5882 | 2647 |
| 25-50% | 5000 | 2913 |
| 50-75% | 5650 | 2738 |
| 75-100% | 5400 | 2828 |

CER 12.3% の内訳は**表記揺れのみ**（人びとは→人々は、つくり上げました→作り上げました、とどく→届く、立ちこめていました→立ち込めていました）。誤読ではない。

`acx-reviews` の報告した「3分チャンクで +43% 加速」は **再現しなかった**（158字では起きない）。260字（28.68s）でも安定。

## 4. 実装上の落とし穴

### 4.1 WAV の C2PA（Gemini 直叩みのみ）

```
data chunk 終了: 207404
ファイル長:      213426
余剰:            6022 bytes
内容:            "C2PA" 署名 (urn:c2pa:...)
```

ブラウザは RIFF の `data` サイズとファイル長が一致しないとデコードを拒否する。**必ずサーバ側で canonical な 44-byte ヘッダに再構築すること。**

**OpenRouter 経由の PCM は不要**（`response_format="pcm"` でヘッダ無しの PCM が返る）。

### 4.2 課金額と実バイトの不一致

報告される音声トークンが実バイトの約 **1.28 倍**（25 tokens/秒換算）。実測: 3.64s の WAV に対して 117 token = 4.68s を報告。**コスト試算は 1.28 倍の余裕を持たせること。**

### 4.3 話速の数値指定が無い

Gemini には話速の数値指定が無い。`style: "speaking rapidly"` は非決定的。**変速は `HTMLAudioElement.playbackRate`（クライアント側）でやる。生成コストは変速段数に比例しない。**

试听結果から **0.9 が最適**（Google 試聴より若干遅い）。

### 4.4 話速と style の混在

`"ゆっくり、はっきりとした発音で"` を入れると話速まで落ちる（4.32s → 7.64s）。**「ゆっくり」は生成側に入れない。** `playbackRate` 側で使う。

---

## 5. 採用設定

```
model:      google/gemini-3.8-flash-lite-tts   (OpenRouter 経由)
voice:      Ludo
instructions: "Narration"
response_format: "pcm"                          (→ WAV 化)
話速:        playbackRate 0.9 (クライアント側)
生成:        1文 = 1リクエスト (タイムスタンプ無しのため分割不可)
```

### 1文 = 1リクエストの根拠

出力の `AudioContent` は `channels`/`data`/`mime_type` の 3 フィールドのみ。`start_offset`/`end_offset`/`duration` が存在しない。**1リクエスト複数文 → 連続した1本の音声が返り、機械的分割が原理的に不可能。** 既存 Gemini 実装は全てこの回避策を選んでいる。

## 6. 費用

- 全 189文（`babel-import.json`）: 約 $0.25（lite、Standard）
- Free Tier では 19日必要 → **OpenRouter 経由**（Gemini の天井が適用されない）
