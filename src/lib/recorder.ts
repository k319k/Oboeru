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
 *
 * Auto-stop triggers when RMS stays below the threshold for 1 500 ms
 * (after an initial 800 ms grace period). Recordings longer than 30 s
 * are force-stopped.
 */
export async function startRecording(): Promise<{
	stop: () => Promise<Blob>;
	completed: Promise<Blob>;
	onProgress?: (elapsedMs: number) => void;
}> {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

	const mime = selectMime();
	const options: MediaRecorderOptions = mime ? { mimeType: mime } : {};
	const recorder = new MediaRecorder(stream, options);

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
		source.disconnect();
		analyser.disconnect();
		void audioCtx.close();
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
	const checkSilence = () => {
		analyser.getByteTimeDomainData(rmsBuffer);
		const rms = computeRms(rmsBuffer);
		const elapsed = Date.now() - startTime;

		result.onProgress?.(elapsed);

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
	} = { stop, completed };

	return result;
}
