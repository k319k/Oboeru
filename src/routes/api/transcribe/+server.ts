import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { RateLimitError } from 'groq-sdk/error';
import { env } from '$env/dynamic/private';

const VALID_LANGUAGES = ['ja', 'en'] as const;

/** Map MIME type to file extension. */
function extForMime(mime: string): string {
	if (mime.includes('webm')) return '.webm';
	if (mime.includes('mp4')) return '.mp4';
	if (mime.includes('ogg')) return '.ogg';
	if (mime.includes('wav')) return '.wav';
	if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
	if (mime.includes('flac')) return '.flac';
	return '.webm';
}

export const POST: RequestHandler = async ({ request }) => {
	const apiKey = env.GROQ_API_KEY;
	if (!apiKey) {
		return json({ error: 'GROQ_API_KEY が設定されていません' }, { status: 503 });
	}

	const groq = new Groq({ apiKey });

	const formData = await request.formData();
	const file = formData.get('file');
	const language = formData.get('language');

	// Validate file
	if (!(file instanceof File)) {
		return json({ error: 'ファイルが必要です' }, { status: 400 });
	}

	// Validate language
	if (typeof language !== 'string' || !VALID_LANGUAGES.includes(language as 'ja' | 'en')) {
		return json({ error: '言語は ja または en を指定してください' }, { status: 400 });
	}

	try {
		const arrayBuf = await file.arrayBuffer();
		const uint8 = new Uint8Array(arrayBuf);
		const ext = extForMime(file.type);
		const filename = `recording${ext}`;

		const uploadFile = await toFile(uint8, filename, { type: file.type });

		const result = await groq.audio.transcriptions.create({
			model: 'whisper-large-v3-turbo',
			file: uploadFile,
			language
		});

		return json({ text: result.text });
	} catch (err: unknown) {
		if (err instanceof RateLimitError) {
			const h = (err as { headers?: { get?: (k: string) => string | null } }).headers;
			const retryAfter = h?.get?.('retry-after');
			const init: ResponseInit = retryAfter
				? { status: 429, headers: { 'retry-after': retryAfter } }
				: { status: 429 };
			return json({ error: '混雑中です。しばらくお待ちください。' }, init);
		}

		console.error('Transcription failed:', err);
		return json({ error: '文字起こしに失敗しました' }, { status: 502 });
	}
};
