/**
 * Generate a 1-second silent WAV file for testing.
 * PCM, 16-bit, 44100 Hz, mono.
 * Uses only Node.js built-ins.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'tests', 'fixtures');
const outPath = join(outDir, 'sample.wav');

mkdirSync(outDir, { recursive: true });

const sampleRate = 44100;
const numChannels = 1;
const bitsPerSample = 16;
const durationSec = 1;
const dataSize = sampleRate * numChannels * (bitsPerSample / 8) * durationSec; // 88200

// WAV header (44 bytes)
const buf = Buffer.alloc(44 + dataSize);

// RIFF chunk
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataSize, 4); // chunk size
buf.write('WAVE', 8);

// fmt sub-chunk
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); // sub-chunk size
buf.writeUInt16LE(1, 20); // PCM format
buf.writeUInt16LE(numChannels, 22);
buf.writeUInt32LE(sampleRate, 24);
buf.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28); // byte rate
buf.writeUInt16LE(numChannels * (bitsPerSample / 8), 32); // block align
buf.writeUInt16LE(bitsPerSample, 34);

// data sub-chunk
buf.write('data', 36);
buf.writeUInt32LE(dataSize, 40);
// rest is zeros (silence)

writeFileSync(outPath, buf);
console.log(`Wrote ${buf.length} bytes to ${outPath}`);
