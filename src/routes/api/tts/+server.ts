import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isAllowedVoiceName } from '$lib/tts-voices';
import { parsePcmContentType, pcmToWav } from '$lib/pcm-wav';

const MAX_TEXT_LENGTH = 400;

/** Upstream budget. Kept under the client's 15s fetch timeout so the server
 *  never burns a paid generation the client has already given up on. */
const UPSTREAM_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1000, 2000];

/** Provider constants. The voice lives in `$lib/tts-voices` (the allowlist is
 *  the single source of truth). Change TTS_MODEL / TTS_STYLE together with the
 *  literals in `$lib/tts-cache` — they form one versioned cache prefix. */
export const TTS_MODEL = 'google/gemini-3.8-flash-lite-tts';
export const TTS_STYLE = 'Narration';

const SPEECH_URL = 'https://openrouter.ai/api/v1/audio/speech';

export interface TtsRequestBody {
  text: string;
  lang: 'ja' | 'en';
  voiceName: string;
  /** Accepted for client compatibility, deliberately unused: Gemini has no
   *  numeric rate, so speed is a playback-time setting. */
  speakingRate: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(headers: Headers, fallback: number): number {
  const raw = headers.get('Retry-After');
  if (!raw) return fallback;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 5000) : fallback;
}

/** `in_flight_budget` is transient; credits/key limits are not. */
function isRetryable402(body: string): boolean {
  return /"limit_source"\s*:\s*"openrouter_in_flight_budget"/.test(body);
}

interface UpstreamResult {
  ok: boolean;
  pcm?: Uint8Array;
  sampleRate?: number;
  channels?: number;
  timeout?: boolean;
}

async function callUpstream(body: TtsRequestBody, apiKey: string): Promise<UpstreamResult> {
  const payload = {
    model: TTS_MODEL,
    input: body.text,
    voice: body.voiceName,
    response_format: 'pcm',
    // `speech_metadata` MUST live here. A top-level `instructions` field is
    // accepted with HTTP 200 and then silently dropped, so the style would
    // never take effect. Gemini reads `input` verbatim, which is why delivery
    // directions go in speech_metadata instead of the text.
    provider: { options: { 'google-ai-studio': { speech_metadata: { style: TTS_STYLE } } } },
  };

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(SPEECH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ok: false, timeout: true };
      }
      console.error('TTS upstream error:', err);
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const contentType = res.headers.get('Content-Type');
      if (!contentType || !contentType.startsWith('audio/pcm')) {
        console.error('TTS upstream returned a non-PCM Content-Type:', contentType);
        return { ok: false };
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length === 0) return { ok: false };
      const format = parsePcmContentType(contentType);
      return { ok: true, pcm: bytes, ...format };
    }

    const text = await res.text();
    const backoff = BACKOFF_MS[attempt] ?? null;
    const retryable =
      backoff !== null &&
      (res.status === 429 ||
        res.status === 500 ||
        res.status === 502 ||
        res.status === 503 ||
        res.status === 529 ||
        (res.status === 402 && isRetryable402(text)));

    if (!retryable) {
      console.error('TTS upstream HTTP', res.status, text.slice(0, 200));
      return { ok: false };
    }
    await sleep(retryAfterMs(res.headers, backoff));
  }
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

  const result = await callUpstream(b, apiKey);
  if (result.timeout) {
    return json({ error: 'TTS API の応答がタイムアウトしました' }, { status: 408 });
  }
  if (!result.ok || !result.pcm) {
    return json({ error: '音声合成に失敗しました' }, { status: 502 });
  }

  // `pcmToWav` is declared as `Uint8Array<ArrayBufferLike>`, which `BodyInit`
  // rejects. Re-wrapping copies and, as a side effect, re-bases the view onto
  // an `ArrayBuffer` it exactly spans.
  const wav = new Uint8Array(pcmToWav(result.pcm, result.sampleRate ?? 24000, result.channels ?? 1));
  return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
}

/** Key check + JSON parse; thin wrapper around _handleTtsPost. */
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
  _handleTtsRequest(request, env.OPENROUTER_API_KEY);
