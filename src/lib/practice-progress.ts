/**
 * Mid-session progress storage.
 *
 * A single dedicated key, intentionally OUTSIDE the Settings schema
 * (`oboeru:settings:v1`) — same pattern as theme.ts — so a page reload can
 * offer to resume the session. Lives in sessionStorage for the tab session
 * only and expires after 30 minutes.
 */

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
			savedAt: obj.savedAt
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
		// Storage unavailable — nothing to clear.
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
