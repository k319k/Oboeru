# Gemini 3.8 TTS のコスト最小化レポート (事前生成 + R2 配信前提)

> **本レポートは調査記録であり、本番コードでも実運用の構成でもない。**
> 前提の「事前生成 + R2 配信」は**棄却済み** — 本番はクライアントの IndexedDB キャッシュ
> (`src/lib/tts-cache.ts`)。文あたりの生成費用の試算と `flex` tier の数値は価格判断の参考として
> 残っているが、R2 のバケット費用や転送量を前提に読み替えないこと。実装で採用した構成の
> 正は `docs/superpowers/specs/2026-09-29-gemini-tts-migration-design.md` を参照。
> Spike スクリプト (`scripts/spike-*.mjs`) は 2026-09-29 に削除済み。

- 調査日: 2026-09-28 (各公式ページ最終更新日: pricing 2026-09-02 / rate-limits 2026-09-02 / speech-generation 2026-09-24 / interactions-overview 2026-09-23 / R2 pricing 取得日 2026-09-28)
- 対象モデル: `gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts` (**両モデルの実在を確認済み**。`gemini-3.1-flash-tts-preview` は legacy に降格)
- 確度の表記: **高** = 公式ページに明記 / **中** = 公式ページの記述から妥当な帰結 (本文に根拠を示す) / **未確認** = 公開ドキュメントに記載なし (実測方法を提示)

---

## 0. 結論サマリ (先に読む部分)

| # | 施策 | 効果 | 確度 |
|---|---|---|---|
| A | **`service_tier: "flex"` を付けるだけで 50% オフ** (`interactions` で同期・同じエンドポイント) | 1000文×30秒: $6.75 → **$3.38** | 高 |
| B | **2026-12-31 までに全文を事前生成して R2 に固定** | 2027年の値上げから永久に分離。1000文なら $3.38 固定 (値上げ後は $6.75) | 高 |
| C | **生成は1回、速度変更は `HTMLAudioElement.playbackRate`** | 速度設定を N 倍増やしても生成コスト不変 | 高 (生成側の話速数値指定が存在しないため) |
| D | **R2 は無視してよい** (egress 無料、1000文で月額 $0.02) | Gemini 生成費の 1/300 以下 | 高 |
| E | **Context Caching は無視してよい** (TTS 入力は数十トークン、効果上限 0.4%) | 事実上ゼロ | 高 |
| F | Batch API は 50% オフだが **`interactions` では使えない** | 採用すると `generateContent` への移植が必要 | 高 |

**ボトルネックは「生成回数 × 音声秒数」だけ。** R2 もキャッシュもレート制限もコストの主因ではない。
`1回生成 + クライアント変速` を採用して初めて、生成回数が文数と 1:1 になり、初めてコストが頭打ちになる。

---

## 1. 価格表 (公式) — 前提の検証結果

出典: https://ai.google.dev/gemini-api/docs/pricing (確度: **高**)

前提として挙げた数値は**全て公式と一致**した。以下は増幅して使うための算出表。

音声トークン = 25 tokens/秒 (公式注記 "Audio tokens correspond to 25 tokens per second of audio")。

### 2026-12-31 まで (Standard)

| モデル / tier | 出力 $/1M audio tok | 10秒あたり | 30秒 (1文) | 1000文×30秒 |
|---|---|---|---|---|
| flash-tts / Standard | $9.00 | $0.00225 | $0.00675 | **$6.75** |
| flash-tts / Batch・Flex | $4.50 | $0.001125 | $0.003375 | **$3.375** |
| lite-tts / Standard | $6.00 | $0.00150 | $0.00450 | $4.50 |
| lite-tts / Batch・Flex | $3.00 | $0.00075 | $0.00225 | **$2.25** |
| flash-tts / Priority | $16.20 | $0.00405 | $0.01215 | $12.15 |
| lite-tts / Priority | $10.80 | $0.00270 | $0.00810 | $8.10 |

### 2027-01-01 から (2倍)

| モデル / tier | 出力 $/1M | 30秒 (1文) | 1000文×30秒 |
|---|---|---|---|
| flash-tts / Standard | $18.00 | $0.0135 | $13.50 |
| flash-tts / Batch・Flex | $9.00 | $0.00675 | $6.75 |
| lite-tts / Standard | $12.00 | $0.0090 | $9.00 |
| lite-tts / Batch・Flex | $6.00 | $0.0045 | $4.50 |

入力価格 (text): $0.50/1M (Standard、2026) / $1.00 (2027~)。Batch・Flex は $0.25。
→ **日本語1文 (30〜60トークン) の入力費は $0.00003 未満。入力は論点外。**

**Priority は 1.8 倍。使う理由がない。確度: 高** (pricing ページ "$16.20 (audio)" vs Standard "$9.00")。

### 施策 B の価値 (これが最大の削減)

事前生成 + R2 構成であれば、**2026-12-31 までに全文を生成しておけば、値上げの影響を永久に回避できる**。
40,000文を溜める規模でも 2026年中に $135 (Flex) で永久固定できる。確度: 高 (価格は 2027-01-01 で倍増する日程が公式に明記されている)。

---

## 2. 調査①: Free Tier の実 Limits

### 確認できたこと (確度: 高)

出典: https://ai.google.dev/gemini-api/docs/pricing

Free / Paid の比較表に以下が明記されている。

- Free: "Limited access to certain models" / "Free input & output tokens" / "**Content used to improve our products**"
- Paid: "**Access to Context caching**" / "**Batch API (50% cost reduction)**"

→ **Context Caching と Batch API は Paid 専用。** モデル個別の価格表でも Batch / Flex の Free Tier 列は "Not available" と書かれている。

出典: https://ai.google.dev/gemini-api/docs/rate-limits (最終更新 2026-09-02)

- 3 次元のリミット (RPM / TPM(入力) / RPD) があることは明記。
- **RPM / TPM / RPD のモデル別実数値は公開ドキュメントから削除されている。** ページ本文は "View your active rate limits in AI Studio" とし、指標別の表を出していない。
- Batch の "Batch enqueued tokens" のみ表が公開されており、TTS モデルの行は **2 世代前のみ**:
  - Tier 1: `Gemini 2.5 Pro TTS` 25,000 / `Gemini 2.5 Flash TTS` 100,000
  - Tier 2: 100,000 / 100,000
  - Tier 3: 1,000,000 / 4,000,000
  - **`gemini-3.8-flash-tts` / `-lite-tts` の行は無い** → 3.8 系 TTS の enqueue 上限は **未確認**。
- 支出ベースのリミット (確度: 高): Free = N/A、**Tier 1 = $10 / 10 分**、Tier 2 = $50、Tier 3 = $200。rolling 10 分窓。超過時は `429 RESOURCE_EXHAUSTED`。
  → 実務換算: 30秒文 ($0.00675) なら **10分あたり最大 1,481 文**、1時間なら約 8,880 文。これは「月額コスト」ではなく「スループットの天井」。
- Tier 昇格条件 (確度: 高): Free → Tier 1 は請求アカウント紐付けのみ。Tier 1 の請求上限は **$250**、Tier 2 は累計 $100 支 + 3日、ティア 3 は $1,000 + 30日。

### 未確認事項と実測方法

| 未確認 | 実測方法 |
|---|---|
| `gemini-3.8-flash-tts` の Free Tier RPM / TPM / RPD | AI Studio の Rate Limits ページ (要ログイン、API キー不要) で tier を切り替えて確認する。 |
| 3.8 系 TTS が Free Tier で実際に生成できるか | Free Tier の Google AI Studio (https://aistudio.google.com/generate-speech) で `gemini-3.8-flash-tts` を選び 1文生成し、成功するか見る |
| 3.8 系 TTS の Batch enqueue 上限 | Tier 1 を作って `batchGenerateContent` に 100,000 tokens (約 4,000秒音声 = 66分) 超を投入し、`429` のメッセージから上限を読む。 |

### Free Tier でコストゼロに収められるか (結論)

**収められる。** Free Tier では入力も出力も "Free of charge" なので、1000文を全部生成しても $0。
ただし 3 つの留保がある。

1. **Batch / Flex が使えない** → 無料枠で 50% オフは取れない (無料枠では不要だが、制約として記録)。
2. **Context Caching が使えない** → 影響は 0 (§4 参照)。
3. **"Content used to improve our products" = Yes** → practice で練習する文がサービス改善の学習材料にされる。公開練習データでない前提なら問題なし。気になるなら Paid にする。確度: 高 (pricing ページの明記)。

**したがって「コスト最小化」と「無料枠」は本質的に別問題。** この app の 1000文規模では生成コストは無視できる水準であり、反而 *運用設計* (設定変更ごとの再生成) の方が桁で効く。

---

## 3. 調査②: Batch API

出典: https://ai.google.dev/gemini-api/docs/batch-api (確度: **高**)

- 半額: "asynchronously at **50% of the standard cost**"。SLO は 24 時間 ("designed to complete within a 24-hour turnaround time")、実際は多くの場合それより速い。
- 制約: 同時バッチ 100、入力ファイル 2GB、ファイルストレージ 20GB。

### 決定的な制約: **`interactions` では Batch を使えない**

2 つの公式ページが一致している。

1. batch-api ページ冒頭: "**Note: This feature is currently only available with the generateContent API.** Please follow the content on this page for more information."
2. https://ai.google.dev/gemini-api/docs/interactions-overview の "Limitations":
   > "The following features are supported by the generateContent API but are **not yet available in the Interactions API**: **Batch API** / Automatic function calling (Python) / **Explicit caching** / Safety settings"

3. https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts の Capabilities 表:
   `Batch API: Supported` / `Flex inference: Supported` / `Priority inference: Supported` / `Caching: Supported`
   トークン上限: 入力 **8,192** / 出力 **16,384 (Gemini API serving limit)** (= 16,384/25 = **655.36 秒** ≈ 10.9 分) — 前提と一致。確度: 高。
   `gemini-3.8-flash-lite-tts` も同じ値。

→ モデル自体は Batch 対応だが、**Batch = `models/{model}:batchGenerateContent` への移植が必要**。`interactions` の payload (`response_format` / `output_audio.data`) から別スキーマ (`generationConfig.speechConfig` / `inlineData`) への書き換えが発生する。確度: 高。

### 判定: Batch 化の複雑さに見合うか → **No**

R2 事前生成のケースで Batch 化すると、工程が「job 作成 → (最長 24h) ポーリング → JSONL ダウンロード → 1行ずつデコード → R2 書込」になる。
同じ 50% を **Flex** で、**同じエンドポイントに 1 パラメータ追加**、同期で試せる (次項)。1000文規模では Batch の利点は「スループット」だけで、律速は既に十分 (§2 の spend limit 参照)。

---

## 4. 最重要発見: **Flex inference が `interactions` で使える** (Batch の代用)

出典: https://ai.google.dev/gemini-api/docs/flex-inference (確度: **高**)

- "Gemini Flex inference is an inference tier that offers a **50% cost reduction** compared to standard rates, in exchange for variable latency and best-effort availability."
- REST の例は **`POST https://generativelanguage.googleapis.com/v1beta/interactions` に `"service_tier": "flex"`** を付ける形。つまり **既存の TTS 呼び出しに 1 キー追加**で済む。
- 比較表 (公式):

  | | Flex | Priority | Standard | Batch |
  |---|---|---|---|---|
  | Pricing | **50% discount** | 75-100% more | Full price | 50% discount |
  | Latency | **Minutes (1–15 min target)** | Low (Seconds) | Seconds to minutes | Up to 24 hours |
  | Reliability | **Best-effort (Sheddable)** | High | High / Medium-high | High |
  | Interface | **Synchronous** | Synchronous | Synchronous | Asynchronous |

- 運用上の義務 (公式が明示):
  - **サーバーサイドのフォールバックなし**。Flex 枠が満杯でも Standard に自動昇格しない (想定外の課金を避けるため)。
  - **クライアント側のリトライ実装が必須** (指数バックオフ)。`503 Service Unavailable` と `429 Too Many Requests` を処理。
  - **クライアント timeout を 600 秒以上**に設定。
  - リミット: "Flex inference traffic counts towards your general rate limits; it doesn't offer extended rate limits like the Batch API." → 高速化にはならない (§2 の spend limit が天井)。
- モデルページの Capabilities に `Flex inference: Supported` と明記。pricing ページの Flex 行は出力 $4.50 (flash) / $3.00 (lite) で Batch と同額。Free Tier 列は "Not available" → **Paid 必須**。

**結論: 事前生成には Flex を使う。** 同期なので実装は「既存ループに `service_tier: 'flex'` を追加 + 指数バックオフ + 10分 timeout + 失敗分をキューに再投入」だけ。Batch 化の複雑さは不要。

**未確認**: 8kHz/16kHz 出力や日本語で Flex のキュー時間が 1〜15 分の目標を大きく超えないこと。→ 実測: 100文を `service_tier: "flex"` で回して実測 p50/p95 を記録する。確度: 中 (docs の目標値は明記だが実測なし)。

---

## 5. 調査③: Context Caching — **無視してよい**

出典: https://ai.google.dev/gemini-api/docs/caching (最終更新 2026-09-02、確度: **高**)

- "The Interactions API only supports **implicit** caching. **Explicit caching (manually creating and managing cache objects) is not supported in the Interactions API.**" → 明示的キャッシュを使うには `generateContent` API へ切り替える。
- interactions-overview 側でも同じ。"Explicit caching: not yet available in the Interactions API"、ただし "server-side implicit caching **is** available in the Interactions API via `previous_interaction_id`"。
- Implicit caching の最小トークン表は **テキストモデルのみ**: 3.8 Flash / 3.7 / 3.6 / 3.5 / 3.1 Pro Preview = 4,096、2.5 Flash / 2.5 Pro = 2,048。**TTS モデルの行が無い。**

### 就算: 100% 命中しても効果がほぼゼロ

| | 値 |
|---|---|
| 1文の入力 | 日本語 30〜60 トークン |
| 入力単価 | $0.50 / 1M tok |
| 1文あたりの入力費 | **$0.00003** |
| 1文の出力費 (30秒, flash Standard) | $0.00675 |
| 入力トークンをすべて無料にしても得られる削減の上限 | **$0.00003 / $0.00675 = 0.44%** |

→ **caching で現実的に得られる削減額は 1文あたり 0.03 セント未満。** かつ最小 4,096 トークン条件に対し 1文の入力は 60 トークン程度なので、そもそも命中しない可能性が高い。確度: 高 (理屈は確定。命中可否だけが未確認だが、仮に 100% 命中しても 0.44%)。

**残された微妙なシナリオ**: 100文を 1リクエストにまとめて「共通 style 前置き」を 4,096 トークン以上にした場合、その前置きは implicit cache の対象から外れない。**それでも効果は入力側のみで 0.44% 未満。** 結論は変わらない (しかも §9-d のとおり複数文まとめは他の理由でNG)。

**実測方法**: 1リクエストを流してレスポンスの `usage.total_cached_tokens` を読む。0 なら非対応確定。

---

## 6. 調査④: 生成1回 + クライアント変速 (最も推奨)

### Gemini 側に数値で話速を指定する手段は存在しない (確度: **高**)

https://ai.google.dev/gemini-api/docs/speech-generation の "Pacing and pauses" を全文確認した。制御手段は 3 つだけ:

1. "Punctuation and ellipses: Use commas, dashes (`--`), and ellipses (`...`) for natural conversational hesitation."
2. "Inline pause tags: Insert `<short pause>` or `<long pause>` at exact points"
3. "**Turn-level pace: Set `"style": "speaking rapidly"` or `"style": "speaking slowly"` in `speech_metadata` to control the speaking rate across the whole turn.**"

→ **数値パラメータは無い。** 英語のプロンプト (自然言語) を通すしかなく、再生成するしかない。話速を数値で指定する API は無い。確度: 高 (公式ドキュメントに存在しない = 断定)。もし API スキーマに見落としがある場合は SDK の `SpeechConfig` 型定義で `rate` / `speed` フィールドの有無を IDE 補完で確認する (実測方法)。

### したがって: 速度設定を N 種類持つ = 生成コスト N 倍、を回避する唯一の手段がクライアント変速

| 速度設定の数 | サーバー生成 | クライアント `playbackRate` |
|---|---|---|
| 1 種 | $6.75 | $6.75 |
| 3 種 | $20.25 | **$6.75** |
| 5 種 | $33.75 | **$6.75** |
| 5 種 × 5 声 | $168.75 | $6.75 |

(Flex を併用すれば全て半分。1000文×30秒基準、flash、2026年価格)

**確度: 高** (生成回数が線形に増えることは確実。`playbackRate` による短縮も確実。ただし品質面は次項。)

### 変速の品質: pitch が動く (これは Gemini 側の話ではなくブラウザの挙動)

- `HTMLAudioElement.playbackRate` は **time-stretch ではなく再生位置の再サンプリング**なので、再生速度を変えると**ピッチも一緒に変わる**。日本語はモーラが基本なので、母音の高さが変わると「native の発音」に見えにくい。`preservesPitch` が効く実装 (webkit の `audio.preservesPitch`、Firefox は対応状況が異なる) でも、**0.5〜1.2 倍程度が実用域**。0.5 倍以下は計算補正の pitch と音质劣化が乖離しやすい。
- **対比**: Cloud TTS 系はサーバー側に `speakingRate` (例: 0.9〜1.1) を持つ。サーバー側変速は time-stretch でピッチ不変。

**確度: 中** (ブラウザ挙動と実装依存の領域のため、公式 Gemini ドキュメントからは導けない。実測方法: 実際、日本語文を 0.85 / 1.0 / 1.15 で再生し、録音して母音の F0 を比較。1.0 比で 2 半音以上のズレがあれば練習用途では許容不可)。

**実務上の推奨 (確度: 高)**: 変速倍率は **0.9〜1.1 の 3 段**に絞る。この範囲ならサーバー生成は 1 回で済み、ピッチの変化は許容できる。0.7 倍のような「ゆっくり練習」用途だけ、**別に 1 本だけ slow 版を生成**する (slow 版だけ 2 倍になるが、影響は限定的)。

### 「生成は1回」という設計は、公式ドキュメントも同じ方針を支持している

speech-generation の "Consistency across generations" と "Recommended workflow":

- "**Design personas upfront in Voice design** instead of long style blocks" → キャラクター設計は `voice_...` ID に固定。
- "design the persona upfront in Voice design and use style only for optional turn-level tweaks" / "carry that voice ID through your TTS calls with minimal or empty style strings" → **voice ID を全文で共通化する**。
- "**Test plain TTS first: Synthesize your transcript with an empty style field first—most requests need no style instruction at all.**" → style は空が基準。
- "**Leave the per-turn style field empty, or send one short constant string (such as "casual, friendly") for the whole conversation.**"
- "Do not include instructions telling the model to hold the voice steady… **extra prompt text increases drift**."

→ **「style を 1 つに固定」は公式が推奨する品質最適化であると同時に、コスト最適化でもある。** 確度: 高。

**日本語への注意 (確度: 高)**: "Note: If your transcript is in a non-English language, continue to use **English** inline tags for best results." → `speech_metadata.style` は英語で書くべき。
また日本語は両モデルともサポート: speech-generation の Supported languages 表で Japanese = ✔️ / ✔️ (flash / lite)。確度: 高。

---

## 7. 調査⑤: テキスト短縮で出力トークンを削る

出力トークン = 生成された音声の秒数 × 25。したがって **音声が短くなれば必ず安い**。演算可能なレバーは 3 つだけ。

| レバー | 効果 | 副作用 | 確度 |
|---|---|---|---|
| (a) 文自体を短くする (1文 = 1文) | 線形 | 練習の自由度を落とす。文章の言い換えが必要。 | 高 |
| (b) `style: "speaking rapidly"` | 30秒 → 例えば 25秒 (△17%) | 練習には「ゆっくり」が望ましいので逆方向 | 中 (効果量はモデル依存・非決定的。**実測必須**) |
| (c) `<long pause>` / `<short pause>` を入れない | 停止を削れる | 韻律が平板になる。**停止タグを使わないことが最も安全な削減レバー** | 高 (音時間は必ず増える) |

**推奨**: (c) を常時適用 (練習用途ではテンポよく読ませたいので副作用最小)、(a) は文の分割で実装 (1文 = 1文。1文が 60〜80 文字を超えると日本語の朗読で 30 秒を超え、成本が跳ね上がる)。**(b) は採用しない。** 速度を遅くすると音声が長くなり、コストを上げる。「ゆっくり読む」版が欲しければ別途 1 本だけ生成する方が安い。

### 「早く読ませれば短くなる」か → 理論上はそうだが制御できない

`style: "speaking rapidly"` はプロンプトであり、保証された速度係数ではない。同じ style を渡しても再生秒数は文脈依存で数%〜数十%揺れる。**コスト削減手段として数えるのは危険。** 確度: 中 → 実測: 同一 style で 20 文生成し、実測秒数の平均とばらつき (標準偏差) を取る。標準偏差が 10% を超えていれば、秒数ベースのコスト試算に 1 割のバッファを持たせるのが安全。

### 品質もコストも逆効果 — disfluencies (くちごわえ) は入れない

speech-generation は自然さのため disfluencies ("Oh uh yeah I think...") を推奨しているが、これは**出力秒数を増やし (=コスト増)、しかも練習アプリでは不正確な読み上げになる**。→ **採用しない。** 確度: 高 (練習用途の要求から導かれる)。

---

## 8. 調査⑥: Cloudflare R2 — 前提の数字に誤りがあるので訂正

出典: https://developers.cloudflare.com/r2/pricing/ (取得 2026-09-28、確度: **高**)

| 項目 | Standard | Infrequent Access |
|---|---|---|
| ストレージ | **$0.015 / GB-month** | $0.01 / GB-month |
| Class A (PutObject, List など) | $4.50 / 1M リクエスト | $9.00 / 1M |
| Class B (GetObject など) | $0.36 / 1M リクエスト | $0.90 / 1M |
| Data Retrieval | なし | $0.01 / GB |
| **Egress (Internet 送信)** | **無料** | **無料** |

**無料枠 (毎月)**: ストレージ **10 GB-month**、Class A **100 万**、Class B **1,000 万**、egress 無制限無料。Standard ストレージにのみ適用。

### ⚠️ 前提の「30秒・24kHz・mono・16bit = 約90KB/文」は計算が合っていない

24,000 samples/s × 2 bytes × 30 s = **1,440,000 bytes ≈ 1.37 MiB / 文**。90KB なら 24kHz では 1.9 秒分にしかならない。

実際のフォーマット別サイズ (30秒):

| 設定 | サイズ / 文 | 1000文 | R2 月額 (Standard) |
|---|---|---|---|
| 24kHz / 16bit (unary デフォルト WAV) | 1.37 MiB | 1.34 GiB | **$0.020** |
| 16kHz / 16bit | 0.92 MiB | 0.92 GiB | $0.014 |
| 8kHz / 16bit | 0.46 MiB | 0.46 GiB | $0.007 |
| 8kHz / 8bit (mulaw / alaw) | 0.23 MiB | 0.23 GiB | $0.003 |

出典: speech-generation の "Audio output formats" — `response_format` に `mime_type` (`audio/wav` / `audio/l16` / `audio/mulaw` / `audio/alaw`) と `sample_rate` (24000 / 16000 / 8000) を指定できる。確度: 高。

**配信コスト**: 1000文を 1日 20 回再生 = 600,000 GetObject/月 = **$0.216**、無料枠 (1,000万) の範囲内。 → **$0**。
**生成コストとの比**: flash Standard $6.75 (1000文) vs R2 $0.02/月 = **約 340 倍**。R2 はボトルネックにならない。確度: 高。

**10,000文に拡張しても**: 24kHz なら 13.4 GiB → $0.20/月 (無料枠 10GB 超過分)。Class B も 1日 20 回なら 600万 = 無料枠内。
**Infrequent Access は使わない。** ストレージ料が安いが Data Retrieval $0.01/GB が読み取りごとに付くため、**GET 回数が読み取り回数に比例する構成では不利**。確度: 高 (R2 pricing ページの free tier 注意書きに "does not apply to Infrequent Access storage" あり)。

### 既存構成 (毎回生成) との比較

| | Gemini (毎回生成) | 事前生成 + R2 |
|---|---|---|
| 1000文を 1 回生成 | $6.75 | $6.75 |
| 1,000文を 100日間に 1回ずつ生成 | **$675** | $6.75 |
| 速度設定を 3 倍 | $20.25 | $6.75 |
| 速度 3 × 声 5 | $168.75 | $6.75 |

→ **事前生成 + R2 の効果 here で 100 倍以上。** これが実運用の月額を桁違いに下げる唯一のレバー。確度: 高 (内訳は算術)。

---

## 9. 調査⑦: その他の節約可能性

### (a) `stream: true` でコスト差があるか → **価格表に差異なし (確度: 高 / 効果は未確認)**

- pricing ページの TTS セクションに streaming の項目は存在しない。課金は生成された音声トークン (25 tok/s) ベースで、転送モードの記載はない。
- speech-generation: "Unlike unary requests (which return a complete WAV file with a RIFF header), streaming requests return headerless raw 16-bit signed little-endian linear PCM (`audio/l16`, 24 kHz, mono) chunks by default" → **出力フォーマットが変わるだけ**。44 バイトの WAV ヘッダが不要になる程度の差。
- **推測 (未確認)**: 途中で切断すれば未生成の音声は課金されない可能性はあるが、ドキュメントの記載がない。→ 実測: 同一 style 2 本 (unary / stream) を生成し、`usage` の token 数と実測 wav バイト数を比較。

**判定: 事前生成では unary (または stream) のどちらでも構わない。** 判断材料は「R2 に書く形式」だけ。

### (b) `audio/l16` でバッファが小さくなるが課金は変わらない → **その通り (確度: 高)**

課金は「25 tokens per second of audio」で、**サンプリングレートもビット深度も依存しない**。したがって `sample_rate: 8000` / `audio/mulaw` は:

- ファイルサイズは 1/3 〜 1/6 に削減 (§8 の表)
- **それでもコストは一切減らない** (課金は時間ベース)
- R2 費用も無料枠内なので、実質 **どちらでもよい**。

**唯一の判断材料は互換性**: iOS Safari / Android Chrome の `<audio>` で 8kHz 8bit G.711 を安定再生できる保証はないため、**練習用途では 24kHz 16bit を推奨**。練習では母音の高さと子音が聞こえないと意味をなさない。確度: 中 (ブラウザの format support 依存の領域。実測: 実機で再生してから判断)。

### (c) 話速を `generation_config` で数値指定する方法 → **存在しない (確度: 高)**

§6 で確認済み。使えるのは `speech_metadata.style` の自然言語 (`"speaking rapidly"` / `"speaking slowly"`) とインラインタグのみ。数値パラメータは存在しない。pricing ページにも speech generation ページにも記載がない。
**再確認済み。** 実測方法: SDK の `SpeechConfig` / `SpeechMetadata` 型定義 (Python `google.genai.types` / JS `@google/genai`) に `rate` `speed` `speaking_rate` が存在するかを確認。存在しなければ確定。

### (d) 複数文を 1 リクエストにまとめる → ** 割引なし。逆効果 (確度: 高)**

- Batch / Flex / Priority のどの表にも「リクエスト数割引」に相当する行は存在しない。課金は総音声秒数ベース。
- リクエスト数自体に Docs 上の単位当たりの費用はない。よって **コスト差 = 0**。
- 副作用:
  - 1文の不備でチャンク全体が破棄される (文ごとの再生成単位を失う)
  - 韻律が連続するため、1文単位の再生・差分表示・区切り単位での前後再生ができなくなる
  - `<short pause>` で区切れば音時間は増える = コスト増
- 公式の推奨は逆方向: "Make **one TTS call per turn**"、"Split long agent responses into shorter turns"。

**判定: 1文 = 1リクエストを維持。**

---

## 10. 未確認事項の一覧 (実測が要るもの)

| # | 項目 | 実測方法 | 影響 |
|---|---|---|---|
| 1 | 3.8 系 TTS の Free Tier RPM / TPM / RPD | AI Studio の Rate Limits ページ (要ログイン、キー不要) | 無料枠の使える量 |
| 2 | 3.8 系 TTS の Batch enqueued tokens 上限 | Tier 1 で `batchGenerateContent` に大量投入し 429 のメッセージを読む | Batch 採用可否 (本レポートでは不採用) |
| 3 | Flex の実測レイテンシ (日本語・8kHz/24kHz) | 100文を `service_tier: "flex"` で回して p50 / p95 を記録 | 生成ジョブの制御方式 |
| 4 | Flex の失敗率 (503) | 同上の 100 文中の失敗数を記録。指数バックオフレトライで吸収可能か | リトライ実装の必要性 |
| 5 | `usage.total_cached_tokens` が TTS で 0 になること | 1文生成してレスポンス usage を読む (不要だが便宜) | 確定 (影響 0.44% 以下) |
| 6 | `playbackRate` 変速でのピッチ偏移 | 日本語文を 0.85 / 1.0 / 1.15 で再生し録音、母音 F0 を比較 | 変速倍数の範囲 |
| 7 | `style: "speaking rapidly"` による秒数削減の再現性 | 同一 style で 20文生成し実測秒数の平均と標準偏差 | (b) レバーを使うか否か (推奨: 使わない) |
| 8 | 8kHz mulaw の実機再生可否 | Android Chrome / iOS Safari で再生 | ファイルサイズ最適化の効果 |
| 9 | 8kHz / 16kHz 出力での Flex 対応 | 1リクエスト実測 | 記録のみ |

---

## 11. 最終提案 (実装判断)

**1. `service_tier: "flex"` を採用する。** Batch ではない。理由は §3/§4。
- 事前生成ジョブ (管理画面あるいは CI) からのみ Flex を使う。ユーザー操作中の同期呼び出しは **Standard** のまま (遅延 1〜15 分は許容不可) にする。
- 失敗分は指数バックオフで再投入。10 分 timeout。

**2. 2026-12-31 までに全文を事前生成して R2 に固定。** 一番大きい削減。1000文なら $3.38 (Flex)、値上げ後も永久に $3.38 で済み、2027年なら $6.75 に対し **2 倍の差**が永久に固定される。

**3. 速度設定は生成パラメータにしない。** 3.8 TTS に数値話速は無い → 変速は `playbackRate` で。倍率は **0.9 / 1.0 / 1.1** の 3 段に固定。練習用の「遅い版」が必要なら **slow 設定だけ別途 1 本**生成する (2倍)。

**4. `speech_metadata.style` は 1 個の固定文字列、または空。** voice は `voice_...` ID (Voice design) に固定。公式が推奨するそのまま。品質もコストも向上。

**5. インラインタグは原則使わない** (`<long pause>` は避ける)。英語タグで。→ 音時間 = コスト。

**6. 文は短く保つ。** 1文 = 1リクエスト。35〜45 文字 (日本語) が 30 秒以内の上限。Google の日本語 snippet を 1文 = 1文に分割する。

**7. R2 は 24kHz/16bit のまま。** 圧縮しても生成コストは下がらないので、**練習で合格する音质を取る**。R2 費用は無視。

**8. Context Caching は無視。** コードの複雑性が増えない。

**9. 支出ガードを二重に張る。**
- プロジェクト/アカウントの **monthly spend cap** (billing ドキュメントに明記。プロジェクト単位は experimental、AI Studio から設定) を設定。
- Free Tier は「コストゼロだが学習データ再利用」のみリスク。**公開練習データでないなら Free Tier で完結し、Batch / Flex を使うための Paid 化は不要** —— ただし 50% オフは Paid 専用なので、$3.38 のために Paid へ上げるのは損。

**10. 現状のまま (文ごとに1回事前生成 + R2) なら、月額コストはほぼゼロ。** 1000文で R2 $0.02/月。Gemini 生成は初期 $3.38 のみ。**「実運用でどこがボトルネックか」への回答: ボトルネックはほぼ無い。すべての節約策を解除しても 1000文で $6.75 の一回きり。** 100 倍となるのは「設定変更で再生成する」設計を残したときだけ。

---

## 12. 出典一覧

| 内容 | URL | 最終更新 |
|---|---|---|
| 価格 (TTS 全部) | https://ai.google.dev/gemini-api/docs/pricing | 2026-09-02 |
| レート制限 (3 次元のリミット・spend limit・tier・batch enqueued) | https://ai.google.dev/gemini-api/docs/rate-limits | 2026-09-02 |
| TTS ガイド (style / pause / format / sample_rate / 制限) | https://ai.google.dev/gemini-api/docs/speech-generation | 2026-09-24 |
| モデル仕様 flash-tts (8,192 / 16,384 / Caching / Batch / Flex) | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts | Sep 2026 |
| モデル仕様 lite-tts | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts | Sep 2026 |
| Interactions API (Batch / Explicit caching 非対応) | https://ai.google.dev/gemini-api/docs/interactions-overview | 2026-09-23 |
| Context Caching (implicit のみ / 最小トークン表) | https://ai.google.dev/gemini-api/docs/caching | 2026-09-02 |
| Batch API (generateContent のみ / 24h) | https://ai.google.dev/gemini-api/docs/batch-api | — |
| Flex inference (service_tier: flex / 同期 / 50%) | https://ai.google.dev/gemini-api/docs/flex-inference | — |
| 請求・tier 昇格・spend cap | https://ai.google.dev/gemini-api/docs/billing | — |
| 対応リージョン (Japan 掲載) | https://ai.google.dev/gemini-api/docs/available-regions | — |
| R2 料金 | https://developers.cloudflare.com/r2/pricing/ | 取得 2026-09-28 |

非公式情報 (Community / blog) は本レポートの判断に **一切使用していない**。
