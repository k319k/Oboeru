import { describe, it, expect, vi, afterEach } from 'vitest';
import { _handleTtsRequest, _TTS_MODEL, _TTS_STYLE } from './+server';

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

/** A retryable upstream error, optionally advertising how long to wait. */
function retryAfterResponse(retryAfter?: string, status = 429): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
  return new Response('{"error":{}}', { status, headers });
}

/** Never settles until its signal aborts — a hanging upstream. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** How many 429s before the mock starts hanging. */
function throttleThenHang(throttles: number, retryAfter?: string): ReturnType<typeof vi.fn> {
  let n = 0;
  const mock = vi.fn((_url: string, init: RequestInit) => {
    n++;
    if (n <= throttles) return Promise.resolve(retryAfterResponse(retryAfter));
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Valid request body, for tests that care about timing rather than input. */
function timingBody(): Request {
  return post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 });
}

/** Sentinel for "the promise had not settled when the clock ran out". */
const PENDING = Symbol('pending');

/**
 * A fake clock whose `elapsed` is measured from the moment it was created, so
 * stepping it in several slices still reports the total virtual time the call
 * consumed. Yields `PENDING` instead of hanging when the promise has not
 * settled, so a deadline that regressed outward fails fast rather than burning
 * the test timeout.
 */
function fakeClock() {
  const started = Date.now();
  return {
    async step(
      promise: Promise<Response>,
      ms: number,
    ): Promise<{ status: number | symbol; elapsed: number }> {
      const raced = await Promise.race<number | symbol>([
        promise.then((r) => r.status),
        vi.advanceTimersByTimeAsync(ms).then(() => PENDING),
      ]);
      return { status: raced, elapsed: Date.now() - started };
    },
  };
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

  it('logs the missing key, so a 503 is never silent', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await _handleTtsRequest(post({ text: 'こんにちは' }), undefined);
      expect(res.status).toBe(503);
      expect(spy).toHaveBeenCalledWith('OPENROUTER_API_KEY is not set');
    } finally {
      spy.mockRestore();
    }
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
      model: _TTS_MODEL,
      input: 'こんにちは',
      voice: 'Ludo',
      response_format: 'pcm',
      provider: { options: { 'google-ai-studio': { speech_metadata: { style: _TTS_STYLE } } } },
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

  it.each([401, 403, 404, 413])('does not retry a %i', async (status) => {
    const mock = stubFetch(pcmResponse('{"error":{}}', 'application/json', status));
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
    expect(mock).toHaveBeenCalledTimes(1);
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
    // A factory, not `mockResolvedValue`: the server reads the error body on
    // every attempt, and one shared Response is spent after the first read.
    mock.mockImplementation(async () =>
      pcmResponse('{"error":{}}', 'application/json', 503),
    );
    const res = await _handleTtsRequest(
      post({ text: 'a', lang: 'ja', voiceName: 'Ludo', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
    expect(mock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('returns 408 when the attempt hits the 10s upstream timeout', async () => {
    vi.useFakeTimers();
    try {
      hangingFetch();
      const clock = fakeClock();
      const promise = _handleTtsRequest(timingBody(), 'key');
      // Still running one tick before the deadline: the timer has to be the
      // thing that ends this call, so a shorter timeout would settle earlier.
      expect((await clock.step(promise, 9_999)).status).toBe(PENDING);
      const done = await clock.step(promise, 1);
      expect(done.status).toBe(408);
      expect(done.elapsed).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
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

/**
 * `TTS_BUDGET_MS` is the contract with the client: the server has to be done
 * before the client gives up, or it burns a paid generation nobody hears.
 * These tests pin the whole ceiling, not each timeout in isolation — a flat cap
 * on `Retry-After` still lets two waits plus the final timeout overrun it.
 */
describe('_handleTtsPost — time budget', () => {
  it('finishes within 13s when Retry-After asks for 5s twice, then hangs', async () => {
    vi.useFakeTimers();
    try {
      throttleThenHang(2, '5');
      const clock = fakeClock();
      const promise = _handleTtsRequest(timingBody(), 'key');
      expect((await clock.step(promise, 12_999)).status).toBe(PENDING);
      const done = await clock.step(promise, 1);
      expect(done.status).toBe(408);
      // 5s + 5s of honoured waits, then the last attempt is cut to the 3s that
      // remain. 5 + 5 + 10 = 20s unclamped.
      expect(done.elapsed).toBe(13_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs when a late attempt is cut short to the remaining budget', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      throttleThenHang(2, '5');
      const clock = fakeClock();
      const promise = _handleTtsRequest(timingBody(), 'key');
      await clock.step(promise, 13_000);
      const cuts = spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('cut to'));
      // Attempts 2 and 3 both inherit less than the full 10s: 8s after the
      // first honoured wait, then 3s after the second.
      expect(cuts).toHaveLength(2);
      expect(cuts[0]).toContain('attempt 2 timeout cut to 8000ms');
      expect(cuts[1]).toContain('attempt 3 timeout cut to 3000ms');
      expect(cuts[1]).toContain('13000ms budget');
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('waits the interval the server asked for, not the fallback', async () => {
    vi.useFakeTimers();
    try {
      const mock = vi
        .fn()
        .mockResolvedValueOnce(retryAfterResponse('3'))
        .mockResolvedValueOnce(pcmResponse());
      vi.stubGlobal('fetch', mock);
      const clock = fakeClock();
      const promise = _handleTtsRequest(timingBody(), 'key');
      expect((await clock.step(promise, 2_999)).status).toBe(PENDING);
      expect(mock).toHaveBeenCalledTimes(1);
      const done = await clock.step(promise, 1);
      expect(done.status).toBe(200);
      // 3000ms from Retry-After; the BACKOFF_MS fallback would have been 1000ms.
      expect(done.elapsed).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads Retry-After given as an HTTP-date (RFC 9110 §10.2.3)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const mock = vi
        .fn()
        .mockResolvedValueOnce(retryAfterResponse('Thu, 01 Jan 2026 00:00:04 GMT'))
        .mockResolvedValueOnce(pcmResponse());
      vi.stubGlobal('fetch', mock);
      const clock = fakeClock();
      const done = await clock.step(_handleTtsRequest(timingBody(), 'key'), 4_000);
      expect(done.status).toBe(200);
      expect(done.elapsed).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to BACKOFF_MS for an unparseable Retry-After', async () => {
    vi.useFakeTimers();
    try {
      const mock = vi
        .fn()
        .mockResolvedValueOnce(retryAfterResponse('soon-ish'))
        .mockResolvedValueOnce(pcmResponse());
      vi.stubGlobal('fetch', mock);
      const clock = fakeClock();
      const done = await clock.step(_handleTtsRequest(timingBody(), 'key'), 1_000);
      expect(done.status).toBe(200);
      expect(done.elapsed).toBe(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a Retry-After longer than the whole budget by cutting it', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => retryAfterResponse('30')));
      const clock = fakeClock();
      const done = await clock.step(_handleTtsRequest(timingBody(), 'key'), 13_000);
      // The upstream throttled us and we ran out of budget before it could be
      // honoured, so this is an upstream failure (502), not a timeout (408).
      expect(done.status).toBe(502);
      expect(done.elapsed).toBe(13_000);
      expect(String(spy.mock.calls[0][0])).toContain(
        'Retry-After 30000ms clamped to 13000ms by the 13000ms budget',
      );
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
