import { describe, it, expect } from 'vitest';
import { tokenizeSentence, ProgressAligner } from './alignment';
import type { WordMatch } from './alignment';

// ─── tokenizeSentence ────────────────────────────────────────────────
describe('tokenizeSentence', () => {
	it('splits Japanese text with budoux', () => {
		expect(tokenizeSentence('私は毎朝コーヒーを飲みます。', 'ja')).toEqual([
			'私は',
			'毎朝コーヒーを',
			'飲みます。'
		]);
	});

	it('trims whitespace attached to ja tokens (budoux keeps input spaces)', () => {
		expect(tokenizeSentence('私は 毎朝 コーヒーを 飲みます', 'ja')).toEqual([
			'私は',
			'毎朝 コーヒーを',
			'飲みます'
		]);
	});

	it('splits English text on whitespace', () => {
		expect(tokenizeSentence('Hello world  foo', 'en')).toEqual(['Hello', 'world', 'foo']);
	});

	it('returns empty array for blank input', () => {
		expect(tokenizeSentence('', 'en')).toEqual([]);
		expect(tokenizeSentence('   ', 'en')).toEqual([]);
		expect(tokenizeSentence('　', 'ja')).toEqual([]);
	});
});

// ─── ProgressAligner: exact / fuzzy match ────────────────────────────
describe('ProgressAligner exact and fuzzy matching', () => {
	it('confirms exact matches in order', () => {
		const aligner = new ProgressAligner(['hello', 'world']);
		expect(aligner.feed('hello')).toEqual({ tokenIndex: 0, word: 'hello', status: 'match' });
		expect(aligner.feed('world')).toEqual({ tokenIndex: 1, word: 'world', status: 'match' });
		expect(aligner.getMatched()).toHaveLength(2);
	});

	it('matches with fuzzy levenshtein ratio >= 0.7', () => {
		// 1 edit over 5 chars → ratio 0.8
		const aligner = new ProgressAligner(['hello', 'world']);
		expect(aligner.feed('helo')).toEqual({ tokenIndex: 0, word: 'helo', status: 'match' });
	});

	it('matches at exactly the 0.7 ratio boundary', () => {
		// 3 substitutions over 10 chars → ratio 0.7 (inclusive)
		const aligner = new ProgressAligner(['abcdefghij']);
		expect(aligner.feed('abcxxxghij')?.status).toBe('match');
	});

	it('rejects fuzzy ratio < 0.7 as mismatch', () => {
		const aligner = new ProgressAligner(['abcd']);
		// 4 edits over 4 chars → ratio 0
		expect(aligner.feed('zzzz')).toEqual({ tokenIndex: 0, word: 'zzzz', status: 'mismatch' });
	});

	it('prefers an exact match further ahead over a fuzzy match closer', () => {
		// 'helo' fuzzy-matches 'hello' at 0.8, but index 1 is an exact match
		const aligner = new ProgressAligner(['helo', 'hello']);
		expect(aligner.feed('hello')?.tokenIndex).toBe(1);
	});

	it('matches ignoring punctuation, whitespace and case', () => {
		const aligner = new ProgressAligner(['Hello,', 'World!']);
		expect(aligner.feed('hello')).toEqual({ tokenIndex: 0, word: 'hello', status: 'match' });
		expect(aligner.feed('  WORLD ')).toEqual({ tokenIndex: 1, word: '  WORLD ', status: 'match' });
	});
});

// ─── ProgressAligner: kana folding (alignment-internal normalization) ─
describe('ProgressAligner kana folding', () => {
	it('matches katakana target with hiragana input', () => {
		const aligner = new ProgressAligner(['コーヒー', 'テスト']);
		expect(aligner.feed('こーひー')).toEqual({ tokenIndex: 0, word: 'こーひー', status: 'match' });
		expect(aligner.feed('てすと')).toEqual({ tokenIndex: 1, word: 'てすと', status: 'match' });
	});

	it('matches hiragana target with katakana input', () => {
		const aligner = new ProgressAligner(['てすと', 'うんどう']);
		expect(aligner.feed('テスト')).toEqual({ tokenIndex: 0, word: 'テスト', status: 'match' });
		expect(aligner.feed('運動')).toEqual({ tokenIndex: 1, word: '運動', status: 'mismatch' });
	});
});

// ─── ProgressAligner: lookahead and mismatch ─────────────────────────
describe('ProgressAligner lookahead and mismatch', () => {
	it('skips ahead within the default lookahead window on match', () => {
		const aligner = new ProgressAligner(['ichi', 'ni', 'san']);
		expect(aligner.feed('san')).toEqual({ tokenIndex: 2, word: 'san', status: 'match' });
		// Skipped tokens produce no WordMatch (they stay un-read)
		expect(aligner.getMatched()).toEqual([{ tokenIndex: 2, word: 'san', status: 'match' }]);
	});

	it('returns mismatch without advancing the pointer, then recovers', () => {
		const aligner = new ProgressAligner(['hello', 'world']);
		expect(aligner.feed('zzzzz')).toEqual({ tokenIndex: 0, word: 'zzzzz', status: 'mismatch' });
		expect(aligner.feed('hello')).toEqual({ tokenIndex: 0, word: 'hello', status: 'match' });
		expect(aligner.feed('world')).toEqual({ tokenIndex: 1, word: 'world', status: 'match' });
	});

	it('expands lookahead to 3 after repeated mismatches (granularity tolerance)', () => {
		const aligner = new ProgressAligner(['a', 'b', 'c', 'd']);
		expect(aligner.feed('x')).toEqual({ tokenIndex: 0, word: 'x', status: 'mismatch' });
		expect(aligner.feed('y')).toEqual({ tokenIndex: 0, word: 'y', status: 'mismatch' });
		// With the expanded window (current + 3), index 3 is reachable from pointer 0
		expect(aligner.feed('d')).toEqual({ tokenIndex: 3, word: 'd', status: 'match' });
	});

	it('does not choke on punctuation-only target tokens', () => {
		const aligner = new ProgressAligner(['こんにちは', '、', '世界']);
		expect(aligner.feed('こんにちは')).toEqual({ tokenIndex: 0, word: 'こんにちは', status: 'match' });
		// window (current + 2) reaches past the empty-norm '、' token
		expect(aligner.feed('世界')).toEqual({ tokenIndex: 2, word: '世界', status: 'match' });
	});
});

// ─── ProgressAligner: recoloring is forbidden ────────────────────────
describe('ProgressAligner recoloring prevention', () => {
	it('never re-matches an already matched token (same word fed twice)', () => {
		const aligner = new ProgressAligner(['hello']);
		expect(aligner.feed('hello')?.status).toBe('match');
		// All tokens consumed → nothing to match again
		expect(aligner.feed('hello')).toBeNull();
	});

	it('a matched token cannot match again while later tokens remain', () => {
		const aligner = new ProgressAligner(['hello', 'world']);
		aligner.feed('hello');
		// Second 'hello' cannot recolor token 0 → aimed at the next pending token
		expect(aligner.feed('hello')).toEqual({ tokenIndex: 1, word: 'hello', status: 'mismatch' });
	});
});

// ─── ProgressAligner: invalid feeds and state snapshot ───────────────
describe('ProgressAligner edge cases', () => {
	it('returns null for words that normalize to empty and leaves state untouched', () => {
		const aligner = new ProgressAligner(['hello']);
		expect(aligner.feed('')).toBeNull();
		expect(aligner.feed('   ')).toBeNull();
		expect(aligner.feed('、')).toBeNull();
		expect(aligner.feed('hello')).toEqual({ tokenIndex: 0, word: 'hello', status: 'match' });
	});

	it('returns null when all tokens are consumed', () => {
		const aligner = new ProgressAligner(['hello']);
		aligner.feed('hello');
		expect(aligner.feed('hello')).toBeNull();
	});

	it('handles an empty target list', () => {
		const aligner = new ProgressAligner([]);
		expect(aligner.feed('hello')).toBeNull();
		expect(aligner.getMatched()).toEqual([]);
	});

	it('returns a snapshot copy from getMatched', () => {
		const aligner = new ProgressAligner(['hello']);
		aligner.feed('hello');
		const snapshot: WordMatch[] = aligner.getMatched();
		snapshot.push({ tokenIndex: 9, word: 'x', status: 'mismatch' });
		expect(aligner.getMatched()).toHaveLength(1);
	});
});

// ─── Vosk-style ja fixtures (kana/kanji drift + token granularity) ───
describe('ProgressAligner with Vosk-style ja output', () => {
	it('aligns kana STT words against budoux tokens (fold + fuzzy + granularity差)', () => {
		const target = tokenizeSentence('コーヒーを飲みます。', 'ja');
		expect(target).toEqual(['コーヒーを', '飲みます。']);

		const aligner = new ProgressAligner(target);
		// Vosk emits kana and drops the particle from the noun token
		// 'こーひー' vs 'こーひーを': ratio 0.8 → fuzzy match
		expect(aligner.feed('こーひー')).toEqual({ tokenIndex: 0, word: 'こーひー', status: 'match' });
		// Standalone particle cannot match '飲みます。' → mismatch, pointer stays
		expect(aligner.feed('を')).toEqual({ tokenIndex: 1, word: 'を', status: 'mismatch' });
		// Next word lands on its token (target punctuation ignored)
		expect(aligner.feed('のみます')).toEqual({ tokenIndex: 1, word: 'のみます', status: 'match' });

		expect(aligner.getMatched()).toEqual([
			{ tokenIndex: 0, word: 'こーひー', status: 'match' },
			{ tokenIndex: 1, word: 'を', status: 'mismatch' },
			{ tokenIndex: 1, word: 'のみます', status: 'match' }
		]);
	});

	it('keeps alignment on track when kanji tokens cannot match kana input', () => {
		const target = tokenizeSentence('私は毎朝コーヒーを飲みます。', 'ja');
		expect(target).toEqual(['私は', '毎朝コーヒーを', '飲みます。']);

		const aligner = new ProgressAligner(target);
		// Kanji/kana difference: 'わたし は' can never match '私は' → mismatches
		expect(aligner.feed('わたし')).toEqual({ tokenIndex: 0, word: 'わたし', status: 'mismatch' });
		expect(aligner.feed('は')).toEqual({ tokenIndex: 0, word: 'は', status: 'mismatch' });
		expect(aligner.feed('まいあさ')).toEqual({ tokenIndex: 0, word: 'まいあさ', status: 'mismatch' });
		// Alignment does not desync: the final kana word still finds its token
		expect(aligner.feed('のみます')).toEqual({ tokenIndex: 2, word: 'のみます', status: 'match' });
		expect(aligner.getMatched()).toHaveLength(4);
	});

	it('aligns en words with case and punctuation drift', () => {
		const target = tokenizeSentence('Hello, world!', 'en');
		expect(target).toEqual(['Hello,', 'world!']);

		const aligner = new ProgressAligner(target);
		expect(aligner.feed('hello')).toEqual({ tokenIndex: 0, word: 'hello', status: 'match' });
		expect(aligner.feed('world')).toEqual({ tokenIndex: 1, word: 'world', status: 'match' });
	});
});
