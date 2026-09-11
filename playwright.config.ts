import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests',
	timeout: 30000,
	use: {
		baseURL: 'http://localhost:5173',
		headless: true
	},
	projects: [
		{
			name: 'chromium',
			use: {
				browserName: 'chromium',
				launchOptions: {
					args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
				},
				contextOptions: {
					permissions: ['microphone']
				}
			}
		}
	],
	webServer: {
		command: 'npm run dev -- --port 5173',
		port: 5173,
		reuseExistingServer: true,
		timeout: 30000
	}
});
