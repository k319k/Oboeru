import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadModelUrl } from './model-loader';

// ─── Fixtures ──────────────────────────────────────────────────────────

function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});
}

/** Stream that never delivers data but errors when the fetch signal aborts
 *  (mirrors how a real aborted fetch rejects its body reader). */
function hangingBody(signal: AbortSignal): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			signal.addEventListener(
				'abort',
				() => controller.error(new DOMException('The operation was aborted', 'AbortError')),
				{ once: true }
			);
		}
	});
}

interface MockResponseInit {
	chunks?: Uint8Array[];
	total?: number | null;
	hang?: boolean;
}

function okResponse({ chunks = [], total = null, hang = false }: MockResponseInit) {
	return {
		ok: true,
		status: 200,
		headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? total : null) },
		body: hang ? undefined : bodyOf(chunks)
	};
}

function okHangingResponse(signal: AbortSignal) {
	return {
		ok: true,
		status: 200,
		headers: { get: (_name: string) => null },
		body: hangingBody(signal)
	};
}

function errorResponse(status: number) {
	return {
		ok: false,
		status,
		headers: { get: (_name: string) => null },
		body: undefined
	};
}

type CacheStore = Map<string, Blob>;

function stubCache(store: CacheStore) {
	vi.stubGlobal('caches', {
		open: async () => ({
			match: async (url: string) => {
				const blob = store.get(url);
				return blob ? { blob: async () => blob } : undefined;
			},
			put: async (url: string, response: { blob: () => Promise<Blob> }) => {
				store.set(url, await response.blob());
			}
		})
	});
}

function stubBrokenCache(openError: Error | null = null, putError: Error | null = null) {
	vi.stubGlobal('caches', {
		open: async () => {
			if (openError) throw openError;
			return {
				match: async () => undefined,
				put: async () => {
					if (putError) throw putError;
				}
			};
		}
	});
}

// ─── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// ─── Cache hit ─────────────────────────────────────────────────────────
describe('loadModelUrl — cache hit', () => {
	it('returns a blob URL without touching the network', async () => {
		const store: CacheStore = new Map([
			['/models/vosk-model-small-ja-0.22.zip', new Blob(['cached-model'])]
		]);
		stubCache(store);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const url = await loadModelUrl('ja');

		expect(url).toMatch(/^blob:/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ─── Cache miss ────────────────────────────────────────────────────────
describe('loadModelUrl — cache miss', () => {
	it('fetches, reports progress and returns a blob URL', async () => {
		stubCache(new Map());
		const fetchMock = vi.fn().mockResolvedValue(
			okResponse({ chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])], total: 7 })
		);
		vi.stubGlobal('fetch', fetchMock);

		const progress: Array<{ loaded: number; total: number | null }> = [];
		const url = await loadModelUrl('ja', (p) => progress.push({ ...p }));

		expect(url).toMatch(/^blob:/);
		expect(fetchMock).toHaveBeenCalledWith(
			'/models/vosk-model-small-ja-0.22.zip',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		expect(progress).toEqual([
			{ loaded: 3, total: 7 },
			{ loaded: 7, total: 7 }
		]);
	});

	it('reports total=null when Content-Length is absent', async () => {
		stubCache(new Map());
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(okResponse({ chunks: [new Uint8Array([1])] }))
		);

		const progress: Array<{ loaded: number; total: number | null }> = [];
		await loadModelUrl('ja', (p) => progress.push({ ...p }));

		expect(progress).toEqual([{ loaded: 1, total: null }]);
	});

	it('persists the download so the next call hits the cache', async () => {
		const store: CacheStore = new Map();
		stubCache(store);
		const fetchMock = vi
			.fn()
			.mockResolvedValue(okResponse({ chunks: [new Uint8Array([9, 9])], total: 2 }));
		vi.stubGlobal('fetch', fetchMock);

		const first = await loadModelUrl('ja');
		const second = await loadModelUrl('ja');

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(second).toMatch(/^blob:/);
		expect(store.has('/models/vosk-model-small-ja-0.22.zip')).toBe(true);
		expect(first).toMatch(/^blob:/);
	});
});

// ─── Cache unavailable ─────────────────────────────────────────────────
describe('loadModelUrl — cache failures', () => {
	it('continues in memory when caches.open throws (private window)', async () => {
		stubBrokenCache(new Error('SecurityError'));
		const fetchMock = vi
			.fn()
			.mockResolvedValue(okResponse({ chunks: [new Uint8Array([1, 2])], total: 2 }));
		vi.stubGlobal('fetch', fetchMock);

		const url = await loadModelUrl('ja');

		expect(url).toMatch(/^blob:/);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('ignores cache.put failures and still returns a blob URL', async () => {
		stubBrokenCache(null, new Error('QuotaExceededError'));
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(okResponse({ chunks: [new Uint8Array([1])], total: 1 }))
		);

		const url = await loadModelUrl('ja');

		expect(url).toMatch(/^blob:/);
	});
});

// ─── Failures ──────────────────────────────────────────────────────────
describe('loadModelUrl — failures', () => {
	it('returns null on HTTP error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(503)));

		expect(await loadModelUrl('ja')).toBeNull();
	});

	it('returns null on network failure', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

		expect(await loadModelUrl('ja')).toBeNull();
	});

	it('returns null when the caller aborts', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_url: string, options: { signal?: AbortSignal }) =>
				options.signal?.aborted
					? Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
					: Promise.resolve(okResponse({ chunks: [new Uint8Array([1])] }))
			)
		);
		const controller = new AbortController();

		const pending = loadModelUrl('ja', undefined, controller.signal);
		controller.abort();

		expect(await pending).toBeNull();
	});

	it('returns null after the 60s timeout', async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				Promise.resolve(okHangingResponse(options.signal))
			)
		);

		const pending = loadModelUrl('ja');
		await vi.advanceTimersByTimeAsync(60_000);

		expect(await pending).toBeNull();
	});
});
