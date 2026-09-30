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
