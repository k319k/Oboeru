/**
 * Scripted LiveSttEngine for tests and E2E. Words fire on timers in script
 * order; stop() flushes any steps whose timers have not fired yet, so a
 * test can drive a whole utterance deterministically. Audio fed to feed()
 * is ignored — the script is the source of truth.
 */

import type { LiveSttEngine, LiveWord } from './types';

export interface MockWordStep {
	word: string;
	/** Delay in ms after the previous step fires. */
	delayMs: number;
	/** Confidence reported for the word (default 0.9). */
	conf?: number;
	/** Deliver via onPartial (ghost) instead of onWord. */
	partial?: boolean;
}

export function createMockEngine(steps: MockWordStep[]): LiveSttEngine {
	let wordCb: ((word: LiveWord) => void) | null = null;
	let partialCb: ((word: LiveWord) => void) | null = null;
	const timers: ReturnType<typeof setTimeout>[] = [];
	const fired = steps.map(() => false);

	const fire = (step: MockWordStep, index: number) => {
		if (fired[index]) return;
		fired[index] = true;
		const word: LiveWord = {
			word: step.word,
			conf: step.conf ?? 0.9,
			start: step.partial ? -1 : index * 0.5,
			end: step.partial ? -1 : index * 0.5 + 0.5,
			final: !step.partial
		};
		if (step.partial) partialCb?.(word);
		else wordCb?.(word);
	};

	return {
		async start() {
			let elapsed = 0;
			steps.forEach((step, index) => {
				elapsed += step.delayMs;
				timers.push(setTimeout(() => fire(step, index), elapsed));
			});
		},
		feed() {
			// Scripted — real audio is ignored.
		},
		async stop() {
			for (const timer of timers) clearTimeout(timer);
			timers.length = 0;
			steps.forEach((step, index) => fire(step, index));
		},
		onWord(cb) {
			wordCb = cb;
		},
		onPartial(cb) {
			partialCb = cb;
		},
		dispose() {
			for (const timer of timers) clearTimeout(timer);
			timers.length = 0;
		}
	};
}
