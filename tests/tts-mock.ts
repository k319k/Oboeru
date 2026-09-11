import type { Page } from '@playwright/test';

/**
 * Build a tiny valid silent WAV (PCM mono 16-bit). Plays instantly in
 * Chromium so the practice flow sees fast 'ended' — no API key needed.
 */
export function silentWavBytes(durationMs = 80, sampleRate = 8000): Buffer {
	const numSamples = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
	const dataSize = numSamples * 2;
	const buf = Buffer.alloc(44 + dataSize);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + dataSize, 4);
	buf.write('WAVE', 8);
	buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(dataSize, 40);
	return buf; // remaining bytes are zero = silence
}

export interface TtsMock {
	/** Number of POST /api/tts requests served so far. */
	count: () => number;
}

/** Intercept POST /api/tts and return a tiny silent WAV. */
export async function mockTtsApi(page: Page): Promise<TtsMock> {
	let calls = 0;
	await page.route('**/api/tts', async (route) => {
		calls++;
		await route.fulfill({
			status: 200,
			contentType: 'audio/wav',
			body: silentWavBytes(80)
		});
	});
	return { count: () => calls };
}
