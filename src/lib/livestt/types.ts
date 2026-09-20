/**
 * Live STT contract. The engine never captures audio itself —
 * the caller (recorder) owns capture and pushes samples via feed().
 */

/** One recognized word. Times are seconds from the start of recognition. */
export interface LiveWord {
	word: string;
	conf: number;
	/** Start time. -1 when unknown (partial ghost words carry no timing). */
	start: number;
	/** End time. -1 when unknown (partial ghost words carry no timing). */
	end: number;
	/** true: settled result. false: in-progress ghost from a partial result. */
	final: boolean;
}

/** Progress of a model download, in bytes. */
export interface ModelLoadProgress {
	loaded: number;
	/** null when the server did not send Content-Length. */
	total: number | null;
}

export interface LiveSttEngine {
	/** Must be called once before feed(). Creates the recognizer and flushes pre-start buffering. */
	start(sampleRate: number): Promise<void>;
	/** Sole audio input. Samples may be fed before start(); they are ring-buffered (~5s) and flushed on start. */
	feed(samples: Float32Array): void;
	/** Flushes the tail of the utterance (retrieveFinalResult) before resolving. */
	stop(): Promise<void>;
	onWord(cb: (word: LiveWord) => void): void;
	onPartial(cb: (word: LiveWord) => void): void;
	/** Frees the recognizer. The shared Model is released via terminateLiveStt() on unmount. */
	dispose(): void;
}
