/**
 * Headerless PCM → RIFF/WAV, plus the Content-Type parser for OpenRouter's
 * `audio/pcm;rate=…;channels=…` response header.
 *
 * Browser-safe by contract: `DataView` + `Uint8Array` only, no `Buffer`.
 * `src/lib/tts.ts` imports this module directly, and `src/routes/+layout.svelte`
 * imports `src/lib/tts.ts`, so this reaches the browser bundle. `tts-cache.ts`
 * does NOT import it — the two are independent; the header is added on the
 * server (`api/tts`) and on playback (`tts.ts`), never in the cache.
 */

export const DEFAULT_SAMPLE_RATE = 24000;
export const DEFAULT_CHANNELS = 1;

export interface PcmFormat {
	sampleRate: number;
	channels: number;
}

/**
 * Read `rate` / `channels` out of a PCM Content-Type header. Parameter order is
 * not guaranteed, and either parameter may be absent, so parse per-field with
 * a default rather than relying on a positional regex. A non-numeric value
 * falls back too — writing NaN into the WAV header makes browsers refuse to
 * decode, which means silence rather than a fallback.
 */
export function parsePcmContentType(contentType: string | null): PcmFormat {
	const format: PcmFormat = {
		sampleRate: DEFAULT_SAMPLE_RATE,
		channels: DEFAULT_CHANNELS,
	};
	if (!contentType) return format;
	for (const param of contentType.split(';').slice(1)) {
		const eq = param.indexOf('=');
		if (eq < 0) continue;
		const key = param.slice(0, eq).trim().toLowerCase();
		const value = Number(param.slice(eq + 1).trim());
		if (!Number.isFinite(value) || value <= 0) continue;
		if (key === 'rate') format.sampleRate = value;
		else if (key === 'channels') format.channels = Math.trunc(value);
	}
	return format;
}

/** Prepend a canonical 44-byte RIFF header to a 16-bit PCM payload. */
export function pcmToWav(
	pcm: Uint8Array,
	sampleRate: number,
	channels: number
): Uint8Array {
	const bytesPerSample = 2;
	const blockAlign = channels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const dataSize = pcm.length;

	const out = new Uint8Array(44 + dataSize);
	const view = new DataView(out.buffer);

	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
	};

	writeAscii(0, 'RIFF');
	view.setUint32(4, out.length - 8, true);
	writeAscii(8, 'WAVE');
	writeAscii(12, 'fmt ');
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // audioFormat = PCM
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true); // bitsPerSample
	writeAscii(36, 'data');
	view.setUint32(40, dataSize, true);
	out.set(pcm, 44);

	return out;
}
