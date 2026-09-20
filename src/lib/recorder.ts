/**
 * Audio recording with automatic silence detection.
 *
 * Pure `isSilent()` function for testability + `startRecording()` that wraps
 * MediaRecorder with RMS-based silence auto-stop.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLING_INTERVAL_MS = 100;
const DEFAULT_SILENCE_THRESHOLD = 0.02;
const DEFAULT_HOLD_MS = 1_500;
const MIN_RECORDING_MS = 800;
const MAX_RECORDING_MS = 30_000;
const FFT_SIZE = 2_048;

/** Frame rate requested for the live-STT tap (vosk expects 16 kHz). */
const LIVE_SAMPLE_RATE = 16000;
/** ScriptProcessor buffer size for the worklet fallback (256 ms @ 16 kHz). */
const FRAME_BUFFER_SIZE = 4096;

/**
 * AudioWorklet source for the 16 kHz tap. Forwards every render quantum as a
 * Float32Array copy; the buffer is reused between callbacks, so the copy is
 * mandatory. A zero-gain sink keeps the node pulled by the render graph
 * without echoing audio to the speakers.
 */
const FRAME_TAP_WORKLET = `
  class FrameTap extends AudioWorkletProcessor {
    process(inputs) {
      const channel = inputs[0] && inputs[0][0];
      if (channel) this.port.postMessage(new Float32Array(channel));
      return true;
    }
  }
  registerProcessor('frame-tap', FrameTap);
`;

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Detect if a sequence of RMS values represents sustained silence.
 *
 * Returns `true` when every value in `rmsValues` is below `threshold`
 * AND the array has at least `holdMs / 100` samples (sampling at 100 ms).
 *
 * This function is intentionally pure — no browser API dependency — so it
 * can be unit-tested without mocks.
 */
export function isSilent(
  rmsValues: number[],
  threshold: number = DEFAULT_SILENCE_THRESHOLD,
  holdMs: number = DEFAULT_HOLD_MS,
): boolean {
  const requiredSamples = Math.ceil(holdMs / SAMPLING_INTERVAL_MS);
  if (rmsValues.length < requiredSamples) return false;
  return rmsValues.every((v) => v < threshold);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return the first MIME type supported by the runtime, or null. */
export function selectMime(
  isSupported: (mime: string) => boolean = (m) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
): string | null {
  for (const mime of MIME_CANDIDATES) {
    if (isSupported(mime)) return mime;
  }
  return null;
}

/**
 * Compute RMS (root mean square) from a Uint8Array of time-domain samples.
 * Samples are unsigned bytes [0, 255] centered at 128.
 */
function computeRms(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const normalized = (data[i] - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartRecordingOptions {
	/**
	 * Optional 16 kHz Float32 frame callback (live STT feed). When provided,
	 * a second AudioContext at 16 kHz taps the same MediaStream and delivers
	 * ~128-sample frames while recording. The default-rate analyser path and
	 * MediaRecorder are unaffected.
	 */
	onAudioFrame?: (samples: Float32Array) => void;
	/**
	 * Silence auto-stop switch (default `true`). `false` disables the 800 ms
	 * grace window and the 1.5 s silence hold — push-to-talk callers end the
	 * recording via `stop()` on key release. The 30 s force-stop stays
	 * enabled in both modes as a safety net.
	 */
	autoStop?: boolean;
}

/**
 * Start recording from the default audio input.
 *
 * Returns an object with:
 * - `stop()`: manually end the recording. Resolves to the recorded `Blob`
 *   once the recorder has fully stopped.
 * - `completed`: a Promise that resolves to the recorded `Blob` on ANY stop
 *   path — silence auto-stop, the 30 s force-stop, or a manual `stop()`.
 *   Callers await this instead of wiring their own `onstop` handler.
 * - `onProgress`: optional callback the caller can assign to receive the
 *   elapsed recording time (ms) every 100 ms.
 * - `onLevel`: optional callback the caller can assign to receive the
 *   input RMS level every 100 ms (for a live level meter).
 *
 * Auto-stop triggers when RMS stays below the threshold for 1 500 ms
 * (after an initial 800 ms grace period). Recordings longer than 30 s
 * are force-stopped. Pass `autoStop: false` to record until `stop()`
 * (push-to-talk) — the 30 s force-stop still applies.
 */
export async function startRecording(
	options: StartRecordingOptions = {}
): Promise<{
	stop: () => Promise<Blob>;
	completed: Promise<Blob>;
	onProgress?: (elapsedMs: number) => void;
	onLevel?: (rms: number) => void;
}> {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

	const mime = selectMime();
	const recorderOptions: MediaRecorderOptions = mime ? { mimeType: mime } : {};
	const recorder = new MediaRecorder(stream, recorderOptions);

	// Set up analyser for RMS monitoring
	const audioCtx = new AudioContext();
	const source = audioCtx.createMediaStreamSource(stream);
	const analyser = audioCtx.createAnalyser();
	analyser.fftSize = FFT_SIZE;
	source.connect(analyser);

	const rmsBuffer = new Uint8Array(analyser.fftSize);
	let silenceStart: number | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let forceTimer: ReturnType<typeof setTimeout> | null = null;
	const startTime = Date.now();

	// Collect audio chunks
	const chunks: Blob[] = [];
	recorder.ondataavailable = (e) => {
		if (e.data.size > 0) chunks.push(e.data);
	};

	// -----------------------------------------------------------------------
	// 16 kHz frame tap for live STT — a separate context so the default-rate
	// analyser path above is untouched (MediaRecorder reads the stream
	// directly). Set up asynchronously: recording starts immediately and
	// pre-start frames are ring-buffered by the live engine.
	// -----------------------------------------------------------------------
	let frameCtx: AudioContext | null = null;
	let frameTeardown: (() => void) | null = null;
	let frameTapDisposed = false;
	if (options.onAudioFrame) {
		const onFrame = options.onAudioFrame;
		void (async () => {
			const ctx = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE });
			frameCtx = ctx;
			const tapSource = ctx.createMediaStreamSource(stream);
			// The render graph only pulls nodes that reach the destination;
			// the zero-gain sink keeps the tap alive without audible output.
			const sink = ctx.createGain();
			sink.gain.value = 0;
			sink.connect(ctx.destination);
			try {
				const moduleUrl = URL.createObjectURL(
					new Blob([FRAME_TAP_WORKLET], { type: 'application/javascript' })
				);
				try {
					await ctx.audioWorklet.addModule(moduleUrl);
				} finally {
					URL.revokeObjectURL(moduleUrl);
				}
				if (frameTapDisposed) return;
				const node = new AudioWorkletNode(ctx, 'frame-tap');
				node.port.onmessage = (e) => {
					if (e.data instanceof Float32Array) onFrame(e.data);
				};
				tapSource.connect(node);
				node.connect(sink);
				frameTeardown = () => {
					node.port.onmessage = null;
					node.disconnect();
					tapSource.disconnect();
				};
			} catch {
				// AudioWorklet unavailable (e.g. strict CSP) — ScriptProcessor fallback.
				if (frameTapDisposed) return;
				const processor = ctx.createScriptProcessor(FRAME_BUFFER_SIZE, 1, 1);
				processor.onaudioprocess = (e) => {
					// Copy: inputBuffer channel data is reused between events.
					onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
				};
				tapSource.connect(processor);
				processor.connect(sink);
				frameTeardown = () => {
					processor.onaudioprocess = null;
					processor.disconnect();
					tapSource.disconnect();
				};
			}
		})();
	}

	// -----------------------------------------------------------------------
	// Completion plumbing — set up at creation time so ANY stop path
	// (silence auto-stop / 30 s force-stop / manual stop()) resolves
	// `completed`. The previous structure set `onstop` inside `stop()`'s
	// closure, which made auto-stop unawaitable without calling `stop()`.
	// -----------------------------------------------------------------------
	let resolveCompleted: (blob: Blob) => void = () => {};
	let rejectCompleted: (err: unknown) => void = () => {};
	const completed = new Promise<Blob>((resolve, reject) => {
		resolveCompleted = resolve;
		rejectCompleted = reject;
	});
	let settled = false;

	const cleanup = () => {
		if (timer !== null) clearInterval(timer);
		if (forceTimer !== null) clearTimeout(forceTimer);
		timer = null;
		forceTimer = null;
		frameTapDisposed = true;
		frameTeardown?.();
		source.disconnect();
		analyser.disconnect();
		void audioCtx.close();
		void frameCtx?.close();
	};

	const finalize = (): Blob => {
		cleanup();
		stream.getTracks().forEach((t) => t.stop());
		return chunks.length > 0
			? new Blob(chunks, { type: recorder.mimeType })
			: new Blob([], { type: recorder.mimeType });
	};

	recorder.onstop = () => {
		if (settled) return;
		settled = true;
		resolveCompleted(finalize());
	};
	recorder.onerror = (e) => {
		if (settled) return;
		settled = true;
		cleanup();
		stream.getTracks().forEach((t) => t.stop());
		rejectCompleted(e);
	};

	// Silence-monitoring interval (every 100 ms)
	const silenceAutoStop = options.autoStop ?? true;
	const checkSilence = () => {
		analyser.getByteTimeDomainData(rmsBuffer);
		const rms = computeRms(rmsBuffer);
		const elapsed = Date.now() - startTime;

		result.onProgress?.(elapsed);
		result.onLevel?.(rms);

		if (!silenceAutoStop) return;
		if (elapsed < MIN_RECORDING_MS) return;

		if (rms < DEFAULT_SILENCE_THRESHOLD) {
			if (silenceStart === null) silenceStart = Date.now();
			if (Date.now() - silenceStart >= DEFAULT_HOLD_MS) {
				cleanup();
				recorder.stop();
			}
		} else {
			silenceStart = null;
		}
	};

	// Force-stop at MAX_RECORDING_MS
	timer = setInterval(checkSilence, SAMPLING_INTERVAL_MS);
	forceTimer = setTimeout(() => {
		cleanup();
		if (recorder.state === 'recording') recorder.stop();
	}, MAX_RECORDING_MS);

	recorder.start(SAMPLING_INTERVAL_MS); // request data every 100 ms

	const stop = (): Promise<Blob> => {
		if (recorder.state === 'recording') {
			recorder.stop();
		}
		// Already stopped (e.g. auto-stop fired first) — `completed` is
		// already resolved (or will be when onstop fires).
		return completed;
	};

	const result: {
		stop: () => Promise<Blob>;
		completed: Promise<Blob>;
		onProgress?: (elapsedMs: number) => void;
		onLevel?: (rms: number) => void;
	} = { stop, completed };

	return result;
}
