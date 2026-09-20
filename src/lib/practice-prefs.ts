/**
 * Practice operation preferences + mid-session progress storage.
 *
 * Two dedicated keys, intentionally OUTSIDE the Settings schema
 * (`oboeru:settings:v1`) — same pattern as theme.ts:
 *
 * - `oboeru:practice-ui:v1` (localStorage): how the practice UI operates —
 *   auto-advance on/off and the dwell speeds after feedback. Invalid stored
 *   values are clamped back to the defaults.
 * - `oboeru:progress:v1` (sessionStorage): where the user stopped mid-practice
 *   so a page reload can offer to resume. Lives for the tab session only and
 *   expires after 30 minutes.
 */

import { CORRECT_DWELL_MS, INCORRECT_DWELL_MS } from './constants';

// ---------------------------------------------------------------------------
// Practice prefs (localStorage)
// ---------------------------------------------------------------------------

export interface PracticePrefs {
	/** Advance / retry automatically after scored feedback (default true). */
	autoAdvance: boolean;
	/** Wait after a passing feedback before advancing, in ms (default 800). */
	correctDwellMs: number;
	/** Wait after a failing feedback before retrying, in ms (default 2000). */
	incorrectDwellMs: number;
}

const PREFS_STORAGE_KEY = 'oboeru:practice-ui:v1';

const DEFAULT_PREFS: Readonly<PracticePrefs> = {
	autoAdvance: true,
	correctDwellMs: 800,
	incorrectDwellMs: 2000,
} as const;

/**
 * Dwell values may not exceed the legacy fixed defaults (constants.ts) —
 * the constants remain the fallback envelope of the valid range.
 */
const CORRECT_DWELL_MAX_MS = CORRECT_DWELL_MS;
const INCORRECT_DWELL_MAX_MS = INCORRECT_DWELL_MS;

function clampDwell(value: unknown, max: number, fallback: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
	if (value < 0 || value > max) return fallback;
	return value;
}

function validatePrefs(raw: Record<string, unknown>): PracticePrefs {
	return {
		autoAdvance: typeof raw.autoAdvance === 'boolean' ? raw.autoAdvance : DEFAULT_PREFS.autoAdvance,
		correctDwellMs: clampDwell(raw.correctDwellMs, CORRECT_DWELL_MAX_MS, DEFAULT_PREFS.correctDwellMs),
		incorrectDwellMs: clampDwell(
			raw.incorrectDwellMs,
			INCORRECT_DWELL_MAX_MS,
			DEFAULT_PREFS.incorrectDwellMs
		),
	};
}

/** Read practice prefs from localStorage, falling back to defaults on any error. */
export function loadPracticePrefs(): PracticePrefs {
	try {
		const raw = localStorage.getItem(PREFS_STORAGE_KEY);
		if (raw === null) return { ...DEFAULT_PREFS };
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PREFS };
		return validatePrefs(parsed as Record<string, unknown>);
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

/** Persist practice prefs to localStorage. */
export function savePracticePrefs(prefs: PracticePrefs): void {
	try {
		localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Persistence failure is non-fatal — keep the in-memory preference.
	}
}

// ---------------------------------------------------------------------------
// Practice progress (sessionStorage)
// ---------------------------------------------------------------------------

export interface PracticeProgress {
	/** Chapter the session belongs to (restore only matches the same chapter). */
	chapterId: string;
	/** Sentence index to resume at (0-based). */
	currentIndex: number;
	/** Scored attempts so far (attempts, not distinct sentences). */
	completedCount: number;
	/** Accumulated similarity score over scored attempts. */
	totalScore: number;
	skippedCount: number;
	/** Epoch ms when the snapshot was written. */
	savedAt: number;
}

const PROGRESS_STORAGE_KEY = 'oboeru:progress:v1';
const PROGRESS_MAX_AGE_MS = 30 * 60 * 1000;

function nonNegInt(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	return Math.floor(value);
}

/** Read the saved progress, or null when absent / foreign / stale / invalid. */
export function loadPracticeProgress(chapterId: string, now: number = Date.now()): PracticeProgress | null {
	try {
		const raw = sessionStorage.getItem(PROGRESS_STORAGE_KEY);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const obj = parsed as Record<string, unknown>;
		if (obj.chapterId !== chapterId) return null;
		if (typeof obj.savedAt !== 'number' || !Number.isFinite(obj.savedAt)) return null;
		if (now - obj.savedAt > PROGRESS_MAX_AGE_MS) return null;
		return {
			chapterId,
			currentIndex: nonNegInt(obj.currentIndex),
			completedCount: nonNegInt(obj.completedCount),
			totalScore: nonNegInt(obj.totalScore),
			skippedCount: nonNegInt(obj.skippedCount),
			savedAt: obj.savedAt,
		};
	} catch {
		return null;
	}
}

/** Persist the mid-session progress snapshot (sessionStorage — tab lifetime). */
export function savePracticeProgress(progress: PracticeProgress): void {
	try {
		sessionStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(progress));
	} catch {
		// Persistence failure is non-fatal.
	}
}

/** Remove the saved progress (reached summary / chose to start over). */
export function clearPracticeProgress(): void {
	try {
		sessionStorage.removeItem(PROGRESS_STORAGE_KEY);
	} catch {
		// Storage unavailable — nothing to clear.
	}
}
