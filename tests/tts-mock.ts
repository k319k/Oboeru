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

/**
 * Build a continuous LOUD sine WAV (PCM mono 16-bit), same 44-byte header shape
 * as `silentWavBytes`. Fed to Chromium via
 * `--use-file-for-fake-audio-capture=<path>`, it makes every recorded level
 * sample saturate, so a test can assert on the loud end of the range without
 * depending on the bursty built-in fake beep (1 loud beep per 500ms, which a
 * throttled parallel worker can miss entirely).
 *
 * Amplitude and frequency are fixed constants on purpose — a varying tone would
 * make the resulting bar heights non-deterministic.
 */
export function loudWavBytes(
	durationMs = 10000,
	sampleRate = 48000,
	amplitude = 30000,
	frequencyHz = 440
): Buffer {
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
	for (let i = 0; i < numSamples; i++) {
		const sample = Math.round(amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
		buf.writeInt16LE(sample, 44 + i * 2);
	}
	return buf;
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
