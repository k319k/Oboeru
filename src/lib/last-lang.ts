/**
 * Remembers the language of the last practice session so the top page can
 * warm the matching STT model before practice starts (freeze-fix).
 */

const KEY = 'oboeru:last-lang:v1';
const LANGS = ['ja', 'en'] as const;

export type LastLang = (typeof LANGS)[number];

function isLastLang(value: unknown): value is LastLang {
	return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

export function getLastLang(): LastLang {
	try {
		const raw = localStorage.getItem(KEY);
		return isLastLang(raw) ? raw : 'ja';
	} catch {
		return 'ja';
	}
}

export function setLastLang(lang: LastLang): void {
	try {
		localStorage.setItem(KEY, lang);
	} catch {
		// SSR/private mode — best effort.
	}
}