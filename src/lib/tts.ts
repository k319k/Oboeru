/**
 * TTS client backed by the /api/tts endpoint (Google Cloud TTS).
 *
 * No Web Speech API usage. Browser globals (Audio, URL) are only touched at
 * call time so that importing this module in Node (e.g. vitest) never throws.
 */

import { resolveVoice, type TtsLang } from './tts-voices';

export interface SpeakOptions {
  /** Playback/synthesis rate (default 1.0). */
  rate?: number;
  /** Google voice name (e.g. 'ja-JP-Neural2-B'); falls back to the language default. */
  voiceURI?: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const PLAYBACK_TIMEOUT_MS = 30_000;
const CACHE_LIMIT = 50;

let activeAudio: HTMLAudioElement | null = null;

interface TtsRequest {
  text: string;
  lang: string;
  voiceName: string;
  speakingRate: number;
}

interface CacheEntry {
  blobUrl: string;
  blob: Blob;
}

const blobCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<Blob>>();

function cacheKeyOf(req: TtsRequest): string {
  return `${req.text}|${req.lang}|${req.voiceName}|${req.speakingRate}`;
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

async function fetchTtsBlob(key: string, req: TtsRequest): Promise<Blob> {
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: fetchController.signal,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? `TTS エラー (${res.status})`);
    }
    const blob = await res.blob();
    storeBlob(key, blob);
    return blob;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('TTS に接続できませんでした (タイムアウト)');
    }
    throw err;
  } finally {
    clearTimeout(fetchTimer);
  }
}

function obtainTtsBlob(req: TtsRequest): Promise<Blob> {
  const key = cacheKeyOf(req);
  const hit = cachedBlob(key);
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchTtsBlob(key, req).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

function buildTtsRequest(text: string, lang: string, options?: SpeakOptions): TtsRequest {
  const voice = resolveVoice(lang as TtsLang, options?.voiceURI);
  return { text, lang, voiceName: voice.name, speakingRate: options?.rate ?? 1 };
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
 * Reuses the session cache on hit (no fetch). Resolves when playback ends;
 * rejects on fetch/upstream/playback errors.
 */
export async function speak(
  text: string,
  lang: string,
  options?: SpeakOptions,
): Promise<void> {
  const blob = await obtainTtsBlob(buildTtsRequest(text, lang, options));

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
  await obtainTtsBlob(buildTtsRequest(text, lang, options));
}

/** Test-only: drop every cached entry and in-flight request (no revoke). */
export function resetTtsCacheForTests(): void {
  blobCache.clear();
  inFlight.clear();
}
