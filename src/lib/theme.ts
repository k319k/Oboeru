/**
 * Theme state with localStorage persistence.
 *
 * The theme preference is stored under its own localStorage key (`oboeru:theme`)
 * and is intentionally NOT part of the Settings schema (`oboeru:settings:v1`).
 *
 * - `'system'` (default) follows the OS `prefers-color-scheme` and reacts to
 *   live changes via a `matchMedia` subscription.
 * - `'light'` / `'dark'` are explicit overrides that leave `system`.
 *
 * Applying the theme means toggling the `.dark` class on `document.documentElement`
 * (the token definitions in app.css already provide both light/dark palettes).
 */

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'oboeru:theme';
const DEFAULT_THEME: Theme = 'system';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The user's stored preference (`'system'` by default). */
let theme: Theme = loadTheme();

/** The theme actually applied to the document (never `'system'`). */
let resolved: ResolvedTheme = resolve(theme);

type Listener = () => void;
const listeners = new Set<Listener>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadTheme(): Theme {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
	} catch {
		// localStorage unavailable (e.g. privacy mode) — fall back to default.
	}
	return DEFAULT_THEME;
}

function systemPrefersDark(): boolean {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-color-scheme: dark)').matches
	);
}

function resolve(t: Theme): ResolvedTheme {
	if (t === 'system') return systemPrefersDark() ? 'dark' : 'light';
	return t;
}

function apply(): void {
	resolved = resolve(theme);
	document.documentElement.classList.toggle('dark', resolved === 'dark');
	listeners.forEach((listener) => listener());
}

// ---------------------------------------------------------------------------
// System preference subscription (only active while theme === 'system')
// ---------------------------------------------------------------------------

let mediaQuery: MediaQueryList | null = null;

function onSystemChange(): void {
	if (theme === 'system') apply();
}

function syncMediaSubscription(): void {
	if (theme !== 'system') {
		mediaQuery?.removeEventListener('change', onSystemChange);
		mediaQuery = null;
		return;
	}
	if (mediaQuery) return;
	mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
	mediaQuery.addEventListener('change', onSystemChange);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The user's stored theme preference. */
export function getTheme(): Theme {
	return theme;
}

/** The theme currently applied to the document (`'light'` or `'dark'`). */
export function getResolvedTheme(): ResolvedTheme {
	return resolved;
}

/** Set an explicit theme preference (or `'system'` to follow the OS). */
export function setTheme(next: Theme): void {
	theme = next;
	try {
		localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Persistence failure is non-fatal — keep the in-memory preference.
	}
	syncMediaSubscription();
	apply();
}

/**
 * Toggle between explicit light/dark based on the currently resolved theme.
 * A user click leaves `system` and pins an explicit preference.
 */
export function toggleTheme(): void {
	setTheme(resolved === 'dark' ? 'light' : 'dark');
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function subscribeTheme(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Initialize on module load (browser only)
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
	syncMediaSubscription();
	apply();
}
