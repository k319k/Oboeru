import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLiveStt, terminateLiveStt } from './engine';
import { loadModelUrl } from './model-loader';
import { createMockEngine } from './mock-engine';
import type { LiveSttEngine, LiveWord } from './types';

// Narrow slices of the vosk-browser wire format used by the fakes.
interface FakeResultWord {
	conf: number;
	start: number;
	end: number;
	word: string;
}

interface FakeResultMessage {
	event: 'result';
	result: { result: FakeResultWord[]; text: string };
}

interface FakePartialMessage {
	event: 'partialresult';
	result: { partial: string };
}

type FakeMessage = FakeResultMessage | FakePartialMessage;

class FakeRecognizer {
	static instances: FakeRecognizer[] = [];
	id = 'rec-' + (FakeRecognizer.instances.length + 1);
	listeners = new Map<string, ((message: FakeMessage) => void)[]>();
	words: boolean | null = null;
	accepted: Array<{ samples: Float32Array; sampleRate: number }> = [];
	finalRetrieved = false;
	removed = false;

	constructor(
		public sampleRate: number,
		public grammar?: string
	) {
		FakeRecognizer.instances.push(this);
	}

	on(event: string, listener: (message: FakeMessage) => void): void {
		const queue = this.listeners.get(event) ?? [];
		queue.push(listener);
		this.listeners.set(event, queue);
	}

	setWords(words: boolean): void {
		this.words = words;
	}

	acceptWaveformFloat(samples: Float32Array, sampleRate: number): void {
		this.accepted.push({ samples, sampleRate });
	}

	retrieveFinalResult(): void {
		this.finalRetrieved = true;
	}

	remove(): void {
		this.removed = true;
	}

	emit(message: FakeMessage): void {
		for (const listener of this.listeners.get(message.event) ?? []) listener(message);
	}
}

class FakeModel {
	static instances: FakeModel[] = [];
	/** Load outcome: `true` (success), `false` (result=false), 'error', or 'hang'. */
	static autoResult: boolean | 'error' | 'hang' = true;

	modelUrl: string;
	terminated = false;
	private listeners = new Map<string, ((message: unknown) => void)[]>();

	constructor(modelUrl: string) {
		this.modelUrl = modelUrl;
		FakeModel.instances.push(this);
		// Defer: the engine attaches its listeners right after `new Model`.
		queueMicrotask(() => this.settle());
	}

	get KaldiRecognizer(): typeof FakeRecognizer {
		return FakeRecognizer;
	}

	on(event: string, listener: (message: unknown) => void): void {
		const queue = this.listeners.get(event) ?? [];
		queue.push(listener);
		this.listeners.set(event, queue);
	}

	terminate(): void {
		this.terminated = true;
	}

	private settle(): void {
		if (this.terminated) return;
		const result = FakeModel.autoResult;
		if (result === false) this.emit('load', { event: 'load', result: false });
		else if (result === 'error') this.emit('error', { event: 'error' });
		else if (result === 'hang') return;
		else this.emit('load', { event: 'load', result: true });
	}

	emit(event: string, message: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(message);
	}
}

// The fake is assigned after the class definition; vosk-browser is imported
// lazily by the engine, so the mock factory is called only at first use.
const h = vi.hoisted(() => {
	return { ModelClass: null as unknown };
});

vi.mock('vosk-browser', () => ({
	Model: h.ModelClass
}));

h.ModelClass = FakeModel;

vi.mock('./model-loader', () => ({
	loadModelUrl: vi.fn()
}));

const loadModelUrlMock = vi.mocked(loadModelUrl);

function expectEngine(engine: LiveSttEngine | null): LiveSttEngine {
	if (!engine) throw new Error('expected engine to load');
	return engine;
}

// ─── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
	FakeRecognizer.instances = [];
	FakeModel.instances = [];
	FakeModel.autoResult = true;
	loadModelUrlMock.mockReset();
	loadModelUrlMock.mockResolvedValue('blob:mock-model');
});

afterEach(async () => {
	await terminateLiveStt();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function createStartedEngine(sampleRate = 16000): Promise<LiveSttEngine> {
	const engine = expectEngine(await createLiveStt({ lang: 'ja' }));
	await engine.start(sampleRate);
	return engine;
}

// ─── Engine injection ──────────────────────────────────────────────────
describe('createLiveStt — engine injection', () => {
	it('returns the injected engine without loading vosk or the model', async () => {
		const injected = createMockEngine([{ word: 'テスト', delayMs: 0 }]);

		const engine = await createLiveStt({ lang: 'ja', engine: injected });

		expect(engine).toBe(injected);
		expect(loadModelUrlMock).not.toHaveBeenCalled();
		expect(FakeModel.instances).toHaveLength(0);
	});
});

// ─── Model singleton ───────────────────────────────────────────────────
describe('createLiveStt — model singleton', () => {
	it('shares one Model across engines for the same language', async () => {
		await createLiveStt({ lang: 'ja' });
		await createLiveStt({ lang: 'ja' });

		expect(loadModelUrlMock).toHaveBeenCalledOnce();
		expect(FakeModel.instances).toHaveLength(1);
	});

	it('creates one recognizer per engine start from the shared model', async () => {
		const first = expectEngine(await createLiveStt({ lang: 'ja' }));
		const second = expectEngine(await createLiveStt({ lang: 'ja' }));
		await first.start(16000);
		await second.start(16000);

		expect(FakeRecognizer.instances).toHaveLength(2);
		expect(FakeRecognizer.instances[0].sampleRate).toBe(16000);
		expect(FakeRecognizer.instances[1].sampleRate).toBe(16000);
	});

	it('returns null when the model fails to load and retries on the next call', async () => {
		loadModelUrlMock.mockResolvedValueOnce(null);

		expect(await createLiveStt({ lang: 'ja' })).toBeNull();
		expect(FakeModel.instances).toHaveLength(0);

		expect(await createLiveStt({ lang: 'ja' })).not.toBeNull();
		expect(FakeModel.instances).toHaveLength(1);
		expect(loadModelUrlMock).toHaveBeenCalledTimes(2);
	});

	it('revokes the blob URL after the model is created', async () => {
		const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);

		await createLiveStt({ lang: 'ja' });

		expect(revokeSpy).toHaveBeenCalledWith('blob:mock-model');
	});
});

// ─── Single-resident policy ────────────────────────────────────────────
describe('createLiveStt — single resident model', () => {
	it('terminates the previous resident Model when a different language is requested', async () => {
		await createLiveStt({ lang: 'ja' });
		await createLiveStt({ lang: 'en' });

		expect(FakeModel.instances).toHaveLength(2);
		expect(FakeModel.instances[0].terminated).toBe(true);
		expect(FakeModel.instances[1].terminated).toBe(false);
	});

	it('frees a stale model that settles after its language was evicted', async () => {
		let releaseJa!: (v: string | null) => void;
		loadModelUrlMock.mockImplementation((lang) =>
			lang === 'ja'
				? new Promise((r) => (releaseJa = r))
				: Promise.resolve('blob:en')
		);

		const jaEngine = createLiveStt({ lang: 'ja' });
		await createLiveStt({ lang: 'en' }); // evicts ja while it is still loading

		releaseJa('blob:ja');
		await jaEngine;

		// Exactly one model survives the eviction race.
		expect(FakeModel.instances.filter((m) => !m.terminated)).toHaveLength(1);
		expect(FakeModel.instances.find((m) => m.modelUrl === 'blob:ja')?.terminated).toBe(true);
	});
});

// ─── createModelSafely failure paths ──────────────────────────────────
describe('createLiveStt — model load failure', () => {
	it('terminates the worker and returns null when the Model reports result=false', async () => {
		FakeModel.autoResult = false;

		expect(await createLiveStt({ lang: 'ja' })).toBeNull();
		expect(FakeModel.instances[0].terminated).toBe(true);
	});

	it('terminates the worker and returns null when the Model reports an error', async () => {
		FakeModel.autoResult = 'error';

		expect(await createLiveStt({ lang: 'ja' })).toBeNull();
		expect(FakeModel.instances[0].terminated).toBe(true);
	});

	it('resolves null instead of hanging when the Model never narrates its load', async () => {
		vi.useFakeTimers();
		FakeModel.autoResult = 'hang';

		const pending = createLiveStt({ lang: 'ja' });
		let done = false;
		void pending.then(
			() => (done = true),
			() => (done = true)
		);
		// The async chain (dynamic import + new Model) registers the watchdog at
		// its own pace; advance in steps so the clock never outruns it.
		for (let i = 0; i < 100 && !done; i++) {
			await vi.advanceTimersByTimeAsync(1_000);
		}

		expect(done).toBe(true);
		expect(await pending).toBeNull();
		expect(FakeModel.instances[0].terminated).toBe(true);
	});
});

// ─── Recognition flow ──────────────────────────────────────────────────
describe('vosk engine — recognition', () => {
	it('enables word timing on the recognizer', async () => {
		await createStartedEngine();

		expect(FakeRecognizer.instances[0].words).toBe(true);
	});

	it('feeds audio straight through after start', async () => {
		const engine = await createStartedEngine();
		const samples = new Float32Array([0.1, 0.2]);

		engine.feed(samples);

		const recognizer = FakeRecognizer.instances[0];
		expect(recognizer.accepted).toEqual([{ samples, sampleRate: 16000 }]);
	});

	it('buffers pre-start audio and flushes the last ~5s on start', async () => {
		const engine = expectEngine(await createLiveStt({ lang: 'ja' }));
		const silence = (value: number) => new Float32Array(16000).fill(value);
		engine.feed(silence(0));
		engine.feed(silence(1));
		engine.feed(silence(2));
		engine.feed(silence(3));
		engine.feed(silence(4));
		engine.feed(silence(5)); // 6s buffered — the first second must be dropped
		await engine.start(16000);

		const recognizer = FakeRecognizer.instances[0];
		expect(recognizer.accepted).toHaveLength(5);
		expect(recognizer.accepted.map((a) => a.samples[0])).toEqual([1, 2, 3, 4, 5]);
	});

	it('delivers result words via onWord with final=true', async () => {
		const engine = await createStartedEngine();
		const words: LiveWord[] = [];
		engine.onWord((word) => words.push(word));

		FakeRecognizer.instances[0].emit({
			event: 'result',
			result: {
				result: [
					{ word: 'こんにちは', conf: 0.92, start: 0, end: 0.4 },
					{ word: '世界', conf: 0.88, start: 0.4, end: 0.8 }
				],
				text: 'こんにちは 世界'
			}
		});

		expect(words).toEqual([
			{ word: 'こんにちは', conf: 0.92, start: 0, end: 0.4, final: true },
			{ word: '世界', conf: 0.88, start: 0.4, end: 0.8, final: true }
		]);
	});

	it('delivers partial ghosts via onPartial with final=false and no timing', async () => {
		const engine = await createStartedEngine();
		const ghosts: LiveWord[] = [];
		engine.onPartial((word) => ghosts.push(word));

		FakeRecognizer.instances[0].emit({
			event: 'partialresult',
			result: { partial: 'こんにちは 世界 ' }
		});

		expect(ghosts).toEqual([
			{ word: 'こんにちは', conf: 0, start: -1, end: -1, final: false },
			{ word: '世界', conf: 0, start: -1, end: -1, final: false }
		]);
	});

	it('flushes the tail via retrieveFinalResult on stop', async () => {
		const engine = await createStartedEngine();

		await engine.stop();

		expect(FakeRecognizer.instances[0].finalRetrieved).toBe(true);
	});

	it('removes the recognizer on dispose', async () => {
		const engine = await createStartedEngine();

		engine.dispose();

		expect(FakeRecognizer.instances[0].removed).toBe(true);
	});
});

// ─── terminateLiveStt ──────────────────────────────────────────────────
describe('terminateLiveStt', () => {
	it('terminates the shared model for every language', async () => {
		loadModelUrlMock.mockImplementation(async (lang: string) => `blob:mock-${lang}`);
		await createLiveStt({ lang: 'ja' });
		await createLiveStt({ lang: 'en' });

		await terminateLiveStt();

		expect(FakeModel.instances.map((model) => model.terminated)).toEqual([true, true]);
	});
});

// ─── Mock engine ───────────────────────────────────────────────────────
describe('mock engine', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it('fires scripted words in order', async () => {
		const engine = createMockEngine([
			{ word: '一', delayMs: 10 },
			{ word: '二', delayMs: 10 },
			{ word: '三', delayMs: 10 }
		]);
		const words: LiveWord[] = [];
		engine.onWord((word) => words.push(word));
		await engine.start(16000);

		await vi.advanceTimersByTimeAsync(35);

		expect(words.map((word) => word.word)).toEqual(['一', '二', '三']);
		expect(words.every((word) => word.final)).toBe(true);
	});

	it('delivers partial steps via onPartial', async () => {
		const engine = createMockEngine([{ word: 'こん', delayMs: 5, partial: true, conf: 0 }]);
		const ghosts: LiveWord[] = [];
		engine.onPartial((word) => ghosts.push(word));
		await engine.start(16000);

		await vi.advanceTimersByTimeAsync(10);

		expect(ghosts).toEqual([{ word: 'こん', conf: 0, start: -1, end: -1, final: false }]);
	});

	it('flushes unfired steps on stop', async () => {
		const engine = createMockEngine([
			{ word: '遅い', delayMs: 60_000 },
			{ word: '残り', delayMs: 60_000 }
		]);
		const words: LiveWord[] = [];
		engine.onWord((word) => words.push(word));
		await engine.start(16000);

		await vi.advanceTimersByTimeAsync(1000);
		await engine.stop();

		expect(words.map((word) => word.word)).toEqual(['遅い', '残り']);
	});
});
