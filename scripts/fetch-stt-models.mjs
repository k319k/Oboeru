#!/usr/bin/env node
/**
 * Download the official Vosk small model archives into .stt-models/ (repo
 * root, git-ignored — NEVER static/, Cloudflare Workers caps static assets
 * at 25 MiB per file which would break `wrangler deploy`).
 *
 * The archives stay as the official .zip files: vosk-browser extracts them
 * in its worker with libarchive configured via archive_read_support_format_all
 * (upstream src/utils.cc), which reads zip directly. No conversion needed.
 *
 * Usage: npm run stt:fetch
 */
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODELS = [
	{
		name: 'vosk-model-small-ja-0.22',
		url: 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip'
	},
	{
		name: 'vosk-model-small-en-us-0.15',
		url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip'
	}
];

const OUT_DIR = path.resolve(import.meta.dirname, '..', '.stt-models');

await mkdir(OUT_DIR, { recursive: true });

let failures = 0;
for (const model of MODELS) {
	const outPath = path.join(OUT_DIR, `${model.name}.zip`);
	if (existsSync(outPath) && (await stat(outPath)).size > 0) {
		console.log(`skip (already downloaded): ${outPath}`);
		continue;
	}
	console.log(`downloading ${model.url}`);
	try {
		const response = await fetch(model.url);
		if (!response.ok || !response.body) {
			throw new Error(`HTTP ${response.status}`);
		}
		await pipeline(Readable.fromWeb(response.body), createWriteStream(outPath));
		const { size } = await stat(outPath);
		console.log(`saved: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
	} catch (error) {
		failures++;
		console.error(`failed: ${model.name}: ${error.message}`);
		await unlink(outPath).catch(() => {});
	}
}

process.exit(failures > 0 ? 1 : 0);
