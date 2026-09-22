import { describe, it, expect } from 'vitest';
import { normalize, levenshteinDistance, similarity } from './similarity';

// ─── normalize ───────────────────────────────────────────────────────
describe('normalize', () => {
	it('applies NFKC normalization', () => {
		// Full-width 'A' (U+FF21) → ASCII 'A'
		expect(normalize('Ａ')).toBe('a');
	});

	it('removes whitespace', () => {
		expect(normalize('hello world')).toBe('helloworld');
		expect(normalize('  leading')).toBe('leading');
		expect(normalize('trailing  ')).toBe('trailing');
		expect(normalize('  both  ')).toBe('both');
		expect(normalize('tabs\there')).toBe('tabshere');
	});

	it('removes punctuation', () => {
		expect(normalize('hello, world!')).toBe('helloworld');
		expect(normalize('what\'s up?')).toBe('whatsup');
		expect(normalize('a.b,c;d')).toBe('abcd');
	});

	it('lowercases Latin characters', () => {
		expect(normalize('HELLO')).toBe('hello');
		expect(normalize('HeLLo WoRLd')).toBe('helloworld');
	});

	it('handles Japanese text', () => {
		expect(normalize('こんにちは、世界！')).toBe('こんにちは世界');
		expect(normalize('はい、そうです。')).toBe('はいそうです');
	});

	it('handles mixed scripts', () => {
		const input = 'Hello、World！日本語テスト。';
		const result = normalize(input);
		expect(result).not.toContain(' ');
		expect(result).not.toContain('、');
		expect(result).not.toContain('！');
		expect(result).not.toContain('。');
		expect(result).toBe('helloworld日本語てすと');
	});

	it('folds katakana to hiragana (unified with normalizeJapaneseText)', () => {
		expect(normalize('バベルの塔')).toBe('ばべるの塔');
	});

	it('strips symbols (\\p{S}) alongside punctuation', () => {
		expect(normalize('★がんばれ☆!')).toBe('がんばれ');
	});

	it('returns empty string for empty input', () => {
		expect(normalize('')).toBe('');
	});

	it('handles string of only punctuation/whitespace', () => {
		expect(normalize(' , ! .  ')).toBe('');
	});
});

// ─── levenshteinDistance ─────────────────────────────────────────────
describe('levenshteinDistance', () => {
	it('returns 0 for identical strings', () => {
		expect(levenshteinDistance('hello', 'hello')).toBe(0);
	});

	it('returns 1 for single insertion', () => {
		expect(levenshteinDistance('cat', 'cats')).toBe(1);
	});

	it('returns 1 for single deletion', () => {
		expect(levenshteinDistance('cats', 'cat')).toBe(1);
	});

	it('returns 1 for single substitution', () => {
		expect(levenshteinDistance('cat', 'cot')).toBe(1);
	});

	it('returns max length for completely different strings', () => {
		expect(levenshteinDistance('abc', 'xyz')).toBe(3);
	});

	it('handles empty string vs non-empty', () => {
		expect(levenshteinDistance('', 'abc')).toBe(3);
		expect(levenshteinDistance('abc', '')).toBe(3);
	});

	it('handles both empty strings', () => {
		expect(levenshteinDistance('', '')).toBe(0);
	});

	it('handles single character strings', () => {
		expect(levenshteinDistance('a', 'a')).toBe(0);
		expect(levenshteinDistance('a', 'b')).toBe(1);
		expect(levenshteinDistance('a', '')).toBe(1);
		expect(levenshteinDistance('', 'a')).toBe(1);
	});

	it('is symmetric', () => {
		expect(levenshteinDistance('hello', 'hallo')).toBe(levenshteinDistance('hallo', 'hello'));
	});

	it('computes a more complex edit distance', () => {
		// kitten → sitting: 3 edits (k→s, e→i, insert g)
		expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
	});

	it('works when b is shorter than a (space optimization path)', () => {
		expect(levenshteinDistance('abcdef', 'a')).toBe(5);
	});
});

// ─── similarity ──────────────────────────────────────────────────────
describe('similarity', () => {
	it('returns 100 for identical strings', () => {
		expect(similarity('hello', 'hello')).toBe(100);
	});

	it('returns 100 for identical content with different punctuation', () => {
		const score = similarity('hello, world!', 'Hello World');
		expect(score).toBe(100);
	});

	it('returns 100 for Japanese text with punctuation differences', () => {
		const score = similarity('こんにちは、世界！', 'こんにちは世界');
		expect(score).toBe(100);
	});

	it('returns high score for minor differences', () => {
		const score = similarity('hello', 'hallo');
		// 1 edit out of 5 chars → 80%
		expect(score).toBe(80);
	});

	it('returns low score for completely different strings', () => {
		const score = similarity('aaa', 'xyz');
		expect(score).toBeLessThan(50);
	});

	it('returns 100 when both strings are empty', () => {
		expect(similarity('', '')).toBe(100);
	});

	it('returns 0 when one string is empty and other is not', () => {
		expect(similarity('', 'hello')).toBe(0);
		expect(similarity('hello', '')).toBe(0);
	});

	it('returns 0 when only whitespace/punctuation in one', () => {
		expect(similarity('hello', ', ! .')).toBe(0);
	});

	it('handles single character strings', () => {
		expect(similarity('a', 'a')).toBe(100);
		expect(similarity('a', 'b')).toBe(0);
	});

	it('normalizes before comparing (case insensitive)', () => {
		expect(similarity('Hello', 'hello')).toBe(100);
	});

	it('normalizes before comparing (whitespace insensitive)', () => {
		expect(similarity('hello world', 'hello   world')).toBe(100);
	});

	it('produces a reasonable score for similar Japanese sentences', () => {
		// One has a punctuation difference
		const score = similarity('今日はいい天気ですね', '今日は、いい天気ですね');
		expect(score).toBe(100); // After normalization, punctuation removed → identical
	});
});

// ─── performance ─────────────────────────────────────────────────────
describe('performance', () => {
	it('handles 500-char strings within 1 second', () => {
		const chars = 'abcdefghijklmnopqrstuvwxyz';
		const a = Array.from({ length: 500 }, (_, i) => chars[i % chars.length]).join('');
		const b = Array.from({ length: 500 }, (_, i) => chars[(i + 1) % chars.length]).join('');

		const start = Date.now();
		levenshteinDistance(a, b);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(1000);
	});

	it('handles 200-char strings within 100ms', () => {
		const a = 'あいうえおかきくけこ'.repeat(10);
		const b = 'あいうえおかきくけこさ'.repeat(9);

		const start = Date.now();
		levenshteinDistance(a, b);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(100);
	});
});
