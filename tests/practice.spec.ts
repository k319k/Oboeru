import { test, expect, type Page } from '@playwright/test';
import { mockTtsApi, type TtsMock } from './tts-mock';

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
	text: string;
	language: 'ja' | 'en';
	order: number;
}

interface SeedOptions {
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
		({ storageKey, settingsKey, chapters, sentences, settings }) => {
			localStorage.setItem(storageKey, JSON.stringify({ chapters, sentences }));
			localStorage.setItem(settingsKey, JSON.stringify(settings));
		},
		{ storageKey: STORAGE_KEY, settingsKey: SETTINGS_KEY, chapters, sentences, settings }
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

/** Mock /api/transcribe. Queue of responses; the last entry repeats. */
async function mockTranscribe(page: Page, responses: TranscribeResponse[]) {
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
	// fake-media はトーン音声のため無音自動停止は発火しない。手動停止ボタンを基本とする(plan T5 手順4)
	test('initial show phase displays the sentence and progress', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('sentence-text')).toBeVisible();
		await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
		await expect(page.getByTestId('progress')).toHaveText('1 / 1');
	});

	test('auto-advances from show through tts to transcribing (text hidden)', async ({
		page
	}) => {
		await setupPractice(page, {
			transcribe: [{ text: 'おはようございます。', delayMs: 1000 }]
		});

		// Text visible initially (show phase)
		await expect(page.getByTestId('sentence-text')).toBeVisible();

		// After the show dwell + TTS, the text is hidden and recording starts
		await expect(page.getByTestId('sentence-text')).toBeHidden({ timeout: 5000 });
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

		// Manual stop → transcribing (mock has delayMs: 1000 so it stays visible)
		await page.getByTestId('stop-recording-btn').click();
		await expect(page.getByTestId('sentence-transcribing')).toBeVisible({
			timeout: 5000
		});
	});

	test('full pass loop: feedback with score then summary', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		// Recording phase → manual stop → transcribe → feedback
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();

		// Feedback with a passing score and the transcribed text
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/pass/);
		await expect(page.getByTestId('score')).toHaveText('100%');
		await expect(page.getByTestId('transcribed-text')).toContainText(
			'おはようございます。'
		);

		// After the correct dwell, the single-sentence session ends
		await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('summary-sentences')).toHaveText('1');
		await expect(page.getByTestId('summary-average')).toHaveText('100%');
	});

	test('fail loop: low score then retry', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'ぜんぜんちがう' }] });

		// Recording phase → manual stop → transcribe → failing feedback
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();

		// First feedback: failing score
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/fail/);

		// Retry: feedback disappears, recording restarts → manual stop again
		await expect(page.getByTestId('feedback')).toBeHidden({ timeout: 10000 });
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();
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

		// TTS plays (50ms mock) → hidden → recording — well before the 800ms show dwell
		await expect(page.getByTestId('sentence-text')).toBeHidden({ timeout: 500 });
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 500 });
	});

	test('replay button in feedback replays the sentence', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ text: 'おはようございます。' }] });

		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

		// speak count: 1 (initial tts) → click replay → 2
		await page.getByTestId('replay-btn').click();
		await expect.poll(() => ttsCallCount()).toBe(2);
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

		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();
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

		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();
		await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('score')).toHaveClass(/fail/);

		// Click もう一度試す → recording restarts well before the 2.5s fail-dwell
		await page.getByTestId('retry-btn').click();
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 500 });
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
// Transcription errors
// ---------------------------------------------------------------------------

test.describe('Practice — Transcription errors', () => {
	// fake-media はトーン音声のため無音自動停止は発火しない。手動停止ボタンを基本とする(plan T5 手順4)
	test('transcribe 500 shows error message in feedback', async ({ page }) => {
		await setupPractice(page, { transcribe: [{ status: 500 }] });

		// Recording phase → manual stop → transcribe 500 → error feedback
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();

		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
		await expect(page.getByTestId('error-message')).toContainText('文字起こしエラー');
	});

	test('transcribe 429 shows congestion message', async ({ page }) => {
		await setupPractice(page, {
			transcribe: [{ status: 429, headers: { 'retry-after': '0' } }]
		});

		// Recording phase → manual stop → transcribe 429 → congestion feedback
		await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });
		await page.getByTestId('stop-recording-btn').click();

		await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 15000 });
		await expect(page.getByTestId('error-message')).toContainText('混雑中です');
	});
});