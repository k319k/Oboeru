/**
 * TTS client backed by the /api/tts endpoint (OpenRouter → Gemini TTS).
 *
 * No Web Speech API usage. Browser globals (Audio, URL, indexedDB) are only
 * touched at call time so that importing this module in Node (e.g. vitest)
 * never throws.
 */

import { resolveVoice } from './tts-voices';
import { pcmToWav, DEFAULT_SAMPLE_RATE, DEFAULT_CHANNELS } from './pcm-wav';
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

/** The canonical 44-byte header `pcmToWav` writes, and the only one we accept. */
const WAV_HEADER_BYTES = 44;

const RIFF_MAGIC = 0x46464952; // 'RIFF', little-endian
const WAVE_MAGIC = 0x45564157; // 'WAVE'
const FMT_MAGIC = 0x20746d66; // 'fmt '
const AUDIO_FORMAT_PCM = 1;

interface WavHeader {
  sampleRate: number;
  channels: number;
}

/**
 * Read the canonical RIFF/WAVE header, or return null when these bytes are not
 * one — raw PCM, a truncated blob, or a compressed format we never produce.
 *
 * Local to this module on purpose: `pcm-wav.ts` is the "headerless PCM in, WAV
 * out" codec, and teaching it to *parse* WAV would also mean editing its test
 * file, which is outside this task's file scope. The asymmetry this resolves
 * exists only here, where a server WAV meets a PCM-shaped record.
 */
function readWavHeader(bytes: Uint8Array): WavHeader | null {
  if (bytes.length < WAV_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== RIFF_MAGIC) return null;
  if (view.getUint32(8, true) !== WAVE_MAGIC) return null;
  if (view.getUint32(12, true) !== FMT_MAGIC) return null;
  if (view.getUint16(20, true) !== AUDIO_FORMAT_PCM) return null;
  // A data chunk that overruns the buffer is a truncated write, not a WAV we can
  // trust; treating it as PCM would emit a header claiming more audio than
  // exists, which plays as a truncated file rather than as a clean miss.
  if (view.getUint32(40, true) + WAV_HEADER_BYTES > bytes.length) return null;
  return { sampleRate: view.getUint32(24, true), channels: view.getUint16(22, true) };
}

/**
 * Normalise a fetched blob into the raw PCM the record is documented to hold.
 *
 * A header is stripped only when it declares the format `loadFromIdb` would
 * rebuild, so the round trip is byte-identical. If the upstream ever answers with
 * a rate or channel count other than the default, the header is kept instead:
 * the format then lives nowhere else — `readCachedPcm` returns bare bytes with
 * no sidecar — so discarding it would replay the audio at the wrong speed
 * forever. `loadFromIdb` plays such a record verbatim.
 */
function toStoredPcm(bytes: Uint8Array): Uint8Array {
  const header = readWavHeader(bytes);
  if (header === null) return bytes;
  if (header.sampleRate === DEFAULT_SAMPLE_RATE && header.channels === DEFAULT_CHANNELS) {
    return bytes.subarray(WAV_HEADER_BYTES);
  }
  return bytes;
}

/**
 * Persist the generated audio for reuse across reloads. /api/tts returns a WAV
 * blob, while the IndexedDB record is raw PCM (`tts-cache` names the field
 * `pcm`), so the header is stripped here — see `toStoredPcm`.
 */
async function persistToIdb(key: string, blob: Blob): Promise<void> {
  if (!isTtsCacheAvailable()) return;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeCachedPcm(key, toStoredPcm(bytes));
  } catch {
    // Transparent optimisation — a failed write only costs a regeneration.
  }
}

async function loadFromIdb(key: string): Promise<Blob | null> {
  if (!isTtsCacheAvailable()) return null;
  try {
    const stored = await readCachedPcm(key);
    if (!stored || stored.length === 0) return null;
    if (readWavHeader(stored) !== null) {
      // A whole WAV: either written before the strip, or kept whole because its
      // rate is not the default. Its header already carries the real format, so
      // it is played verbatim. Prepending a second one is not cosmetic — the
      // "RIFF"/"WAVE"/"fmt " bytes decode as 22 samples at ~85% full scale, i.e.
      // a click on the first sample of every cached replay.
      return new Blob([new Uint8Array(stored)], { type: 'audio/wav' });
    }
    // Raw PCM: rebuild the header. `pcmToWav` returns
    // `Uint8Array<ArrayBufferLike>`, which `BlobPart` rejects, so the re-wrap
    // yields the `ArrayBuffer`-backed view — same fix as
    // src/routes/api/tts/+server.ts.
    return new Blob([new Uint8Array(pcmToWav(stored, DEFAULT_SAMPLE_RATE, DEFAULT_CHANNELS))], {
      type: 'audio/wav',
    });
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
  // carries no discriminating information. Adding a second voice therefore
  // requires extending the versioned prefix inside `cacheKeyOf` and bumping
  // `TTS_CACHE_SCHEMA_VERSION` (see tts-cache.ts) — merely passing the name
  // through to the fetch, as we do, is not enough: the key does not include it,
  // so the previous voice's audio would keep being served.
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
    // Only network results are written back. Re-writing an IndexedDB hit would
    // loop for no gain, and — since reads now normalise legacy whole-WAV
    // records on the fly (`readWavHeader`) — a bad record cannot become
    // permanently stuck: it plays correctly, and the next network fetch
    // overwrites it with canonical raw PCM.
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
