import { describe, it, expect } from 'vitest';
import {
	parsePcmContentType,
	pcmToWav,
	DEFAULT_SAMPLE_RATE,
	DEFAULT_CHANNELS,
} from './pcm-wav';

function wavField(bytes: Uint8Array, offset: number, size: 1 | 2 | 4): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (size === 1) return view.getUint8(offset);
	if (size === 2) return view.getUint16(offset, true);
	return view.getUint32(offset, true);
}

describe('parsePcmContentType', () => {
	it('returns defaults for null', () => {
		expect(parsePcmContentType(null)).toEqual({
			sampleRate: DEFAULT_SAMPLE_RATE,
			channels: DEFAULT_CHANNELS,
		});
	});

	it('returns defaults for a bare audio/pcm with no parameters', () => {
		expect(parsePcmContentType('audio/pcm')).toEqual({
			sampleRate: DEFAULT_SAMPLE_RATE,
			channels: DEFAULT_CHANNELS,
		});
	});

	it('parses the observed OpenRouter header', () => {
		expect(parsePcmContentType('audio/pcm;rate=24000;channels=1')).toEqual({
			sampleRate: 24000,
			channels: 1,
		});
	});

	it('is order independent (channels before rate)', () => {
		expect(parsePcmContentType('audio/pcm;channels=2;rate=16000')).toEqual({
			sampleRate: 16000,
			channels: 2,
		});
	});

	it('falls back per-field when one parameter is missing', () => {
		expect(parsePcmContentType('audio/pcm;rate=16000')).toEqual({
			sampleRate: 16000,
			channels: DEFAULT_CHANNELS,
		});
		expect(parsePcmContentType('audio/pcm;channels=2')).toEqual({
			sampleRate: DEFAULT_SAMPLE_RATE,
			channels: 2,
		});
	});

	it('falls back per-field when a value is not a number', () => {
		expect(parsePcmContentType('audio/pcm;rate=abc;channels=2')).toEqual({
			sampleRate: DEFAULT_SAMPLE_RATE,
			channels: 2,
		});
	});
});

describe('pcmToWav', () => {
	it('writes a canonical 44-byte RIFF header for mono 16-bit', () => {
		const pcm = new Uint8Array(8);
		const wav = pcmToWav(pcm, 24000, 1);
		expect(wav.length).toBe(44 + 8);
		expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
		expect(wavField(wav, 4, 4)).toBe(wav.length - 8);
		expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
		expect(String.fromCharCode(...wav.slice(12, 16))).toBe('fmt ');
		expect(wavField(wav, 16, 4)).toBe(16);
		expect(wavField(wav, 20, 2)).toBe(1); // PCM
		expect(wavField(wav, 22, 2)).toBe(1); // mono
		expect(wavField(wav, 24, 4)).toBe(24000);
		expect(wavField(wav, 28, 4)).toBe(48000); // byteRate = 24000 * 1 * 2
		expect(wavField(wav, 32, 2)).toBe(2); // blockAlign = 1 * 2
		expect(wavField(wav, 34, 2)).toBe(16); // bitsPerSample
		expect(String.fromCharCode(...wav.slice(36, 40))).toBe('data');
		expect(wavField(wav, 40, 4)).toBe(8);
	});

	it('computes byteRate and blockAlign for stereo', () => {
		const wav = pcmToWav(new Uint8Array(16), 16000, 2);
		expect(wavField(wav, 22, 2)).toBe(2);
		expect(wavField(wav, 28, 4)).toBe(16000 * 2 * 2);
		expect(wavField(wav, 32, 2)).toBe(4);
	});

	it('copies the PCM payload verbatim into the data chunk', () => {
		const wav = pcmToWav(new Uint8Array([1, 2, 3, 250, 251, 252]), 24000, 1);
		expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 250, 251, 252]);
	});
});
