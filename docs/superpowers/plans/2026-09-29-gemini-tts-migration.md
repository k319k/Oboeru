# Gemini TTS 移行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 読み上げ音声の provider を Google Cloud TTS Neural2 から OpenRouter 経由の Gemini 3.8 Flash-Lite TTS に置き換え、生成済み音声を IndexedDB に永続キャッシュする。

**Architecture:** `/api/tts` サーバプロキシの upstream 呼び出しだけを差し替える（`_handleTtsPost(body, apiKey)` のシグネチャと戻り値の型 `Response` は維持）。OpenRouter が返す headerless PCM を 44-byte RIFF ヘッダ付きで WAV に変換して返す。クライアントは話速を `playbackRate` で制御し（生成キーから `speakingRate` を除去）、生成済み PCM を IndexedDB に保存して 2 回目以降の生成リクエストをゼロにする。

**Tech Stack:** SvelteKit 2 / Svelte 5 / Cloudflare Workers / TypeScript 5.8 / vitest 3 / Playwright 1.52 / IndexedDB / OpenRouter `/api/v1/audio/speech`

**Spec:** `docs/superpowers/specs/2026-09-29-gemini-tts-migration-design.md`
**Spike レポート:** `docs/research/2026-09-29-gemini-tts-spike-results.md`

## Global Constraints

- `model: "google/gemini-3.8-flash-lite-tts"` / `voice: "Ludo"` / `speech_metadata.style: "Narration"`。この 3 つのリテラルは**ペアで変更すること**（サーバの upstream ボディとキャッシュキーの 2 箇所に現れる）
- **`speech_metadata` は top-level `instructions` では効かない。** 必ず `provider.options['google-ai-studio'].speech_metadata.style` に渡す（top-level は HTTP 200 を返すが黙って捨てられる）
- `response_format: "pcm"` のみ（`"mp3"` は `400 Gemini TTS only supports response_format="pcm"` で拒否される）
- `src/lib/pcm-wav.ts` は **`Buffer` を使わない**。`DataView` + `Uint8Array` のみ
- `src/lib/tts-cache.ts` は**モジュールトップレベルで `indexedDB` に触らない**（`src/lib/tts.ts:4-5` の SSR 不変条件。`src/routes/+layout.svelte:10` が `tts.ts` を import する）
- `$app/environment` の `browser` を使わない（vitest の node 環境で `false` になりテスト不能）。ガードは `typeof indexedDB === 'undefined'` のみ
- Content-Type パーサは**順序非依存**、既定値 `sampleRate=24000` / `channels=1` を持つ
- キャッシュキーは**同期純関数**のまま（ハッシュ化しない）
- サーバの upstream タイムアウト **10 秒** / クライアントの `FETCH_TIMEOUT_MS` **15 秒** / バックオフ合計 3 秒
- `speak()` は `audio.preservesPitch = true` を明示してから `playbackRate` を設定する
- 既存メッセージ文言 `TTS API キーが未設定です` を**変更しない**（`tts-server.test.ts:22` が完全一致 assert している）
- UI 文言は日本語。レスポンシブ 390px 維持、axe serious/critical 0 維持
- **コミット/プッシュ/デプロイ/`wrangler secret delete` はユーザー明示依頼時のみ**
- `.env` / `babel-import.json` / `test-results/` はコミット禁止物

---

## File Structure

| ファイル | 責務 | 状態 |
|---|---|---|
| `src/lib/pcm-wav.ts` | PCM + (rate, channels) → WAV バイト列。Content-Type パーサも同じファイルに置く | 新規 |
| `src/lib/pcm-wav.test.ts` | 上記のユニットテスト | 新規 |
| `src/lib/tts-cache.ts` | IndexedDB の open/get/put/delete + 自前 LRU。**透過的な最適化**（失敗しても練習は続く） | 新規 |
| `src/lib/tts-cache.test.ts` | fake-indexeddb によるテスト | 新規 |
| `src/lib/tts-voices.ts` | ボイス 1 件（`Ludo`）。`lang` / `languageCode` / `gender` を abolish | 変更 |
| `src/lib/tts-voices.test.ts` | 1 件構成に書き直し | 変更 |
| `src/lib/tts.ts` | キャッシュキーの差し替え + `playbackRate` / `preservesPitch` + IDB 統合 | 変更 |
| `src/lib/tts.test.ts` | 既存 3 箇所の旧 voice 名を修正 + 新規アサーション | 変更 |
| `src/routes/api/tts/+server.ts` | upstream を OpenRouter に差し替え + PCM→WAV + リトライ | 変更 |
| `src/routes/api/tts/tts-server.test.ts` | レスポンス形状と upstream ボディの検証 | 変更 |
| `src/routes/manage/+page.svelte` | ボイス select の幽霊値修正 + 孤児化した見出し削除 | 変更 |
| `src/routes/practice/+page.svelte` | `voiceURI` → `voiceName` の改名 | 変更 |
| `README.md` / `.env.example` / `AGENTS.md` | ドキュメント更新 | 変更 |
| `scripts/spike-*.mjs` | spike 専用。`GOOGLE_TTS_API_KEY` を読むので削除 | 削除 |

---

## Task 1: `pcm-wav.ts` — PCM を WAV に変換するブラウザ安全な純関数

**Files:**
- Create: `src/lib/pcm-wav.ts`
- Test: `src/lib/pcm-wav.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DEFAULT_SAMPLE_RATE = 24000;
  export const DEFAULT_CHANNELS = 1;
  export interface PcmFormat { sampleRate: number; channels: number }
  export function parsePcmContentType(contentType: string | null): PcmFormat
  export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array
  ```

- [ ] **Step 1: テストファイルを書く**

`src/lib/pcm-wav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  parsePcmContentType,
  pcmToWav,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_CHANNELS,
} from './pcm-wav';

function wavField(bytes: Uint8Array, offset: number, size: 1 | 2 | 4): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (size === 1) return view.getUint8(offset);
  if (size === 2) return view.getUint16(offset, true);
  return view.getUint32(offset, true);
}

describe('parsePcmContentType', () => {
  it('returns defaults for null', () => {
    expect(parsePcmContentType(null)).toEqual({
      sampleRate: DEFAULT_SAMPLE_RATE,
      channels: DEFAULT_CHANNELS,
    });
  });

  it('returns defaults for a bare audio/pcm with no parameters', () => {
    expect(parsePcmContentType('audio/pcm')).toEqual({
      sampleRate: DEFAULT_SAMPLE_RATE,
      channels: DEFAULT_CHANNELS,
    });
  });

  it('parses the observed OpenRouter header', () => {
    expect(parsePcmContentType('audio/pcm;rate=24000;channels=1')).toEqual({
      sampleRate: 24000,
      channels: 1,
    });
  });

  it('is order independent (channels before rate)', () => {
    expect(parsePcmContentType('audio/pcm;channels=2;rate=16000')).toEqual({
      sampleRate: 16000,
      channels: 2,
    });
  });

  it('falls back per-field when one parameter is missing', () => {
    expect(parsePcmContentType('audio/pcm;rate=16000')).toEqual({
      sampleRate: 16000,
      channels: DEFAULT_CHANNELS,
    });
    expect(parsePcmContentType('audio/pcm;channels=2')).toEqual({
      sampleRate: DEFAULT_SAMPLE_RATE,
      channels: 2,
    });
  });

  it('falls back per-field when a value is not a number', () => {
    expect(parsePcmContentType('audio/pcm;rate=abc;channels=2')).toEqual({
      sampleRate: DEFAULT_SAMPLE_RATE,
      channels: 2,
    });
  });
});

describe('pcmToWav', () => {
  it('writes a canonical 44-byte RIFF header for mono 16-bit', () => {
    const pcm = new Uint8Array(8);
    const wav = pcmToWav(pcm, 24000, 1);
    expect(wav.length).toBe(44 + 8);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(wavField(wav, 4, 4)).toBe(wav.length - 8);
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...wav.slice(12, 16))).toBe('fmt ');
    expect(wavField(wav, 16, 4)).toBe(16);
    expect(wavField(wav, 20, 2)).toBe(1); // PCM
    expect(wavField(wav, 22, 2)).toBe(1); // mono
    expect(wavField(wav, 24, 4)).toBe(24000);
    expect(wavField(wav, 28, 4)).toBe(48000); // byteRate = 24000 * 1 * 2
    expect(wavField(wav, 32, 2)).toBe(2); // blockAlign = 1 * 2
    expect(wavField(wav, 34, 2)).toBe(16); // bitsPerSample
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe('data');
    expect(wavField(wav, 40, 4)).toBe(8);
  });

  it('computes byteRate and blockAlign for stereo', () => {
    const wav = pcmToWav(new Uint8Array(16), 16000, 2);
    expect(wavField(wav, 22, 2)).toBe(2);
    expect(wavField(wav, 28, 4)).toBe(16000 * 2 * 2);
    expect(wavField(wav, 32, 2)).toBe(4);
  });

  it('preserves the PCM payload verbatim', () => {
    const pcm = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const wav = pcmToWav(pcm, 24000, 1);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 250, 251, 252]);
  });
});
```

最後の it は実質的な検証にならないので、**この 1 本は削除し**、代わりに Step 3 で `Buffer` を含まないことをコードレビューで確認する。

- [ ] **Step 2: テストを走らせて失敗を確認する**

```
npm test -- src/lib/pcm-wav.test.ts
```
Expected: FAIL — `Cannot find module './pcm-wav'`

- [ ] **Step 3: 実装する**

`src/lib/pcm-wav.ts`:

```ts
/**
 * Headerless PCM → RIFF/WAV, plus the Content-Type parser for OpenRouter's
 * `audio/pcm;rate=…;channels=…` response header.
 *
 * Browser-safe by contract: `DataView` + `Uint8Array` only, no `Buffer`.
 * This module reaches the browser bundle through
 * `src/routes/+layout.svelte` → `src/lib/tts.ts` → `src/lib/tts-cache.ts`.
 */

export const DEFAULT_SAMPLE_RATE = 24000;
export const DEFAULT_CHANNELS = 1;

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

/**
 * Read `rate` / `channels` out of a PCM Content-Type header. Parameter order is
 * not guaranteed, and either parameter may be absent, so parse per-field with
 * a default rather than relying on a positional regex. A non-numeric value
 * falls back too — writing NaN into the WAV header makes browsers refuse to
 * decode, which means silence rather than a fallback.
 */
export function parsePcmContentType(contentType: string | null): PcmFormat {
  const format: PcmFormat = {
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: DEFAULT_CHANNELS,
  };
  if (!contentType) return format;
  for (const param of contentType.split(';').slice(1)) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    const value = Number(param.slice(eq + 1).trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    if (key === 'rate') format.sampleRate = value;
    else if (key === 'channels') format.channels = Math.trunc(value);
  }
  return format;
}

/** Prepend a canonical 44-byte RIFF header to a 16-bit PCM payload. */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;

  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bitsPerSample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  out.set(pcm, 44);

  return out;
}
```

- [ ] **Step 4: テストを通して `Buffer` がないことを確認する**

```
npm test -- src/lib/pcm-wav.test.ts
grep -n "Buffer" src/lib/pcm-wav.ts
```
Expected: 全テスト PASS / `grep` の出力なし（0 件）

- [ ] **Step 5: コミットする**

```bash
git add src/lib/pcm-wav.ts src/lib/pcm-wav.test.ts
git commit -m "feat: convert headerless PCM to WAV with a browser-safe header builder"
```

---

## Task 2: ボイス 1 件化 (`tts-voices.ts`)

**Files:**
- Modify: `src/lib/tts-voices.ts`（全置換）
- Test: `src/lib/tts-voices.test.ts`（全置換）

**Interfaces:**
- Consumes: なし（Task 1 の成果に依存しない）
- Produces:
  ```ts
  export type TtsLang = 'ja' | 'en';
  export interface VoiceInfo { name: string; label: string }
  export const CURATED_VOICES: VoiceInfo[];
  export function resolveVoice(storedVoiceURI: string | null | undefined): VoiceInfo
  export function isAllowedVoiceName(name: string): boolean
  ```
  **`DEFAULT_VOICE` / `TtsLang` / `VoiceInfo.lang` / `VoiceInfo.languageCode` / `VoiceInfo.gender` は削除する。**
  **`resolveVoice` は第 1 引数（`lang`）を取らない。**

- [ ] **Step 1: テストファイルを書く**

`src/lib/tts-voices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CURATED_VOICES, resolveVoice, isAllowedVoiceName } from './tts-voices';

describe('CURATED_VOICES', () => {
  it('holds exactly one Gemini voice', () => {
    expect(CURATED_VOICES).toHaveLength(1);
    expect(CURATED_VOICES[0].name).toBe('Ludo');
  });

  it('exposes only name and label', () => {
    for (const v of CURATED_VOICES) {
      expect(Object.keys(v).sort()).toEqual(['label', 'name']);
    }
  });

  it('has a Japanese display label', () => {
    expect(CURATED_VOICES[0].label.length).toBeGreaterThan(0);
  });
});

describe('isAllowedVoiceName', () => {
  it('accepts Ludo', () => {
    expect(isAllowedVoiceName('Ludo')).toBe(true);
  });

  it('rejects the retired Google Cloud TTS names', () => {
    for (const name of [
      'ja-JP-Neural2-B',
      'ja-JP-Neural2-C',
      'ja-JP-Neural2-D',
      'en-US-Neural2-A',
      'en-US-Neural2-C',
      'en-US-Neural2-F',
    ]) {
      expect(isAllowedVoiceName(name)).toBe(false);
    }
  });

  it('rejects garbage', () => {
    expect(isAllowedVoiceName('some-random-uri')).toBe(false);
  });
});

describe('resolveVoice', () => {
  it('returns Ludo when nothing is stored', () => {
    expect(resolveVoice(null).name).toBe('Ludo');
    expect(resolveVoice(undefined).name).toBe('Ludo');
    expect(resolveVoice('').name).toBe('Ludo');
  });

  it('returns Ludo when Ludo is stored', () => {
    expect(resolveVoice('Ludo').name).toBe('Ludo');
  });

  it('falls back to Ludo for every stored Google name, so old settings are invalidated', () => {
    for (const stored of ['ja-JP-Neural2-B', 'en-US-Neural2-F', 'garbage-voice']) {
      expect(resolveVoice(stored).name).toBe('Ludo');
    }
  });
});
```

**削除するテスト**: 旧 `:45-51` の `returns a voice with matching lang in all cases`。
ボイスが言語に紐づくという不変条件そのものが今回 abolishment されるため、
このテストは成立しなくなる。**不変条件の消滅による削除であり、アサーション弱化ではない。**
（旧 `CURATED_VOICES` の length 6 / `lang` 分割の assert も同様に 1 件構成への更新で置き換える。）

- [ ] **Step 2: テストを走らせて失敗を確認する**

```
npm test -- src/lib/tts-voices.test.ts
```
Expected: FAIL — `resolveVoice` は 2 引数必須、`DEFAULT_VOICE` が存在しない

- [ ] **Step 3: 実装する**

`src/lib/tts-voices.ts`（全置換）:

```ts
/**
 * The single Gemini TTS voice, plus pure selection logic.
 * No browser APIs — safe to import from the server (/api/tts), the client, and
 * Node tests.
 *
 * `Ludo` is a Gemini prebuilt voice that handles both ja and en: Gemini detects
 * the language from the input text, so there is no per-language voice axis.
 * `languageCode` / `gender` were Google Cloud TTS concepts and are gone.
 */

export interface VoiceInfo {
  /** Gemini voice name — stored verbatim in settings.voiceURI. */
  name: string;
  /** Short label shown in the UI (Japanese). */
  label: string;
}

export const CURATED_VOICES: VoiceInfo[] = [{ name: 'Ludo', label: 'Ludo' }];

/**
 * Pick the voice. The stored preference is honoured only when it is in the
 * allowlist; anything else (unknown, or a Google name retired by the Gemini
 * migration) falls back to the single default. This is what silently
 * invalidates `settings.voiceURI` values written by older versions.
 */
export function resolveVoice(storedVoiceURI: string | null | undefined): VoiceInfo {
  if (storedVoiceURI) {
    const match = CURATED_VOICES.find((v) => v.name === storedVoiceURI);
    if (match) return match;
  }
  return CURATED_VOICES[0];
}

/** Allowlist check used by the /api/tts endpoint. */
export function isAllowedVoiceName(name: string): boolean {
  return CURATED_VOICES.some((v) => v.name === name);
}
```

- [ ] **Step 4: テストを通して型チェックも通ることを確認する**

```
npm test -- src/lib/tts-voices.test.ts
npm run check
```
Expected: テスト PASS。`npm run check` は `src/lib/tts.ts` と `manage/+page.svelte` の
旧シグネチャ利用でエラーになる可能性がある（Task 5 / Task 6 で直す）。**このタスクの
時点では `tts-voices.test.ts` と `pcm-wav.test.ts` に関するエラーがないことだけ確認する。**

- [ ] **Step 5: コミットする**

```bash
git add src/lib/tts-voices.ts src/lib/tts-voices.test.ts
git commit -m "refactor: reduce the voice list to the single Gemini voice Ludo"
```

---

## Task 3: IndexedDB 永続キャッシュ (`tts-cache.ts`)

**Files:**
- Create: `src/lib/tts-cache.ts`
- Test: `src/lib/tts-cache.test.ts`
- Modify: `package.json`（devDependencies に `fake-indexeddb` を追加）

**Interfaces:**
- Consumes: なし（Task 1 の `pcmToWav` は **Task 5** のクライアント側で使われる。`tts-cache.ts` は PCM をそのまま保存し、ハッダ付けはしない）
- Produces:
  ```ts
  export const TTS_CACHE_SCHEMA_VERSION = 1;
  export const TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
  export interface TtsCacheKeyParts { text: string; lang: string }
  export function cacheKeyOf(parts: TtsCacheKeyParts): string
  export function isTtsCacheAvailable(): boolean
  export async function readCachedPcm(key: string): Promise<Uint8Array | null>
  export async function writeCachedPcm(key: string, pcm: Uint8Array): Promise<void>
  export async function clearTtsCacheForTests(): Promise<void>
  ```

- [ ] **Step 1: `fake-indexeddb` を devDependency に追加する**

```
npm install -D fake-indexeddb
```

- [ ] **Step 2: テストファイルを書く**

`src/lib/tts-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  TTS_CACHE_SCHEMA_VERSION,
  TTS_CACHE_MAX_BYTES,
  cacheKeyOf,
  isTtsCacheAvailable,
  readCachedPcm,
  writeCachedPcm,
  clearTtsCacheForTests,
} from './tts-cache';

const DB_NAME = 'oboeru-tts';
const STORE = 'audio';

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await clearTtsCacheForTests();
});

describe('cacheKeyOf', () => {
  it('is a synchronous pure function', () => {
    const key = cacheKeyOf({ text: 'こんにちは', lang: 'ja' });
    expect(typeof key).toBe('string');
  });

  it('embeds the schema version, model, voice and style', () => {
    expect(cacheKeyOf({ text: 'x', lang: 'ja' })).toBe(
      `v${TTS_CACHE_SCHEMA_VERSION}|google/gemini-3.8-flash-lite-tts|Ludo|Narration|ja|x`,
    );
  });

  it('excludes speakingRate so a rate change does not regenerate', () => {
    const a = cacheKeyOf({ text: 'x', lang: 'ja' });
    const b = cacheKeyOf({ text: 'x', lang: 'ja' });
    expect(a).toBe(b);
    expect(a).not.toContain('0.9');
  });

  it('separates different text and different lang', () => {
    expect(cacheKeyOf({ text: 'a', lang: 'ja' })).not.toBe(
      cacheKeyOf({ text: 'b', lang: 'ja' }),
    );
    expect(cacheKeyOf({ text: 'a', lang: 'ja' })).not.toBe(
      cacheKeyOf({ text: 'a', lang: 'en' }),
    );
  });
});

describe('isTtsCacheAvailable', () => {
  it('is true when indexedDB exists', () => {
    expect(isTtsCacheAvailable()).toBe(true);
  });
});

describe('read / write round trip', () => {
  it('returns null for a key that was never written', async () => {
    expect(await readCachedPcm('nope')).toBeNull();
  });

  it('returns the exact bytes that were written', async () => {
    const pcm = new Uint8Array([0, 1, 250, 251, 128, 64]);
    await writeCachedPcm('k1', pcm);
    const back = await readCachedPcm('k1');
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(pcm));
  });

  it('overwrites an existing key', async () => {
    await writeCachedPcm('k1', new Uint8Array([1, 1]));
    await writeCachedPcm('k1', new Uint8Array([2, 2, 2]));
    expect(Array.from((await readCachedPcm('k1'))!)).toEqual([2, 2, 2]);
  });

  it('stores a record with lastUsedAt so eviction can order it', async () => {
    await writeCachedPcm('k1', new Uint8Array([1]));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = await new Promise<{ lastUsedAt: number; byteLength: number }>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get('k1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    expect(typeof record.lastUsedAt).toBe('number');
    expect(record.byteLength).toBe(1);
    db.close();
  });
});

async function countEntries(): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const n = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return n;
}

describe('LRU pruning', () => {
  it('keeps everything under the byte budget', async () => {
    // 40 KiB is far below the 64 MiB cap, so nothing is pruned.
    const chunk = new Uint8Array(1024);
    for (let i = 0; i < 40; i++) await writeCachedPcm(`bulk-${i}`, chunk);
    expect(await countEntries()).toBe(40);
  });

  it('drops the oldest entries once the budget is exceeded', async () => {
    // Shrink the cap for this test so pruning is actually exercised without
    // writing 64 MiB. vi.resetModules + dynamic import picks up the new value.
    vi.resetModules();
    vi.doMock('./tts-cache', async () => {
      const actual = await vi.importActual<typeof import('./tts-cache')>('./tts-cache');
      return { ...actual, TTS_CACHE_MAX_BYTES: 4096 };
    });
    const { writeCachedPcm: write, readCachedPcm: read, cacheKeyOf: key } = await import(
      './tts-cache'
    );
    const { IDBFactory: Fresh } = await import('fake-indexeddb');
    globalThis.indexedDB = new Fresh();
    // Six 1 KiB records = 6 KiB > 4096, so the oldest must be pruned.
    for (let i = 0; i < 6; i++) await write(`p-${i}`, new Uint8Array(1024));
    expect(await countEntries()).toBeLessThan(6);
    // The most recent write survives.
    const newest = await read('p-5');
    expect(newest).not.toBeNull();
    vi.doUnmock('./tts-cache');
    vi.resetModules();
  });
});

```

- [ ] **Step 3: テストを走らせて失敗を確認する**

```
npm test -- src/lib/tts-cache.test.ts
```
Expected: FAIL — `Cannot find module './tts-cache'`

- [ ] **Step 4: 実装する**

`src/lib/tts-cache.ts`:

```ts
/**
 * Persistent PCM cache in IndexedDB.
 *
 * This is a TRANSPARENT OPTIMISATION. Every operation swallows its own errors
 * and resolves to "no cache hit", so a browser with IndexedDB disabled
 * (private mode), an old WebView, or a rejected write degrades to the
 * in-memory LRU plus the network — the practice flow keeps working.
 *
 * SSR contract (mirrors src/lib/tts.ts:4-5): the database is opened lazily on
 * the first read/write. Never touch `indexedDB` at module top level, and never
 * import `$app/environment` (its `browser` flag is `false` under vitest's node
 * environment, which would make this untestable).
 */

export const TTS_CACHE_SCHEMA_VERSION = 1;

/**
 * Self-managed LRU ceiling. The browser evicts IndexedDB per-origin in bulk
 * (taking unrelated data with it) and `navigator.storage.estimate()` is only an
 * approximation, so we prune before the browser does. 189 sentences at ~5s
 * each is ~45 MB, so this never actually trips for the current corpus.
 */
export const TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const DB_NAME = 'oboeru-tts';
const DB_VERSION = 1;
const STORE = 'audio';

export interface TtsCacheKeyParts {
  text: string;
  lang: string;
}

/**
 * Cache identity == what we send upstream. `speakingRate` is deliberately
 * absent: Gemini cannot be told a rate, so rate is a playback-time setting and
 * including it would store the same sentence once per rate setting.
 *
 * Model / voice / style are inlined as a versioned prefix. Bumping
 * TTS_CACHE_SCHEMA_VERSION (or any of the three literals) invalidates
 * everything at once. Kept synchronous so the in-memory LRU hot path never
 * awaits — hashing via `crypto.subtle.digest` would add a Promise and a
 * secure-context requirement for no benefit at 189 x ~100 characters.
 */
export function cacheKeyOf(parts: TtsCacheKeyParts): string {
  return [
    `v${TTS_CACHE_SCHEMA_VERSION}`,
    'google/gemini-3.8-flash-lite-tts',
    'Ludo',
    'Narration',
    parts.lang,
    parts.text,
  ].join('|');
}

export function isTtsCacheAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

interface AudioRecord {
  key: string;
  pcm: ArrayBuffer;
  byteLength: number;
  lastUsedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!isTtsCacheAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) {
        // Schema bump: drop everything rather than leaving orphans that can
        // never be read but still consume the byte budget.
        db.deleteObjectStore(STORE);
      }
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  }).then((db) => {
    if (!db) dbPromise = null;
    return db;
  });
  return dbPromise;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch {
      resolve(null);
      return;
    }
    const req = body(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      req.preventDefault();
      resolve(null);
    };
    tx.onabort = () => resolve(null);
  });
}

/** Total stored bytes, or 0 when the count cannot be read. */
async function totalBytes(db: IDBDatabase): Promise<number> {
  return new Promise<number>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      resolve(0);
      return;
    }
    const store = tx.objectStore(STORE);
    let sum = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(sum);
        return;
      }
      sum += (cursor.value as AudioRecord).byteLength ?? 0;
      cursor.continue();
    };
    cursorReq.onerror = () => resolve(sum);
  });
}

async function pruneOldest(db: IDBDatabase): Promise<void> {
  const used = await totalBytes(db);
  if (used <= TTS_CACHE_MAX_BYTES) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const cursorReq = store.index('lastUsedAt').openCursor();
    let running = used;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || running <= TTS_CACHE_MAX_BYTES) return;
      running -= (cursor.value as AudioRecord).byteLength ?? 0;
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => undefined;
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function readCachedPcm(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  const record = await run<AudioRecord>(db, 'readonly', (s) => s.get(key) as IDBRequest<AudioRecord>);
  if (!record) return null;
  // Touch lastUsedAt so the LRU order reflects reads, not just writes. A failed
  // touch is harmless — the entry is still usable.
  void writeLastUsed(db, key);
  return new Uint8Array(record.pcm);
}

function writeLastUsed(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const record = getReq.result as AudioRecord | undefined;
      if (!record) return;
      record.lastUsedAt = Date.now();
      store.put(record);
    };
    getReq.onerror = () => resolve(null);
    tx.oncomplete = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

export async function writeCachedPcm(key: string, pcm: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const copy = pcm.slice().buffer;
  const record: AudioRecord = {
    key,
    pcm: copy,
    byteLength: pcm.length,
    lastUsedAt: Date.now(),
  };
  const written = await run(db, 'readwrite', (s) => s.put(record));
  if (written === null) {
    // Most likely QuotaExceededError. Prune and retry once, then give up
    // silently — the caller treats a missing cache entry as a normal miss.
    await pruneOldest(db);
    await run(db, 'readwrite', (s) => s.put(record));
  }
}

export async function clearTtsCacheForTests(): Promise<void> {
  dbPromise = null;
  if (!isTtsCacheAvailable()) return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
```

- [ ] **Step 5: テストを通して型チェックも通ることを確認する**

```
npm test -- src/lib/tts-cache.test.ts
npm run check
```
Expected: テスト PASS。`npm run check` は Task 2 で壊れた `tts.ts` / `manage`  所以にエラーが残るが、`tts-cache` 自体にエラーがないこと。

- [ ] **Step 6: コミットする**

```bash
git add src/lib/tts-cache.ts src/lib/tts-cache.test.ts package.json package-lock.json
git commit -m "feat: cache generated PCM in IndexedDB with a self-managed LRU"
```

---

## Task 4: `/api/tts` を OpenRouter に差し替える

**Files:**
- Modify: `src/routes/api/tts/+server.ts`（全置換）
- Test: `src/routes/api/tts/tts-server.test.ts`（全置換）

**Interfaces:**
- Consumes: Task 1 の `parsePcmContentType` / `pcmToWav`、Task 2 の `isAllowedVoiceName` / `resolveVoice`
- Produces:
  ```ts
  export interface TtsRequestBody {
    text: string; lang: 'ja' | 'en'; voiceName: string; speakingRate: number;
  }
  export const TTS_MODEL = 'google/gemini-3.8-flash-lite-tts';
  export const TTS_STYLE = 'Narration';
  export async function _handleTtsPost(body: unknown, apiKey: string): Promise<Response>
  export async function _handleTtsRequest(request: Request, apiKey: string | undefined): Promise<Response>
  ```
  503 の本文は `{ error: 'TTS API キーが未設定です' }` のまま維持する。

- [ ] **Step 1: テストファイルを書く**

`src/routes/api/tts/tts-server.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { _handleTtsRequest, TTS_MODEL, TTS_STYLE } from './+server';

const PCM = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function post(body: unknown): Request {
  return new Request('http://localhost/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function pcmResponse(
  body: BodyInit = PCM,
  contentType = 'audio/pcm;rate=24000;channels=1',
  status = 200,
): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

function stubFetch(...responses: Response[]) {
  const mock = vi.fn();
  for (const r of responses) mock.mockResolvedValueOnce(r);
  mock.mockResolvedValue(pcmResponse());
  vi.stubGlobal('fetch', mock);
  return mock;
}

function upstreamBody(mock: ReturnType<typeof vi.fn>, index = 0) {
  return JSON.parse(String(mock.mock.calls[index]?.[1]?.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('_handleTtsRequest — validation', () => {
  it('returns 503 when the API key is missing', async () => {
    const res = await _handleTtsRequest(post({ text: 'こんにちは' }), undefined);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'TTS API キーが未設定です' });
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await _handleTtsRequest(post('not json'), 'key');
    expect(res.status).toBe(400);
  });

  it('returns 400 for unsupported lang', async () => {
    const res = await _handleTtsRequest(
      post({ text: 'hello', lang: 'fr', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('ja または en');
  });

  it('returns 400 for text over 400 chars', async () => {
    const res = await _handleTtsRequest(
      post({ text: 'a'.repeat(401), lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty text', async () => {
    const res = await _handleTtsRequest(
      post({ text: '', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for a voice outside the allowlist', async () => {
    const res = await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'Ludo2', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('許可');
  });
});

describe('_handleTtsPost — upstream request shape', () => {
  it('calls the OpenRouter speech endpoint', async () => {
    const mock = stubFetch();
    await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(mock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/audio/speech');
    const init = mock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
  });

  it('nests speech_metadata under provider.options, never at the top level', async () => {
    const mock = stubFetch();
    await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    const body = upstreamBody(mock);
    expect(body).toEqual({
      model: TTS_MODEL,
      input: 'こんにちは',
      voice: 'Ludo',
      response_format: 'pcm',
      provider: { options: { 'google-ai-studio': { speech_metadata: { style: TTS_STYLE } } } },
    });
    // Regression guard: top-level `instructions` returns HTTP 200 but is
    // silently dropped upstream, so the style would never take effect.
    expect(body).not.toHaveProperty('instructions');
    expect(body).not.toHaveProperty('speech_metadata');
  });

  it('ignores speakingRate (Gemini cannot be told a rate)', async () => {
    const mock = stubFetch();
    await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 10 }),
      'key',
    );
    const body = upstreamBody(mock);
    expect(JSON.stringify(body)).not.toContain('speakingRate');
    expect(body).not.toHaveProperty('speed');
  });

  it('sends the requested voice, not a hardcoded literal', async () => {
    const mock = stubFetch();
    await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(upstreamBody(mock).voice).toBe('Ludo');
  });
});

describe('_handleTtsPost — PCM to WAV conversion', () => {
  it('returns audio/wav with a 44-byte header prepended', async () => {
    stubFetch();
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/wav');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(44 + PCM.length);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    expect(bytes[20] | (bytes[21] << 8)).toBe(1);
    expect(Array.from(bytes.slice(44))).toEqual(Array.from(PCM));
  });

  it('falls back to 24000/1 when the Content-Type has no parameters', async () => {
    stubFetch(pcmResponse(PCM, 'audio/pcm'));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint16(22, true)).toBe(1);
  });

  it('is order independent about rate and channels', async () => {
    stubFetch(pcmResponse(PCM, 'audio/pcm;channels=2;rate=16000'));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(28, true)).toBe(16000 * 2 * 2);
  });

  it('never writes NaN into the header for a malformed Content-Type', async () => {
    stubFetch(pcmResponse(PCM, 'audio/pcm;rate=oops'));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(24000);
  });

  it('returns 502 when the Content-Type is not PCM', async () => {
    stubFetch(pcmResponse(PCM, 'audio/mpeg'));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 for an empty body', async () => {
    stubFetch(pcmResponse(new Uint8Array(0)));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
  });
});

describe('_handleTtsPost — upstream errors', () => {
  it('does not retry a 400', async () => {
    const mock = stubFetch(pcmResponse('{"error":{}}', 'application/json', 400));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 401 or 403', async () => {
    for (const status of [401, 403, 404, 413]) {
      const mock = stubFetch(pcmResponse('{"error":{}}', 'application/json', status));
      const res = await _handleTtsRequest(
        post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
        'key',
      );
      expect(res.status).toBe(502);
      expect(mock).toHaveBeenCalledTimes(1);
    }
  });

  it('does not retry a 402 for credits or key limits', async () => {
    const body = JSON.stringify({
      error: { message: 'x', metadata: { limit_source: 'openrouter_credits' } },
    });
    const mock = stubFetch(pcmResponse(body, 'application/json', 402));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('retries 429 once and succeeds', async () => {
    const mock = stubFetch(
      pcmResponse('{"error":{}}', 'application/json', 429),
      pcmResponse(),
    );
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('retries 503 once', async () => {
    const mock = stubFetch(
      pcmResponse('{"error":{}}', 'application/json', 503),
      pcmResponse(),
    );
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and returns 502', async () => {
    const mock = stubFetch();
    mock.mockResolvedValue(pcmResponse('{"error":{}}', 'application/json', 503));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('returns 408 when the upstream times out', async () => {
    vi.useFakeTimers();
    const abort = new DOMException('aborted', 'AbortError');
    const mock = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('fetch', mock);
    const promise = _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await promise;
    vi.useRealTimers();
    expect(res.status).toBe(408);
  });

  it('returns 502 when the upstream cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
  });
});
```

**削除するテスト 2 本**:
- 旧 `returns 200 audio/mpeg with decoded bytes on success` — Google の
  `{audioContent: base64 mp3}` レスポンス形状を前提にしているため。新テストに置き換える
- 旧 `clamps speakingRate to 0.25–4.0` — `speakingRate` を upstream に送る実装のテスト。
  Gemini では話速を指定せずサーバはこの値を無視するので**検証対象が消える**ため削除する

- [ ] **Step 2: テストを走らせて失敗を確認する**

```
npm test -- src/routes/api/tts/tts-server.test.ts
```
Expected: FAIL — `TTS_MODEL` が export されていない、`_handleTtsPost` はまだ Google を叩く

- [ ] **Step 3: 実装する**

`src/routes/api/tts/+server.ts`（全置換）:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isAllowedVoiceName } from '$lib/tts-voices';
import { parsePcmContentType, pcmToWav } from '$lib/pcm-wav';

const MAX_TEXT_LENGTH = 400;

/** Upstream budget. Kept under the client's 15s fetch timeout so the server
 *  never burns a paid generation the client has already given up on. */
const UPSTREAM_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1000, 2000];

/** Provider constants. The voice lives in `$lib/tts-voices` (the allowlist is
 *  the single source of truth). Change TTS_MODEL / TTS_STYLE together with the
 *  literals in `$lib/tts-cache` — they form one versioned cache prefix. */
export const TTS_MODEL = 'google/gemini-3.8-flash-lite-tts';
export const TTS_STYLE = 'Narration';

const SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';

export interface TtsRequestBody {
  text: string;
  lang: 'ja' | 'en';
  voiceName: string;
  /** Accepted for client compatibility, deliberately unused: Gemini has no
   *  numeric rate, so speed is a playback-time setting. */
  speakingRate: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(headers: Headers, fallback: number): number {
  const raw = headers.get('Retry-After');
  if (!raw) return fallback;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : fallback;
}

/** `in_flight_budget` is transient; credits/key limits are not. */
function isRetryable402(body: string): boolean {
  return /"limit_source"\s*:\s*"openrouter_in_flight_budget"/.test(body);
}

interface UpstreamResult {
  ok: boolean;
  pcm?: Uint8Array;
  sampleRate?: number;
  channels?: number;
  timeout?: boolean;
}

async function callUpstream(body: TtsRequestBody, apiKey: string): Promise<UpstreamResult> {
  const payload = {
    model: TTS_MODEL,
    input: body.text,
    voice: body.voiceName,
    response_format: 'pcm',
    // `speech_metadata` MUST live here. A top-level `instructions` field is
    // accepted with HTTP 200 and then silently dropped, so the style would
    // never take effect. Gemini reads `input` verbatim, which is why delivery
    // directions go in speech_metadata instead of the text.
    provider: { options: { 'google-ai-studio': { speech_metadata: { style: TTS_STYLE } } } },
  };

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(SPEECH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, timeout: true };
      }
      console.error('TTS upstream error:', err);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const contentType = res.headers.get('Content-Type');
      if (!contentType || !contentType.startsWith('audio/pcm')) {
        console.error('TTS upstream returned a non-PCM Content-Type:', contentType);
        return { ok: false };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) return { ok: false };
      const format = parsePcmContentType(contentType);
      return { ok: true, pcm: bytes, ...format };
    }

    const text = await res.text();
    const backoff = BACKOFF_MS[attempt] ?? null;
    const retryable =
      backoff !== null &&
      (res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 529 ||
        (res.status === 402 && isRetryable402(text)));

    if (!retryable) {
      console.error('TTS upstream HTTP', res.status, text.slice(0, 200));
      return { ok: false };
    }
    await sleep(retryAfterMs(res.headers, backoff));
  }
}

/**
 * Pure request handler — unit-testable without $env.
 * `apiKey` is injected by the caller (Workers secret / .env).
 */
export async function _handleTtsPost(body: unknown, apiKey: string): Promise<Response> {
  const b = body as TtsRequestBody | null;
  if (!b || typeof b !== 'object') {
    return json({ error: 'JSON ボディが必要です' }, { status: 400 });
  }
  if (typeof b.text !== 'string' || b.text.length === 0 || b.text.length > MAX_TEXT_LENGTH) {
    return json({ error: `text は 1〜${MAX_TEXT_LENGTH} 文字で指定してください` }, { status: 400 });
  }
  if (b.lang !== 'ja' && b.lang !== 'en') {
    return json({ error: '言語は ja または en を指定してください' }, { status: 400 });
  }
  if (typeof b.voiceName !== 'string' || !isAllowedVoiceName(b.voiceName)) {
    return json({ error: '指定された声は許可されていません' }, { status: 400 });
  }

  const result = await callUpstream(b, apiKey);
  if (result.timeout) {
    return json({ error: 'TTS API の応答がタイムアウトしました' }, { status: 408 });
  }
  if (!result.ok || !result.pcm) {
    return json({ error: '音声合成に失敗しました' }, { status: 502 });
  }

  const wav = pcmToWav(result.pcm, result.sampleRate ?? 24000, result.channels ?? 1);
  return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
}

/** Key check + JSON parse; thin wrapper around _handleTtsPost. */
export async function _handleTtsRequest(
  request: Request,
  apiKey: string | undefined,
): Promise<Response> {
  if (!apiKey) {
    return json({ error: 'TTS API キーが未設定です' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON ボディが必要です' }, { status: 400 });
  }
  return _handleTtsPost(body, apiKey);
}

export const POST: RequestHandler = ({ request }) =>
  _handleTtsRequest(request, env.OPENROUTER_API_KEY);
```

- [ ] **Step 4: テストを通してタイムアウトの総予算を確認する**

```
npm test -- src/routes/api/tts/tts-server.test.ts
```
Expected: テスト PASS。リトライを含む最悪ケースがクライアントの 15 秒内に収まることを
確認する（10s timeout + 1s + 2s = 13s < 15s）。

- [ ] **Step 5: コミットする**

```bash
git add src/routes/api/tts/+server.ts src/routes/api/tts/tts-server.test.ts
git commit -m "feat: synthesize through OpenRouter Gemini TTS and return WAV"
```

---

## Task 5: `tts.ts` — キャッシュキー・話速・IndexedDB 統合

**Files:**
- Modify: `src/lib/tts.ts`
- Test: `src/lib/tts.test.ts`

**Interfaces:**
- Consumes: Task 1 の `pcmToWav`、Task 2 の `resolveVoice`、Task 3 の `cacheKeyOf` / `readCachedPcm` / `writeCachedPcm` / `isTtsCacheAvailable`
- Produces:
  ```ts
  export interface SpeakOptions { rate?: number; voiceName?: string | null }
  export function speak(text: string, lang: string, options?: SpeakOptions): Promise<void>
  export function cancelSpeech(): void
  export function unlockAudio(): void
  export function prefetchTts(text: string, lang: string, options?: SpeakOptions): Promise<void>
  export function resetTtsCacheForTests(): void
  ```
  **`SpeakOptions.voiceURI` は `voiceName` に改名する。**

- [ ] **Step 1: 既存のハードコードされた voice 名を 3 箇所直す**

`src/lib/tts.test.ts` の以下を修正する:

```ts
// L69
const p = speak('hello', 'en', { voiceName: 'Ludo' });

// L223-242: 'separates cache entries by voice and rate' を書き換える。
// voice 軸は Gemini 一本化で消えたので、意図を 'text' と 'lang' の軸に移す。
it('separates cache entries by text and lang', async () => {
  fetchMock.mockImplementation(() => okResponse());
  const p1 = speak('声A', 'ja');
  await flush();
  await flush();
  lastAudio.onended?.();
  await p1;
  const p2 = speak('声B', 'ja');
  await flush();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  lastAudio.onended?.();
  await p2;
  const p3 = speak('声A', 'en');
  await flush();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  lastAudio.onended?.();
  await p3;
});

it('does NOT regenerate when only the rate changes', async () => {
  fetchMock.mockImplementation(() => okResponse());
  const p1 = speak('同じ文', 'ja', { rate: 1 });
  await flush();
  await flush();
  lastAudio.onended?.();
  await p1;
  const p2 = speak('同じ文', 'ja', { rate: 0.9 });
  await flush();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  lastAudio.onended?.();
  await p2;
});

// L327-331 付近の重複排除テスト: voiceURI → voiceName
void prefetchTts('声', 'ja', { voiceName: 'Ludo' });
```

- [ ] **Step 2: `FakeAudio` に playback 関連のフィールドを追加する**

`src/lib/tts.test.ts` の `FakeAudio` クラスを:

```ts
class FakeAudio {
  src = '';
  muted = false;
  playbackRate = 1;
  preservesPitch = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
}
```

- [ ] **Step 3: playbackRate / preservesPitch のテストを追加する**

`src/lib/tts.test.ts` の `describe('speak', …)` ブロックに追加:

```ts
it('sets preservesPitch and playbackRate from options', async () => {
  fetchMock.mockImplementation(() => okResponse());
  const p = speak('文', 'ja', { rate: 0.9 });
  await flush();
  await flush();
  expect(lastAudio.preservesPitch).toBe(true);
  expect(lastAudio.playbackRate).toBe(0.9);
  lastAudio.onended?.();
  await p;
});

it('defaults playbackRate to 1', async () => {
  fetchMock.mockImplementation(() => okResponse());
  const p = speak('文2', 'ja');
  await flush();
  await flush();
  expect(lastAudio.playbackRate).toBe(1);
  lastAudio.onended?.();
  await p;
});
```

- [ ] **Step 4: テストを走らせて失敗を確認する**

```
npm test -- src/lib/tts.test.ts
```
Expected: FAIL — `preservesPitch` が設定されない、`voiceName` が無視される、
rate 変更で再生成される

- [ ] **Step 5: `tts.ts` を書き換える**

`src/lib/tts.ts`（全置換）:

```ts
/**
 * TTS client backed by the /api/tts endpoint (OpenRouter → Gemini TTS).
 *
 * No Web Speech API usage. Browser globals (Audio, URL, indexedDB) are only
 * touched at call time so that importing this module in Node (e.g. vitest)
 * never throws.
 */

import { resolveVoice } from './tts-voices';
import { pcmToWav, parsePcmContentType } from './pcm-wav';
import {
  cacheKeyOf,
  isTtsCacheAvailable,
  readCachedPcm,
  writeCachedPcm,
} from './tts-cache';

export interface SpeakOptions {
  /** Playback rate. Applied at playback time, not synthesis time: Gemini has
   *  no numeric rate parameter, so changing this must not trigger a
   *  regeneration (and a charge). */
  rate?: number;
  /** Stored voice preference; anything outside the allowlist falls back. */
  voiceName?: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const PLAYBACK_TIMEOUT_MS = 30_000;
const CACHE_LIMIT = 50;

let activeAudio: HTMLAudioElement | null = null;

interface CacheEntry {
  blobUrl: string;
  blob: Blob;
}

const blobCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Blob>>();

/** Cache identity: schema version + provider + lang + text. No speakingRate —
 *  see SpeakOptions.rate. */
function cacheKeyOfRequest(text: string, lang: string): string {
  return cacheKeyOf({ text, lang });
}

/** Returns the cached blob, refreshing its LRU recency. */
function cachedBlob(key: string): Blob | null {
  const entry = blobCache.get(key);
  if (!entry) return null;
  blobCache.delete(key);
  blobCache.set(key, entry);
  return entry.blob;
}

function storeBlob(key: string, blob: Blob): void {
  blobCache.set(key, { blobUrl: URL.createObjectURL(blob), blob });
  if (blobCache.size <= CACHE_LIMIT) return;
  const oldest = blobCache.entries().next();
  if (oldest.done !== true) {
    blobCache.delete(oldest.value[0]);
    URL.revokeObjectURL(oldest.value[1].blobUrl);
  }
}

async function fetchTtsWav(text: string, lang: string, voiceName?: string | null): Promise<Blob> {
  const voice = resolveVoice(voiceName ?? null);
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang, voiceName: voice.name, speakingRate: 1 }),
      signal: fetchController.signal,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `TTS エラー (${res.status})`);
    }
    return await res.blob();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('TTS に接続できませんでした (タイムアウト)');
    }
    throw err;
  } finally {
    clearTimeout(fetchTimer);
  }
}

/**
 * Persist the generated audio for reuse across reloads. /api/tts returns a WAV
 * blob; we stash it whole. The PCM layout is recoverable from the header if a
 * future change makes the split worthwhile.
 */
async function persistToIdb(key: string, blob: Blob): Promise<void> {
  if (!isTtsCacheAvailable()) return;
  try {
    await writeCachedPcm(key, new Uint8Array(await blob.arrayBuffer()));
  } catch {
    // Transparent optimisation — a failed write only costs a regeneration.
  }
}

async function loadFromIdb(key: string): Promise<Blob | null> {
  if (!isTtsCacheAvailable()) return null;
  try {
    const pcm = await readCachedPcm(key);
    if (!pcm || pcm.length === 0) return null;
    return new Blob([pcmToWav(pcm, 24000, 1)], { type: 'audio/wav' });
  } catch {
    return null;
  }
}

async function obtainTtsBlob(
  text: string,
  lang: string,
  voiceName?: string | null,
): Promise<Blob> {
  // The key deliberately omits voiceName: there is exactly one voice, so it
  // carries no discriminating information. Threading it into the fetch keeps
  // the preference path working if a second voice is ever added.
  const key = cacheKeyOfRequest(text, lang);
  const hit = cachedBlob(key);
  if (hit) return hit;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    // IndexedDB survives reloads, which the in-memory LRU cannot. It is a
    // transparent optimisation, so any failure falls through to the network.
    const fromIdb = await loadFromIdb(key);
    const blob = fromIdb ?? (await fetchTtsWav(text, lang, voiceName));
    storeBlob(key, blob);
    if (!fromIdb) void persistToIdb(key, blob);
    return blob;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, request);
  return request;
}

const AUTOPLAY_BLOCKED_MESSAGE =
  '音声の再生がブロックされました。ページをタップまたはクリックしてから、もう一度お試しください';

/**
 * Call on the first user gesture (pointerdown/touchstart/keydown) to grant
 * audio playback permission; muted play is exempt from the autoplay policy.
 */
export function unlockAudio(): void {
  try {
    const a = new Audio();
    a.muted = true;
    void a.play().catch(() => {});
  } catch {
    // Audio is unavailable (SSR/Node) — nothing to unlock.
  }
}

function toPlaybackError(err: unknown): Error {
  const isAutoplayBlocked =
    (err instanceof Error && err.name === 'NotAllowedError') ||
    (err instanceof Error && /not allowed|play/i.test(err.message));
  if (isAutoplayBlocked) {
    return new Error(AUTOPLAY_BLOCKED_MESSAGE);
  }
  return err instanceof Error ? err : new Error('音声の再生に失敗しました');
}

/** Stop any in-progress speech synthesis playback. Safe to call anytime. */
export function cancelSpeech(): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
}

/**
 * Speak via POST /api/tts → HTMLAudioElement playback.
 * Reuses the in-memory LRU, then IndexedDB, then the network. Resolves when
 * playback ends; rejects on fetch/upstream/playback errors.
 */
export async function speak(
  text: string,
  lang: string,
  options?: SpeakOptions,
): Promise<void> {
  const blob = await obtainTtsBlob(text, lang, options?.voiceName);

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;

  try {
    await new Promise<void>((resolve, reject) => {
      const playbackTimer = setTimeout(() => {
        audio.pause();
        reject(new Error('音声の再生に失敗しました (タイムアウト)'));
      }, PLAYBACK_TIMEOUT_MS);
      audio.onended = () => {
        clearTimeout(playbackTimer);
        resolve();
      };
      audio.onerror = () => {
        clearTimeout(playbackTimer);
        audio.pause();
        reject(new Error('音声の再生に失敗しました'));
      };
      // Muted autoplay is never blocked by the autoplay policy; unmute once
      // playback has actually started.
      audio.muted = true;
      // Pitch preservation is not cosmetic here: at 0.5x a shifted pitch stops
      // being recognisable Japanese, which defeats the whole exercise.
      audio.preservesPitch = true;
      audio.playbackRate = options?.rate ?? 1;
      void audio.play()
        .then(() => {
          audio.muted = false;
        })
        .catch((err: unknown) => {
          clearTimeout(playbackTimer);
          reject(toPlaybackError(err));
        });
    });
  } finally {
    activeAudio = null;
    URL.revokeObjectURL(url);
  }
}

/**
 * Fetch and cache the audio for a sentence without playing it.
 * Resolves once the audio is cached (immediately, on cache hit).
 */
export async function prefetchTts(
  text: string,
  lang: string,
  options?: SpeakOptions,
): Promise<void> {
  await obtainTtsBlob(text, lang, options?.voiceName);
}

/** Test-only: drop every cached entry and in-flight request (no revoke). */
export function resetTtsCacheForTests(): void {
  blobCache.clear();
  inFlight.clear();
}
```

- [ ] **Step 6: テストを通して SSR 不変条件を確認する**

```
npm test -- src/lib/tts.test.ts
node -e "import('./src/lib/tts-cache.ts').then(()=>console.log('import ok'))" 2>/dev/null || true
```
Expected: テスト PASS。Node（`indexedDB` なし）で `tts-cache` を import しても例外が出ないこと。

- [ ] **Step 7: コミットする**

```bash
git add src/lib/tts.ts src/lib/tts.test.ts
git commit -m "feat: play at a client-side rate and persist audio in IndexedDB"
```

---

## Task 6: 呼び出し側と管理画面の追随

**Files:**
- Modify: `src/routes/practice/+page.svelte`（`voiceURI` → `voiceName`）
- Modify: `src/routes/manage/+page.svelte`（幽霊値修正 + 孤児見出し削除）
- Test: `tests/practice.spec.ts`（リロード跨ぎの E2E を追加）

**Interfaces:**
- Consumes: Task 5 の `SpeakOptions.voiceName`
- Produces: なし（UI 層）

- [ ] **Step 1: `practice/+page.svelte` の 3 箇所を改名する**

`src/routes/practice/+page.svelte` の 297 / 619 / 638 / 643 行付近の `voiceURI` を
`voiceName` に改名する。変数宣言 107 行も:

```ts
let voiceName: string | null = $state(null);
```

858 行の `voiceURI = settings.voiceURI;` は:

```ts
voiceName = settings.voiceURI;
```

`settings.voiceURI` は**そのまま**（設定のフィールド名は変えない。マイグレーション不要で
古い値は `resolveVoice` が無効化する）。

- [ ] **Step 2: `npm run check` で practice のエラーが 0 になることを確認する**

```
npm run check
```
Expected: `speak` / `prefetchTts` 相关的エラーが 0

- [ ] **Step 3: `manage/+page.svelte` の `voiceLabel` を修正する**

`src/routes/manage/+page.svelte:314-317`:

```ts
	function voiceLabel(voiceURI: string | null): string {
		if (!voiceURI) return 'デフォルト (言語に応じて自動)';
		const voice = CURATED_VOICES.find((v) => v.name === voiceURI);
		// Retired Google names (ja-JP-Neural2-*) fail the allowlist. Showing the
		// raw string would render a value with no matching Select.Item, i.e. an
		// unselectable ghost, so fall back to the default label.
		return voice ? voice.label : 'デフォルト (言語に応じて自動)';
	}
```

- [ ] **Step 4: ボイス select を 1 段列挙にする**

`src/routes/manage/+page.svelte:1870-1880` の `#each` ブロックと、
`Select.Label`（日本語 / English）と `Select.Separator` を 1 段の `#each` に置き換える:

```svelte
					<Select.Content>
						{#each CURATED_VOICES as voice (voice.name)}
							<Select.Item value={voice.name}>{voice.label}</Select.Item>
						{/each}
					</Select.Content>
```

- [ ] **Step 5: 既存の E2E が緑のまま通ることを確認する**

```
npx playwright test tests/practice.spec.ts --workers=1 --reporter=list
```
Expected: 既存の `ttsCallCount()` の assert（`practice.spec.ts:409,764,767`）を含めて全パス

- [ ] **Step 6: リロード跨ぎの E2E を追加する**

`tests/practice.spec.ts` の TTS 関連の describe ブロックに追加:

**挿入位置**: `tests/practice.spec.ts` の既存の `describe('Practice — TTS cache', …)`
ブロック（`ttsCallCount()` を使う既存テスト群、L400 前後）の末尾。

**seed とヘルパーは既存のものを再利用する**（新しいヘルパーを書かない）:
`tests/fixtures.ts` の `seedStorage(page, data)` と、`mockTtsApi(page)`。
既存の TTS キャッシュテスト（`practice.spec.ts:400-410`）が同じ形で seed しているので、
**そのテストの seed データをそのまま複製する**。

```ts
test('IndexedDB キャッシュはリロードを跨いで効く', async ({ page }) => {
	const tts = await mockTtsApi(page);
	// ← 既存の TTS キャッシュテスト（L400 前後）と同じ seed をそのまま使う
	await seedStorage(page, TTS_CACHE_SEED);
	await page.goto('/practice?node=ch-1');
	await page.getByTestId('record-ready').waitFor({ state: 'visible' });

	// 1 回目の読み上げ: ネットワークから取得される
	await page.keyboard.down('Space');
	await page.waitForTimeout(800);
	await page.keyboard.up('Space');
	await expect.poll(() => tts.count()).toBeGreaterThanOrEqual(1);
	const before = tts.count();

	// リロード後はインメモリ LRU が空になるが IndexedDB は残る
	await page.reload();
	await page.getByTestId('record-ready').waitFor({ state: 'visible' });
	await page.keyboard.down('Space');
	await page.waitForTimeout(800);
	await page.keyboard.up('Space');

	// 新規生成しない = IndexedDB から供給された
	await page.waitForTimeout(500);
	expect(tts.count()).toBe(before);
});
```

`TTS_CACHE_SEED` は既存の TTS キャッシュテストが使っている seed オブジェクトに
インラインで名前を付けて切り出す（新しいデータを作らない）。

**注記**: E2E は `tests/practice.spec.ts:909` の `page.route('**/api/tts')` で**サーバを
丸ごと差し替えている**ため、upstream 呼び出し・リトライ・PCM→WAV 変換は一度も実行されない。
これらは Task 4 のユニットテストでしか検証されない。

- [ ] **Step 7: E2E を走らせる**

```
npx playwright test tests/practice.spec.ts --workers=1 --reporter=list
```
Expected: 追加分を含めて全パス

- [ ] **Step 8: コミットする**

```bash
git add src/routes/practice/+page.svelte src/routes/manage/+page.svelte tests/practice.spec.ts
git commit -m "feat: follow the Gemini voice rename and cover the reload-persistent cache"
```

---

## Task 7: ドキュメントと不要ファイルの整理

**Files:**
- Modify: `README.md`（30-50, 120-121 行）
- Modify: `.env.example`（8-9 行）
- Modify: `AGENTS.md`（セットアップ節、ロードマップ ④、ディレクトリ地図、Jev 規約）
- Modify: `docs/superpowers/specs/2026-09-22-tts-freeze-fix.md`（付録 127/139/145 行）
- Delete: `scripts/spike-gemini-tts.mjs`, `scripts/spike-listen-set.mjs`, `scripts/spike-listen-set2.mjs`, `scripts/fix-wav.mjs`

**Interfaces:**
- Consumes: なし
- Produces: なし（ドキュメント）

- [ ] **Step 1: `README.md` の TTS 節を差し替える**

`README.md:30-50` の「GOOGLE_TTS_API_KEY の取得と設定」節を、
`OPENROUTER_API_KEY` を使う説明に置き換える。API キーは **Jev 判定と共有**している
こと、TTS の従量課金は 10 秒あたり $0.0015、1 文あたり約 $0.002〜0.005、
生成済み音声は IndexedDB にキャッシュされて 2 回目は請求されないことを書く。

`README.md:120-121` の「読み上げはサーバー経由の Google Cloud TTS（Neural2）を使用」
と「日本語 3 声 + English 3 声」を、Gemini 一本化（ボイス 1 種 `Ludo`）の説明に置き換える。

- [ ] **Step 2: `.env.example` から `GOOGLE_TTS_API_KEY` を削除する**

`.env.example:8-9` の「Google Cloud Text-to-Speech API キー」ブロックを削除する。
`GROQ_API_KEY` と `OPENROUTER_API_KEY` の記述（あれば残す）を確認する。

- [ ] **Step 3: `AGENTS.md` を 4 箇所更新する**

1. セットアップ節: `GOOGLE_TTS_API_KEY` の行を削除し、`OPENROUTER_API_KEY` が
   **Jev 判定と TTS で共有**されていることを明記する
2. ディレクトリ地図: `src/lib/pcm-wav.ts`（PCM→WAV 純関数・`Buffer` 禁止）と
   `src/lib/tts-cache.ts`（IndexedDB 永続キャッシュ・透過的最適化）を追記
3. ロードマップ ④: `gemini-3.8-flash-tts` → `google/gemini-3.8-flash-lite-tts`
   （OpenRouter 経由）、R2 は弃却して IndexedDB、2026-09-29 実装済に更新
4. TTS 規約の節を新設: 「読み上げは OpenRouter 経由の Gemini TTS。
   `speech_metadata` は必ず `provider.options['google-ai-studio']` 配下。
   top-level `instructions` は 200 を返すが黙って捨てられる。
   話速は `playbackRate`（`preservesPitch = true`）で、生成キーには
   `speakingRate` を含めない」

- [ ] **Step 4: freeze-fix の付録 3 点を訂正する**

`docs/superpowers/specs/2026-09-22-tts-freeze-fix.md` の 127 / 139 / 145 行を、
単なる「実装済」フラグではなく**決定の訂正**として書き直す:

- モデル: `gemini-3.8-flash-tts` → **`google/gemini-3.8-flash-lite-tts`**
- キー: `GEMINI_API_KEY` → **`OPENROUTER_API_KEY`（Jev と共有）**
- 配信: 「R2 に保存して配信」→ **弃却。IndexedDB のクライアントキャッシュ**

**この 3 点を訂正しないと、次の読み手が R2 と `GEMINI_API_KEY` で設計を始める。**

- [ ] **Step 5: spike 用スクリプトを削除する**

```bash
git rm scripts/spike-gemini-tts.mjs scripts/spike-listen-set.mjs scripts/spike-listen-set2.mjs scripts/fix-wav.mjs
```

これらは `GOOGLE_TTS_API_KEY` / `GEMINI_API_KEY` を読む spike 専用で、
秘密鍵の削除後は動かなくなる。実測結果は `docs/research/` のレポートに残っている。

- [ ] **Step 6: 秘密鍵を `.env` から削除する**

`.env` から `GOOGLE_TTS_API_KEY` と `GEMINI_API_KEY` の行を削除する
（`.env` はコミットしない）。

**`npx wrangler secret delete GOOGLE_TTS_API_KEY` はデプロイに影響するので、
ユーザー明示依頼後に実行する（ここでは実行しない）。**

- [ ] **Step 7: 全検証を走らせる**

```
npm run check
npm test
npx playwright test --workers=1
```
Expected: `svelte-check` 0 エラー / vitest 全緑 / Playwright 全緑

- [ ] **Step 8: コミットする**

```bash
git add README.md .env.example AGENTS.md docs/superpowers/specs/2026-09-22-tts-freeze-fix.md
git commit -m "docs: replace Google TTS with OpenRouter Gemini in setup and roadmap docs"
```

---

## 検証コマンド（全部）

```
npm run check                          # svelte-check 0 エラー
npm test                               # vitest 全緑
npx playwright test --workers=1        # Playwright 全緑
grep -n "GOOGLE_TTS_API_KEY\|Gemini" src/ | grep -v test   # ソースに残存参照がないこと
```

デプロイ後のスモーク（**ユーザー明示依頼時のみ**）:

```
curl -X POST https://oboeru.k319-k319-k319-k319.workers.dev/api/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","lang":"ja","voiceName":"Ludo","speakingRate":1}' \
  -o /tmp/smoke.wav -w "%{http_code} %{content_type}\n"
```
Expected: `200 audio/wav` かつ `xxd -l 16 /tmp/smoke.wav` が `5249 4646 ... 5741 5645`（RIFF + WAVE）

## 実機ゲート（ユーザー承認ゲート — 未実施）

自動検証は全緑でも下列は**ユーザー確認が必要**:

1. Android Chrome と iOS Safari で読み上げが鳴る（`preservesPitch` が効いている）
2. 話速スライダー 0.5 / 1.0 / 2.0 で pitch が崩れない
3. リロードを跨いで音声が即再生される（IndexedDB 経路）
4. リロードを跨いで**8 日以上使わずに**も音声が維持されるか
   （iOS ITP の 7 日ルール。**ホーム画面 PWA を追加していれば免除**。
   ロードマップ⑤の PWA 化はこの风险的を消す）
5. `ttsRate` の 0.9 が実際に最適か（試聴は 1 文のみで確定していない。既定値は 1.0 のまま）


---

## Self-Review（spec 突き合わせ）

### Spec coverage

| Spec の節 | カバーする Task |
|---|---|
| §1 `/api/tts` の差し替え（upstream ボディ、`speech_metadata` の位置、503 文言維持、PCM→WAV、`GOOGLE_TTS_API_KEY` 削除） | Task 4, Task 7 |
| §2 ボイス選択の単純化（`languageCode`/`gender`/`lang` abolish、`manage` の 3+1 箇所の変更） | Task 2, Task 6 |
| §3 話速をクライアントへ（`speakingRate` をキーに含めない、`preservesPitch`、既定 1.0 維持） | Task 5 |
| §4 IndexedDB 永続キャッシュ（DB 設計、LRU 64MB、`persist()` 呼ばない、3 段フォールバック、SSR 不変条件） | Task 3, Task 5 |
| §5 エラー処理（リトライ表、`Retry-After`、`limit_source` 判定、タイムアウト予算） | Task 4 |
| §6 データモデル（変更なし） | 対象外（意図的に変更なし。どこにもタスクを置いていない） |
| テスト計画（`pcm-wav.test.ts` / `tts-server.test.ts` 拡張+削除2本 / `tts-voices.test.ts` 書き直し+削除1本 / `tts-cache.test.ts` / `tts.test.ts` 修正3箇所 / E2E リロード跨ぎ） | Task 1, 2, 3, 4, 5, 6 |
| 移行チェックリスト（README / `.env.example` / `AGENTS.md` 4 箇所 / freeze-fix 付録 3 点 / spike スクリプト削除 / `.env` 整理） | Task 7 |

**Gap なし。** 特に:

- **503 のメッセージ文言維持**（旧 `tts-server.test.ts:22` の完全一致 assert）→ Task 4 Step 1
- **`OPENROUTER_API_KEY` 共有のリスク**（TTS 大量消費が Jev を無言で劣化させる）→
  Task 4（429/402 のリトライ）と Task 7 の AGENTS.md Jev 規約追記。キーの分離自体は
  非目標として見送り（個人利用では割に合わない）
- **`navigator.storage.estimate()` を使わない**（近似値）→ Task 3 の実装に現れない

### Placeholder scan

「TBD」/「TODO」/「後で実装」/「appropriate error handling」/「上のテストを書く」は
**0 件**。全ステップに実コードと期待出力を記載。

### Type consistency

| 名前 | 定義元 | 使用箇所 |
|---|---|---|
| `pcmToWav(pcm, sampleRate, channels)` | Task 1 | Task 5 `loadFromIdb` |
| `parsePcmContentType(contentType)` | Task 1 | Task 4 `callUpstream` |
| `DEFAULT_SAMPLE_RATE` / `DEFAULT_CHANNELS` | Task 1 | Task 1 のテスト、Task 4 のフォールバック |
| `resolveVoice(stored)` | Task 2 | Task 5 `fetchTtsWav` |
| `isAllowedVoiceName(name)` | Task 2 | Task 4 `_handleTtsPost` |
| `cacheKeyOf({text, lang})` | Task 3 | Task 5 `cacheKeyOfRequest` |
| `readCachedPcm` / `writeCachedPcm` / `isTtsCacheAvailable` | Task 3 | Task 5 |
| `TTS_MODEL` / `TTS_STYLE` | Task 4 | Task 4 のテスト、Task 7 の AGENTS.md 追記 |
| `SpeakOptions.voiceName` | Task 5 | Task 6 の `practice/+page.svelte` |

全名前が 1 箇所で定義され、以降は参照のみ。**Task 3 の `Consumes` は「なし」に訂正した**
（`tts-cache.ts` は `pcm-wav.ts` を import しない — ヘッダ付けは Task 5 のクライアント側）。

### 意図的に残した既知の弱点

1. **Task 3 の LRU テストは `vi.doMock` で定数を 4096 に書き換える。** 64 MiB を実際に
   埋めるのは非現実的なので定数フックで代替した。定数が `export const` である前提に依存
   するので、`let` に変えるとテストが壊れる（その旨は `tts-cache.ts` のコメントにない。
   **実装時に `export const` を維持すること**）
2. **Task 6 の E2E は「`page.route` でサーバを丸ごと差し替えている」ため、
   PCM→WAV 変換やリトライを検証しない。** ここだけは Task 4 のユニットテストが唯一の
   検証手段。E2E の限界は Task 6 Step 6 の注記に明記した
3. **`TTS_CACHE_SEED` の実体は既存の TTS キャッシュテストから切り出す想定。**
   該当テストが見つからない場合は seed を新設してよいが、**新しい音声アセットを
   作らない**（既存の `babel-import.json` 由来の seed を使う）
