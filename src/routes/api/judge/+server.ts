import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { buildJudgeRequest, parseJudgeResponse } from '$lib/jev';

const JEV_ENDPOINT = 'https://openrouter.ai/api/v1/systemone';
const TIMEOUT_MS = 8000;

async function callJev(body: unknown, apiKey: string): Promise<unknown> {
	const doFetch = async (): Promise<Response> => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
		try {
			return await fetch(JEV_ENDPOINT, {
				method: 'POST',
				headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: ctrl.signal
			});
		} finally {
			clearTimeout(timer);
		}
	};
	let res = await doFetch();
	// 429/529/5xx は 500ms 待機で1回だけリトライ (docs推奨のバックオフを簡略化)
	if (res.status === 429 || res.status === 529 || res.status >= 500) {
		await new Promise((r) => setTimeout(r, 500));
		res = await doFetch();
	}
	return res.json();
}

/**
 * Pure request handler — unit-testable without $env.
 * `apiKey` is injected by the caller (Workers secret / .env).
 * 常に HTTP 200。あらゆる失敗 (bad body / キー欠損 / Jevエラー / タイムアウト / パース失敗) を
 * {available: false} に畳む。
 */
export async function _handleJudgeRequest(
	request: Request,
	apiKey: string | undefined
): Promise<Response> {
	const fallback = json({ available: false });
	try {
		const body = await request.json();
		const reference = body?.reference;
		const transcription = body?.transcription;
		if (
			typeof reference !== 'string' || !reference.trim() ||
			typeof transcription !== 'string' || !transcription.trim()
		) {
			return fallback;
		}
		if (!apiKey) {
			console.error('OPENROUTER_API_KEY is not set');
			return fallback;
		}
		const raw = await callJev(buildJudgeRequest(reference, transcription), apiKey);
		return json(parseJudgeResponse(raw));
	} catch (err) {
		console.error('judge failed:', err);
		return fallback;
	}
}

export const POST: RequestHandler = ({ request }) =>
	_handleJudgeRequest(request, env.OPENROUTER_API_KEY);
