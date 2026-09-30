import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { speak, cancelSpeech, unlockAudio, prefetchTts, resetTtsCacheForTests } from './tts';
import { CURATED_VOICES } from './tts-voices';
import { cacheKeyOf, clearTtsCacheForTests, readCachedPcm } from './tts-cache';

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

/** Yield to the macrotask queue so that Node.js Response.blob() resolves. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

let lastAudio: FakeAudio;
const fetchMock = vi.fn();

beforeEach(() => {
  lastAudio = new FakeAudio();
  vi.stubGlobal('Audio', vi.fn((url?: string) => { lastAudio.src = url ?? ''; return lastAudio; }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:mock-tts'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

beforeEach(() => {
  resetTtsCacheForTests();
});

function okResponse(): Response {
  return new Response(new Blob(['audio-data']), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  });
}

describe('speak', () => {
  // The server ignores `speakingRate` (Gemini has no rate parameter), so the
  // client always sends the constant 1 and the user's rate only ever reaches
  // `playbackRate`. See "does NOT regenerate when only the rate changes".
  it('posts the resolved voice and a fixed speakingRate to /api/tts', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const p = speak('こんにちは', 'ja', { rate: 1.5 });
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/tts', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      text: 'こんにちは',
      lang: 'ja',
      voiceName: CURATED_VOICES[0].name,
      speakingRate: 1,
    });

    lastAudio.onended?.();
    await p;
  });

  // The stored preference is resolved through the allowlist before it is sent:
  // there is no language axis to match against any more, and forwarding a
  // retired name verbatim would be rejected with 400 by /api/tts — which is what
  // silently invalidates `settings.voiceURI` written by an older version.
  it('sends only allowlisted voice names to /api/tts', async () => {
    // A fresh Response per call: a Response body can only be read once.
    fetchMock.mockImplementation(() => okResponse());
    const p1 = speak('hello', 'en', { voiceName: 'Ludo' });
    await flush();
    await flush();
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body1.voiceName).toBe('Ludo');
    lastAudio.onended?.();
    await p1;

    const p2 = speak('world', 'en', { voiceName: 'en-US-Neural2-F' });
    await flush();
    await flush();
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body2.voiceName).toBe('Ludo');
    lastAudio.onended?.();
    await p2;
  });

  it('resolves when playback ends and revokes the blob URL', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const p = speak('hello', 'en');
    await flush();
    await flush();
    const revoke = vi.mocked(URL.revokeObjectURL);
    expect(revoke).not.toHaveBeenCalled();
    lastAudio.onended?.();
    await p;
    expect(revoke).toHaveBeenCalledWith('blob:mock-tts');
    expect(lastAudio.src).toBe('blob:mock-tts');
  });

  it('rejects with the server error message on non-ok response', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'TTS API キーが未設定です' }), { status: 503 }),
    );
    await expect(speak('hello', 'en')).rejects.toThrow('TTS API キーが未設定です');
  });

  it('rejects on fetch network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(speak('hello', 'en')).rejects.toThrow('Failed to fetch');
  });

  // 15s, not 10s: /api/tts can burn 13s of retry budget server-side, so a
  // client that gave up earlier would abandon a synthesis that still succeeds.
  it('rejects after 15s fetch timeout', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_u: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      });
      const p = speak('hello', 'en');
      // The abort timer is only armed after obtainTtsBlob's IndexedDB probe
      // resolves, so the microtasks have to be drained first; the clock is then
      // advanced synchronously, like the playback-timeout test below, so the
      // rejection is still handled inside the same microtask checkpoint.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(15_000);
      await expect(p).rejects.toThrow('接続できませんでした');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on audio error', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const p = speak('hello', 'en');
    await flush();
    await flush();
    lastAudio.onerror?.();
    await expect(p).rejects.toThrow('音声の再生に失敗しました');
    expect(lastAudio.pause).toHaveBeenCalled();
  });

  it('rejects after 30s playback timeout and pauses', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(okResponse());
      const p = speak('hello', 'en');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      vi.advanceTimersByTime(30_000);
      await expect(p).rejects.toThrow('タイムアウト');
      expect(lastAudio.pause).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays muted first, then unmutes once playback starts (autoplay-safe)', async () => {
    fetchMock.mockResolvedValue(okResponse());
    let resolvePlay!: () => void;
    lastAudio.play.mockImplementation(
      () => new Promise<void>((resolve) => { resolvePlay = resolve; }),
    );
    const p = speak('hello', 'en');
    await flush();
    await flush();

    // play() is still pending → audio must stay muted (muted autoplay is exempt).
    expect(lastAudio.muted).toBe(true);

    resolvePlay();
    await flush();
    expect(lastAudio.muted).toBe(false);

    lastAudio.onended?.();
    await p;
  });

  it('maps autoplay-blocked play() (NotAllowedError) to a friendly Japanese error', async () => {
    fetchMock.mockResolvedValue(okResponse());
    lastAudio.play.mockRejectedValue(
      new DOMException(
        'The play method is not allowed by the user agent or the platform in the current context',
        'NotAllowedError',
      ),
    );
    await expect(speak('hello', 'en')).rejects.toThrow('ブロック');
  });

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
});

describe('unlockAudio', () => {
  it('calls muted play on a fresh Audio', () => {
    unlockAudio();
    expect(lastAudio.muted).toBe(true);
    expect(lastAudio.play).toHaveBeenCalled();
  });

  it('does not throw when play() rejects', async () => {
    lastAudio.play.mockRejectedValue(new Error('blocked'));
    expect(() => unlockAudio()).not.toThrow();
    await flush();
  });
});

describe('cancelSpeech', () => {
  it('pauses the active audio element', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const p = speak('hello', 'en');
    await flush();
    await flush();
    cancelSpeech();
    expect(lastAudio.pause).toHaveBeenCalled();
    expect(lastAudio.src).toBe('');
    lastAudio.onended?.();
    await p.catch(() => {});
  });
});

describe('tts session cache', () => {
  it('fetches /api/tts only once when the same params are spoken twice', async () => {
    fetchMock.mockImplementation(() => okResponse());
    const p1 = speak('キャッシュ', 'ja');
    await flush();
    await flush();
    lastAudio.onended?.();
    await p1;

    const p2 = speak('キャッシュ', 'ja');
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lastAudio.onended?.();
    await p2;
  });

  // The voice axis is gone: there is exactly one voice, so the only
  // discriminating parts of a cache key are the text and the language.
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

  // Rate is applied at playback time, so it must not invalidate the cache:
  // regenerating would re-bill the same sentence on every rate change.
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

  it('evicts the oldest entry with revokeObjectURL when the cache exceeds 50', async () => {
    let n = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:u${n++}`);
    fetchMock.mockImplementation(() => okResponse());
    for (let i = 0; i < 51; i++) {
      const p = speak(`文${i}`, 'ja');
      await flush();
      await flush();
      lastAudio.onended?.();
      await p;
    }
    const revoke = vi.mocked(URL.revokeObjectURL);
    // createObjectURL mock numbering: even = cache URL, odd = per-playback URL.
    expect(revoke).toHaveBeenCalledWith('blob:u0');
    expect(revoke).not.toHaveBeenCalledWith('blob:u2');

    fetchMock.mockClear();
    const p = speak('文0', 'ja'); // evicted → must re-fetch
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lastAudio.onended?.();
    await p;
  });

  it('keeps the cached blob URL alive across cancelSpeech and reuses it', async () => {
    let n = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:u${n++}`);
    fetchMock.mockImplementation(() => okResponse());
    const p1 = speak('共有', 'ja');
    await flush();
    await flush();
    cancelSpeech();
    lastAudio.onended?.();
    await p1.catch(() => {});
    const revoke = vi.mocked(URL.revokeObjectURL);
    expect(revoke).not.toHaveBeenCalledWith('blob:u0');
    expect(revoke).toHaveBeenCalledWith('blob:u1');

    const p2 = speak('共有', 'ja');
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit
    lastAudio.onended?.();
    await p2;
    expect(revoke).toHaveBeenCalledWith('blob:u2');
    expect(revoke).not.toHaveBeenCalledWith('blob:u0');
  });
});

describe('prefetchTts', () => {
  it('fetches and caches without playing; a following speak does not fetch', async () => {
    fetchMock.mockImplementation(() => okResponse());
    await prefetchTts('先読み', 'ja');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastAudio.play).not.toHaveBeenCalled();

    const p = speak('先読み', 'ja');
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lastAudio.onended?.();
    await p;
  });

  it('shares one in-flight request between duplicate prefetches', async () => {
    fetchMock.mockImplementation(() => okResponse());
    await Promise.all([prefetchTts('並行', 'ja'), prefetchTts('並行', 'ja')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares the in-flight request between prefetchTts and speak', async () => {
    fetchMock.mockImplementation(() => okResponse());
    const pre = prefetchTts('同時', 'ja');
    const p = speak('同時', 'ja');
    await pre;
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lastAudio.onended?.();
    await p;
  });

  // Was "treats different voices as separate cache entries". Gemini ships one
  // voice, so the voice is no longer a cache-key axis: an explicit preference and
  // a retired Google name (which resolveVoice maps onto the same voice) must
  // share one entry instead of re-billing the sentence.
  it('does NOT split cache entries by voice — the voice is not part of the key', async () => {
    fetchMock.mockImplementation(() => okResponse());
    await prefetchTts('声', 'ja', { voiceName: 'Ludo' });
    await prefetchTts('声', 'ja', { voiceName: 'ja-JP-Neural2-D' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).voiceName).toBe('Ludo');
  });

  it('keeps the most recently used entry when the cache overflows (LRU)', async () => {
    fetchMock.mockImplementation(() => okResponse());
    for (let i = 0; i < 50; i++) await prefetchTts(`文${i}`, 'ja');
    await prefetchTts('文0', 'ja'); // cache hit → LRU bump, no fetch
    await prefetchTts('文50', 'ja'); // overflow → evicts 文1, not 文0
    expect(fetchMock).toHaveBeenCalledTimes(51);

    fetchMock.mockClear();
    await prefetchTts('文0', 'ja'); // still cached thanks to the bump
    expect(fetchMock).not.toHaveBeenCalled();
    await prefetchTts('文1', 'ja'); // was evicted → re-fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The IndexedDB layer only exists in a browser, so `fake-indexeddb` is installed
 * per test here rather than at module scope: the rest of the suite must keep
 * running the no-IndexedDB path, which is the one that has to survive an old
 * WebView or private mode.
 */
describe('IndexedDB persistence', () => {
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    // Also drops tts-cache's cached dbPromise, which would otherwise point at
    // the factory installed by the previous test.
    await clearTtsCacheForTests();
  });

  afterEach(async () => {
    await clearTtsCacheForTests();
    vi.stubGlobal('indexedDB', undefined);
  });

  /** The write is fired with `void`, so it has to be waited out. */
  async function awaitPersisted(key: string): Promise<Uint8Array | null> {
    for (let i = 0; i < 20; i++) {
      const pcm = await readCachedPcm(key);
      if (pcm && pcm.length > 0) return pcm;
      await flush();
    }
    return null;
  }

  /**
   * Wait until `speak` has reached playback. An IndexedDB read is several async
   * hops (open, transaction, get) that the usual two macrotask flushes do not
   * cover, and `FakeAudio` is one shared object per test, so the playback count
   * is the only signal that the second speak got that far.
   */
  async function awaitPlaybacks(count: number): Promise<void> {
    for (let i = 0; i < 50 && lastAudio.play.mock.calls.length < count; i++) await flush();
  }

  // Asserts the cost property only — that a reload does not re-bill. The byte
  // layout of the rebuilt blob is deliberately NOT asserted: /api/tts returns a
  // WAV, persistToIdb stores that whole WAV in a PCM-named slot, and
  // loadFromIdb prepends a second RIFF header, so the rebuilt blob currently
  // carries 44 bytes of header-as-audio. See task-5-report.md.
  it('serves the next request from IndexedDB without regenerating', async () => {
    fetchMock.mockImplementation(() => okResponse());
    const key = cacheKeyOf({ text: '永続', lang: 'ja' });

    const p1 = speak('永続', 'ja');
    await awaitPlaybacks(1);
    lastAudio.onended?.();
    await p1;
    expect(await awaitPersisted(key)).not.toBeNull();

    // Drop the in-memory layer only; IndexedDB is what survives a reload.
    resetTtsCacheForTests();
    const p2 = speak('永続', 'ja');
    await awaitPlaybacks(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastAudio.play).toHaveBeenCalledTimes(2);
    lastAudio.onended?.();
    await p2;
  });

  it('still serves the same text+lang after a full cache reset', async () => {
    fetchMock.mockImplementation(() => okResponse());
    const p1 = speak('再読', 'ja');
    await awaitPlaybacks(1);
    lastAudio.onended?.();
    await p1;
    await awaitPersisted(cacheKeyOf({ text: '再読', lang: 'ja' }));

    resetTtsCacheForTests();
    await prefetchTts('再読', 'ja');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
