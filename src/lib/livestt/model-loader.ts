/**
 * Model archive loader. Resolves a blob URL for the language's STT model,
 * preferring the Cache API and falling back to an in-memory blob when the
 * cache is unavailable (private window, quota, SSR).
 *
 * On failure (network error, HTTP error, caller abort, 60s timeout) it
 * resolves null — the caller decides how to degrade (live captions off).
 */

import type { ModelLoadProgress } from './types';
import { modelProxyUrl, type ModelLang } from './urls';

const CACHE_NAME = 'oboeru-stt-v1';
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Resolve a blob URL for the model archive.
 * The caller must revoke the URL once the model is created.
 */
export async function loadModelUrl(
	lang: ModelLang,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal
): Promise<string | null> {
	const url = modelProxyUrl(lang);

	const cached = await readFromCache(url);
	if (cached) return cached;

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted) controller.abort();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok || !response.body) return null;

		const totalHeader = response.headers.get('content-length');
		const total = totalHeader ? Number(totalHeader) : null;

		const reader = response.body.getReader();
		// slice() hands Blob an ArrayBuffer-backed copy (BlobPart requires it).
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let loaded = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value.slice());
			loaded += value.byteLength;
			onProgress?.({ loaded, total });
		}

		const blob = new Blob(chunks, { type: 'application/zip' });

		// Persist for the next session — best effort only.
		try {
			const cache = await caches.open(CACHE_NAME);
			await cache.put(url, new Response(blob));
		} catch {
			// Cache write failed (quota / private window) — memory blob still works.
		}

		return URL.createObjectURL(blob);
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener('abort', onAbort);
	}
}

/** Cache lookups must never break loading: the Cache API can be absent or
 *  throw in private windows, and `caches` is undefined outside the browser. */
async function readFromCache(url: string): Promise<string | null> {
	try {
		const cache = await caches.open(CACHE_NAME);
		const cached = await cache.match(url);
		if (!cached) return null;
		return URL.createObjectURL(await cached.blob());
	} catch {
		return null;
	}
}
