/** Normalize Japanese text for similarity scoring: NFKC, strip
 * punctuation/symbols/whitespace, unify katakana to hiragana. */
export function normalizeJapaneseText(text: string): string {
	const nfkc = text.normalize('NFKC');
	const stripped = nfkc.replace(/[\p{P}\p{S}\s]+/gu, '');
	// Katakana (ァ-ヶ 0x30A1-0x30F6) → Hiragana (0x3041-)
	const hira = stripped.replace(/[\u30A1-\u30F6]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0x60)
	);
	return hira;
}
