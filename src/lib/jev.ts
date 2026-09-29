import { normalize } from './similarity';

export const JEV_MODEL = 'typesafe/jev-1.13';

/** Jev 判定リクエスト (OpenRouter systemone) のボディを組み立てる。 */
export function buildJudgeRequest(reference: string, transcription: string) {
	// 句読点・空白・記号・全角/半角・カタカナ/ひらがな・英字大小はここで落とす。
	// 読んでも发音が変わらないものは判定材料にすべきではなく、
	// Jev に差分として見せること自体が誤判定の温床になるため state 側から消す。
	// 正規化は similarity() と同一 (normalize.ts の正規格に Latin 小文字化を加えたもの)。
	const normRef = normalize(reference);
	const normTrn = normalize(transcription);
	return {
		model: JEV_MODEL,
		state: { reference: normRef, transcription: normTrn },
		questions: {
			same_utterance: {
				type: 'noul',
				// 実測済みの文言。Jev は state の文字列しか見ないので、句読点・空白・全角半角・
				// 英字大小・カタカナひらがな差はここで落として前提を固定し、「同じ読み =
				// 同じ発話」「口語・縮約形も同一」という同値クラスを明示している。
				// 旧的文言 (疑問形 + 「無視して」) では町/街 0.67・長文 0.59 しか出ず落第。
				instructions:
					'Decide whether `transcription` is the same spoken utterance as `reference`. ' +
					'Both are normalized renderings of one practice sentence: punctuation, spacing, ' +
					'symbols, width and Latin case are already removed and katakana is folded to ' +
					'hiragana, so those are never evidence. Compare PRONUNCIATION and CONTENT. ' +
					'Same reading means the same utterance however it is written: 争う/あらそう, ' +
					'町/まち/街, 作る/つくる, 届く/とどく, 三/3, 人/人々 are all THE SAME. ' +
					'A colloquial or contracted form of the same word is also the SAME utterance ' +
					'(みな/みんな, 食べれる/食べられる, 走ってる/走っている) — that is a word_variant, ' +
					'not a different one. ' +
					'Set noul high (1) when a native speaker reading both aloud would say the same ' +
					'thing with nothing missing and nothing extra. Set it low only for a genuinely ' +
					'different word or reading (町 vs 川, 犬 vs 猫, 作る vs 壊す, student vs teacher) ' +
					'or missing/extra content. A kanji/kana difference alone must never lower the score.',
				criteria: {
					true: 'Same utterance and same content by a native reading',
					false: 'Different utterance, wrong reading, or missing/extra content'
				}
			},
			difference_kind: {
				type: 'choice',
				instructions:
					'Classify the relationship between `reference` and `transcription`. ' +
					'Remember both are punctuation/spacing-stripped and kana-folded, so an identical ' +
					'normalized pair means the original forms differed only in punctuation, spacing, ' +
					'width, case or kana/kanji choice — never in meaning.',
				criteria: {
					identical_text: 'Character-for-character identical as given',
					orthography_variant: 'Same words and reading; spelling differs (kana/kanji, width, case)',
					word_variant: 'Colloquial or shortened form of one word (みな/みんな, 走ってる/走っている)',
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
