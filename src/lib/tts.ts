/**
 * TTS client backed by the /api/tts endpoint (OpenRouter → Gemini TTS).
 *
 * No Web Speech API usage. Browser globals (Audio, URL, indexedDB) are only
 * touched at call time so that importing this module in Node (e.g. vitest)
 * never throws.
 */

import { resolveVoice } from './tts-voices';
import { pcmToWav } from './pcm-wav';
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
    // `pcmToWav` returns `Uint8Array<ArrayBufferLike>`, which `BlobPart`
    // rejects; the re-wrap yields the `ArrayBuffer`-backed view. Same fix as
    // src/routes/api/tts/+server.ts.
    return new Blob([new Uint8Array(pcmToWav(pcm, 24000, 1))], { type: 'audio/wav' });
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
