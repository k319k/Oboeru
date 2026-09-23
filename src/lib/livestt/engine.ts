/**
 * Live STT engine backed by vosk-browser (WASM). Browser-only at runtime:
 * vosk-browser is imported dynamically inside createLiveStt(), never at
 * module load, so importing this module during SSR is harmless.
 *
 * The vosk Model is per-language and owns a Worker + ~40MB WASM heap. Only
 * ONE language is resident at a time: requesting a different language frees
 * the previous model (single-resident policy), because keeping two resident
 * pushed the phone renderer into an out-of-memory kill. Model loads never
 * reject and never hang — a failed or timed-out load frees its worker and
 * returns null (live captions degrade off), and the singleton stays
 * retryable. terminateLiveStt() (practice screen unmount) frees whatever is
 * left.
 */

import type { LiveSttEngine, LiveWord, ModelLoadProgress } from './types';
import { loadModelUrl } from './model-loader';
import type { ModelLang } from './urls';

type VoskModule = typeof import('vosk-browser');
type VoskModel = InstanceType<VoskModule['Model']>;
type VoskRecognizer = InstanceType<VoskModel['KaldiRecognizer']>;
type VoskModelMessage = { event: string; result?: boolean };

/** Upper bound for pre-start buffering: the last ~5 seconds at 16kHz. */
const RING_BUFFER_CAPACITY_SAMPLES = 16000 * 5;

/** Safety net: a worker that never narrates its load never poisons anything. */
const MODEL_LOAD_TIMEOUT_MS = 60_000;

export interface CreateLiveSttOptions {
	lang: ModelLang;
	onProgress?: (progress: ModelLoadProgress) => void;
	signal?: AbortSignal;
	/** Test/E2E injection — skips vosk and the model download entirely. */
	engine?: LiveSttEngine;
}

const modelLeases = new Map<ModelLang, Promise<VoskModel | null>>();

function loadModel(
	lang: ModelLang,
	onProgress?: (progress: ModelLoadProgress) => void,
	signal?: AbortSignal
): Promise<VoskModel | null> {
	const existing = modelLeases.get(lang);
	if (existing) return existing;

	// Single-resident: a different language evicts whatever is resident.
	// Late-settling loads are freed by the identity check on settle below.
	for (const [otherLang, other] of modelLeases) {
		modelLeases.delete(otherLang);
		void other.then((model) => model?.terminate());
	}

	const promise = (async () => {
		const blobUrl = await loadModelUrl(lang, onProgress, signal);
		if (!blobUrl) return null;
		try {
			return await createModelSafely(blobUrl, signal);
		} finally {
			// The worker has read the archive into its own filesystem by now.
			URL.revokeObjectURL(blobUrl);
		}
	})();

	void promise.then((model) => {
		if (!model) {
			// A failed load must not poison the singleton — allow a later retry.
			modelLeases.delete(lang);
			return;
		}
		// Evicted while loading (a different language superseded it) → free now.
		if (modelLeases.get(lang) !== promise) model.terminate();
	});

	modelLeases.set(lang, promise);
	return promise;
}

/**
 * Create a vosk Model from an already-resolved blob URL without ever leaking
 * its worker or hanging. The stock `createModel` rejects without terminating
 * its Model on failure and never settles if the worker is silent, so this own
 * factory wraps `new Model()` with load/error/abort/timeout listeners — every
 * non-success path terminates the worker and resolves null.
 */
async function createModelSafely(
	blobUrl: string,
	signal?: AbortSignal
): Promise<VoskModel | null> {
	const { Model } = await import('vosk-browser');
	const model = new Model(blobUrl);
	try {
		return await new Promise<VoskModel | null>((resolve) => {
			let settled = false;
			const finish = (value: VoskModel | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				signal?.removeEventListener('abort', onAbort);
				if (value !== model) model.terminate();
				resolve(value);
			};
			const onAbort = () => finish(null);
			model.on('load', (message: VoskModelMessage) => {
				finish(message?.result === true ? model : null);
			});
			model.on('error', () => finish(null));
			const timeoutId = setTimeout(() => finish(null), MODEL_LOAD_TIMEOUT_MS);
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener('abort', onAbort, { once: true });
		});
	} finally {
		// URL revocation is the caller's job; the worker archive handling is
		// already done here.
	}
}

/** Resolves to null when the model cannot be loaded (caller degrades to no live captions). */
export async function createLiveStt(options: CreateLiveSttOptions): Promise<LiveSttEngine | null> {
	if (options.engine) return options.engine;

	const model = await loadModel(options.lang, options.onProgress, options.signal);
	if (!model) return null;
	return new VoskLiveSttEngine(model);
}

/** Free the shared Models and their workers. Only the practice screen unmount should call this. */
export async function terminateLiveStt(): Promise<void> {
	const pending = [...modelLeases.values()];
	modelLeases.clear();
	const models = await Promise.all(pending);
	for (const model of models) model?.terminate();
}

class VoskLiveSttEngine implements LiveSttEngine {
	private wordCb: ((word: LiveWord) => void) | null = null;
	private partialCb: ((word: LiveWord) => void) | null = null;
	private recognizer: VoskRecognizer | null = null;
	private sampleRate = 16000;
	private pendingChunks: Float32Array[] = [];
	private pendingSamples = 0;

	constructor(private readonly model: VoskModel) {}

	async start(sampleRate: number): Promise<void> {
		const recognizer = new this.model.KaldiRecognizer(sampleRate);
		recognizer.setWords(true);
		recognizer.on('result', (message) => {
			if (message.event !== 'result') return;
			for (const w of message.result.result) {
				this.wordCb?.({ word: w.word, conf: w.conf, start: w.start, end: w.end, final: true });
			}
		});
		recognizer.on('partialresult', (message) => {
			if (message.event !== 'partialresult') return;
			// Partials carry no word timings — deliver ghosts for live coloring.
			for (const word of message.result.partial.trim().split(/\s+/)) {
				if (!word) continue;
				this.partialCb?.({ word, conf: 0, start: -1, end: -1, final: false });
			}
		});
		this.sampleRate = sampleRate;
		this.recognizer = recognizer;
		this.flushPending();
	}

	feed(samples: Float32Array): void {
		if (!this.recognizer) {
			this.buffer(samples);
			return;
		}
		this.recognizer.acceptWaveformFloat(samples, this.sampleRate);
	}

	async stop(): Promise<void> {
		// Flush the tail of the utterance — its 'result' event still reaches onWord.
		this.recognizer?.retrieveFinalResult();
	}

	onWord(cb: (word: LiveWord) => void): void {
		this.wordCb = cb;
	}

	onPartial(cb: (word: LiveWord) => void): void {
		this.partialCb = cb;
	}

	dispose(): void {
		this.recognizer?.remove();
		this.recognizer = null;
	}

	private buffer(samples: Float32Array): void {
		// Copy: the caller may reuse its frame buffer between feeds.
		const chunk = new Float32Array(samples);
		this.pendingChunks.push(chunk);
		this.pendingSamples += chunk.length;
		// Keep the most recent ~5s. Feeds are per-frame chunks far below the
		// capacity, so whole-chunk dropping is accurate enough.
		while (this.pendingSamples > RING_BUFFER_CAPACITY_SAMPLES && this.pendingChunks.length > 0) {
			const dropped = this.pendingChunks.shift();
			if (dropped) this.pendingSamples -= dropped.length;
		}
	}

	private flushPending(): void {
		const recognizer = this.recognizer;
		if (!recognizer) return;
		const chunks = this.pendingChunks;
		this.pendingChunks = [];
		this.pendingSamples = 0;
		for (const chunk of chunks) {
			recognizer.acceptWaveformFloat(chunk, this.sampleRate);
		}
	}
}
