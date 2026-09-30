# Gemini 3.8 TTS — 日本語発音練習用途の評価レポート

> **本レポートは調査記録であり、本番コードではない。**
> ここで参照した Spike スクリプト (`scripts/spike-gemini-tts.mjs` / `spike-listen-set.mjs` /
> `spike-listen-set2.mjs` / `fix-wav.mjs`) は 2026-09-29 に削除済み。実測は当時の
> `GEMINI_API_KEY` 直叩き (`generativelanguage.googleapis.com`) でのもので、本番の
> `/api/tts` は **OpenRouter 経由** (`google/gemini-3.8-flash-lite-tts`、`OPENROUTER_API_KEY`)。

調査日: 2026-09-28 / 対象アプリ: おぼえる (SvelteKit on Cloudflare Workers)

**確度の凡例**

- `[公式]` = 一次ソース (ai.google.dev / cloud.google.com) に明記
- `[未確認]` = 一次ソースに記載がない / 実測していない
- `[非公式]` = 第三者。**本レポートでは該当なし** (日本語の第三者評価が検索で 1 件もヒットしなかった)

---

## 0. 結論

1. **gemini-3.8 系は Gemini Developer API (generativelanguage) 専用。Google Cloud TTS / Vertex AI には未搭載。**
   Cloud TTS の Gemini-TTS ページ (2026-09-28 時点) に載っているのは `gemini-3.1-flash-tts-preview` と 2.5 系のみ。`3.8` の文字列は当該ページ・モデルカード・DeepMind モデル一覧のいずれにも出現しない `[公式]`
   → **「Workers に API key 1 本だけ持ちたい」という要件は自動的に満たされる。GCP 認証を Workers secret に持ち込む必要は生じない。**

2. **日本語の発音・明瞭度について公式の実測データ (MOS / Elo / 人間評価) は存在しない。** `[未確認]`
   3.8 系は **2026-09-22 に GA** (changelog)。調査時点で 6 日しか経っておらず、日本語利用の第三者報告も 0 件。**この判断は「公式のポジショニング記述」だけに基づく。**

3. **「日本語の発音練習」という目的に対する公式の推奨は flash 側にある。ただし flash-lite の用例にも "read-aloud features" が明示されている。** これが唯一の判断の分かれ目。詳細は §1。

4. **コスト差は 30 分セッションあたり約 $0.14。品質優先なら flash を採るべき。**

5. **日本語の読み (数字・単位・熟語・二拍名詞) を直接制御する API が存在しない。** SSML もルビも音素入力も無い `[公式: 記載なし]`。対処はアプリ側 (本文のかな化 / style プロンプト) でしかできない。

6. **保険として Cloud TTS `ja-JP-Chirp3-HD-*` (30 voice) が残る。** 価格的には同程度むしろ安く、2027/01/01 の 3.8 値上げ後には 3 倍安になる。ただし SSML / 話速指定は非対応 `[公式]`。

---

## 1. モデル位置づけと品質差 (調査項目 1)

### 公式の記述

| 観点 | gemini-3.8-flash-tts | gemini-3.8-flash-lite-tts |
|---|---|---|
| Primary strength | 最大ボイス忠実度・演技の粒度・方言カバレッジ | スループット・低遅延・コスト効率 |
| Best use cases | Audiobook, studio narration, complex multi-speaker dialogue, **heavy vocal-burst acting, difficult pronunciation, regional dialects** | High-volume production, voice agent cascade, **read-aloud features**, voice replication, everyday single-speaker |
| 対応言語 | 130 | 101 (いずれも日本語を含む) |
| 単一 / 複数話者 | ○ / ○ | ○ / ○ |
| Voice design / replication | ○ / ○ | ○ / ○ |

出典: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts (flash-lite-tts ページにも同一の表がある)

> 「difficult pronunciation (難発音)」は flash の用例、「read-aloud features (読み上げ機能)」は flash-lite の用例。

### 評価: この app への当てはめ

本 app は「日本語の文を **高品質に読み上げて** 自分で復唱して練習する」ツールである。日本語を読める人にとっては文の難易度自体は高くないが、目的は **「発音が一語ずつ正確に再現されること」** である。

- **品質優先 (推奨) → flash。** 難読語 (二拍名詞・擬音・外来語の音訓) の読み誤りはこの app の中核的な失敗モードであり、公式が flash に割り当てている強みに直接該当する。
- **逆説的に flash-lite の "read-aloud features" に当たるか。** ただし同項目の "everyday single-speaker generation across major languages" に従えば価格差は障害にならない。差额的コスト (§1 末尾の表) を参照。

### 実測評価データの状態

| 項目 | 状態 |
|---|---|
| 公式 MOS / Elo | **存在しない。** ai.google.dev の料金ページ・モデルカード・changelog・DeepMind モデル一覧のいずれにも数値記載なし `[未確認]` |
| 日本語限定の比較データ | **存在しない** `[未確認]` |
| lite が何を犠牲にしているかの明示 | 定量なし。定性は「fidelity / acting nuance / 方言カバレッジ」の 3 軸のみで、韻律・リッチネスに関する記述は無い `[未確認]` |
| 長文安定性の実測 (日本語 500 字以上) | 公式の主張のみ (「rock-solid voice and room-tone stability」「long-form multi-turn stability」)。日本語での実測は無い `[未確認]` |
| ブレ / 繰り返し / 語尾脱落の発生率 | **公式報告なし。** 日本語固有の TTS 問題 (二拍名詞・擬音詞・撥音便) への言及も一切ない `[未確認]` |

### 判断材料としてのコスト

公式表記「$0.00225 per 10s audio」から実算:

| | flash | flash-lite | 差 |
|---|---|---|---|
| 10 秒あたり (〜2026/12/31) | $0.00225 | $0.00150 | $0.00075 |
| 10 秒あたり (2027/01/01〜) | $0.00450 | $0.00300 | $0.00150 |
| **1 回 30 分の練習セッション** | **$0.405** | $0.270 | $0.135 |
| 500 回/月 (1 日 1 回) | $202 | $135 | $67 |

出典: https://ai.google.dev/gemini-api/docs/pricing

> **前回セッションの前提に無い新情報: 2027 年 1 月 1 日から全 TTS モデルの单价が 2 倍になる。**
> flash は出力 $9→$18、lite は $6→$12、入力 $0.50→$1.00。launch 時の減価価格と見られる。**降りるなら今が最安。**

**Free Tier**: 両モデルとも入力・出力ともに "Free of charge"、ただし **"Used to improve our products: Yes"** `[公式]`。練習者の音声がモデル改善に使われる点が許容できるか要判断 (個人利用なら実害は小さいが、無償の一般ユーザー利用にはポリシー判断が必要)。

---

## 2. 日本語の発音を制御する具体手段 (本 app の中心機能 / 調査項目 2)

### 使えるもの `[公式]`

**A. `speech_metadata.style` — ターン単位の配送制御 (唯一の主力手段)**

公式の例: `"cheerful and friendly"` / `"whispered urgently"` / `"out of breath"` / `"warm and enthusiastic"` / `"speaking rapidly"` / `"speaking slowly"` / `"monotone and flat"` / `"high pitch, cheerful and excited inflection"`

日本語の発音練習に翻訳すると:

| 目的 | 想定 style 文字列 |
|---|---|
| 明瞭度の確保 (基本) | `"clear, slow, careful articulation"` |
| 母語者ナレーション | `"native Japanese narrator, educational audiobook, warm and clear"` |
| 漢字の読みを丁寧に | `"very slow, deliberate, enunciating each word distinctly"` |
| 平板な読み (復唱の基準に) | `"monotone and flat, neutral reading"` |
| 最重要ルール (公式) | **短い style 文字列を使う。**「hold the voice steady」「maintain identical timbre」等のメタ指示は **drift を増やす** と明記。空 style でまず試すのが推奨手順 |

**B. インライン補助タグ — その場限りの非発声音** (推奨タグ約 40 種: `<laugh>` `<sigh>` `<cough>` `<breath>` `<short pause>` `<long pause>` 他)

> **公式の明確な指定: 「If your transcript is in a non-English language, continue to use English inline tags for best results.」**
> → 日本語文中に `<ため息>` や `<笑>` と書いても **効果なし**。必ず英語タグを書く。日本語利用で確実に効く点。

**C. ペースと間 (3 段階)**

1. 句読点のみ: `,` `--` `...` (会話的な躊躇)
2. インラインタグ: `<short pause>` / `<long pause>`
3. ターン単位: `style: "speaking slowly"` / `"speaking rapidly"`

**D. 強調**: 本文中の大文字 (英語前提。日本語には無効) `[未確認: 日本語のテキストで強調として機能するかは docs に記載がない]`

### 使えないもの (公式に記載が無い) `[公式: 記載なし]`

| 制御したいもの | API での手段 | 判定 |
|---|---|---|
| **SSML** (`<phoneme>` `<sub>` `<break time=>` `<prosody rate=>`) | なし | **存在しない。** Gemini API TTS に SSML 入力は無い |
| **ルビ / 読み仮名の指定** (漢字の読みを直接指定) | なし | **存在しない。** `phoneme` / `ruby` / `kana` の概念がドキュメントに一切出てこない |
| **音素 (IPA) 入力** | なし | **存在しない** |
| **数字・単位の読み分け** (`3階`→`さんかい` / `100km`→`ひゃくキロ` / `2,500円`→`にせんごひゃくえん`) | なし | **専用 API が無い。** 素のテキストを渡す。読みは LLM 系のテキスト正規化に任される |
| **テキスト正規化 (日付・金額) の明示的適用** | なし | **Gemini API 3.8 には記載なし。** あるのは Cloud TTS API の 3.1 preview 側のみ (§3) |
| **不規則な日本語発音への個別対処** (擬音・二拍名詞・熟語の誤読修正) | なし | **公式の対処指針なし。** 手段は ①アプリ側で本文をかな書きに差し替える ②style で負荷を下げる の 2 つ |

### 実務上の含意 (本 app の実装方針)

1. **`style` を日本語で書くか英語か。**
   公式はインラインタグについてのみ「英語を使う」と明記。`speech_metadata.style` の**言語指定はドキュメントに無い** `[未確認]`。
   → **英語指定を既定にすべき。** 公式推奨の英語タグ方針と整合し、未確認の挙動を踏まずに済む。日本語 style を試すなら spike で A/B する。

2. **数字・単位・熟語はアプリ側でかな化する。**
   例: `3階` を `3階` / `三階` / `三階 (さんかい)` の 3 通りで spike し、最も正しい形式を TTS 用テキストの既定にする。表示用テキストと TTS 用テキストを分ける必要が出る可能性が高い。

3. **反復・脱落の対策**は、1 文を分割して複数リクエストにする / 句点で `<short pause>` を挟む、程度しか策が無い `[未確認: 分割が逆に接合部の不連続を生む可能性]`

### 長文・大量入力の制約 `[公式]`

| 項目 | 値 |
|---|---|
| 入力上限 | 8,192 text token |
| 出力上限 | 16,384 audio token (25 token/秒 ≒ 655 秒 ≒ 約 10 分 55 秒) |
| 日本語での体感 | 250 字/分 なら約 1,300 字。1 文単位の練習には制約にならない |
| prebuilt ボイスでの複数話者 | 最大 2 話者 |

---

## 3. Deployment path (調査項目 3)

| 観点 | Gemini Developer API (API key) | Cloud TTS API / Vertex AI API |
|---|---|---|
| **gemini-3.8 系** | **○ (GA)** | **× 非搭載** (`gemini-3.1-flash-tts-preview` と 2.5 系のみ) `[公式]` |
| 認証 | **API key 1 本** (`x-goog-api-key`)。Workers の secret 1 本で完結 | ADC / サービスアカウント。GCP プロジェクト必須 |
| 出力形式 | 既定 `audio/wav` (RIFF ヘッダ付)。`audio/l16` `audio/mulaw` `audio/alaw` も選択可。`sample_rate` 指定可 (24000 / 16000 等) | Cloud TTS API: LINEAR16 / ALAW / MULAW / **MP3** / OGG_OPUS / PCM。Vertex AI API: PCM16 24kHz 固定・WAV ヘッダなし |
| Voice design / replication | ○ (`POST /v1beta/voices`) | 記載なし |
| Extended Voice Library (150 以上のボイス) | ○ (`GET /v1beta/voices`) | 記載なし |
| SSML | なし | Chirp 3 HD: **非対応**。Studio voice: 一部対応 (非対応タグ: `<mark>` `<emphasis>` `<prosody pitch>` `<lang>`) |
| テキスト正規化 (日付・金額) | 記載なし | Cloud TTS API で **既定適用** |
| 話速 / ピッチの明示指定 | `style` 経由のみ (数値指定は無い) | Chirp 3 HD: 非対応 |
| 料金 (10 秒あたり) | flash $0.00225 / lite $0.00150 | 3.1 preview $0.0050 / Chirp 3 HD は文字数課金 |
| リージョン | グローバル | global / us / eu / northamerica-northeast1 など (データレジデンシー対応) |
| プロンプト形式 | `"{prompt}: {text}"` が 1 本の `contents` に統合される | Cloud TTS API は text と prompt を別フィールドで受け取れる |

出典: https://cloud.google.com/text-to-speech/docs/gemini-tts , https://cloud.google.com/text-to-speech/docs/voices , https://cloud.google.com/text-to-speech/pricing

### 判断

**3.8 系を使うなら Gemini Developer API 一択。** Vertex AI / Cloud TTS を選んでも 3.8 は命中しないため、「GCP 認証を Workers secret に持ち込む重み」という論点は**発生しない**。むしろ逆で、Cloud TTS 側に移すと**モデルの世代が 1 つ落ちる**。

**残る差**: データレジデンシー・SLA・従量課金/大規模ワークロードになった時の運用。いずれも本 app (個人利用の学習ツール) では該当しない。

**Voice design / Voice replication が Gemini Developer API 限定**である点も、3.8 を選ぶ場合は追加コストなしで得られる。

---

## 4. prompted / replicated カスタムボイス (調査項目 4)

| 項目 | Voice design (`type:"prompted"`) | Voice replication (`type:"replicated"`) |
|---|---|---|
| 入力 | 自然言語記述 (年齢・音色・アクセント・基本配送) | **参照音 10〜30 秒** + **同意文録音** (両方 同一話者・24kHz mono 16bit WAV 推奨) |
| 同意文の言語 | 不要 | **30 言語対応、日本語あり** (ja-JP: 「私はこの音声の所有者であり、Googleがこの音声を使用して音声合成モデルを作成することを承認します。」) |
| 戻り値 | 永続 `voice_...` ID + `sample_audio` (WAV プレビュー) | 永続 `voice_...` ID (または store=False で `voicekey_...`) |
| 上限 | stateful 200 voice / project (prompted と replicated で共有)、**TTL 1 年** | 同左。stateless `voicekey_` は **TTL 7 日** (クライアント管理) |
| 言語指定 | docs の例は `language_code: "en-GB"` のみ。**日本語で動作するかは未確認** `[未確認]` | 同意文は日本語可。参照音の言語指定方法の詳細な記述は無い `[未確認]` |
| **課金の記載** | **docs に記載なし** `[未確認: 無料と推定]` | **docs に記載なし** `[未確認: 無料と推定]` |
| 話者 | 実在人物は不要 | 実在の成人話者。**自分の声なら技術的・法的に成立する** |

出典: https://ai.google.dev/gemini-api/docs/voice-design , https://ai.google.dev/gemini-api/docs/voice-replication

### 本 app への当てはめ

- **「日本語話者の custom voice は可能か」→ replication 側は YES。** 同意文の言語一覧に ja-JP がある。話者自身が自分の声である限り、同意取得の経路が明示的に用意されている。
- **ただし「練習の模範音声」として自分の声を使うのはプロダクション的に筋が悪い。** 練習者が自分の声を模範に聴いて練習するのは反復学習を妨げる。望ましいのは非同人の高品質な日本語話者の声 = Voice design (日本語指定が使えるかは要 spike) か、Extended Voice Library の日本語ボイス。
- **運用ゲートはクリアしている。** 200 voice / TTL 1 年に対し必要数は 1〜3。20 秒の参照音と同意文録音の 1 回だけで済む。**課金が文書化されていない点は運用前に要確認。**
- **Extended Voice Library の日本語ボイス一覧は docs からは取得できない。** API key 付きで `GET /v1beta/voices?language_code=ja-JP` を 1 回呼べば確定する。

---

## 5. Google Cloud TTS との比較 — GO / NO-GO (調査項目 5)

### 前提の訂正: `Journey` ボイスは存在しない

- `cloud.google.com/text-to-speech/docs/journey-voice` → **404**。voices 一覧にも `Journey` は無い。**この tier は存在しない** (記憶違いか他社モデルとの混同)。
- 実在する tiers (voices / pricing より): **Chirp 3: HD** (最新 LLM 系) / Studio (ニュース・放送向けレガシー) / WaveNet / Standard / Instant custom voice。

### 日本語対応 voice 数 (Cloud TTS 側) `[公式]`

| tier | ja-JP voice 数 | SSML | 話速・ピッチ指定 |
|---|---|---|---|
| **Chirp 3: HD** | **30** (`ja-JP-Chirp3-HD-Achernar` / `Achird` / `Algenib` / `Algieba` / `Alnilam` など) | **非対応** | **非対応** |
| WaveNet | 4 (A〜D) | ○ | ○ |
| Standard | 4 (A〜D) | ○ | ○ |
| Studio | **0** (en-GB / en-US / fr-FR / de-DE のみ) | 一部対応 | — |

→ **日本語については Chirp 3 HD のみが「最新 LLM 系」の選択肢。** 30 voice × 30 style という潤沢な選択肢があり、これは 3.8 の prebuilt 30 voice (言語属性なし) と対比して「日本語ネイティブで録音された voice が 30 個ある」という点では有利である。

### コスト比較 (日本語の読み上げ速度 4.2〜5 字/秒 で概算) `[公式価格から実算]`

| 選択肢 | 10 秒あたり | 無料枠 | 備考 |
|---|---|---|---|
| **Cloud TTS Chirp 3 HD** | 42〜50 字 × $0.00003 = **$0.0013〜0.0015** | **100 万文字/月** | 日本語は 1 文字 1 課金 |
| **gemini-3.8-flash-tts** (〜2026/12) | **$0.00225** | Free Tier あり (データ利用同意) | |
| **gemini-3.8-flash-lite-tts** (〜2026/12) | **$0.00150** | 同上 | |
| Cloud TTS Gemini 3.1 Flash TTS (Preview) | $20/1M audio tok ÷ 40,000 秒 = **$0.0050** | **無し** | 3.8 の約 2.2 倍 |
| gemini-3.8-flash-tts (2027/01 以降) | **$0.00450** | — | **Chirp 3 HD の約 3 倍** |

出典: https://cloud.google.com/text-to-speech/pricing , https://ai.google.dev/gemini-api/docs/pricing

### GO / NO-GO 判定

**条件付き GO — `gemini-3.8-flash-tts` を既定とする。ただし spike 通過が条件。**

理由:

1. 3.8 系は Gemini Developer API 専用であり、既存の endpoint と既存の API key 運用をそのまま使える (実装コスト最小)。
2. **練習の核心は「明瞭な一語一語の発音」であり、3.8 だけが `style` で話速・明瞭度・ピッチを制御できる。** Chirp 3 HD は SSML も話速指定も非対応 `[公式]`。これは機能面で決定的な差であり、10 秒あたり $0.0008 の価格差より重要。
3. Chirp 3 HD はフォールバック先として常備する価値がある。**特に 2027/01/01 以降は 3.8 が約 3 倍高くなる**ため、その後の保険として重要。

**NO-GO となる条件 (spike で測定して判定):**

- 日本語 500 字超の連続文で、接合部の不自然な継ぎ目や room tone の不連続が出る。
- 二拍名詞・擬音・数字/単位の読み誤りが「練習として許容できる」水準を超える。
- 同一語句の繰り返しが発生し、採用を妨げる。
- 日本語の `style` 文字列が英語相比で明確に劣る。

---

## 6. 未確認項目の実測手順 (spike)

全て **AI Studio** (`https://aistudio.google.com`) で API key 不要・無償で実行できる。まず短時間で A/B を送り、GO/NO-GO を確定してから実装に入る。

### Step 1: 2 モデルの A/B (同一テキスト・同一 voice・同一 style)

- モデル: `gemini-3.8-flash-tts` と `gemini-3.8-flash-lite-tts`
- voice: prebuilt から 2〜3 個 (Kore / Puck / Zephyr など)
- style: 4 通り — 空 / `"clear, slow, careful articulation"` / `"native Japanese narrator, educational audiobook, warm and clear"` / `"very slow, deliberate, enunciating each word distinctly"`
- 判定: 公式推奨どおり「空 style でまず試す」が実際に最良かどうか

### Step 2: 日本語発音コントロールの実効性

| テスト | 内容 | 判定基準 |
|---|---|---|
| style の言語 | 同じ内容を英語 style と日本語 style (`"ゆっくり、はっきりの声で"`) で合成し盲検 A/B | どちらが明瞭か。言語差があるか |
| インラインタグ | `<short pause>` (英語) / `<ため息>` (日本語) / なし の 3 通り | 英語版のみ効くことを確認 |
| 句読点 | `、` と `--` と `...` の間差 | 日本語で機能するか |
| かな化 | `3階` を `3階` / `三階` / `三階 (さんかい)` の 3 通り | どれが正しいか。**TTS 用テキスト設計の根拠になる** |
| 数字・単位 | `3階` / `100km` / `1LDK` / `2,500円` / `令和7年` を各合成 | 誤読率。かな化が必要かの判断 |

### Step 3: 二拍名詞・擬音・熟語

`がざん` `がたん` `じゃんけん` `きょう` `あてな` `ひびき` `曖昧` などを 1 文にまとめて合成し、ネイティブ日本語話者が聞き取り採点。

### Step 4: 長文安定性

- 500 字 / 1,000 字の日本語連続文を **1 リクエスト** で合成 (章の連結文を使う)。
- 判定項目: (a) 接合部の継ぎ目が不自然か (b) room tone が破綻するか (c) 無音・繰り返し・語尾脱落が発生するか
- 補助: 出力を Whisper で文字起こしし期待文と diff する。空白と反復は定量検出できる。
- 比較: 同じテキストを 5 文ずつ分割して合成し、1 リクエスト版との差を見る (分割が逆に接合部の不連続を生むか)。

### Step 5: 定量的スコア

- **単語 CER**: Whisper で書き起こし → 期待読みと CER 算出 (数字・単位・擬音の誤読を定量化する)
- **話速**: 文字数 ÷ 音声長
- **繰り返し率・脱落率**: Step 4 の Whisper timestamps で区間異常を検出
- **主観 MOS**: 日本語話者が 10 文を 1〜5 で採点 (対象ユーザー自身の要和に最も近い評価)

### Step 6: フォールバック候補の同時実測

Cloud TTS `ja-JP-Chirp3-HD-Achernar` などで同一テストセットを合成し、CER と MOS で 3.8 と並べる。取れれば保険が確定する。

---

## 7. 出典一覧 (一次ソース)

| 内容 | URL | 最終更新 |
|---|---|---|
| TTS 生成ガイド (機能 / プロンプト / 言語 / 制約) | https://ai.google.dev/gemini-api/docs/speech-generation | 2026-09-24 |
| gemini-3.8-flash-tts モデルカード | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts | 2026-09 |
| gemini-3.8-flash-lite-tts モデルカード | https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-lite-tts | 2026-09 |
| 料金 (2027/01/01 の値上げを含む) | https://ai.google.dev/gemini-api/docs/pricing | 2026-09 |
| リリースノート (3.8 系 GA = 2026/09/22) | https://ai.google.dev/gemini-api/docs/changelog | 2026-09-22 |
| Voice design (prompted) | https://ai.google.dev/gemini-api/docs/voice-design | 2026-09-24 |
| Voice replication (同意文 30 言語 / 日本語) | https://ai.google.dev/gemini-api/docs/voice-replication | 2026-09-24 |
| Cloud TTS Gemini-TTS (3.8 非搭載の根拠 / リージョン) | https://cloud.google.com/text-to-speech/docs/gemini-tts | 2026-09 |
| Cloud TTS voice 一覧 (Chirp 3 HD 日本語 30 voice / SSML 制約) | https://cloud.google.com/text-to-speech/docs/voices | 2026-09 |
| Cloud TTS 料金 | https://cloud.google.com/text-to-speech/pricing | 2026-09 |
| DeepMind モデル一覧 (数値ベンチが無いことの確認) | https://deepmind.google/models/gemini/ | 2026-09 |
