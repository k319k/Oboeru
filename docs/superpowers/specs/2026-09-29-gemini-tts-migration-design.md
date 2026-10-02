# Gemini TTS 移行 — 設計

- 日付: 2026-09-29
- 状態: **ユーザー承認済み**（試聴を Google AI Studio で行い `flash-lite-tts` / `Ludo` / `"Narration"` を選択。追加試聴は打ち切り）
- ロードマップ: ④AI TTS（`docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` の付録）
- Spike レポート: `docs/research/2026-09-29-gemini-tts-spike-results.md`
- 調査レポート: `docs/research/2026-09-28-gemini-38-tts-japanese-evaluation.md` / `docs/research/2026-09-28-gemini-tts-cost-optimization.md`

## 目的

日本語の発音練習アプリにおいて、読み上げ音声の_provider_ を Google Cloud TTS Neural2 から
Gemini TTS に置き換える。ユーザーがuzuえた問題点は 2 つで、どちらも Neural2 の
アルゴリズム固有の限界であり話速調整では直らない:

- **イントネーションが不正確**
- **声が機械的に聞こえる**

Gemini 3.8 系は `speech_metadata` 経由で話速・明瞭度を制御でき、Neural2 には voices 以外の
選択肢が無い（日本語は Neural2-A〜D の 4 種のみ）。gemini-3.8-flash-tts 由来の音声では
両方の問題輕減できた。

## 採用設定

```
provider:  OpenRouter  POST https://openrouter.ai/api/v1/audio/speech
model:     google/gemini-3.8-flash-lite-tts
voice:     Ludo
style:     provider.options['google-ai-studio'].speech_metadata.style = "Narration"
format:    response_format = "pcm"  →  サーバ側で 44-byte RIFF ヘッダを付けて WAV 化
話速:      HTMLAudioElement.playbackRate = settings.ttsRate (クライアント側、既定 1.0)
生成:      1文 = 1リクエスト
キャッシュ: IndexedDB (R2 不要)
```

### 採用理由

| 判断 | 理由 |
|---|---|
| `flash-lite-tts` | 試聴で選定。`flash-tts` と比較して(select 根拠詳細は Spike レポート) |
| `voice: Ludo` | 試聴で選定。ドキュメントの 30 voice 一覧には無いが実動する（拡張ボイス） |
| `style: "Narration"` | 一言が最良。長い style は音質を劣化させ、`"ゆっくり、はっきりとした発音で"` は話速まで 1.77 倍落とした |
| `pcm` → WAV | `response_format: "mp3"` は `400 Gemini TTS only supports response_format="pcm"` で拒否される。mp3/Opus/AAC は**将来課題として保留**（今回のスコープ外） |
| `playbackRate` は `settings.ttsRate` をそのまま使う | Gemini には話速の数値指定が無い（`speech_metadata` の自然言語のみ、しかも非決定的）。変速はクライアント側に移す。既定値は 1.0 のまま（試聴で 0.9 が最適という所見があったが、既存設定値には効かないため別件で扱う） |
| IndexedDB | サーバ側キャッシュは効かない（下記）。R2 を足す理由が無い |

## 移行前の現状（2026-09-29 時点）

> **注意** — この節は **移行前** の状態を記録したものであり、現行の仕様ではない。
> Google Cloud TTS / `audio/mpeg` / `GOOGLE_TTS_API_KEY` はすべて既に廃止され、
> Gemini (`google/gemini-3.8-flash-lite-tts` を OpenRouter 経由) + `audio/wav` +
> `OPENROUTER_API_KEY` に置き換わっている。現状は `AGENTS.md` の TTS 規約節を参照。

### provider 側 (`src/routes/api/tts/+server.ts`)

- Google Cloud TTS `POST https://texttospeech.googleapis.com/v1/text:synthesize` を呼び出し
- `audioConfig: { audioEncoding: 'MP3', speakingRate }` を送り、`audio/mpeg` を返す
- `GOOGLE_TTS_API_KEY` を `$env/dynamic/private` から読む
- 純粋関数の注入パターン: `_handleTtsPost(body, apiKey)` / `_handleTtsRequest(request, apiKey)`
- 既に `_handleTtsPost` のユニットテストが `src/routes/api/tts/tts-server.test.ts` にある

### クライアント側 (`src/lib/tts.ts`)

- インメモリ LRU `Map<string, {blob, blobUrl}>`、上限 50 件
- `inFlight: Map<string, Promise<Blob>>` で同時リクエストの重複排除
- キャッシュキーは `cacheKeyOf` が `${text}|${lang}|${voiceName}|${speakingRate}` を**同期的に**生成
- `speak()` が `new Audio(createObjectURL(blob))` を再生、`PLAYBACK_TIMEOUT_MS = 30_000`
- `prefetchTts()` は文を再生せずにキャッシュだけ入れる（`practice/+page.svelte` の 2 箇所から呼ばれる）
- `unlockAudio()` が最初のユーザー gesture で muted play して autoplay を解除

### ボイス選択 (`src/lib/tts-voices.ts`)

- `CURATED_VOICES` に 6 件（ja-JP-Neural2-B/C/D、en-US-Neural2-A/C/F）
- `DEFAULT_VOICE = { ja: 'ja-JP-Neural2-B', en: 'en-US-Neural2-C' }`
- `resolveVoice(lang, storedVoiceURI)` は保存値を優先し、言語が違えば既定にフォールバック
- `isAllowedVoiceName(name)` がサーバ側の許可リスト
- `settings.voiceURI` に保存される

## 設計

### 1. `/api/tts` の差し替え

`_handleTtsPost(body, apiKey)` の**シグネチャと戻り値の型（`Response`）を維持**したまま、
内部の upstream 呼び出しだけを差し替える。テストの注入パターンを壊さない。

**リクエストボディの型:**

```ts
export interface TtsRequestBody {
  text: string;
  lang: 'ja' | 'en';
  voiceName: string;
  speakingRate: number;   // 互換のため受け取るが Gemini では使わない
}
```

`speakingRate` は既存クライアントとの互換のため受け取る。Gemini は話速を指定できないため、
**サーバはこの値を無視する**（話速はクライアントの `playbackRate` で制御する）。

**upstream リクエスト:**

```
POST https://openrouter.ai/api/v1/audio/speech
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json

{
  "model": "google/gemini-3.8-flash-lite-tts",
  "input": "<text>",
  "voice": "<b.voiceName — allowlist 検証済み>",
  "response_format": "pcm",
  "provider": { "options": { "google-ai-studio": {
    "speech_metadata": { "style": "Narration" }
  } } }
}
```

**voice は `tts-voices.ts` に一本化する。** upstream ボディに `"Ludo"` をリテラルで
書くと `CURATED_VOICES` と二重管理になり、`tts-voices.ts` にボイスを追加しても
サーバが無視する。**`b.voiceName`（allowlist 検証後）を使う。** `Ludo` を書くのは
`tts-voices.ts` だけで、`model` と `style` は `/api/tts/+server.ts` の定数として 1 箇所に
定義する（キャッシュキーにも同じ値镜子む。**この 2 つの文字列はペアで変更すること**）。

**`speech_metadata` は top-level `instructions` ではない（重要）**

実測で対照実験한:

| 試行 | 出力長 |
|---|---|
| style なし（基準） | 4.44s |
| top-level `instructions: "speaking very slowly"` | 4.64s ← **無視されている** |
| `provider.options[...].speech_metadata.style: "speaking very slowly"` | 7.04s ← **効いている** |

top-level `instructions` は HTTP 200 を返すが**黙って捨てられる**。
Gemini 3.8 TTS は `input` を逐語書き起こしとして扱うため、指示をテキストに混ぜると
**読み上げられてしまう**。必ず `speech_metadata` に渡すこと。

**PCM → WAV 変換**

upstream は `audio/pcm;rate=24000;channels=1`（ヘッダ無し）を返す。レスポンスの
`Content-Type` ヘッダから sample rate / channels を取り出し、44-byte の RIFF ヘッダを
 delanteに付けて `audio/wav` として返す。

```ts
function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array
```

`src/lib/pcm-wav.ts` という**ブラウザ安全な純関数**として作る。共有先は
**サーバ・クライアント・テストの 3 つ**（クライアントも IDB からの read 時にヘッダを
付け直すため）。

**`Buffer` を使ってはいけない。** 参照実装 `tests/tts-mock.ts:10-23` は
`Buffer.alloc` / `writeUInt32LE` を使っているが、これは Node/Playwright 専用で
ブラウザに存在しない。`src/lib/tts.ts` は `src/routes/+layout.svelte:10` から
SSR 経由で import されるため、`Buffer` 依存のモジュールがブラウザバンドルに入ると
落ちる。**`DataView` + `Uint8Array` のみ**で書き、`channels` が 2 でも
`byteRate` / `blockAlign` が正しく決まること。

**`GOOGLE_TTS_API_KEY` の扱い**

Gemini 一本化により **Google Cloud TTS は削除**。`GOOGLE_TTS_API_KEY` は
`$env/dynamic/private` と `.env` から削除する。`.env` はコミット禁止なので問題ないが、
`AGENTS.md` のセットアップ節と wrangler secret の記述を更新する（`OPENROUTER_API_KEY` は
**既に Jev 判定で使用中**なので、secret は追加不要）。

### 2. ボイス選択の単純化 (`src/lib/tts-voices.ts`)

Google の 6 ボイスは**全削除**し、Gemini の 1 ボイスに置き換える。Gemini の `Ludo` は
**日本語と英語の両方を担当する単一のボイス**なので、`CURATED_VOICES` は 1 件になる。

```ts
export const CURATED_VOICES: VoiceInfo[] = [
  { name: 'Ludo', lang: 'ja', gender: 'neutral', label: 'Ludo' },
];

export const DEFAULT_VOICE: Record<TtsLang, string> = { ja: 'Ludo', en: 'Ludo' };
export function isAllowedVoiceName(name: string): boolean  // 'Ludo' のみ true
export function resolveVoice(lang, storedVoiceURI): VoiceInfo
```

**`languageCode` と `gender` を削除し、`lang` も削除する。**

- `languageCode` — Google 固有（`ja-JP` / `en-US`）。Gemini の `voice` は言語を持たない
  （言語は入力テキストから自動判定される）
- `gender` — 型は `'male' | 'female'` だが**消費者は 1 つも無い**（`tts-voices.ts` 内の
  定義とリテラルのみ）。`gender: 'neutral'` は型エラーになるので、フィールドごと消す
- `lang` — **これが問題の軸**。`resolveVoice` は `v.lang === lang` で照合していたので、
  `Ludo` が 1 件だと `lang: 'en'` のときに `find` が失敗する

**決定: `lang` も削除して `resolveVoice` の引数から落とす。** 呼び出し側を調べると
`src/lib/tts.ts:102` は戻り値の `.name` だけを使い、
`src/routes/practice/+page.svelte:297,619,638,643` も `voiceURI` を `speak()` に渡すだけ、
`src/routes/manage/+page.svelte:1872,1877` は `CURATED_VOICES` を直接見ている。
**どこも `.lang` を使っていない**ので、引数を落として差分ゼロで通せる。

```ts
export interface VoiceInfo {
  name: string;
  label: string;
}
export const CURATED_VOICES: VoiceInfo[] = [{ name: 'Ludo', label: 'Ludo' }];
export function resolveVoice(storedVoiceURI: string | null | undefined): VoiceInfo
export function isAllowedVoiceName(name: string): boolean  // 'Ludo' のみ true
```

`DEFAULT_VOICE` も単一ボイスでは冗長（`resolveVoice` の既定が常に `Ludo`）なので削除する。
`SpeakOptions.voiceURI` は `voiceName` に改名する（Google 固有の意味付けを外す）。

**既存ユーザの `settings.voiceURI` は `'ja-JP-Neural2-B'` などだが、`isAllowedVoiceName`
が false を返すので `resolveVoice` が既定 `Ludo` にフォールバックする。移行時の
データ変換は不要**（旧値は自然に無効化される）。

**管理画面の select (`src/routes/manage/+page.svelte`)** は 3 箇所の変更が必要:

1. `voiceLabel()` (L314-317) が `voice.languageCode` を参照しているため、削除後の
   `label` のみを使う。**さらに、許可リストに無い旧値（`ja-JP-Neural2-B` など）は
   `null` を返して「デフォルト」表示に戻す。** 現状は生文字列を返してしまい、
   `Select.Root value={settings.voiceURI}` に該当する `Select.Item` が無いので
   **選択不可能な幽霊値が表示される**（spec の「データ変換不要」は再生経路についてのみ正しい）
2. `#each CURATED_VOICES.filter((v) => v.lang === 'ja')` (L1872) と `filter((v) => v.lang === 'en')`
   (L1877) が同じ `Ludo` を 2 回列挙するため、**言語による分岐を廃止して
   `CURATED_VOICES` をそのまま 1 段で列挙する**
3. 「音声:」のラベルと `data-testid="voice-select"` は**維持する**（1 項目の select になる）。
   完全に削除すると `tests/` の該当テストと UI 一貫性を壊す
4. `manage/+page.svelte:1871,1875,1876` の `<Select.Label>日本語</Select.Label>` /
   `<Select.Separator />` / `<Select.Label>English</Select.Label>` は言語分岐の削除で
   **空の見出しとして孤児化**するので、3 つとも削除する

### 3. 話速をクライアント側へ (`src/lib/tts.ts`)

**これが Gemini 移行の主要なクライアント変更。** 現状は `speakingRate` をサーバに送って
Google に再合成させていた。Gemini では話速を指定できないので:

- **生成キーに `speakingRate` を含めない**。含めると速度設定ごとに別々に生成・課金される
- `speak()` の中で **`audio.preservesPitch = true` を明示**してから
  `audio.playbackRate = options.rate ?? 1` を設定する。発音練習では pitch 保存が前提で、
  0.5 倍が「モorganizational な鉉 Pallete」になると練習にならない。ブラウザ既定は true
  だが古い Safari / 一部 Android WebView では既定が効かない
- `options.rate` は
  `settings.ttsRate` が既に渡してくるので、現行の 1.0 のまま動く）
**`DEFAULT_PLAYBACK_RATE` は 1.0 のまま維持する。** 試聴で「0.9 が最適」という所見があったが、
既存ユーザの `oboeru:settings:v1` に `ttsRate: 1.0` が保存されており、**既定値を変えても
既存値には効かない**。0.9 の最適性は試聴 1 文（バベルの塔）での判断であり、実際の広い文で
再確認を挟むべきである。

したがって今回のスコープは「`settings.ttsRate` の値を `playbackRate` に渡す」配線のみで、
**既定値は 1.0 のまま**。0.9 への変更は実機ゲートの結果を見て別件で行う。
UI のスライダー範囲（0.5–2.0）も変更しない。

**キャッシュキーの変更:**

```ts
// 変更前
`${text}|${lang}|${voiceName}|${speakingRate}`
// 変更後（決定）
`v1|google/gemini-3.8-flash-lite-tts|Ludo|Narration|${lang}|${text}`
```

- **`speakingRate` を落とす** — 戻すと同一文が速度設定ごとに重複生成・重複課金される
- **`lang` は残す** — サーバに送るリクエストの識別子と缓存の識別子が乖離しないよう、
  送信内容と素直に一致させる（189 文 × ~100 字の平文キーで実用上問題なし）
- **`voiceName` は埋めない** — `Ludo` に 1 voice になった今、埋めると
  `tts-voices.ts` の値と二重管理になる。`v1` prefix でボイス変更時は一括無効化できる
- **キーは同期純関数のまま維持**（ハッシュ化しない）。理由は「hot path が非同期化する」
  ではなく、**189 文 × ~100 字の平文キーで実用上問題がなく、デバッグ時に DB の中身を
  直接読んで意味が分かることの方が価値が高い**ため。`crypto.subtle.digest` は
  secure context 必須かつ非同期で、代償なく失う。

`v1` prefix を付けることで、model / voice / style / format のいずれかを変えた時に
バージョン bump だけで全エントリを無効化できる。

### 4. IndexedDB 永続キャッシュ

**R2 は不要。** 根拠は「サーバ.provider のキャッシュ水里か」ではない。

- **本アプリは単一ユーザーで、全データがブラウザ内の localStorage / IndexedDB にあり、
  サーバは複数端末を束ねるエントリを持たない。同一テキストが 2 つのクライアントから
  要求される経路が存在しない**ので、サーバ側キャッシュ（R2 を含む）を参照しても
  参照回数は増えない。R2 の効果はゼロ。
- **provider 側のキャッシュも効かない**（下の通り）ので、代替も無い。 OpenRouter の response caching は
  `/chat/completions` / `/responses` / `/messages` / `/embeddings` の 4 エンドポイントのみ
  対応で、`/api/v1/audio/speech` は対象外かつ既定でオフ。Google の implicit キャッシュは
  最小 4,096 トークン必要だが 1 文の入力は 30〜60 トークンで**永久に届かない**。
  しかも課金の 98% は出力（音声）トークンなので、入力キャッシュが当たっても効果 2% 以下
- **クライアント側 IndexedDB は 100% 効く。** 2 回目以降の再生はリクエスト 0 件＝請求 0

**容量:** 189 文 × 約 5 秒 = 約 45MB。ブラウザの quota（Chromium = ディスクの 60%、
Firefox = min(10%, 10GiB)、WebKit = 約 60%）に対して 3〜4 桁小さい。**quota 超過は
事実上の非存在。** `navigator.storage.estimate()` は近似値であり保証でないため、
容量チェックには使わない。

**SSR 不変条件**: `src/lib/tts.ts:4-5` に
「Browser globals (Audio, URL) are only touched at call time so that importing this
module in Node (e.g. vitest) never throws」と明記されている。`src/routes/+layout.svelte:10`
が `tts.ts` を import するため、**`tts-cache.ts` のモジュールトップレベルで
`indexedDB` に触ってはいけない**。`openDB()` は最初の read/write 時に呼ぶ遅延オープンで、
ガードは `typeof indexedDB === 'undefined'` のみ。`$app/environment` の `browser` は使わない
（vitest の node 環境で false になりテスト不能）。

**DB 設計:**

```
DB: oboeru-tts   version 1
objectStore 'audio'   keyPath: 'key'
  index 'lastUsedAt'  (非 unique)   ← 自前 LRU eviction 用
```

```ts
export interface TtsCacheRecord {
  key: string;              // `v1|<model>|<voice>|<style>|<text>`
  pcm: ArrayBuffer;         // 生 PCM（WAV ヘッダ無し）
  sampleRate: number;
  channels: number;
  byteLength: number;
  lastUsedAt: number;       // Date.now()
}
```

**`ArrayBuffer` を格納し、`Blob` は read 時に作る。** フォーマット変更時にヘッダを
付け直すだけで済み、キャッシュ报废が不要になるため。

**自前 LRU 上限 = 64MB。** ブラウザの eviction は origin 単位の一括削除で他データを巻き込む
ため、`lastUsedAt` index で古いものから自前で消す。`QuotaExceededError` を待たせない
（MDN 推奨: "Freeing up space by deleting data before storing new data"）。

**`navigator.storage.persist()` は呼ばない。** 3 つの理由:
1. web.dev は「ユーザー gesture の中で包め。ロード時に要求するな。混乱して拒否される」
2. Firefox ではポップアップが出て UX を汚染する
3. 音声キャッシュは**再生成可能な投棄可能データ**で、消えても影響は「少し遅くなる」だけ

**透明な最適化として実装する（絶対に依存しない）:**

フォールバック 3 段。IDB が使えない環境（private mode、`SecurityError`、
`VersionError`、`QuotaExceededError`）では黙って段 1+3 に落とす。UI には出さない。

```
1. インメモリ LRU（既存の blobCache、50件）— 同期・必ず成立
2. IndexedDB（typeof indexedDB !== 'undefined' なら）
3. ネットワーク POST /api/tts
```

### 5. エラー処理

**`/api/tts`（サーバ）:**

| upstream 状態 | 処理 | 返す HTTP |
|---|---|---|
| 200 | PCM → WAV 化 | 200 `audio/wav` |
| 400 / 401 / 403 / 404 / 413 | リトライしない（設定 or 権限の問題） | 502 |
| 402 + `limit_source: "openrouter_in_flight_budget"` | `Retry-After` 遵守して 1 回だけ | 502 |
| 503 | キー未設定。**メッセージ文言 `TTS API キーが未設定です` は現状維持**（`tts-server.test.ts:22` が完全一致 assert している） | 503 |
| 402 その他 | リトライしない（残高 / 上限） | 502 |
| 429 / 502 / 503 / 529 | `Retry-After` あれば従う、なければ 1s → 2s（最大 2 回） | 502 |
| 500 | 1 回だけリトライ | 502 |
| タイムアウト（10s） | 現状の AbortController を維持 | 408 |

**リトライ回数は `/api/judge` より厚くする**（`src/routes/api/judge/+server.ts:28-31` は
1 回・固定 500ms）。judge と揃える必要はない — 1 回の失敗あたりのコストが
「採点 1 件（無害）」と「TTS 1 文（$0.0015、伊拉克の生成コスト）」で桁が違うため。

**ただしクライアントのタイムアウト内に収めること。** 現状の
`src/lib/tts.ts:17` の `FETCH_TIMEOUT_MS = 10_000` は
`src/routes/api/tts/+server.ts:41` のサーバ 25s より**短い**（クライアントが常に先に
abort している）。サーバ側で「タイムアウト + バックオフ合計」が 10 秒を超えると、
**クライアントが見捨てた後にサーバだけ回って課金だけ発生する**。

- サーバの upstream タイムアウト: **10 秒**（現状 25 秒から短縮。クライアントに合わせる）
- バックオフ合計: 1s + 2s = 3 秒
- 合計予算: 10s + 3s = **13 秒** > クライアント 10 秒 → **クライアント timeout を 15 秒に
  引き上げる**（`FETCH_TIMEOUT_MS = 15_000`）。スライダーの既存値には影響しない
- 結果として 2 回リトライでもクライアントは 13 秒で必ず応答を得る

（上書き: 実装時に数値を再確認すること。ずれた場合は「クライアントの予算を
サーバが超えないこと」を制約として固定する。）

**クライアント:** 現在のエラーメッセージ（`TTS に接続できませんでした (タイムアウト)` /
`音声の再生がブロックされました`）を維持する。失敗時はpractice の error 表示に fallen through。

### 6. データモデル

**変更なし。** `Sentence` 型に音声関連フィールドを追加しない。音声キャッシュは
**文のテキストから導出される派生物**であり、数据モデルに含めない。これは:

- テキストを編集すれば key が変わるので、キャッシュが自然に無効化される
- インポート/エクスポート（version 3）に影響しない
- ⑥ クラウド同期 unaffected になる

**`practice-progress.ts` の `chapterId` フィールド**は章/トラックのノード id を持つが、
今回の変更とは無関係（既に実装済み）。

## 既知のリスク: `OPENROUTER_API_KEY` の共有

`OPENROUTER_API_KEY` は **Jev 判定と TTS で共有**する（既存の 1 本を使い回す）。

**TTS の大量消費が Jev 判定を無言で劣化させる危険がある。** `/api/judge` は
キー欠損・429・失敗を**全て `{available: false}` に畳んで HTTP 200** で返す
（AGENTS.md 採点パイプライン規約どおり）ので、TTS が枠を食って
`limit_source: "openrouter_in_flight_budget"` が発生すると、**Jev が無言で similarity
フォールバックに落ちる**。

**対策（今回のスコープ）:**
1. TTS 側で 1 文 1 リクエストのみ（Bulk しない）で消費を抑える
2. TTS 失敗のログを `console.error` で残し、Jev 由来なのか TTS 由来なのか区別できるようにする
3. TTS のクライアントに `inFlight`（既存）と自前 LRU がある（`src/lib/tts.ts:35-36`）ので、
   **同じ文の重複生成は起きない**

**将来（キーの分離を検討する余地）:** TTS 用と Jev 用で別キーにする。TTS は事前生成的に
まとめて消費し、Jev は文ごとに小さく消費するので、性質が全く違う。ただし
個人利用では割に合わないので**今回は見送り**し、Mots  symmetries が発生したら別件とする。

## テスト計画

**ユニット (vitest):**

- `src/lib/pcm-wav.test.ts`（新規）— ヘッダのフィールド値、44-byte 前提、長さの整合性。
  `channels=2` でも `byteRate` / `blockAlign` が正しいこと、`Buffer` を一切使わないこと
- `src/routes/api/tts/tts-server.test.ts`（拡張 + 削除 2 本）— upstream URL / ボディの検証。
  - **削除 1 本**: `:84-96` の `clamps speakingRate to 0.25–4.0` は `speakingRate` を
    upstream に送る実装のテスト。Gemini では話速を指定せず**サーバはこの値を無視する**ので
    検証対象が消えるため削除する
  - **削除 1 本**: 現状の Google レスポンス形状（`{audioContent: base64 mp3}`）を前提に
    したテスト。PCM raw body を返す新しい形に置換する
  - 追加: 503 のメッセージ文言 `TTS API キーが未設定です` は**現状維持**を assert
  `speech_metadata` が `provider.options` 配下にあることの**回帰テストは必須**
  （top-level `instructions` は黙って無視されるため、ここを間違えると静かに劣化する）。
  PCM 入力 → WAV 出力、400/402/429/503/タイムアウト、**Content-Type パラメータ欠落 /
  順序反転 / `channels=2` の 3 ケース**、**`Content-Type: audio/mpeg` が返った場合の 502**
- `src/lib/tts-voices.test.ts`（既存、**全面書き直し**）— 現在は
  `CURATED_VOICES` の length 6 と `lang` による分割を assert しているため、
  1 件構成に書き換える。`resolveVoice('ja-JP-Neural2-C')` が `Ludo` を返す
  fallback 経路のテストは**維持する**（旧 voiceURI の無効化は移行の安全性の要）
  - **削除 1 本**: `:45-51` の `returns a voice with matching lang in all cases` は
    「ボイスは言語に紐づく」という不変条件のテスト。`lang` を abolish する今回で
    条件そのものが消えるため削除する（不変条件の消滅による削除であり、
    アサーション弱化ではない。AGENTS.md 運用節の「挙動変更時は正当に更新し報告」に該当）
- `src/lib/tts-cache.test.ts`（新規）— `fake-indexeddb` で put/get/削除/LRU 上限、
  IDB 不可時のフォールバック、key 生成（`speakingRate` が含まれないこと）
- `src/lib/tts.test.ts`（既存、修正）— 以下 3 箇所が旧 Google voice 名を hardcode している:
  - L69 `speak('hello', 'en', { voiceURI: 'en-US-Neural2-F' })`
  - L225-230 / L329-330 の重複排除テスト（`ja-JP-Neural2-C` と `-D` で別 key を生成）
  これらは `resolveVoice` が両方 `Ludo` に解決するため **key が衝突する**。
  **テストの意図（「別 voice なら別キャッシュ」）は voice 軸の消滅で成立しなくなる**ので、
  代わりに `text` を変える版に書き換える（Gemini 一本化後は voice 軸が存在しない）。
  加えて `preservesPitch` / `playbackRate` の設定を追加する
- `src/lib/settings.test.ts` — 変更不要（`voiceURI` は任意の文字列を受け付ける）

**E2E (Playwright):**

- `tests/tts-mock.ts` の `mockTtsApi` は**既に `audio/wav` を返している**（L74-82 で
  `contentType: 'audio/wav'` + `silentWavBytes(80)`）。**変更不要**
- 「同じ文を 2 回再生しても `/api/tts` が 2 回目は呼ばれない」— `TtsMock.count()` の
  カウンタを観測点にする。**`tests/practice.spec.ts:409,764,767` に既に同一の assert が
  あるので重複追加せず，既有テストが緑のまま通ることを確認する**
- **新規: リロードを跨いでもキャッシュが効く** — IndexedDB の最大の価値はリロード跨ぎだが、
  既存 E2E は同一セッション内の再訪しか検証していない。`page.reload()` 後に同じ文を
  再生して `ttsCallCount()` が増えないことを assert する
- `tests/practice.spec.ts` L38 の `voiceURI?: string | null` は seed の一部。`null` の
  ままなら旧 voice 名が含まれないので**変更不要**
- `ttsRate` スライダーが `playbackRate` に反映されることの検証

**E2E の構造的な限界（明記）**: E2E は `tests/practice.spec.ts:909` の
`page.route('**/api/tts')` で**サーバを丸ごと差し替えている**ため、
upstream 呼び出し・リトライ・**PCM→WAV 変換を一度も実行しない**。これらは
`src/routes/api/tts/tts-server.test.ts` のユニットテストでしか検証されない。

**検証コマンド:**

```
npm run check   # svelte-check 0 エラー
npm test        # vitest
npx playwright test --workers=1
```

## 非目標

- **mp3 / Opus / AAC への圧縮** — `response_format` は pcm のみ。WAV (45MB) のまま。
  将来課題として `docs/` に記録する
- **R2 / 事前生成** — IndexedDB のクライアントキャッシュで要件を満たす
- **章全体のブロッキングウォーム** — 20 文 × 5 秒 = 100 秒は UX を劣化させる。
  既存の `prefetchTts`（現在文 + 次文、2 箇所）の**維持**で足りる
- **Google Cloud TTS へのフォールバック** — Gemini 一本化。障害時は練習が成立しない
- **PWA（ロードマップ⑤）** — 別サブプロジェクト。ただし以下の 관계がある:
  iOS 7 日ルール（ITP）は 7 日間 click/tap/key が無ければ IndexedDB を含む
  script-writable ストレージを全削除する（スクロールは数えない）。**ホーム画面 PWA は
  明示的に免除**。ロードマップ⑤を先行させるとこのリスクが消える
- **クラウド同期（ロードマップ⑥）** — 別サブプロジェクト。音声を同期対象に含めるかは
  ④⑤の完了後に判断する
- **多話者 / ボイス複製** — 練習用途では不要
- **章まるごと 1 音源** — Gemini の出力にタイムスタンプが無く（`AudioContent` は
  `channels`/`data`/`mime_type` の 3 フィールドのみ）、1 文 = 1 リクエスト以外は分割不能

## 移行チェックリスト

1. `README.md:30-50` を更新（`GOOGLE_TTS_API_KEY` の取得手順 Neural2 の無料枠の記述を削除）
2. `README.md:120-121` を更新（「読み上げは Google Cloud TTS（Neural2）を使用」
   「日本語 3 声 + English 3 声」→ Gemini 一本化後の説明）
3. `.env.example:8-9` から `GOOGLE_TTS_API_KEY` の取得手順を削除
4. `AGENTS.md` のセットアップ節（`GOOGLE_TTS_API_KEY` の行）を削除
5. `AGENTS.md:129` のロードマップ ④ のモデル名（`gemini-3.8-flash-tts`）を訂正
6. `AGENTS.md` の**ディレクトリ地図**に新規 `src/lib/pcm-wav.ts` / `src/lib/tts-cache.ts`
   を追加（追加漏れやすい）
7. `AGENTS.md` の **Jev 規約**に「`OPENROUTER_API_KEY` は Jev と TTS で**共有**」を追記
   （M12 のキー分離議論の帰結）
8. `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` の付録 127/139/145 行を
   3 つの決定の訂正として書き直す（単なる「実装済」フラグでは不十分）
9. `docs/research/` の spike レポート 3 本の冒頭に「Spike 専用・本番未使用」の注記
10. `scripts/spike-*.mjs`（3 本）は `GOOGLE_TTS_API_KEY` を読む。spike 専用なので
    **削除してよい**ことを明記
11. `GOOGLE_TTS_API_KEY` を `.env` から削除、`GEMINI_API_KEY` も削除（spike 専用）
12. `wrangler secret delete GOOGLE_TTS_API_KEY` は**デプロイに影響する操作**なので、
    **ユーザー明示依頼後に実行**する（AGENTS.md 運用節）

**`OPENROUTER_API_KEY` は既存（Jev で使用中）のため secret の追加は不要。**
