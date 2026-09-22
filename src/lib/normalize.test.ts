import { describe, it, expect } from 'vitest';
import { normalizeJapaneseText } from './normalize';

// ─── NFKC (全角/半角の統一) ──────────────────────────────────────────
describe('normalizeJapaneseText NFKC normalization', () => {
	it('unifies full-width digits to half-width', () => {
		expect(normalizeJapaneseText('１２３')).toBe('123');
	});

	it('strips full-width punctuation that NFKC maps to CJK punctuation', () => {
		// '，' is NFKC-mapped to '、' → then stripped as punctuation
		expect(normalizeJapaneseText('，')).toBe('');
	});

	it('strips full-width symbols (％ → %)', () => {
		expect(normalizeJapaneseText('割引％')).toBe('割引');
	});

	it('unifies half-width katakana via NFKC then folds to hiragana', () => {
		expect(normalizeJapaneseText('ｺﾞｷｹﾞﾝ')).toBe('ごきげん');
	});
});

// ─── 句読点・記号・空白の除去 ────────────────────────────────────────
describe('normalizeJapaneseText punctuation, symbol and whitespace stripping', () => {
	it('strips CJK punctuation', () => {
		expect(normalizeJapaneseText('おはよう、ございます。')).toBe('おはようございます');
	});

	it('strips whitespace including full-width space', () => {
		expect(normalizeJapaneseText('こん にち　は')).toBe('こんにちは');
	});

	it('strips symbols (★☆)', () => {
		expect(normalizeJapaneseText('★がんばれ☆')).toBe('がんばれ');
	});
});

// ─── カタカナ → ひらがな統一 ─────────────────────────────────────────
describe('normalizeJapaneseText katakana to hiragana folding', () => {
	it('folds katakana to hiragana', () => {
		expect(normalizeJapaneseText('バベル')).toBe('ばべる');
	});

	it('keeps kanji and kana already in hiragana untouched', () => {
		expect(normalizeJapaneseText('バベルの塔')).toBe('ばべるの塔');
	});

	it('keeps the prolonged sound mark (ー is outside ァ-ヶ) as-is', () => {
		expect(normalizeJapaneseText('コーヒー')).toBe('こーひー');
		expect(normalizeJapaneseText('タワー')).toBe('たわー');
	});

	it('folds small kana in range (ャ ュ ョ ッ)', () => {
		expect(normalizeJapaneseText('キュート')).toBe('きゅーと');
	});
});

// ─── 英字・空文字・記号のみ ──────────────────────────────────────────
describe('normalizeJapaneseText edge cases', () => {
	it('leaves Latin letters untouched (no lowercasing)', () => {
		expect(normalizeJapaneseText('Hello!')).toBe('Hello');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeJapaneseText('')).toBe('');
	});

	it('returns empty string for symbols-only input', () => {
		expect(normalizeJapaneseText('★☆？！ 〜')).toBe('');
	});
});
