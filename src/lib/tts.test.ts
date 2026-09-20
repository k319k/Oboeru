import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { speak, cancelSpeech, unlockAudio, prefetchTts, resetTtsCacheForTests } from './tts';
import { DEFAULT_VOICE } from './tts-voices';

class FakeAudio {
  src = '';
  muted = false;
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
  it('posts the resolved voice and rate to /api/tts', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const p = speak('こんにちは', 'ja', { rate: 1.5 });
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/tts', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      text: 'こんにちは',
      lang: 'ja',
      voiceName: DEFAULT_VOICE.ja,
      speakingRate: 1.5,
    });

    lastAudio.onended?.();
    await p;
  });

  it('uses the stored voice when it matches the language', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const p = speak('hello', 'en', { voiceURI: 'en-US-Neural2-F' });
    await flush();
    await flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.voiceName).toBe('en-US-Neural2-F');
    lastAudio.onended?.();
    await p;
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

  it('rejects after 10s fetch timeout', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_u: string, init: RequestInit) => {
        const signal = init.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      });
      const p = speak('hello', 'en');
      vi.advanceTimersByTime(10_000);
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

  it('separates cache entries by voice and rate', async () => {
    fetchMock.mockImplementation(() => okResponse());
    const p1 = speak('声', 'ja', { voiceURI: 'ja-JP-Neural2-C' });
    await flush();
    await flush();
    lastAudio.onended?.();
    await p1;
    const p2 = speak('声', 'ja', { voiceURI: 'ja-JP-Neural2-D' });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    lastAudio.onended?.();
    await p2;
    const p3 = speak('声', 'ja', { rate: 1.5 });
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    lastAudio.onended?.();
    await p3;
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

  it('treats different voices as separate cache entries', async () => {
    fetchMock.mockImplementation(() => okResponse());
    await prefetchTts('声', 'ja', { voiceURI: 'ja-JP-Neural2-C' });
    await prefetchTts('声', 'ja', { voiceURI: 'ja-JP-Neural2-D' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
