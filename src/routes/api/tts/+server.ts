import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { CURATED_VOICES, isAllowedVoiceName } from '$lib/tts-voices';

const MAX_TEXT_LENGTH = 400;
const MIN_RATE = 0.25;
const MAX_RATE = 4.0;

export interface TtsRequestBody {
  text: string;
  lang: 'ja' | 'en';
  voiceName: string;
  speakingRate: number;
}

/**
 * Pure request handler — unit-testable without $env.
 * `apiKey` is injected by the caller (Workers secret / .env).
 */
export async function _handleTtsPost(body: unknown, apiKey: string): Promise<Response> {
  const b = body as TtsRequestBody | null;
  if (!b || typeof b !== 'object') {
    return json({ error: 'JSON ボディが必要です' }, { status: 400 });
  }
  if (typeof b.text !== 'string' || b.text.length === 0 || b.text.length > MAX_TEXT_LENGTH) {
    return json({ error: `text は 1〜${MAX_TEXT_LENGTH} 文字で指定してください` }, { status: 400 });
  }
  if (b.lang !== 'ja' && b.lang !== 'en') {
    return json({ error: '言語は ja または en を指定してください' }, { status: 400 });
  }
  if (typeof b.voiceName !== 'string' || !isAllowedVoiceName(b.voiceName)) {
    return json({ error: '指定された声は許可されていません' }, { status: 400 });
  }
  const rawRate = typeof b.speakingRate === 'number' ? b.speakingRate : 1;
  const speakingRate = Math.min(Math.max(rawRate, MIN_RATE), MAX_RATE);
  const voice = CURATED_VOICES.find((v) => v.name === b.voiceName)!;

  // --- Call Google Cloud TTS ---
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let upstream: Response;
  try {
    upstream = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify({
        input: { text: b.text },
        voice: { languageCode: voice.languageCode, name: b.voiceName },
        audioConfig: { audioEncoding: 'MP3', speakingRate },
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return json({ error: 'TTS API の応答がタイムアウトしました' }, { status: 408 });
    }
    console.error('TTS upstream error:', err);
    return json({ error: 'TTS API に接続できませんでした' }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    console.error('TTS upstream HTTP', upstream.status);
    return json({ error: '音声合成に失敗しました' }, { status: 502 });
  }

  const data = (await upstream.json()) as { audioContent?: string };
  if (!data.audioContent) {
    return json({ error: '音声データが空でした' }, { status: 502 });
  }
  const audio = Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0));
  return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } });
}

/** Key check + JSON parse; thin wrapper around handleTtsPost. */
export async function _handleTtsRequest(
  request: Request,
  apiKey: string | undefined,
): Promise<Response> {
  if (!apiKey) {
    return json({ error: 'TTS API キーが未設定です' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON ボディが必要です' }, { status: 400 });
  }
  return _handleTtsPost(body, apiKey);
}

export const POST: RequestHandler = ({ request }) =>
  _handleTtsRequest(request, env.GOOGLE_TTS_API_KEY);
