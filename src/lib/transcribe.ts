/**
 * Transcription client with throttle and retry backoff.
 * Sends audio blobs to the /api/transcribe endpoint for speech-to-text.
 */

const THROTTLE_MS = 3500;
const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

let lastRequestTime = 0;

/**
 * Wait until 3.5s has elapsed since the last request.
 * Returns immediately if enough time has already passed.
 */
async function throttle(): Promise<void> {
	const now = Date.now();
	const elapsed = now - lastRequestTime;
	if (elapsed < THROTTLE_MS) {
		await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS - elapsed));
	}
}

/**
 * Reset throttle state. Exported for testing only.
 * @internal
 */
export function _resetThrottleForTesting(): void {
	lastRequestTime = 0;
}

/**
 * Send an audio blob for transcription.
 * Throttled to one request per 3.5s, with exponential backoff on 429.
 */
export async function transcribe(blob: Blob, language: 'ja' | 'en'): Promise<string> {
	await throttle();
	lastRequestTime = Date.now();

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

		let response: Response;
		try {
			const formData = new FormData();
			formData.append('file', blob);
			formData.append('language', language);

			response = await fetch('/api/transcribe', {
				method: 'POST',
				body: formData,
				signal: controller.signal,
			});
		} catch (error: unknown) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === 'AbortError') {
				throw { message: 'タイムアウトしました' };
			}
			throw error;
		}

		clearTimeout(timeoutId);

		if (response.ok) {
			const data = await response.json();
			return data.text as string;
		}

		if (response.status === 429) {
			const retryAfter = parseInt(response.headers.get('retry-after') ?? '', 10);
			const backoffMs = (isNaN(retryAfter) ? BASE_BACKOFF_MS : retryAfter * 1000)
				* Math.pow(2, attempt);
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
			continue;
		}

		// Non-retryable error
		const errorData = await response.json().catch(() => null);
		throw new Error(errorData?.message ?? `文字起こしに失敗しました (${response.status})`);
	}

	throw new Error('混雑中です。しばらくお待ちください。 (リトライ上限に達しました)');
}
