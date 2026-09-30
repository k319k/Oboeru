import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { isAllowedVoiceName } from '$lib/tts-voices';
import { parsePcmContentType, pcmToWav } from '$lib/pcm-wav';

const MAX_TEXT_LENGTH = 400;

/** Per-attempt upstream timeout. An abort is terminal, so each attempt gets a
 *  fresh timer rather than sharing one across the retry loop. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Fallback wait before the next attempt, used only when the response carries
 *  no usable `Retry-After`. A missing entry ends the loop, so `length` is the
 *  retry budget: 1 + 2 seconds. */
const BACKOFF_MS = [1000, 2000];

/**
 * Hard ceiling for one `_handleTtsPost` call, derived rather than hardcoded so
 * the two budgets cannot drift apart: the last attempt can burn
 * `UPSTREAM_TIMEOUT_MS` and the waits before it sum to `BACKOFF_MS`, so the
 * worst case is 1 + 2 + 10 = 13s. Every wait and every attempt timer is clamped
 * against this deadline — a flat cap on `Retry-After` is not enough, because
 * two waits plus the final timeout still add up past the budget.
 *
 * The client must abort at or after this, and it does: `src/lib/tts.ts` declares
 * `FETCH_TIMEOUT_MS = 15_000`, comfortably above the 13s ceiling. The ordering
 * matters — if the client were the faster of the two it would abandon a
 * synthesis this server is still running, and the paid upstream call would
 * finish with nobody listening. The budget is asserted by the
 * `_handleTtsPost — time budget` tests.
 */
const TTS_BUDGET_MS = UPSTREAM_TIMEOUT_MS + BACKOFF_MS.reduce((a, b) => a + b, 0);

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

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Both forms are parsed here; bounding the result is the caller's job, because
 * only the caller knows how much of `TTS_BUDGET_MS` is left.
 */
function retryAfterMs(headers: Headers, fallback: number): number {
  const raw = headers.get('Retry-After');
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : fallback;
  // Not a number, so it can only be the HTTP-date form.
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : fallback;
  }
  return fallback;
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

  const deadline = Date.now() + TTS_BUDGET_MS;

  for (let attempt = 0; ; attempt++) {
    // Clamped as well as the wait below: a late attempt inherits whatever is
    // left of the budget, so the total cannot drift past TTS_BUDGET_MS.
    const attemptTimeout = Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now());
    if (attemptTimeout < UPSTREAM_TIMEOUT_MS) {
      console.error(
        `TTS upstream attempt ${attempt + 1} timeout cut to ${attemptTimeout}ms by the ${TTS_BUDGET_MS}ms budget`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
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

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.error('TTS upstream HTTP', res.status, 'budget exhausted, giving up');
      return { ok: false };
    }
    // Honour the server's own wait, but never past the budget: `Retry-After` is
    // server-chosen and a single value can otherwise exceed the whole ceiling.
    const requested = retryAfterMs(res.headers, backoff);
    const wait = Math.min(requested, remaining);
    if (wait < requested) {
      console.error(
        `TTS upstream Retry-After ${requested}ms clamped to ${wait}ms by the ${TTS_BUDGET_MS}ms budget`,
      );
    }
    await sleep(wait);
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
  // rejects. Re-wrapping yields the `ArrayBuffer`-backed view `BodyInit` wants.
  // `pcmToWav` currently allocates exactly 44 + dataSize bytes, so the copy is
  // not load-bearing today; it keeps this correct if that ever changes.
  const wav = new Uint8Array(pcmToWav(result.pcm, result.sampleRate ?? 24000, result.channels ?? 1));
  return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
}

/** Key check + JSON parse; thin wrapper around _handleTtsPost. */
export async function _handleTtsRequest(
  request: Request,
  apiKey: string | undefined,
): Promise<Response> {
  if (!apiKey) {
    // Task 7 removes the secret from wrangler/.env; without this line a
    // misconfigured deploy returns 503 forever with nothing in the logs.
    console.error('OPENROUTER_API_KEY is not set');
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
