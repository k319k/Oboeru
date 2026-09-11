import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, _resetThrottleForTesting } from './transcribe';

// ─── Setup ─────────────────────────────────────────────────────────────
beforeEach(() => {
	vi.useFakeTimers();
	_resetThrottleForTesting();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function makeBlob(content = 'audio-data'): Blob {
	return new Blob([content], { type: 'audio/webm' });
}

function createSuccessResponse(text: string) {
	return {
		ok: true,
		json: () => Promise.resolve({ text }),
	};
}

function create429Response(retryAfter?: number) {
	const headers = new Headers();
	if (retryAfter !== undefined) {
		headers.set('retry-after', String(retryAfter));
	}
	return {
		ok: false,
		status: 429,
		headers,
		json: () => Promise.resolve({ message: 'Rate limit exceeded' }),
	};
}

function createErrorResponse(status: number, message: string) {
	return {
		ok: false,
		status,
		json: () => Promise.resolve({ message }),
	};
}

// ─── Successful transcription ─────────────────────────────────────────
describe('transcribe', () => {
	it('returns transcribed text on success', async () => {
		const spy = vi.fn().mockResolvedValue(createSuccessResponse('こんにちは世界'));
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');
		await vi.advanceTimersByTimeAsync(3500);
		expect(await p).toBe('こんにちは世界');

		expect(spy).toHaveBeenCalledOnce();
		const [url, options] = spy.mock.calls[0];
		expect(url).toBe('/api/transcribe');
		expect(options.method).toBe('POST');
		expect(options.signal).toBeInstanceOf(AbortSignal);
	});

	it('sends FormData with file and language', async () => {
		const spy = vi.fn().mockImplementation((_url: string, options: RequestInit) => {
			const form = options.body as FormData;
			expect(form).toBeInstanceOf(FormData);
			expect(form.getAll('file')).toHaveLength(1);
			expect(form.getAll('language')).toEqual(['en']);
			return Promise.resolve(createSuccessResponse('test'));
		});
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();
		const p = transcribe(blob, 'en');
		await vi.advanceTimersByTimeAsync(3500);
		await p;
	});
});

// ─── Throttle ──────────────────────────────────────────────────────────
describe('throttle', () => {
	it('waits ~3.5s between rapid requests', async () => {
		const callTimestamps: number[] = [];
		const spy = vi.fn().mockImplementation(() => {
			callTimestamps.push(Date.now());
			return Promise.resolve(createSuccessResponse('r'));
		});
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();

		// First request — starts at t=0, throttle resolves at t=3500
		const p1 = transcribe(blob, 'ja');
		await vi.advanceTimersByTimeAsync(4000);
		await p1;
		expect(callTimestamps[0]).toBeGreaterThanOrEqual(3500);

		// Second request immediately after — throttle must wait another 3.5s
		const p2 = transcribe(blob, 'ja');
		await vi.advanceTimersByTimeAsync(4000);
		await p2;
		expect(callTimestamps[1]).toBeGreaterThanOrEqual(7500);

		// Gap between the two requests should be ≥ 3500ms
		expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(3500);
	});

	it('does not throttle when requests are >3.5s apart', async () => {
		const callTimestamps: number[] = [];
		const spy = vi.fn().mockImplementation(() => {
			callTimestamps.push(Date.now());
			return Promise.resolve(createSuccessResponse('r'));
		});
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();

		// First request
		const p1 = transcribe(blob, 'ja');
		await vi.advanceTimersByTimeAsync(4000);
		await p1;

		// Simulate 5 seconds passing
		vi.advanceTimersByTime(5000);

		// Second request should fire immediately (throttle elapsed)
		const p2 = transcribe(blob, 'ja');
		await vi.advanceTimersByTimeAsync(100);
		await p2;

		expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(8500);
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

// ─── 429 Retry ─────────────────────────────────────────────────────────
describe('429 retry', () => {
	it('retries with backoff on 429 and succeeds', async () => {
		const spy = vi.fn()
			.mockResolvedValueOnce(create429Response(1))
			.mockResolvedValueOnce(createSuccessResponse('recovered'));
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');

		// Advance through throttle (3.5s) + backoff (retry-after: 1s * 2^0 = 1s)
		await vi.advanceTimersByTimeAsync(3500 + 1000);

		expect(await p).toBe('recovered');
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('uses exponential backoff (1s, 2s, 4s)', { timeout: 30_000 }, async () => {
		const callTimestamps: number[] = [];
		const spy = vi.fn().mockImplementation(() => {
			callTimestamps.push(Date.now());
			return Promise.resolve(create429Response());
		});
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');
		// Attach catch handler immediately to avoid unhandled rejection
		const rejection = p.catch((e: unknown) => e);

		// Run all timers: throttle (3.5s) + backoff 0 (1s) + backoff 1 (2s) + backoff 2 (4s)
		await vi.runAllTimersAsync();

		expect(spy).toHaveBeenCalledTimes(4);
		const err = await rejection;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('混雑中');

		// Verify exponential backoff gaps
		expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(1000);
		expect(callTimestamps[2] - callTimestamps[1]).toBeGreaterThanOrEqual(2000);
		expect(callTimestamps[3] - callTimestamps[2]).toBeGreaterThanOrEqual(4000);
	});

	it('respects retry-after header value', async () => {
		const spy = vi.fn()
			.mockResolvedValueOnce(create429Response(5))
			.mockResolvedValueOnce(createSuccessResponse('ok'));
		vi.stubGlobal('fetch', spy);

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');

		// Throttle (3.5s) + backoff with retry-after: 5s * 2^0 = 5s
		await vi.advanceTimersByTimeAsync(3500 + 5000);

		expect(await p).toBe('ok');
	});
});

// ─── Rate limit error ──────────────────────────────────────────────────
describe('rate limit error', () => {
	it('throws after max retries exhausted', { timeout: 30_000 }, async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(create429Response()));

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');
		const rejection = p.catch((e: unknown) => e);

		// Run all timers: throttle (3.5s) + backoff 0 (1s) + backoff 1 (2s) + backoff 2 (4s)
		await vi.runAllTimersAsync();

		const err = await rejection;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('混雑中');
	});
});

// ─── Timeout ───────────────────────────────────────────────────────────
describe('timeout', () => {
	it('throws on 60s timeout', async () => {
		// Mock fetch to hang forever until aborted
		vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, options: RequestInit) => {
			return new Promise((_resolve, reject) => {
				const signal = options.signal;
				if (signal) {
					signal.addEventListener('abort', () => {
						reject(new DOMException('The operation was aborted', 'AbortError'));
					});
				}
			});
		}));

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');
		const rejection = p.catch((e: unknown) => e);

		// Advance through throttle (3.5s) then timeout (60s)
		await vi.advanceTimersByTimeAsync(3500 + 60_000);

		await expect(rejection).resolves.toEqual({ message: 'タイムアウトしました' });
	});
});

// ─── Network error ─────────────────────────────────────────────────────
describe('network error', () => {
	it('propagates network errors', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');
		const rejection = p.catch((e: unknown) => e);

		// Advance through throttle
		await vi.advanceTimersByTimeAsync(3500);

		const err = await rejection;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('Failed to fetch');
	});

	it('propagates non-429 HTTP errors', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
			createErrorResponse(500, 'Internal server error')
		));

		const blob = makeBlob();
		const p = transcribe(blob, 'ja');
		const rejection = p.catch((e: unknown) => e);

		// Advance through throttle
		await vi.advanceTimersByTimeAsync(3500);

		const err = await rejection;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain('Internal server error');
	});
});
