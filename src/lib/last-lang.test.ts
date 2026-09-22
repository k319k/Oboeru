import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getLastLang, setLastLang } from './last-lang';

const KEY = 'oboeru:last-lang:v1';

function stubStorage(initial: Record<string, string>) {
	const store = new Map(Object.entries(initial));
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	});
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('last-lang', () => {
	it('defaults to ja when nothing is stored', () => {
		stubStorage({});
		expect(getLastLang()).toBe('ja');
	});

	it('falls back to ja for invalid stored values', () => {
		stubStorage({ [KEY]: 'fr' });
		expect(getLastLang()).toBe('ja');
	});

	it('round-trips a stored language', () => {
		stubStorage({});
		setLastLang('en');
		expect(getLastLang()).toBe('en');
	});

	it('does not throw when localStorage is unavailable (SSR)', () => {
		vi.stubGlobal('localStorage', undefined);
		expect(() => getLastLang()).not.toThrow();
		expect(() => setLastLang('ja')).not.toThrow();
	});
});