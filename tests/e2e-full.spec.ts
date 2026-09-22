import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mockTtsApi } from './tts-mock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oboeru:v1';
const SETTINGS_KEY = 'oboeru:settings:v1';

// ---------------------------------------------------------------------------
// Fixed seed data (deterministic per test — independent contexts)
// ---------------------------------------------------------------------------

const seed = {
	chapters: [
		{ id: 'ch-ja-01', name: 'はじめの一歩（日本語）', parentId: null, order: 1 },
		{ id: 'ch-en-01', name: 'First Steps（English）', parentId: null, order: 2 }
	],
	sentences: [
		{ id: 'ja-01', chapterId: 'ch-ja-01', text: 'おはようございます。', language: 'ja', order: 1 },
		{ id: 'ja-02', chapterId: 'ch-ja-01', text: 'こんにちは。', language: 'ja', order: 2 },
		{ id: 'en-01', chapterId: 'ch-en-01', text: 'Good morning.', language: 'en', order: 1 }
	]
};

const settings = {
	threshold: 80,
	ttsRate: 1.0,
	voiceURI: null,
	retryFrom: 'tts'
};

// ---------------------------------------------------------------------------
// Helpers (patterns reused from practice.spec.ts / io-settings.spec.ts)
// ---------------------------------------------------------------------------

/**
 * Seed localStorage via addInitScript. Seeds CONDITIONALLY so that data
 * persisted during the test (e.g. manage round-trip) survives later
 * navigations — addInitScript re-runs on every navigation.
 */
async function seedFull(page: Page): Promise<void> {
	await page.addInitScript(
		({ storageKey, settingsKey, chapters, sentences, settings }) => {
			if (!localStorage.getItem(storageKey)) {
				localStorage.setItem(storageKey, JSON.stringify({ chapters, sentences }));
			}
			if (!localStorage.getItem(settingsKey)) {
				localStorage.setItem(settingsKey, JSON.stringify(settings));
			}
		},
		{ storageKey: STORAGE_KEY, settingsKey: SETTINGS_KEY, ...seed, settings }
	);
}

/** Mock the TTS API (/api/tts) so speak() advances via real audio playback. */
async function mockTts(page: Page): Promise<void> {
	await mockTtsApi(page);
}

interface TranscribeResponse {
	status?: number;
	text?: string;
	delayMs?: number;
	headers?: Record<string, string>;
}

/** Mock /api/transcribe. Queue of responses; the last entry repeats. */
async function mockTranscribe(page: Page, responses: TranscribeResponse[]): Promise<void> {
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

/** Mock /api/judge with the key-less fallback so behavior is key-independent. */
async function mockJudgeFallback(page: Page): Promise<void> {
	await page.route('**/api/judge', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ available: false })
		});
	});
}

/** Hold Space past the 500ms short-tap guard (timer-measured ≥ 0.7s), then release. */
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

// ---------------------------------------------------------------------------
// Full flow: seed → top → practice complete → manage round-trip → top
// ---------------------------------------------------------------------------

test('full flow: seed → top → practice complete → manage round-trip → top', async ({
	page
}) => {
	// T13 プッシュトゥトーク: ホールド中のみ録音(fake-media はトーン音で無音停止は発火しない)
	await seedFull(page);
	await mockTts(page);
	await mockJudgeFallback(page);
	// Sentence 1: pass. Sentence 2: fail → retry → pass. Last entry repeats.
	await mockTranscribe(page, [
		{ text: 'おはようございます。' },
		{ text: 'ぜんぜんちがう' },
		{ text: 'こんにちは。' }
	]);

	// --- TOP: seed data listed, one-tap start from the chapter card ---
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'おぼえる' })).toBeVisible();
	await expect(page.getByText('はじめの一歩（日本語）')).toBeVisible();

	const jaCard = page.getByTestId('chapter-card').filter({ hasText: 'はじめの一歩（日本語）' });
	await jaCard.getByTestId('card-start').click();
	await page.waitForURL('**/practice?chapter=ch-ja-01');

	// --- PRACTICE: sentence 1 passes (hold → release → transcribe) ---
	await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
	await holdAndRelease(page);
	await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });
	await expect(page.getByTestId('score')).toHaveClass(/pass/);
	await expect(page.getByTestId('score')).toHaveText('100%');

	// --- PRACTICE: sentence 2 fails once, then passes on retry ---
	await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。', {
		timeout: 10000
	});
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
	await holdAndRelease(page);
	await expect(page.getByTestId('score')).toHaveClass(/fail/, { timeout: 15000 });
	// Retry: tts → ready → hold → release → pass
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
	await holdAndRelease(page);
	await expect(page.getByTestId('score')).toHaveClass(/pass/, { timeout: 15000 });

	// --- SUMMARY: stats reflect 2 sentences, 1 skip-free, 1 fail + 1 pass retry ---
	await expect(page.getByTestId('summary')).toBeVisible({ timeout: 10000 });
	await expect(page.getByTestId('summary-sentences')).toHaveText('2');
	await expect(page.getByTestId('summary-skipped')).toHaveText('0');
	// totalScore = 100 (pass) + 29 (fail: こんにちは vs ぜんぜんちがう, dist 5/7)
	// + 100 (retry pass) = 229 over 3 scored attempts → round(76.33) = 76
	await expect(page.getByTestId('summary-average')).toHaveText('76%');

	// --- MANAGE ROUND-TRIP: create chapter + sentence, both visible ---
	await page.getByTestId('home-link').click();
	await page.waitForURL('**/');
	await page.getByRole('link', { name: '管理', exact: true }).click();
	await page.waitForURL('**/manage');
	await page.waitForSelector('[data-testid="chapter-name"]', { timeout: 10000 });

	await page.getByTestId('add-root-chapter').click();
	await page.getByTestId('new-chapter-name').fill('E2Eチャプター');
	await page.getByTestId('confirm-add-chapter').click();
	await expect(
		page.getByTestId('chapter-name').filter({ hasText: 'E2Eチャプター' })
	).toBeVisible();

	// The new chapter's ID is generated by the store — select it via the shadcn Select.
	// Sentences live in the 文章 tab.
	await page.getByRole('tab', { name: '文章' }).click();
	await page.getByTestId('add-sentence').click();
	await page.getByTestId('new-sentence-chapter').click();
	await page.getByRole('option', { name: 'E2Eチャプター' }).click();
	await page.getByTestId('new-sentence-text').fill('E2Eの文章です。');
	await page.getByTestId('new-sentence-lang').click();
	await page.getByRole('option', { name: '日本語' }).click();
	await page.getByTestId('confirm-add-sentence').click();
	await expect(
		page.getByTestId('sentence-text').filter({ hasText: 'E2Eの文章です。' })
	).toBeVisible();

	// --- BACK TO TOP: created chapter (with its sentence) is listed ---
	await page.getByRole('link', { name: 'おぼえる' }).click();
	await page.waitForURL('**/');
	await expect(page.getByText('E2Eチャプター')).toBeVisible();
	// Cross-page state: the created sentence counts toward the new chapter
	const e2eChapter = page.getByTestId('chapter-card').filter({ hasText: 'E2Eチャプター' });
	await expect(e2eChapter).toContainText('1文');
});

// ---------------------------------------------------------------------------
// TTS end-event transition (audio content is NOT asserted)
// ---------------------------------------------------------------------------

test('TTS end event fires: show → tts → hidden(ready) → hold → transcribing', async ({ page }) => {
	// T13 プッシュトゥトーク: TTS 終了後は録音準備完了で待機し、ホールドで録音
	await seedFull(page);
	await mockTts(page);
	await mockJudgeFallback(page);
	await mockTranscribe(page, [{ text: 'おはようございます。', delayMs: 1000 }]);

	await page.goto('/practice?chapter=ch-ja-01');

	// Show phase: sentence visible
	await expect(page.getByTestId('sentence-text')).toBeVisible();

	// After the show dwell + TTS end event (50ms mock), the text hides and
	// the ready state waits for a push. This verifies the end-event
	// transition without asserting on any audio content.
	await expect(page.getByTestId('sentence-text')).toBeHidden({ timeout: 5000 });
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });

	// Hold → release → transcribing (mock has delayMs: 1000 so it stays visible)
	await holdAndRelease(page);
	await expect(page.getByTestId('sentence-transcribing')).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// Failure case: API down (500 from /api/transcribe)
// ---------------------------------------------------------------------------

test('API down (500): error UI shown, sentence hidden, skip/stop still work', async ({
	page
}) => {
	// T13 プッシュトゥトーク: ホールド中のみ録音
	await seedFull(page);
	await mockTts(page);
	await mockJudgeFallback(page);
	await mockTranscribe(page, [{ status: 500 }]);

	await page.goto('/practice?chapter=ch-ja-01');

	// Hold → release → transcribe 500 → error feedback
	await expect(page.getByTestId('sentence-text')).toHaveText('おはようございます。');
	await expect(page.getByTestId('record-ready')).toBeVisible({ timeout: 5000 });
	await holdAndRelease(page);
	await expect(page.getByTestId('error-message')).toBeVisible({ timeout: 10000 });
	await expect(page.getByTestId('error-message')).toContainText('文字起こしエラー');
	// Sentence stays hidden in the error feedback view
	await expect(page.getByTestId('sentence-text')).toBeHidden();

	// Skip still works → advances to sentence 2
	await page.getByTestId('skip-btn').click();
	await expect(page.getByTestId('sentence-text')).toHaveText('こんにちは。');
	await expect(page.getByTestId('progress')).toHaveText('2 / 2');

	// Stop still works → end dialog → confirm → summary with the skipped count
	await page.getByTestId('stop-btn').click();
	await expect(page.getByRole('alertdialog')).toBeVisible();
	await page.getByTestId('confirm-end-btn').click();
	await expect(page.getByTestId('summary')).toBeVisible();
	await expect(page.getByTestId('summary-skipped')).toHaveText('1');
});

// ---------------------------------------------------------------------------
// Live STT integration (exactly ONE live test; skipped without GROQ_API_KEY)
// ---------------------------------------------------------------------------

test('live STT: POST /api/transcribe with sample.wav returns {text} shape', async ({
	request
}) => {
	test.skip(
		!process.env.GROQ_API_KEY,
		'GROQ_API_KEY not set - live STT skipped (fixture contract test recorded in evidence instead)'
	);

	const wavPath = fileURLToPath(new URL('./fixtures/sample.wav', import.meta.url));
	const wavBuffer = readFileSync(wavPath);

	const res = await request.post('/api/transcribe', {
		multipart: {
			file: { name: 'sample.wav', mimeType: 'audio/wav', buffer: wavBuffer },
			language: 'ja'
		}
	});

	expect(res.ok()).toBeTruthy();
	const data = await res.json();
	// Shape only — never assert on the transcribed content.
	expect(data).toHaveProperty('text');
	expect(typeof data.text).toBe('string');
});