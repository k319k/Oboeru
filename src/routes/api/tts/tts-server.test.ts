import { describe, it, expect, vi, afterEach } from 'vitest';
import { _handleTtsRequest } from './+server';

const MP3_B64 = Buffer.from('MP3DATA').toString('base64');

function post(body: unknown): Request {
  return new Request('http://localhost/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('_handleTtsRequest', () => {
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
      post({ text: 'hello', lang: 'fr', voiceName: 'ja-JP-Neural2-B', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('ja または en');
  });

  it('returns 400 for text over 400 chars', async () => {
    const res = await _handleTtsRequest(
      post({ text: 'a'.repeat(401), lang: 'ja', voiceName: 'ja-JP-Neural2-B', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for a voice outside the allowlist', async () => {
    const res = await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'ja-JP-Wavenet-A', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('許可');
  });

  it('returns 200 audio/mpeg with decoded bytes on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ audioContent: MP3_B64 }), { status: 200 }),
      ),
    );
    const res = await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'ja-JP-Neural2-B', speakingRate: 1.2 }),
      'key',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe('MP3DATA');

    // Google called with the exact request shape
    const calledWith = vi.mocked(fetch).mock.calls[0];
    expect(calledWith[0]).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    const googleBody = JSON.parse(String(calledWith[1]?.body));
    expect(googleBody).toEqual({
      input: { text: 'こんにちは' },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.2 },
    });
  });

  it('clamps speakingRate to 0.25–4.0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ audioContent: MP3_B64 }), { status: 200 }),
      ),
    );
    await _handleTtsRequest(
      post({ text: 'hi', lang: 'en', voiceName: 'en-US-Neural2-A', speakingRate: 10 }),
      'key',
    );
    const googleBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(googleBody.audioConfig.speakingRate).toBe(4.0);
  });

  it('returns 502 when Google responds with an error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"error":{"message":"quota"}}', { status: 403 }),
      ),
    );
    const res = await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'ja-JP-Neural2-B', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when Google returns no audioContent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const res = await _handleTtsRequest(
      post({ text: 'こんにちは', lang: 'ja', voiceName: 'ja-JP-Neural2-B', speakingRate: 1 }),
      'key',
    );
    expect(res.status).toBe(502);
  });
});
