export const JEV_MODEL = 'typesafe/jev-1.13';

/** Jev 判定リクエスト (OpenRouter systemone) のボディを組み立てる。 */
export function buildJudgeRequest(reference: string, transcription: string) {
	return {
		model: JEV_MODEL,
		state: { reference, transcription },
		questions: {
			same_utterance: {
				type: 'noul',
				instructions:
					'Does `transcription` express the same spoken utterance as `reference`? ' +
					'Notation differences that preserve the reading count as identical: kanji vs kana ' +
					'(はじめ = 初め), comma styles (", " vs "、"), trailing punctuation, and minor ' +
					'colloquial variants of the same word (みな = みんな). ' +
					'Different word, different reading, missing or extra content counts as different.',
				criteria: {
					true: 'Same utterance by a native reading, allowing notation and punctuation variants',
					false: 'Different utterance, wrong reading, or missing/extra content'
				}
			},
			difference_kind: {
				type: 'choice',
				instructions: 'Classify the relationship between `reference` and `transcription`.',
				criteria: {
					identical_text: 'Text is character-for-character identical',
					orthography_variant: 'Same words and reading, different spelling/punctuation/kanji choice',
					word_variant: 'Same words but a colloquial or shortened form of one word (みな/みんな)',
					different_utterance: 'Actually different words or meaning'
				}
			}
		}
	};
}

/**
 * Jev 応答を {available: true, noul, category, confidence} に畳む。
 * どんな入力でも投げない — 欠損/型不整合はすべて {available: false}。
 */
export function parseJudgeResponse(json: unknown):
	| { available: true; noul: number; category: string; confidence: number }
	| { available: false } {
	// answers.same_utterance.noul (0-1), answers.difference_kind.{choice,confidence} を安全に取り出す。
	// 欠損/型不整合/answers不在 → {available: false}
	if (typeof json !== 'object' || json === null) return { available: false };
	const answers = (json as Record<string, unknown>).answers;
	if (typeof answers !== 'object' || answers === null) return { available: false };
	const a = answers as Record<string, unknown>;

	const sameUtterance = a.same_utterance;
	if (typeof sameUtterance !== 'object' || sameUtterance === null) return { available: false };
	const noul = (sameUtterance as Record<string, unknown>).noul;
	if (typeof noul !== 'number' || !Number.isFinite(noul)) return { available: false };

	const differenceKind = a.difference_kind;
	if (typeof differenceKind !== 'object' || differenceKind === null) return { available: false };
	const d = differenceKind as Record<string, unknown>;
	const choice = d.choice;
	if (typeof choice !== 'string' || !choice) return { available: false };
	const confidence = d.confidence;
	if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
		return { available: false };
	}

	// 契約外の有限 noul は [0, 1] にクランプ (スコア > 100 表示を防ぐ)
	return {
		available: true,
		noul: Math.min(1, Math.max(0, noul)),
		category: choice,
		confidence
	};
}
