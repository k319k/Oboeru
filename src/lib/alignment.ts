/**
 * Word-level alignment engine for recorded-feedback word coloring.
 *
 * Tokenizes target sentences (budoux for ja, whitespace for en) and aligns a
 * stream of spoken words against target tokens. Matching reuses the
 * similarity.ts normalization (NFKC + punctuation/whitespace removal + lowercase)
 * and adds an alignment-internal kana-folding layer (katakana → hiragana) so
 * kana spelling drift (こーひー for target コーヒー) still matches.
 */
import { loadDefaultJapaneseParser, type HTMLProcessingParser } from 'budoux';
import { normalize, levenshteinDistance } from './similarity';

export type WordMatchStatus = 'match' | 'mismatch';

/** A confirmed alignment verdict for one fed word. Immutable once returned. */
export interface WordMatch {
	tokenIndex: number;
	word: string;
	status: WordMatchStatus;
}

const FUZZY_THRESHOLD = 0.7;
/** Try the current token plus this many tokens ahead. */
const DEFAULT_LOOKAHEAD = 2;
/** Window grows to this after repeated mismatches (large granularity gap). */
const EXPANDED_LOOKAHEAD = 3;
const ESCALATION_MISMATCHES = 2;

let jaParser: HTMLProcessingParser | null = null;

function getJaParser(): HTMLProcessingParser {
	jaParser ??= loadDefaultJapaneseParser();
	return jaParser;
}

/** Fold katakana to hiragana (U+30A1–U+30F6 all have hiragana counterparts). */
function foldKana(text: string): string {
	return text.replace(/[\u30A1-\u30F6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

/** similarity.normalize + kana folding. Alignment-internal only. */
function normalizeForAlign(text: string): string {
	return foldKana(normalize(text));
}

function fuzzyRatio(a: string, b: string): number {
	return 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
}

/**
 * Split a sentence into target tokens.
 * - ja: budoux word segmentation (tokens are trimmed; budoux attaches input
 *   whitespace to the following token).
 * - en: whitespace split.
 */
export function tokenizeSentence(text: string, lang: 'ja' | 'en'): string[] {
	switch (lang) {
		case 'ja':
			return getJaParser()
				.parse(text)
				.map((token) => token.trim())
				.filter((token) => token.length > 0);
		case 'en':
			return text.split(/\s+/).filter((token) => token.length > 0);
	}
}

/**
 * Aligns fed words against target tokens with a forward-only cursor.
 *
 * feed() confirms a match (exact first, then fuzzy ≥ 0.7) within a lookahead
 * window and advances the cursor past the matched token; tokens jumped over
 * stay un-read. A word matching nothing returns a mismatch verdict at the
 * cursor without advancing it. Matched tokens can never match again, so a
 * confirmed state is never recolored. Skipped tokens produce no WordMatch
 * (callers render them as un-read).
 */
export class ProgressAligner {
	private readonly norms: string[];
	private cursor = 0;
	private mismatchStreak = 0;
	private readonly confirmed: WordMatch[] = [];

	constructor(targetTokens: string[]) {
		this.norms = targetTokens.map(normalizeForAlign);
	}

	feed(word: string): WordMatch | null {
		const wordNorm = normalizeForAlign(word);
		if (wordNorm.length === 0 || this.cursor >= this.norms.length) return null;

		const end = Math.min(this.cursor + this.lookahead(), this.norms.length - 1);
		for (let i = this.cursor; i <= end; i++) {
			if (this.norms[i] === wordNorm) return this.matchAt(i, word);
		}
		for (let i = this.cursor; i <= end; i++) {
			if (fuzzyRatio(this.norms[i], wordNorm) >= FUZZY_THRESHOLD) return this.matchAt(i, word);
		}

		this.mismatchStreak += 1;
		return this.record({ tokenIndex: this.cursor, word, status: 'mismatch' });
	}

	/** All confirmed verdicts (matches and mismatches) in feed order. */
	getMatched(): WordMatch[] {
		return [...this.confirmed];
	}

	private lookahead(): number {
		return this.mismatchStreak >= ESCALATION_MISMATCHES
			? EXPANDED_LOOKAHEAD
			: DEFAULT_LOOKAHEAD;
	}

	private matchAt(index: number, word: string): WordMatch {
		this.mismatchStreak = 0;
		this.cursor = index + 1;
		return this.record({ tokenIndex: index, word, status: 'match' });
	}

	private record(result: WordMatch): WordMatch {
		this.confirmed.push(result);
		return result;
	}
}
