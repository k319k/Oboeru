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

		// Stream both destinations from a single fetch: the archive goes to the
		// Cache API while a byte-counting TransformStream feeds the Blob. No JS
		// chunk array is ever materialized (the old code held 2-3 copies ~90MB
		// in the JS heap, which spiked memory during TTS playback on Android).
		const [cacheStream, blobStream] = response.body.tee();

		const persist = (async () => {
			try {
				const cache = await caches.open(CACHE_NAME);
				await cache.put(url, new Response(cacheStream));
			} catch {
				// Cache write failed (quota / private window) — memory blob still works.
			}
		})();

		const totalHeader = response.headers.get('content-length');
		const total = totalHeader ? Number(totalHeader) : null;

		let loaded = 0;
		const counted = blobStream.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					loaded += chunk.byteLength;
					onProgress?.({ loaded, total });
					controller.enqueue(chunk);
				}
			})
		);

		const blob = await new Response(counted).blob();
		await persist;
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
