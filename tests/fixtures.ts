import { test as base, expect } from '@playwright/test';

type E2EFixtures = {
	stubSttModelProxy: void;
};

const test = base.extend<E2EFixtures>({
	stubSttModelProxy: [
		async ({ context }, use) => {
			await context.route('**/models/**', (route) =>
				route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'stt model proxy stubbed during e2e' })
				})
			);
			await use();
		},
		{ auto: true }
	]
});

export { test, expect };
export type { Page } from '@playwright/test';
