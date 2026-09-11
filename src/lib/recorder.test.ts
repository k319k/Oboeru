import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isSilent, selectMime, startRecording } from './recorder';

// ─── isSilent (pure function) ─────────────────────────────────────────
describe('isSilent', () => {
	it('returns true when all values are below threshold with enough samples', () => {
		const samples = Array.from({ length: 15 }, () => 0.01);
		expect(isSilent(samples)).toBe(true);
	});

	it('returns false when at least one value is at or above threshold', () => {
		const samples = Array.from({ length: 15 }, () => 0.01);
		samples[7] = 0.05; // one loud sample
		expect(isSilent(samples)).toBe(false);
	});

	it('returns false when values are below threshold but too few samples', () => {
		const samples = Array.from({ length: 5 }, () => 0.01);
		expect(isSilent(samples)).toBe(false);
	});

	it('returns false for empty array', () => {
		expect(isSilent([])).toBe(false);
	});

	it('accepts custom threshold', () => {
		const samples = Array.from({ length: 15 }, () => 0.05);
		// Default threshold 0.02 → all above → not silent
		expect(isSilent(samples)).toBe(false);
		// Custom threshold 0.1 → all below → silent
		expect(isSilent(samples, 0.1)).toBe(true);
	});

	it('accepts custom holdMs', () => {
		// 500 ms hold → need 5 samples at 100 ms intervals
		const samples = Array.from({ length: 5 }, () => 0.01);
		expect(isSilent(samples, 0.02, 500)).toBe(true);
		// But 5 samples is not enough for default 1500 ms
		expect(isSilent(samples, 0.02, 1500)).toBe(false);
	});

	it('treats values exactly at threshold as not silent', () => {
		const samples = Array.from({ length: 15 }, () => 0.02);
		expect(isSilent(samples)).toBe(false);
	});

	it('handles zero threshold edge case', () => {
		// All values are > 0 (0.01) so not silent with threshold 0
		const samples = Array.from({ length: 15 }, () => 0.01);
		expect(isSilent(samples, 0)).toBe(false);
	});

	it('handles very large arrays efficiently', () => {
		const samples = Array.from({ length: 1000 }, () => 0.005);
		const start = Date.now();
		expect(isSilent(samples)).toBe(true);
		expect(Date.now() - start).toBeLessThan(100);
	});
});

// ─── selectMime ───────────────────────────────────────────────────────
describe('selectMime', () => {
	it('returns first supported MIME type', () => {
		const isSupported = (mime: string) => mime === 'audio/mp4';
		expect(selectMime(isSupported)).toBe('audio/mp4');
	});

	it('returns preferred webm if supported', () => {
		const isSupported = (mime: string) =>
			mime === 'audio/webm;codecs=opus';
		expect(selectMime(isSupported)).toBe('audio/webm;codecs=opus');
	});

	it('returns null when nothing is supported', () => {
		const isSupported = () => false;
		expect(selectMime(isSupported)).toBeNull();
	});

	it('returns first match when multiple are supported', () => {
		const isSupported = () => true;
		expect(selectMime(isSupported)).toBe('audio/webm;codecs=opus');
	});
});

// ─── startRecording (browser API mocking) ─────────────────────────────
describe('startRecording', () => {
	// Stub: minimal AudioNode mock
	function createAudioNodeStub() {
		return {
			connect: vi.fn(),
			disconnect: vi.fn(),
		};
	}

	let originalMediaDevices: typeof navigator.mediaDevices;
	let originalMediaRecorder: typeof MediaRecorder;
	let originalAudioContext: typeof AudioContext;

	beforeEach(() => {
		originalMediaDevices = navigator.mediaDevices;
		originalMediaRecorder = globalThis.MediaRecorder;
		originalAudioContext = globalThis.AudioContext;

		// Mock getUserMedia
		Object.assign(navigator, {
			mediaDevices: {
				getUserMedia: vi.fn().mockResolvedValue({
					getTracks: () => [{ stop: vi.fn() }],
				}),
			},
		});

		// Mock MediaRecorder
		globalThis.MediaRecorder = vi.fn().mockImplementation(() => {
			const state: { current: string } = { current: 'inactive' };
			const listeners: Record<string, Function> = {};
			// Interceptor: routing onXxx assignments to listeners dict
			function makeHandler(key: string) {
				return {
					get() {
						return listeners[key];
					},
					set(cb: Function) {
						listeners[key] = cb;
					},
				};
			}
			const obj: Record<string, any> = {
				get state() {
					return state.current;
				},
				mimeType: 'audio/webm;codecs=opus',
				start: vi.fn(() => {
					state.current = 'recording';
				}),
				stop: vi.fn(() => {
					state.current = 'inactive';
					// Fire onstop asynchronously (matches real browser behavior)
					setTimeout(() => {
						listeners['stop']?.();
					}, 0);
				}),
				addEventListener: vi.fn((event: string, cb: Function) => {
					listeners[event] = cb;
				}),
				// Expose a way for tests to simulate events
				_dispatch(event: string) {
					listeners[event]?.();
				},
				// Simulate data chunk
				_fireData(data: Blob) {
					listeners['dataavailable']?.({ data });
				},
			};
			// Define onXxx properties that route to listeners
			Object.defineProperties(obj, {
				ondataavailable: makeHandler('dataavailable'),
				onstop: makeHandler('stop'),
				onerror: makeHandler('error'),
			});
			return obj;
		}) as any;
		(globalThis.MediaRecorder as any).isTypeSupported = vi.fn(() => true);

		// Mock AudioContext + AnalyserNode
		const analyserStub = {
			fftSize: 2048,
			getByteTimeDomainData: vi.fn((arr: Uint8Array) => {
				// Fill with silence (128 = center)
				arr.fill(128);
			}),
			connect: vi.fn(),
			disconnect: vi.fn(),
		};
		globalThis.AudioContext = vi.fn().mockImplementation(() => ({
			createMediaStreamSource: vi.fn().mockReturnValue({
				connect: vi.fn(),
				disconnect: vi.fn(),
			}),
			createAnalyser: vi.fn().mockReturnValue(analyserStub),
			close: vi.fn().mockResolvedValue(undefined),
		})) as any;
	});

	afterEach(() => {
		Object.assign(navigator, { mediaDevices: originalMediaDevices });
		globalThis.MediaRecorder = originalMediaRecorder;
		globalThis.AudioContext = originalAudioContext;
		vi.restoreAllMocks();
	});

	it('returns an object with a stop function', async () => {
		const { stop } = await startRecording();
		expect(typeof stop).toBe('function');
	});

	it('calls getUserMedia with audio: true', async () => {
		await startRecording();
		expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
			audio: true,
		});
	});

	it('propagates NotAllowedError from getUserMedia', async () => {
		const error = new DOMException(
			'Permission denied',
			'NotAllowedError',
		);
		(navigator.mediaDevices.getUserMedia as any).mockRejectedValue(
			error,
		);

		await expect(startRecording()).rejects.toThrow(error);
	});

	it('propagates NotFoundError from getUserMedia', async () => {
		const error = new DOMException(
			'No device',
			'NotFoundError',
		);
		(navigator.mediaDevices.getUserMedia as any).mockRejectedValue(
			error,
		);

		await expect(startRecording()).rejects.toThrow(error);
	});

	it('stop() resolves to a Blob with recorded data', async () => {
		const { stop } = await startRecording();

		// Simulate the MediaRecorder returning a data chunk
		const recorderInstance = (MediaRecorder as any).mock.results[0]
			.value;
		recorderInstance._fireData(
			new Blob(['test'], { type: 'audio/webm' }),
		);

		const blob = await stop();
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.size).toBeGreaterThan(0);
	});

	it('stop() resolves to empty Blob when no data was recorded', async () => {
		const { stop } = await startRecording();
		const blob = await stop();
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.size).toBe(0);
	});

	it('stops all tracks on the stream when stop() is called', async () => {
		const trackStop = vi.fn();
		(navigator.mediaDevices.getUserMedia as any).mockResolvedValue({
			getTracks: () => [{ stop: trackStop }],
		});

		const { stop } = await startRecording();
		await stop();

		expect(trackStop).toHaveBeenCalled();
	});

	// ─── completed / auto-stop (fake timers) ─────────────────────────
	// The analyser mock fills the buffer with 128 (center = silence), so
	// RMS is 0 and the silence detector fires.
	describe('startRecording — completed & auto-stop', () => {
		it('stops after a sustained silence event', async () => {
			vi.useFakeTimers();
			try {
				const { completed } = await startRecording();
				const recorderInstance = (MediaRecorder as any).mock.results[0]
					.value;

				// 800 ms grace + 1500 ms hold → auto-stop at t=2300. The
				// mock's stop() schedules onstop via setTimeout(0), which
				// the async advance flushes.
				await vi.advanceTimersByTimeAsync(2310);

				expect(recorderInstance.stop).toHaveBeenCalled();
				await expect(completed).resolves.toBeInstanceOf(Blob);
			} finally {
				vi.useRealTimers();
			}
		});

		it('does not stop before MIN_RECORDING_MS (800ms)', async () => {
			vi.useFakeTimers();
			try {
				const { completed } = await startRecording();
				const recorderInstance = (MediaRecorder as any).mock.results[0]
					.value;

				await vi.advanceTimersByTimeAsync(700);

				expect(recorderInstance.stop).not.toHaveBeenCalled();

				let resolved = false;
				completed.then(() => {
					resolved = true;
				});
				await vi.advanceTimersByTimeAsync(0);
				expect(resolved).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it('completed resolves on manual stop', async () => {
			vi.useFakeTimers();
			try {
				const { stop, completed } = await startRecording();
				const recorderInstance = (MediaRecorder as any).mock.results[0]
					.value;
				recorderInstance._fireData(
					new Blob(['test'], { type: 'audio/webm' }),
				);

				let resolved: Blob | null = null;
				completed.then((b) => {
					resolved = b;
				});

				void stop();
				await vi.advanceTimersByTimeAsync(0);

				expect(resolved).toBeInstanceOf(Blob);
			} finally {
				vi.useRealTimers();
			}
		});

		it('completed resolves on auto stop (silence)', async () => {
			vi.useFakeTimers();
			try {
				const { completed } = await startRecording();

				let resolved = false;
				completed.then(() => {
					resolved = true;
				});

				await vi.advanceTimersByTimeAsync(2310);

				expect(resolved).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it('onProgress reports elapsed ms periodically', async () => {
			vi.useFakeTimers();
			try {
				const rec = await startRecording();
				const reported: number[] = [];
				rec.onProgress = (ms) => reported.push(ms);

				await vi.advanceTimersByTimeAsync(500);

				expect(reported.length).toBeGreaterThan(0);
				expect(reported[reported.length - 1]).toBeGreaterThanOrEqual(400);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
