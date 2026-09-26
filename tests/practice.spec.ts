import { test, expect, type Page } from './fixtures';
import { mockTtsApi, silentWavBytes, type TtsMock } from './tts-mock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oboeru:v1';
const SETTINGS_KEY = 'oboeru:settings:v1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SeedSentence {
	id: string;
	chapterId: string;
	trackId?: string;
	text: string;
	language: 'ja' | 'en';
	order: number;
}

interface SeedTrack {
	id: string;
	chapterId: string;
	name: string;
	order: number;
}

interface SeedOptions {
	tracks?: SeedTrack[];
	sentences?: SeedSentence[];
	settings?: {
		threshold?: number;
		ttsRate?: number;
		voiceURI?: string | null;
		retryFrom?: 'tts' | 'rerecord';
	};
}

/** Seed localStorage with chapters + sentences + settings before navigating. */
async function seedPractice(page: Page, opts: SeedOptions = {}) {
	const chapters = [{ id: 'ch-ja-01', name: '日本語', parentId: null, order: 1 }];
	const sentences = opts.sentences ?? [
		{
			id: 'ja-01',
			chapterId: 'ch-ja-01',
			text: 'おはようございます。',
			language: 'ja' as const,
			order: 1
		}
	];
	const settings = {
		threshold: 80,
		ttsRate: 1.0,
		voiceURI: null,
		retryFrom: 'tts' as const,
		...opts.settings
	};

	await page.addInitScript(
		({ storageKey, settingsKey, chapters, tracks, sentences, settings }) => {
			localStorage.setItem(
				storageKey,
				JSON.stringify({ chapters, tracks, sentences })
			);
			localStorage.setItem(settingsKey, JSON.stringify(settings));
		},
		{
			storageKey: STORAGE_KEY,
			settingsKey: SETTINGS_KEY,
			chapters,
			tracks: opts.tracks,
			sentences,
			settings
		}
	);
}

/** Mock the TTS API (/api/tts) — counts calls via a module-level counter. */
let ttsMock: TtsMock | null = null;
async function mockTts(page: Page): Promise<void> {
	ttsMock = await mockTtsApi(page);
}
async function ttsCallCount(): Promise<number> {
	return ttsMock?.count() ?? 0;
}

interface TranscribeResponse {
	status?: number;
	text?: string;
	delayMs?: number;
	headers?: Record<string, string>;
}

/** Mock /api/judge with the key-less fallback so failing-attempt tests never
 * hit real OpenRouter. Registered FIRST; specific mockJudge mocks registered
 * later override it (Playwright routes are last-registered-first-matched). */
async function mockJudgeFallback(page: Page): Promise<void> {
	await page.route('**/api/judge', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ available: false })
		})
	);
}

/** Mock /api/transcribe. Queue of responses; the last entry repeats.
 * Also installs the default judge fallback (see mockJudgeFallback). */
async function mockTranscribe(page: Page, responses: TranscribeResponse[]) {
	await mockJudgeFallback(page);
	let call = 0;
	await page.route('**/api/transcribe', async (route) => {
		const r = responses[Math.min(call, responses.length - 1)];
		call++;
		if (r.delayMs) {
			await new Promise((resolve) => setTimeout(resolve, r.delayMs));
		}
		if (r.status && r.status !== 200) {
			await route.fulfill({
				status: r.status,
				headers: r.headers ?? {},
				contentType: 'application/json',
				body: '{}'
			});
		} else {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ text: r.text ?? '' })
			});
		}
	});
}

interface JudgeResponse {
	available?: boolean;
	noul?: number;
	category?: string;
	confidence?: number;
}

interface JudgeMock {
	/** Number of /api/judge requests made so far. */
	count(): number;
}

/** Mock /api/judge. Queue of responses; the last entry repeats. Counts requests. */
async function mockJudge(page: Page, responses: JudgeResponse[]): Promise<JudgeMock> {
	let call = 0;
	await page.route('**/api/judge', async (route) => {
		const r = responses[Math.min(call, responses.length - 1)];
		call++;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(r)
		});
	});
	return { count: () => call };
}

/** Seed + mock TTS + (optionally) mock transcribe, then navigate. */
async function setupPractice(
	page: Page,
	opts: SeedOptions & { transcribe?: TranscribeResponse[] } = {},
	chapterId = 'ch-ja-01'
) {
	await seedPractice(page, opts);
	await mockTts(page);
	if (opts.transcribe) {
		await mockTranscribe(page, opts.transcribe);
	}
	await page.goto(`/practice?chapter=${chapterId}`);
}

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

test.describe('Practice — Error states', () => {
	test('missing chapter param shows summary with error', async ({ page }) => {
		await seedPractice(page);
		await page.goto('/practice');

		await expect(page.getByTestId('summary')).toBeVisible();
		await expect(page.getByTestId('error-message')).toContainText(
			'章 ID が指定されていません'
		);
	});

	test('unknown chapter shows summary with error', async ({ page }) => {
		await seedPractice(page);
		await page.goto('/practice?chapter=nope');

		await expect(page.getByTestId('summary')).toBeVisible();
		await expect(page.getByTestId('error-message')).toContainText(
			'章が見つかりません: nope'
		);
	});

	test('chapter with no sentences shows summary with error', async ({ page }) => {
		await seedPractice(page, { sentences: [] });
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('summary')).toBeVisible();
		await expect(page.getByTestId('error-message')).toContainText(
			'この章には文がありません'
		);
	});
});

// ---------------------------------------------------------------------------
// Auto loop
// ---------------------------------------------------------------------------

test.describe('Practice — Auto loop', () => {
	// fake-media はトーン音声のため無音自動停止は発火しない。T13 からは
	// 自動録音が廃止され、ホールド(Space/ボタン)中のみ録音される。
	test('initial show phase displays the sentence and progress', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('progress')).toHaveText('1 / 1');
	});

	test('auto-advances from show through tts to the ready state; hold + release transcribes', async ({
		page
	}) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。', delayMs: 1000 }]
		});

		// Text visible initially (show phase)
		await expect(page.getByTestId('sentence-text')).toBeVisible();

		// After the show dwell + TTS, the text is hidden and the ready state
		// waits for a push — no recording starts on its own.
		await expect(page.getByTestId('sentence-text')).toBeHidden({ timeout: 5000 });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		// Hold → release → transcribing (mock has delayMs: 1000 so it stays visible)
		await holdAndRelease(page);
		await expect(page.getByTestId('sentence-transcribing')).toBeVisible({
			timeout: 5000
		});
	});

	test('full pass loop: feedback with score then summary', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		// Hold → release → transcribe → feedback
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);

		// Feedback with a passing score and the transcribed text
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/pass/);
		await expect(page.getByTestId('score')).toHaveText('100%');
		await expect(page.getByTestId('transcribed-text')).toContainText(
			'おはようございます。'
		);

		// The session no longer auto-advances: the user must press 次へ.
		await page.getByTestId('next-btn').click();
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('summary-sentences')).toHaveText('1');
		await expect(page.getByTestId('summary-average')).toHaveText('100%');
	});

	test('fail loop: low score then retry', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'ぜんぜんちがう' }] });

		// Hold → release → transcribe → failing feedback
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);

		// First feedback: failing score
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/fail/);

		// Retry: もう一度試す → feedback disappears → tts → ready → hold again → feedback
		// The failing feedback no longer auto-retries.
		await page.getByTestId('retry-btn').click();
		await expect(page.getByTestId('feedback')).toBeHidden({ timeout: 10000 });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 15000 });
	});
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

test.describe('Practice — Controls', () => {
	test('skip advances to the next sentence', async ({ page }) => {
		await setupPractice(
			page,
			{
				transcribe: [{ text: 'x' }],
				sentences: [
					{
						id: 'ja-01',
						chapterId: 'ch-ja-01',
						text: 'おはようございます。',
						language: 'ja',
						order: 1
					},
					{
						id: 'ja-02',
						chapterId: 'ch-ja-01',
						text: 'こんにちは。',
						language: 'ja',
						order: 2
					}
				]
			}
		);

		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await page.getByTestId('skip-btn').click();

		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
		await expect(page.getByTestId('progress')).toHaveText('2 / 2');
	});

	test('stop opens the end dialog and confirm ends the session', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }] });

		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await page.getByTestId('stop-btn').click();

		// End confirmation dialog appears (T6: stop → AlertDialog → confirm)
		await expect(page.getByRole('alertdialog')).toBeVisible();
		await expect(page.getByRole('alertdialog')).toContainText('セッションを終了しますか?');

		await page.getByTestId('confirm-end-btn').click();
		await expect(page.getByTestId('summary')).toBeVisible();
	});

	test('summary shows skipped count after skip + stop', async ({ page }) => {
		await setupPractice(
			page,
			{
				transcribe: [{ text: 'x' }],
				sentences: [
					{
						id: 'ja-01',
						chapterId: 'ch-ja-01',
						text: 'おはようございます。',
						language: 'ja',
						order: 1
					},
					{
						id: 'ja-02',
						chapterId: 'ch-ja-01',
						text: 'こんにちは。',
						language: 'ja',
						order: 2
					}
				]
			}
		);

		// Wait for hydration before interacting (clicking too early is a no-op)
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
		await page.getByTestId('stop-btn').click();

		// T6: stop → AlertDialog → confirm → summary
		await expect(page.getByRole('alertdialog')).toBeVisible();
		await page.getByTestId('confirm-end-btn').click();

		await expect(page.getByTestId('summary')).toBeVisible();
		await expect(page.getByTestId('summary-sentences')).toHaveText('2');
		await expect(page.getByTestId('summary-skipped')).toHaveText('1');
		await expect(page.getByTestId('summary-average')).toHaveText('0%');
	});
});

// ---------------------------------------------------------------------------
// Manual controls (T6: replay / next / retry / end dialog / progress bar)
// ---------------------------------------------------------------------------

test.describe('Practice — Manual controls', () => {
	test('replay button in show phase starts TTS immediately', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await page.getByTestId('replay-btn').click();

		// TTS plays (50ms mock) → hidden ready state — well before the 800ms show dwell
		await expect(page.getByTestId('sentence-text')).toBeHidden({ timeout: 500 });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 500 });
	});

	test('replay button in feedback replays the sentence (T3 cache hit, no refetch)', async ({
		page
	}) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

		// T3 cache: the show-phase prefetch warmed the cache, so the feedback
		// replay must reuse it — the API is NOT called a second time (T6).
		await page.getByTestId('replay-btn').click();
		await expect.poll(() => ttsCallCount()).toBe(1);
	});

	test('next button advances immediately without waiting for the dwell', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。' }],
			sentences: [
				{
					id: 'ja-01',
					chapterId: 'ch-ja-01',
					text: 'おはようございます。',
					language: 'ja',
					order: 1
				},
				{
					id: 'ja-02',
					chapterId: 'ch-ja-01',
					text: 'こんにちは。',
					language: 'ja',
					order: 2
				}
			]
		});

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

		// Click 次へ → sentence 2 appears well before the 1.2s correct-dwell
		await page.getByTestId('next-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。', {
			timeout: 700
		});
		await expect(page.getByTestId('progress')).toHaveText('2 / 2');
	});

	test('retry button retries the same sentence immediately', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'ぜんぜんちがう' }] });

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/fail/);

		// Click もう一度試す → back to tts → ready well before the 2.5s fail-dwell
		await page.getByTestId('retry-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 2000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
	});

	test('end dialog cancel keeps the session running', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }] });

		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await page.getByTestId('stop-btn').click();
		await expect(page.getByRole('alertdialog')).toBeVisible();

		await page.getByTestId('cancel-end-btn').click();
		await expect(page.getByRole('alertdialog')).toBeHidden();
		// The session keeps running (not the summary). The phase may have
		// auto-advanced while the dialog was open, so only assert the
		// practice view is still active.
		await expect(page.getByTestId('stop-btn')).toBeVisible();
		await expect(page.getByTestId('summary')).toBeHidden();
	});

	test('progress bar reflects the current sentence', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'x' }],
			sentences: [
				{
					id: 'ja-01',
					chapterId: 'ch-ja-01',
					text: 'おはようございます。',
					language: 'ja',
					order: 1
				},
				{
					id: 'ja-02',
					chapterId: 'ch-ja-01',
					text: 'こんにちは。',
					language: 'ja',
					order: 2
				}
			]
		});

		const bar = page.getByTestId('progress-bar');
		await expect(bar).toBeVisible();
		await expect(bar).toHaveAttribute('aria-valuenow', '1');
		await expect(bar).toHaveAttribute('aria-valuemax', '2');

		await page.getByTestId('skip-btn').click();
		await expect(bar).toHaveAttribute('aria-valuenow', '2');
	});
});

// ---------------------------------------------------------------------------
// Tracks (二段ソート + トラック名バッジ)
// ---------------------------------------------------------------------------

test.describe('Practice — Tracks', () => {
	test('orders by track then sentence order; track badge follows the current track', async ({
		page
	}) => {
		await setupPractice(page, {
			transcribe: [{ text: 'x' }],
			tracks: [
				{ id: 'tr-a', chapterId: 'ch-ja-01', name: '基本', order: 1 },
				{ id: 'tr-b', chapterId: 'ch-ja-01', name: '応用', order: 2 }
			],
			sentences: [
				// トラックB (order 2) の文 order 1 — 文内順は小さいが2番目に来る
				{ id: 'ja-01', chapterId: 'ch-ja-01', trackId: 'tr-b', text: 'こんにちは。', language: 'ja', order: 1 },
				// トラックA (order 1) の文 order 2 — 文内順は大きいが1番目に来る
				{ id: 'ja-02', chapterId: 'ch-ja-01', trackId: 'tr-a', text: 'おはようございます。', language: 'ja', order: 2 }
			]
		});

		// Two-level sort: track A's sentence first despite the higher in-track order
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('progress')).toHaveText('基本 · 1 / 2');

		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
		await expect(page.getByTestId('progress')).toHaveText('応用 · 2 / 2');
	});
});

// ---------------------------------------------------------------------------
// Transcription errors
// ---------------------------------------------------------------------------

test.describe('Practice — Transcription errors', () => {
	// fake-media はトーン音声のため無音自動停止は発火しない。ホールド操作で録音する(T13)
	test('transcribe 500 shows error message in feedback', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ status: 500 }] });

		// Hold → release → transcribe 500 → error feedback
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);

		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('error-message')).toContainText('文字起こしエラー');
	});

	test('transcribe 429 shows congestion message', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ status: 429, headers: { 'retry-after': '0' } }]
		});

		// Hold → release → transcribe 429 → congestion feedback
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);

		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 15000 });
		await expect(page.getByTestId('error-message')).toContainText('混雑中です');
	});
});

// ---------------------------------------------------------------------------
// T6: Keyboard controls
// ---------------------------------------------------------------------------

/** Recorder module mock whose startRecording resolves after 400ms (keeps hidden visible). */
const MOCK_MIC_DELAYED = `
  export async function startRecording() {
    await new Promise((r) => setTimeout(r, 400));
    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
    return {
      stop: async () => { resolveCompleted(new Blob(['x'], { type: 'audio/webm' })); return completed; },
      completed,
      onProgress: undefined
    };
  }
  export function isSilent() { return false; }
  export function selectMime() { return null; }
`;

test.describe('Practice — T6 keyboard', () => {
	test('Space hold in show starts recording after mic prep, release transcribes', async ({
		page
	}) => {
		await seedPractice(page);
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'おはようございます。' }]);
		await page.route('**/src/lib/recorder.ts*', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: MOCK_MIC_DELAYED
			})
		);
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('chapter-name')).toHaveText('日本語');

		// Space during show cancels the TTS path and pushes straight into
		// recording — the delayed mic mock keeps the prep copy visible.
		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-hidden')).toBeVisible({ timeout: 500 });
		await expect(page.getByTestId('sentence-hidden')).toHaveText(/マイクを準備中/);
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		// Held long enough (> 500ms) → release scores.
		await page.waitForTimeout(600);
		await page.keyboard.up('Space');
		await expect(page.getByTestId('sentence-transcribing')).toBeVisible({ timeout: 5000 });
	});

	test('Enter in show skips to the ready state', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');

		await page.keyboard.press('Enter');
		await expect(page.getByTestId('sentence-text')).toBeHidden({ timeout: 500 });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 500 });

		// Recording itself needs the Space hold.
		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.keyboard.up('Space');
	});

	test('Space release ends the hold → transcribing copy', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。', delayMs: 1000 }]
		});
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await holdAndRelease(page);
		await expect(page.getByTestId('sentence-transcribing')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('sentence-transcribing')).toHaveText(/聞き取ってるよ/);
	});

	test('Space in passing feedback advances to the next sentence immediately', async ({
		page
	}) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。' }],
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });

		// Must beat the 1.2s correct-dwell — Space advances instantly.
		await page.keyboard.press(' ');
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。', { timeout: 700 });
	});

	test('R in show replays immediately (skips the show dwell)', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');

		await page.keyboard.press('r');
		// R → tts (cached) → hidden ready, well before the 800ms dwell path.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 700 });
	});

	test('R in passing feedback replays from cache without a second API call', async ({
		page
	}) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect.poll(() => ttsCallCount()).toBe(1);

		await page.keyboard.press('r');
		await expect.poll(() => ttsCallCount()).toBe(1);
	});

	test('S skips to the next sentence', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'x' }],
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');

		await page.keyboard.press('s');
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
		await expect(page.getByTestId('progress')).toHaveText('2 / 2');
	});

	test('Esc opens the end dialog; keys are inert while it is open', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'x' }],
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');

		await page.keyboard.press('Escape');
		await expect(page.getByRole('alertdialog')).toBeVisible();

		// S while the dialog is open must NOT skip behind it.
		await page.keyboard.press('s');
		await expect(page.getByRole('alertdialog')).toBeVisible();
		await expect(page.getByTestId('summary')).toBeHidden();

		await page.keyboard.press('Escape');
		await expect(page.getByRole('alertdialog')).toBeHidden();
		await expect(page.getByTestId('stop-btn')).toBeVisible();
	});

	test('level history grows and reacts while recording', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		// fake-media produces a tone, so at least one bar must exceed the 3px floor.
		await page.waitForFunction(() => {
			const bars = document.querySelectorAll('[data-testid="level-history"] span');
			return (
				bars.length >= 3 &&
				[...bars].some((b) => parseFloat((b as HTMLElement).style.height) > 3)
			);
		});

		const count = await page.getByTestId('level-history').locator('span').count();
		expect(count).toBeGreaterThanOrEqual(3);
		expect(count).toBeLessThanOrEqual(32);

		// The numeric level is still exposed to assistive tech (it used to be
		// asserted via the now-removed `level-value` text).
		await expect(page.getByTestId('level-history')).toHaveAttribute(
			'aria-label',
			/録音レベル \d+%/
		);

		await page.keyboard.up('Space');
	});

	test('level history bars never overflow the meter content box', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		// Wait for a saturated bar (pinned to the 56px clamp) so the check below
		// runs against a loud sample rather than a silent one. Without the clamp
		// no bar can reach 56px, so this doubles as the regression signal.
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll('[data-testid="level-history"] span')].some(
					(b) => parseFloat((b as HTMLElement).style.height) >= 56
				),
			null,
			{ timeout: 10000 }
		);

		const geometry = await page.evaluate(() => {
			const row = document.querySelector<HTMLElement>('[data-testid="level-history"]');
			if (!row) throw new Error('level-history is missing');
			const rr = row.getBoundingClientRect();
			const cs = getComputedStyle(row);
			const contentTop = rr.top + parseFloat(cs.paddingTop);
			const contentBottom = rr.bottom - parseFloat(cs.paddingBottom);
			const bars = [...row.querySelectorAll('span')];
			return {
				contentBoxHeight: contentBottom - contentTop,
				tallestBarHeight: Math.max(...bars.map((b) => b.getBoundingClientRect().height)),
				barCount: bars.length
			};
		});

		expect(geometry.tallestBarHeight).toBeLessThanOrEqual(geometry.contentBoxHeight + 0.5);

		await page.keyboard.up('Space');
	});
});

// ---------------------------------------------------------------------------
// T6: Error retry (un-stick every failure)
// ---------------------------------------------------------------------------

test.describe('Practice — T6 error retry', () => {
	test('TTS 500 → 「もう一度再生」 resumes the flow after recovery', async ({ page }) => {
		await seedPractice(page);
		let ttsCalls = 0;
		await page.route('**/api/tts', async (route) => {
			ttsCalls++;
			if (ttsCalls <= 2) {
				await route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'TTS down' })
				});
				return;
			}
			await route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWavBytes(80) });
		});
		await mockTranscribe(page, [{ text: 'おはようございます。' }]);
		await page.goto('/practice?chapter=ch-ja-01');

		// show-prefetch (#1) + tts speak (#2) both fail → un-stuck error UI.
		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('error-retry-btn')).toHaveText('もう一度再生');

		await page.getByTestId('error-retry-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
	});

	test('mic denied shows the error + retry on the ready screen, then records', async ({
		page
	}) => {
		const MOCK_MIC_DENY_ONCE = `
		  let calls = 0;
		  export async function startRecording() {
		    calls++;
		    if (calls === 1) throw new Error('NotAllowedError: mic denied');
		    let resolveCompleted;
		    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
		    return {
		      stop: async () => { resolveCompleted(new Blob(['x'], { type: 'audio/webm' })); return completed; },
		      completed,
		      onProgress: undefined
		    };
		  }
		  export function isSilent() { return false; }
		  export function selectMime() { return null; }
		`;

		await seedPractice(page);
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'おはようございます。' }]);
		await page.route('**/src/lib/recorder.ts*', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: MOCK_MIC_DENY_ONCE
			})
		);
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		// The push fails: the error + retry appear on the ready screen itself.
		await page.keyboard.down('Space');
		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('error-message')).toContainText('マイク');
		await page.keyboard.up('Space');
		await expect(page.getByTestId('error-retry-btn')).toHaveText('マイクをもう一度許可');

		// Retry clears the error → the next push records (mock call #2 succeeds).
		await page.getByTestId('error-retry-btn').click();
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('error-message')).toHaveCount(0);

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.keyboard.up('Space');
	});

	test('transcribe 500 → 「もう一度採点」 resends the SAME blob', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);

		const blobSizes: number[] = [];
		await page.route('**/api/transcribe', async (route) => {
			blobSizes.push(route.request().postDataBuffer()?.length ?? 0);
			if (blobSizes.length === 1) {
				await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
				return;
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ text: 'おはようございます。' })
			});
		});
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('error-retry-btn')).toHaveText('もう一度採点');

		await page.getByTestId('error-retry-btn').click();
		await expect(page.getByTestId('score')).toHaveText('100%', { timeout: 15000 });
		await expect(page.getByTestId('score')).toHaveClass(/pass/);

		expect(blobSizes.length).toBe(2);
		expect(blobSizes[0]).toBeGreaterThan(0);
		expect(blobSizes[0]).toBe(blobSizes[1]);
	});
});

// ---------------------------------------------------------------------------
// T6: Word diff + celebration
// ---------------------------------------------------------------------------

test.describe('Practice — T6 word diff', () => {
	test('feedback shows token diff: match / mismatch / unread + legend', async ({ page }) => {
		await seedPractice(page, {
			sentences: [
				{
					id: 'en-01',
					chapterId: 'ch-ja-01',
					text: 'Good morning everyone',
					language: 'en',
					order: 1
				}
			]
		});
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'Good banana' }]);
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

		await expect(page.getByTestId('score-label')).toHaveText('類似度');
		await expect(page.getByTestId('word-diff')).toBeVisible();
		await expect(page.locator('[data-testid="diff-token"][data-status="match"]')).toHaveText(
			'Good'
		);
		await expect(page.locator('[data-testid="diff-token"][data-status="mismatch"]')).toHaveText(
			'morning'
		);
		await expect(page.locator('[data-testid="diff-token"][data-status="unread"]')).toHaveText(
			'everyone'
		);
		await expect(page.getByTestId('transcribed-text')).toContainText('Good banana');

		// Legend maps the three states in reading order.
		await expect(page.getByTestId('diff-legend')).toContainText('正しく読めた');
		await expect(page.getByTestId('diff-legend')).toContainText('聞き取りに差');
		await expect(page.getByTestId('diff-legend')).toContainText('未読');
	});

	test('passing score plays celebration-pop and announces 合格', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });

		await expect(page.getByTestId('score')).toHaveClass(/celebrate/);
		await expect(page.locator('p.sr-only[aria-live="polite"]', { hasText: '合格' })).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// T13: Push-to-talk (hold to record)
// ---------------------------------------------------------------------------

/**
 * Hold Space until the recorder has been running for ≥ 700ms (measured by
 * the on-screen timer, not wall clock), then release → the flow transcribes.
 */
async function holdAndRelease(page: Page): Promise<void> {
	await page.keyboard.down('Space');
	await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
	await page.waitForFunction(() => {
		const m = document
			.querySelector('[data-testid="recording-timer"]')
			?.textContent?.match(/(\d+\.\d+)/);
		return m ? parseFloat(m[1]) >= 0.7 : false;
	});
	await page.keyboard.up('Space');
}

test.describe('Practice — T13 push-to-talk', () => {
	test('TTS end leaves the ready state; recording only starts on Space hold', async ({
		page
	}) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。', delayMs: 1000 }] });

		// Ready state after TTS — NO automatic recording anymore.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('record-ready')).toContainText('Spaceを押しながら読み上げてね');
		await expect(page.getByTestId('record-hold-btn')).toBeVisible();
		await expect(page.getByTestId('sentence-recording')).toHaveCount(0);
	});

	test('Space hold records; a 5s hold is never silence-stopped; release transcribes', async ({
		page
	}) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。', delayMs: 1000 }] });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		// autoStop: false — sustained silence must NOT end the recording.
		await page.waitForTimeout(5_000);
		await expect(page.getByTestId('sentence-recording')).toBeVisible();
		const timerText = (await page.getByTestId('recording-timer').textContent()) ?? '';
		const elapsed = parseFloat(timerText.match(/(\d+\.\d+)/)?.[1] ?? '0');
		expect(elapsed).toBeGreaterThanOrEqual(4.5);

		await page.keyboard.up('Space');
		await expect(page.getByTestId('sentence-transcribing')).toBeVisible({ timeout: 5000 });
	});

	test('on-screen hold button records on mouse down and stops on mouse up', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。', delayMs: 1000 }] });
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await page.getByTestId('record-hold-btn').hover();
		await page.mouse.down();
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(700);
		await page.mouse.up();

		await expect(page.getByTestId('sentence-transcribing')).toBeVisible({ timeout: 5000 });
	});

	test('press shorter than 500ms shows the longer-press hint and never scores', async ({
		page
	}) => {
		let transcribeCalls = 0;
		await seedPractice(page);
		await mockTts(page);
		await page.route('**/api/transcribe', async (route) => {
			transcribeCalls++;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ text: 'おはようございます。' })
			});
		});
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.waitForTimeout(150);
		await page.keyboard.up('Space');

		// Back to ready with the hint — no transcription was requested.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('short-press-hint')).toBeVisible();
		await expect(page.getByTestId('sentence-transcribing')).toHaveCount(0);
		await page.waitForTimeout(500);
		expect(transcribeCalls).toBe(0);
	});

	test('kbd hints render on the action buttons', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }] });

		// Show phase: replay carries [R]
		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await expect(page.getByTestId('replay-btn')).toContainText('R');

		// Ready phase: hold button [Space], skip [S]. 終了 is an icon-only button,
		// so the Esc hint no longer renders — the accessible name carries it instead.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('record-hold-btn')).toContainText('Space');
		await expect(page.getByTestId('skip-btn')).toContainText('S');
		await expect(page.getByTestId('stop-btn')).toHaveAttribute('aria-label', '終了');
		await expect(page.getByTestId('stop-btn').locator('kbd')).toHaveCount(0);
	});
});

/** Press at the centre of `testId`, hold, drag a short distance in small steps,
 *  then report how many selection ranges the gesture produced.
 *
 *  The mouse path is the one that discriminates: Chromium's CDP touch path
 *  (`Input.dispatchTouchEvent`) never seeds a range in this headless build — not
 *  even on plainly selectable text — so a touch-based check is always 0 and
 *  proves nothing. See AGENTS.md 「既知の落とし穴」. */
async function longPressDragRangeCount(page: Page, testId: string): Promise<number> {
	const box = await page.getByTestId(testId).boundingBox();
	if (!box) throw new Error(`${testId} has no bounding box`);
	const startX = box.x + box.width / 2;
	const startY = box.y + box.height / 2;

	// Drop any range a previous gesture left behind, otherwise the next reading
	// would just report that stale range.
	await page.evaluate(() => document.getSelection()?.removeAllRanges());

	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.waitForTimeout(700);
	for (let step = 1; step <= 4; step++) {
		await page.mouse.move(startX + step * 10, startY);
	}
	const rangeCount = await page.evaluate(() => document.getSelection()?.rangeCount ?? 0);
	await page.mouse.up();
	return rangeCount;
}

// ---------------------------------------------------------------------------
// Long-press text selection: the record controls must not start a selection.
// On a real device a 1.2s hold plus a small finger drift expands the range into
// visible text selection with Android's selection handles, which competes with
// the press. The gesture is reproduced with a mouse long press + drag, which
// Chromium does honour (unlike the CDP touch path — see longPressDragRangeCount).
// ---------------------------------------------------------------------------

test.describe('Practice — text selection is suppressed on the record controls', () => {
	test('the hold button and the action zone refuse text selection', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

		// `user-select` is the only one of the three declarations Chromium can
		// compute: `-webkit-touch-callout` is dropped by Chromium's CSS parser, so
		// it is unverifiable here and exists for iOS Safari. See task-1-report.md.
		for (const id of ['record-hold-btn', 'action-zone']) {
			const userSelect = await page
				.getByTestId(id)
				.evaluate((el) => getComputedStyle(el).userSelect);
			expect(userSelect, `${id}: user-select`).toBe('none');
		}
	});

	test('sentence text and diff tokens stay selectable', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('sentence-text')).toBeVisible();

		// The suppression is scoped to the record controls; the sentence itself
		// must remain copyable.
		const userSelect = await page
			.getByTestId('sentence-text')
			.evaluate((el) => getComputedStyle(el).userSelect);
		expect(userSelect).not.toBe('none');
	});

	test('a long press with a drag selects nothing on the record controls', async ({ page }) => {
		await seedPractice(page);
		await mockTts(page);
		await page.goto('/practice?chapter=ch-ja-01');
		await expect(page.getByTestId('sentence-text')).toBeVisible();

		// Positive control: the very same gesture over the sentence does select,
		// so the 0s asserted below can only come from the suppression and not
		// from a gesture that never selects anything in this browser.
		const sentence = await longPressDragRangeCount(page, 'sentence-text');
		expect(
			sentence,
			'sentence-text: selection ranges after a long press + drag'
		).toBeGreaterThanOrEqual(1);

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId('record-ready-hint')).toBeVisible();

		// `record-ready-hint` is plain prose inside the action zone rather than a
		// <button>, so its selectability is governed by `.action-zone` alone. It is
		// the case that goes red if the `user-select: none` declaration is dropped.
		const hintRanges = await longPressDragRangeCount(page, 'record-ready-hint');
		expect(hintRanges, 'record-ready-hint: selection ranges after a long press + drag').toBe(
			0
		);

		// `action-zone` and `record-hold-btn` are deliberately NOT probed with the
		// gesture: Chromium refuses to select inside a <button> widget whatever the CSS
		// says, so their rc=0 would hold even with the declarations removed. The
		// computed `user-select` test above is what guards their CSS. Keeping the
		// gesture checks would also drag in two full scoring runs (real /api/transcribe
		// and /api/judge calls, a reload race against the restore dialog, and a
		// user-activation hack for TTS autoplay) for zero regression value.
	});
});

// ---------------------------------------------------------------------------
// T6: Summary normalization
// ---------------------------------------------------------------------------

test.describe('Practice — T6 summary', () => {
	test('full completion: title 練習完了! and 完了文数 n / n', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		// No dwell — the single-sentence session ends on 次へ.
		await page.getByTestId('next-btn').click();
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });

		await expect(page.getByTestId('summary-title')).toHaveText('練習完了!');
		await expect(page.getByTestId('summary-completed')).toHaveText('1 / 1');
		await expect(page.getByTestId('summary-sentences')).toHaveText('1');
	});

	test('early stop: title おつかれさま! and 完了文数 0 / 1', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }] });

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-btn').click();
		await page.getByTestId('confirm-end-btn').click();
		await expect(page.getByTestId('summary')).toBeVisible();

		await expect(page.getByTestId('summary-title')).toHaveText('おつかれさま!');
		await expect(page.getByTestId('summary-completed')).toHaveText('0 / 1');
	});

	test('failed list + 間違えた文だけやり直す restarts with only the failed sentences', async ({
		page
	}) => {
		await setupPractice(page, {
			settings: { threshold: 100 },
			transcribe: [{ text: 'ぜんぜんちがう' }],
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});

		// Sentence 1 fails → skip. Sentence 2 fails → stop (both stay unpassed).
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/fail/, { timeout: 15000 });
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/fail/, { timeout: 15000 });
		await page.getByTestId('stop-btn').click();
		await page.getByTestId('confirm-end-btn').click();

		await expect(page.getByTestId('summary')).toBeVisible();
		await expect(page.getByTestId('summary-title')).toHaveText('おつかれさま!');
		await expect(page.getByTestId('summary-completed')).toHaveText('0 / 2');
		await expect(page.getByTestId('summary-failed-item')).toHaveCount(2);
		await expect(page.getByTestId('summary-sentences')).toHaveText('2');

		await page.getByTestId('retry-failed-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('progress')).toHaveText('1 / 2');
	});
});

// ---------------------------------------------------------------------------
// T9: Session restore (sessionStorage oboeru:progress:v1)
// ---------------------------------------------------------------------------

test.describe('Practice — T9 restore', () => {
	const THREE_SENTENCES: SeedSentence[] = [
		{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
		{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 },
		{ id: 'ja-03', chapterId: 'ch-ja-01', text: 'さようなら。', language: 'ja', order: 3 }
	];

	test('reload at sentence 2 of 3 → restore dialog → 続ける resumes at 2 / 3', async ({
		page
	}) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }], sentences: THREE_SENTENCES });

		// Move to sentence 2 to lay down a mid-session snapshot.
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
		await expect(page.getByTestId('progress')).toHaveText('2 / 3');

		await page.reload();

		await expect(page.getByTestId('restore-dialog')).toBeVisible();
		await expect(page.getByTestId('restore-dialog')).toContainText('前回の続きから再開しますか?');

		await page.getByTestId('resume-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
		await expect(page.getByTestId('progress')).toHaveText('2 / 3');
	});

	test('restore dialog → 最初から restarts at 1 / 3', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }], sentences: THREE_SENTENCES });

		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await page.getByTestId('skip-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');

		await page.reload();
		await expect(page.getByTestId('restore-dialog')).toBeVisible();

		await page.getByTestId('start-over-btn').click();
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('progress')).toHaveText('1 / 3');
	});

	test('no dialog on a fresh session without saved progress', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'x' }], sentences: THREE_SENTENCES });

		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('restore-dialog')).toHaveCount(0);
	});
});

// ---------------------------------------------------------------------------
// No auto-advance: the feedback phase persists until the user acts
// ---------------------------------------------------------------------------

test.describe('Practice — no auto-advance', () => {
	test('passing feedback does not auto-advance; Space advances manually', async ({ page }) => {
		await seedPractice(page, {
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'おはようございます。' }]);
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });

		// Time alone never advances: after 2.5s the feedback must still be up.
		await page.waitForTimeout(2500);
		await expect(page.getByTestId('feedback')).toBeVisible();
		await expect(page.getByTestId('sentence-text')).toHaveCount(0);

		await page.keyboard.press(' ');
		await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。', { timeout: 2000 });
	});
});

// ---------------------------------------------------------------------------
// Recording phase: skip is blocked (the action zone is always visible, so a
// mis-tap during recording would otherwise discard the take).
// ---------------------------------------------------------------------------

test.describe('Practice — skip is disabled while recording', () => {
	test('skip button is disabled and S does not skip during recording', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。' }],
			sentences: [
				{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
				{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 }
			]
		});

		// AGENTS.md の E2E 規約: the FIRST Space keydown must be preceded by a
		// visible record-ready wait, otherwise the keydown fires before hydration
		// attaches the document listener and is silently lost.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await page.keyboard.down('Space');
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		await expect(page.getByTestId('skip-btn')).toBeDisabled();

		const before = await page.getByTestId('progress').textContent();
		await page.keyboard.press('s');
		await page.waitForTimeout(500);
		expect(await page.getByTestId('progress').textContent()).toBe(before);
		await expect(page.getByTestId('sentence-recording')).toBeVisible();

		await page.keyboard.up('Space');
	});
});

// ---------------------------------------------------------------------------
// Jev semantic judge (低類似度の救済判定)
//
// スコアリングペア: 「こんにちは。」 vs 「ぜんぜんちがう」 → 類似度 29
// (e2e-full の 76% 平均アサーションで実証済みの決定論的ペア)。
// ---------------------------------------------------------------------------

const JUDGE_SEED: SeedSentence[] = [
	{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 1 }
];

test.describe('Practice — Jev judge', () => {
	test('rescue: noul boost flips a low-similarity fail into a pass', async ({ page }) => {
		await seedPractice(page, { sentences: JUDGE_SEED });
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'ぜんぜんちがう' }]);
		await mockJudge(page, [
			{ available: true, noul: 0.95, category: 'orthography_variant', confidence: 0.9 }
		]);
		await page.goto('/practice?chapter=ch-ja-01');

		// sim 29 (< 80) → judge is consulted → max(29, round(0.95*100)) = 95
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveText('95%');
	});

	test('fallback: judge unavailable keeps the similarity score and fails', async ({ page }) => {
		await seedPractice(page, { sentences: JUDGE_SEED });
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'ぜんぜんちがう' }]);
		await mockJudge(page, [{ available: false }]);
		await page.goto('/practice?chapter=ch-ja-01');

		// sim 29 stays 29 — no boost without an available judge.
		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/fail/, { timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveText('29%');
	});

	test('no-call: a passing similarity never consults the judge', async ({ page }) => {
		await seedPractice(page, { sentences: JUDGE_SEED });
		await mockTts(page);
		await mockTranscribe(page, [{ text: 'こんにちは。' }]);
		const judge = await mockJudge(page, [{ available: true, noul: 0.95 }]);
		await page.goto('/practice?chapter=ch-ja-01');

		await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
		await holdAndRelease(page);
		await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveText('100%');
		expect(judge.count()).toBe(0);
	});
});
