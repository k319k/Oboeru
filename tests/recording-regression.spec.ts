import { test, expect, type Page } from '@playwright/test';
import { mockTtsApi } from './tts-mock';

// ---------------------------------------------------------------------------
// Component-level regression test for the "recording stops immediately" bug.
//
// WHY Playwright + module interception instead of a vitest component test:
// the repo has no component-test infrastructure (@testing-library/svelte /
// jsdom are not installed, and the plan's dependency guardrail only allows
// @axe-core/playwright). Intercepting the Vite-served /src/lib/recorder.ts
// module lets us mock `startRecording` exactly as the plan specifies while
// exercising the REAL practice/+page.svelte wiring — the actual bug location
// (recorder.ts itself never stopped immediately; the component called
// rec.stop() right after creation).
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oboeru:v1';
const SETTINGS_KEY = 'oboeru:settings:v1';

const MOCK_RECORDER_MODULE = `
  const state = { stopCalls: 0, createdAt: 0, stopCalledAt: null, stopped: false };
  window.__recorderMock = state;

  export async function startRecording() {
    state.createdAt = Date.now();
    let resolveCompleted;
    const completed = new Promise((resolve) => { resolveCompleted = resolve; });
    return {
      stop: async () => {
        // Idempotent like the real recorder (recorder.state === 'recording'
        // guard): only the FIRST call stops. The component's $effect cleanup
        // calls stop() again when leaving the recording phase — that must
        // not count as a second stop.
        if (!state.stopped) {
          state.stopped = true;
          state.stopCalls++;
          state.stopCalledAt = Date.now();
          resolveCompleted(new Blob(['mock-audio'], { type: 'audio/webm' }));
        }
        return completed;
      },
      completed,
      onProgress: undefined
    };
  }
  export function isSilent() { return false; }
  export function selectMime() { return null; }
`;

async function seedAndMock(page: Page): Promise<void> {
	await page.addInitScript(
		({ storageKey, settingsKey }) => {
			localStorage.setItem(
				storageKey,
				JSON.stringify({
					chapters: [
						{ id: 'ch-ja-01', name: '日本語', parentId: null, order: 1 }
					],
					sentences: [
						{
							id: 'ja-01',
							chapterId: 'ch-ja-01',
							text: 'おはようございます。',
							language: 'ja',
							order: 1
						}
					]
				})
			);
			localStorage.setItem(
				settingsKey,
				JSON.stringify({ threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' })
			);
		},
		{ storageKey: STORAGE_KEY, settingsKey: SETTINGS_KEY }
	);

	await mockTtsApi(page);

	await page.route('**/src/lib/recorder.ts*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/javascript',
			body: MOCK_RECORDER_MODULE
		});
	});

	await page.route('**/api/transcribe', async (route) => {
		// delayMs keeps the transcribing phase visible long enough for
		// assertions (same pattern as practice.spec.ts).
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ text: 'おはようございます。' })
		});
	});
}

test('recorder is NOT stopped immediately after creation (regression)', async ({
	page
}) => {
	await seedAndMock(page);
	await page.goto('/practice?chapter=ch-ja-01');

	// Wait until the component has actually created the recorder
	// (startRecording ran — createdAt is set inside the mock function).
	await page.waitForFunction(
		() => (window as any).__recorderMock?.createdAt > 0
	);

	// Give any (buggy) immediate-stop microtask chain time to run.
	await page.waitForTimeout(300);

	// The buggy wiring called rec.stop() right after creation → stopCalls = 1.
	const state = await page.evaluate(() => (window as any).__recorderMock);
	expect(state.stopCalls).toBe(0);

	// The recording phase must be visible and stay alive.
	await expect(page.getByTestId('sentence-recording')).toBeVisible();

	// Manual stop button → stop() called exactly once → transcribing.
	await page.getByTestId('stop-recording-btn').click();
	await expect(page.getByTestId('sentence-transcribing')).toBeVisible({
		timeout: 5000
	});
	const after = await page.evaluate(() => (window as any).__recorderMock);
	expect(after.stopCalls).toBe(1);
});

// ---------------------------------------------------------------------------
// Runtime verification (plan T5 acceptance): REAL recorder + fake-media.
// fake-media produces a TONE, not silence → silence auto-stop never fires,
// so the recording continues until the manual stop button is clicked.
// ---------------------------------------------------------------------------

/** Seed + mock TTS + mock transcribe (with delay). NO recorder module mock. */
async function seedAndMockRuntime(page: Page): Promise<void> {
	await page.addInitScript(
		({ storageKey, settingsKey }) => {
			localStorage.setItem(
				storageKey,
				JSON.stringify({
					chapters: [
						{ id: 'ch-ja-01', name: '日本語', parentId: null, order: 1 }
					],
					sentences: [
						{
							id: 'ja-01',
							chapterId: 'ch-ja-01',
							text: 'おはようございます。',
							language: 'ja',
							order: 1
						}
					]
				})
			);
			localStorage.setItem(
				settingsKey,
				JSON.stringify({ threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' })
			);
		},
		{ storageKey: STORAGE_KEY, settingsKey: SETTINGS_KEY }
	);

	await mockTtsApi(page);

	await page.route('**/api/transcribe', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ text: 'おはようございます。' })
		});
	});
}

test('runtime: real recorder records ≥800ms and transcribes the blob', async ({
	page
}) => {
	await seedAndMockRuntime(page);

	let blobSize = 0;
	page.on('request', (req) => {
		if (req.url().includes('/api/transcribe') && req.method() === 'POST') {
			blobSize = req.postDataBuffer()?.length ?? 0;
		}
	});

	await page.goto('/practice?chapter=ch-ja-01');

	// Recording phase appears after show dwell (800ms) + TTS (50ms mock).
	await expect(page.getByTestId('sentence-recording')).toBeVisible({ timeout: 5000 });

	// Wait until the timer (onProgress, every 100ms) shows ≥ 0.8s.
	await page.waitForFunction(() => {
		const el = document.querySelector('[data-testid="recording-timer"]');
		if (!el?.textContent) return false;
		const m = el.textContent.match(/(\d+\.\d+)/);
		return m ? parseFloat(m[1]) >= 0.8 : false;
	});

	// Read the measured duration from the timer display.
	const timerText = (await page.getByTestId('recording-timer').textContent()) ?? '';
	const match = timerText.match(/(\d+\.\d+)/);
	const durationMs = match ? Math.round(parseFloat(match[1]) * 1000) : 0;
	console.log(`[runtime] measured recording duration: ${durationMs}ms (timer: "${timerText}")`);

	// Manual stop → flow continues: transcribing → feedback.
	await page.getByTestId('stop-recording-btn').click();
	await expect(page.getByTestId('sentence-transcribing')).toBeVisible({ timeout: 5000 });
	await expect(page.getByTestId('feedback')).toBeVisible({ timeout: 10000 });

	// The transcribe POST carried the recorded blob.
	console.log(`[runtime] transcribe blob size: ${blobSize} bytes`);
	expect(blobSize).toBeGreaterThan(0);

	// Acceptance criterion: measured recording duration ≥ 800ms.
	expect(durationMs).toBeGreaterThanOrEqual(800);
});