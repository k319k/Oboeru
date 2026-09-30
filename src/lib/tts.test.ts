import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { speak, cancelSpeech, unlockAudio, prefetchTts, resetTtsCacheForTests } from './tts';
import { CURATED_VOICES } from './tts-voices';
import { pcmToWav } from './pcm-wav';
import { cacheKeyOf, clearTtsCacheForTests, readCachedPcm, writeCachedPcm } from './tts-cache';

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

  // Guards the *default* only. Deleting the playbackRate assignment in tts.ts
  // entirely still passes here, because FakeAudio initialises it to 1 — that
  // case is covered by the test above, which asserts a non-default value.
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

  /** Every Blob handed to `URL.createObjectURL`; the last one reached playback. */
  function captureBlobs(): Blob[] {
    const blobs: Blob[] = [];
    vi.mocked(URL.createObjectURL).mockImplementation((obj: Blob | MediaSource) => {
      if (obj instanceof Blob) blobs.push(obj);
      return 'blob:mock-tts';
    });
    return blobs;
  }

  const bytesOf = async (blob: Blob): Promise<Uint8Array> =>
    new Uint8Array(await blob.arrayBuffer());

  const hasRiffAt = (bytes: Uint8Array, offset: number): boolean =>
    bytes.length >= offset + 4 &&
    bytes[offset] === 0x52 &&
    bytes[offset + 1] === 0x49 &&
    bytes[offset + 2] === 0x46 &&
    bytes[offset + 3] === 0x46;

  /** Non-trivial payload: a zero-filled buffer would make byte-identity vacuous. */
  const fakePcm = (length: number) => {
    const pcm = new Uint8Array(length);
    for (let i = 0; i < length; i++) pcm[i] = (i * 7 + (i >> 3)) % 256;
    return pcm;
  };

  /**
   * Mirrors what /api/tts returns: pcmToWav(pcm, sampleRate ?? 24000,
   * channels ?? 1). No return-type annotation, for the same reason the server
   * route has none — an explicit `Uint8Array` widens to `Uint8Array<ArrayBufferLike>`,
   * which `BodyInit` rejects.
   */
  const serverWav = (pcm: Uint8Array, sampleRate = 24000, channels = 1) =>
    new Uint8Array(pcmToWav(pcm, sampleRate, channels));

  const wavResponse = (wav: Uint8Array<ArrayBuffer>): Response =>
    new Response(wav, { status: 200, headers: { 'Content-Type': 'audio/wav' } });

  // Costs, not bytes: okResponse() is not a WAV, so these only pin that a reload
  // does not re-bill. The byte-level contract is pinned by the four tests below.
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
    expect(await awaitPersisted(cacheKeyOf({ text: '再読', lang: 'ja' }))).not.toBeNull();

    resetTtsCacheForTests();
    await prefetchTts('再読', 'ja');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The whole point of the cache: a reload must be inaudible. A WAV header
  // stored in the PCM slot used to be re-wrapped, so the rebuilt blob carried a
  // nested "RIFF" at offset 44 whose ASCII decoded as 22 loud samples.
  it('stores a server WAV as raw PCM and rebuilds it byte-identically', async () => {
    const pcm = fakePcm(2000);
    const wav = serverWav(pcm);
    expect(wav.length).toBe(2044);
    fetchMock.mockImplementation(() => wavResponse(wav));
    const key = cacheKeyOf({ text: '透明', lang: 'ja' });

    const p1 = speak('透明', 'ja');
    await awaitPlaybacks(1);
    lastAudio.onended?.();
    await p1;

    const persisted = await awaitPersisted(key);
    expect(persisted).not.toBeNull();
    expect(persisted?.length).toBe(2000); // header stripped, not stored
    expect(hasRiffAt(persisted ?? new Uint8Array(0), 0)).toBe(false);
    expect(persisted).toEqual(pcm);

    resetTtsCacheForTests();
    const blobs = captureBlobs();
    const p2 = speak('透明', 'ja');
    await awaitPlaybacks(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rebuilt = await bytesOf(blobs[blobs.length - 1]);
    expect(rebuilt.length).toBe(2044);
    expect(hasRiffAt(rebuilt, 0)).toBe(true);
    expect(hasRiffAt(rebuilt, 44)).toBe(false); // the bug this test exists for
    expect(rebuilt).toEqual(wav);
    lastAudio.onended?.();
    await p2;
  });

  // Migration path: a record written before the strip holds a whole WAV. No
  // schema bump can reach it — bumping TTS_CACHE_SCHEMA_VERSION only changes
  // the KEY, and only a DB_VERSION bump runs the deleteObjectStore that actually
  // drops records — so the read path has to accept it.
  it('restores a record that already holds a whole WAV (no migration needed)', async () => {
    const wav = serverWav(fakePcm(2000));
    const key = cacheKeyOf({ text: '移行', lang: 'ja' });
    await writeCachedPcm(key, wav);

    const blobs = captureBlobs();
    const p = speak('移行', 'ja');
    await awaitPlaybacks(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const rebuilt = await bytesOf(blobs[blobs.length - 1]);
    expect(rebuilt.length).toBe(2044);
    expect(hasRiffAt(rebuilt, 44)).toBe(false);
    expect(rebuilt).toEqual(wav);
    lastAudio.onended?.();
    await p;
  });

  // A non-default rate must survive the round trip, or the audio replays at the
  // wrong speed forever: the stored bytes are all that is left of the format.
  it('keeps a non-default sample rate intact instead of re-wrapping at 24kHz', async () => {
    const pcm = fakePcm(2000);
    const wav = serverWav(pcm, 16000, 1);
    expect(wav.length).toBe(2044);
    fetchMock.mockImplementation(() => wavResponse(wav));
    const key = cacheKeyOf({ text: '16k', lang: 'ja' });

    const p1 = speak('16k', 'ja');
    await awaitPlaybacks(1);
    lastAudio.onended?.();
    await p1;

    // Header kept whole, because a re-wrap could not reproduce its format.
    const persisted = await awaitPersisted(key);
    expect(persisted?.length).toBe(2044);
    expect(hasRiffAt(persisted ?? new Uint8Array(0), 0)).toBe(true);

    resetTtsCacheForTests();
    const blobs = captureBlobs();
    const p2 = speak('16k', 'ja');
    await awaitPlaybacks(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rebuilt = await bytesOf(blobs[blobs.length - 1]);
    expect(rebuilt).toEqual(wav); // 16kHz header intact → no resampling on replay
    lastAudio.onended?.();
    await p2;
  });

  // Raw PCM in the slot is the format this version writes, so the header really
  // does have to be rebuilt — and rebuilt correctly.
  it('wraps a raw-PCM record into a valid WAV with the payload intact', async () => {
    const pcm = fakePcm(2000);
    const key = cacheKeyOf({ text: '生PCM', lang: 'ja' });
    await writeCachedPcm(key, pcm);

    const blobs = captureBlobs();
    const p = speak('生PCM', 'ja');
    await awaitPlaybacks(1);
    expect(fetchMock).not.toHaveBeenCalled();

    const rebuilt = await bytesOf(blobs[blobs.length - 1]);
    expect(rebuilt.length).toBe(2044);
    expect(hasRiffAt(rebuilt, 0)).toBe(true);
    expect(hasRiffAt(rebuilt, 44)).toBe(false);
    // data chunk size must describe the payload, or players see a short file.
    expect(new DataView(rebuilt.buffer, rebuilt.byteOffset).getUint32(40, true)).toBe(2000);
    expect(rebuilt.subarray(44)).toEqual(pcm);
    lastAudio.onended?.();
    await p;
  });
});
