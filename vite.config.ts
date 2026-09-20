import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { MODEL_ARCHIVE_NAMES } from './src/lib/livestt/urls';

const STT_MODEL_FILES = new Set<string>(Object.values(MODEL_ARCHIVE_NAMES));

/**
 * Dev-only: serve the STT model archives straight from .stt-models/ so live
 * STT works locally without the GitHub Release upstream (`npm run stt:upload`
 * + src/lib/livestt/urls.ts). Inert on build — the production /models/[file]
 * SvelteKit route stays authoritative (and Cloudflare Workers caps assets at
 * 25MiB, so bundling ~50MB models is not an option). Registered directly in
 * configureServer, which runs before SvelteKit's post-hook middleware.
 */
function sttModelDevServer(): Plugin {
	return {
		name: 'oboeru-stt-model-dev-server',
		apply: 'serve',
		configureServer(server) {
			const modelsDir = path.join(server.config.root, '.stt-models');
			server.middlewares.use('/models/', (req, res) => {
				const file = path.basename((req.url ?? '').split('?')[0]);
				if (!STT_MODEL_FILES.has(file)) {
					res.statusCode = 404;
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ error: 'モデルが見つかりません' }));
					return;
				}
				const stats = statSync(path.join(modelsDir, file), { throwIfNoEntry: false });
				if (!stats || !stats.isFile()) {
					res.statusCode = 503;
					res.setHeader('content-type', 'application/json');
					res.end(
						JSON.stringify({
							error: 'STTモデルが未ダウンロードです。npm run stt:fetch を実行してください'
						})
					);
					return;
				}
				res.statusCode = 200;
				res.setHeader('content-type', 'application/zip');
				res.setHeader('content-length', stats.size);
				createReadStream(path.join(modelsDir, file)).pipe(res);
			});
		}
	};
}

export default defineConfig({
	plugins: [sttModelDevServer(), tailwindcss(), sveltekit()],
	server: {
		watch: {
			// .omo/ is agent metadata (evidence/plans/notepads). Tests append to
			// evidence files there; watching them would broadcast page reloads
			// to every connected client and break parallel Playwright runs.
			ignored: ['**/.omo/**']
		}
	},
	test: {
		// Only collect unit tests under src/**. Playwright specs live in
		// tests/** and must NOT be collected by vitest.
		include: ['src/**/*.test.ts'],
		exclude: ['tests/**', 'node_modules/**', 'dist/**', '.svelte-kit/**']
	}
});
