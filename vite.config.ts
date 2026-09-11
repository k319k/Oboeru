import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
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
