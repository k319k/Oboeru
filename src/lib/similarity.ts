/**
 * Text normalization and Levenshtein similarity for shadowing practice.
 * Used to compare STT transcription against original sentence text.
 */

import { normalizeJapaneseText } from './normalize';

/**
 * Normalize text for comparison — the scoring-integrated version of the
 * canonical Japanese normalization (normalize.ts, ONE rule set) plus Latin
 * lowercasing: NFKC, strip punctuation/symbols/whitespace, fold katakana
 * to hiragana, lowercase Latin characters.
 */
export function normalize(text: string): string {
	return normalizeJapaneseText(text).toLowerCase();
}

/**
 * Classic Levenshtein distance via DP.
 * Time: O(n*m), Space: O(min(n,m)) using rolling arrays.
 */
export function levenshteinDistance(a: string, b: string): number {
	const lenA = a.length;
	const lenB = b.length;

	if (lenA === 0) return lenB;
	if (lenB === 0) return lenA;

	// Ensure we use O(min(n,m)) space by always making b the shorter string
	if (lenA < lenB) return levenshteinDistance(b, a);

	// Two rows: previous and current
	let prev = new Array<number>(lenB + 1);
	let curr = new Array<number>(lenB + 1);

	// Base case: transforming empty string to b[0..j]
	for (let j = 0; j <= lenB; j++) {
		prev[j] = j;
	}

	for (let i = 1; i <= lenA; i++) {
		curr[0] = i;
		for (let j = 1; j <= lenB; j++) {
			if (a[i - 1] === b[j - 1]) {
				curr[j] = prev[j - 1];
			} else {
				curr[j] = 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
			}
		}
		[prev, curr] = [curr, prev];
	}

	return prev[lenB];
}

/**
 * Compute similarity score (0–100) between two strings.
 * Both inputs are normalized before comparison.
 * Returns 100 for identical content, 0 for completely different.
 */
export function similarity(a: string, b: string): number {
	const normA = normalize(a);
	const normB = normalize(b);

	if (normA.length === 0 && normB.length === 0) return 100;
	if (normA.length === 0 || normB.length === 0) return 0;

	const distance = levenshteinDistance(normA, normB);
	const maxLen = Math.max(normA.length, normB.length);
	return 100 * (1 - distance / maxLen);
}
