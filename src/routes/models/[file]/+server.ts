import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { MODEL_ARCHIVE_NAMES, UPSTREAM_MODEL_URLS, type ModelLang } from '$lib/livestt/urls';

const ARCHIVE_BY_NAME = new Map<string, ModelLang>(
	(Object.entries(MODEL_ARCHIVE_NAMES) as Array<[ModelLang, string]>).map(([lang, name]) => [
		name,
		lang
	])
);

/**
 * Same-origin proxy for STT model archives. GitHub Release assets (the
 * upstream) do not send CORS headers, so the browser cannot fetch them
 * directly — this route re-serves the allow-listed archives instead.
 */
export const GET: RequestHandler = async ({ params, fetch }) => {
	const lang = ARCHIVE_BY_NAME.get(params.file);
	if (!lang) {
		return json({ error: 'モデルが見つかりません' }, { status: 404 });
	}

	const upstreamUrl = UPSTREAM_MODEL_URLS[lang];
	if (!upstreamUrl) {
		return json(
			{
				error:
					'STTモデルの上流URLが未設定です。npm run stt:fetch → npm run stt:upload を実行し、src/lib/livestt/urls.ts にURLを設定してください。'
			},
			{ status: 503 }
		);
	}

	const upstream = await fetch(upstreamUrl);
	if (!upstream.ok || !upstream.body) {
		return json({ error: 'STTモデルの取得に失敗しました' }, { status: 502 });
	}

	const headers = new Headers({ 'content-type': 'application/zip' });
	const contentLength = upstream.headers.get('content-length');
	if (contentLength) headers.set('content-length', contentLength);
	return new Response(upstream.body, { headers });
};
