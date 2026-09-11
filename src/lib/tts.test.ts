import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { speak, cancelSpeech, unlockAudio } from './tts';
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
