import { describe, it, expect } from 'vitest';
import { JEV_MODEL, buildJudgeRequest, parseJudgeResponse } from './jev';

// ─── buildJudgeRequest ───────────────────────────────────────────────
describe('buildJudgeRequest', () => {
	it('builds the exact request body (model/state/questions, all fields)', () => {
		expect(buildJudgeRequest('はじめ', '初め')).toEqual({
			model: 'typesafe/jev-1.13',
			state: { reference: 'はじめ', transcription: '初め' },
			questions: {
				same_utterance: {
					type: 'noul',
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
						word_variant:
							'Colloquial or shortened form of one word (みな/みんな, 走ってる/走っている)',
						different_utterance: 'Actually different words or meaning'
					}
				}
			}
		});
	});

	it('strips punctuation from the state so it cannot be judged', () => {
		const punct = buildJudgeRequest('これらの人びとは、天までとどく塔をたてようと望み、', 'これらの人々は天まで届く塔を建てようと望み');
		const plain = buildJudgeRequest('これらの人びとは天までとどく塔をたてようと望み', 'これらの人々は天まで届く塔を建てようと望み');
		expect(punct.state).toEqual(plain.state);
		expect(punct.state.reference).toBe('これらの人びとは天までとどく塔をたてようと望み');
		expect(punct.state.transcription).toBe('これらの人々は天まで届く塔を建てようと望み');
	});

	it('strips width, Latin case and katakana variants from the state', () => {
		expect(buildJudgeRequest('ＴＯＫＹＯ， に行く', 'とうきょう に 行く').state).toEqual(
			buildJudgeRequest('TOKYO に行く', 'トウキョウに行く').state
		);
	});

	it('keeps real word differences in the state', () => {
		expect(buildJudgeRequest('三階', '二階').state.reference).not.toBe(
			buildJudgeRequest('三階', '二階').state.transcription
		);
	});

	it('exposes the pinned model constant', () => {
		expect(JEV_MODEL).toBe('typesafe/jev-1.13');
		expect(buildJudgeRequest('a', 'b').model).toBe('typesafe/jev-1.13');
	});

	it('has exactly the two noul criteria keys', () => {
		const req = buildJudgeRequest('a', 'b');
		expect(Object.keys(req.questions.same_utterance.criteria)).toEqual(['true', 'false']);
	});

	it('has exactly the four choice option keys', () => {
		const req = buildJudgeRequest('a', 'b');
		expect(Object.keys(req.questions.difference_kind.criteria)).toEqual([
			'identical_text',
			'orthography_variant',
			'word_variant',
			'different_utterance'
		]);
	});
});

// ─── parseJudgeResponse ──────────────────────────────────────────────
/** 実測レスポンス (OpenRouter / systemone) と同じ形。余計なフィールド付き。 */
const VALID_JEV_RESPONSE = {
	model: 'typesafe/jev-1.13-20260917',
	answers: {
		same_utterance: { type: 'noul', noul: 0.97 },
		difference_kind: {
			choice: 'orthography_variant',
			confidence: 0.88,
			probabilities: {
				identical_text: 0.05,
				orthography_variant: 0.88,
				word_variant: 0.04,
				different_utterance: 0.03
			}
		}
	},
	usage: { total_tokens: 123 }
};

/** noul を差し替えた応答 */
const withNoul = (v: unknown) => ({
	...VALID_JEV_RESPONSE,
	answers: {
		...VALID_JEV_RESPONSE.answers,
		same_utterance: { ...VALID_JEV_RESPONSE.answers.same_utterance, noul: v }
	}
});

const withoutNoul = () => {
	const { noul: _omit, ...same } = VALID_JEV_RESPONSE.answers.same_utterance;
	return { ...VALID_JEV_RESPONSE, answers: { ...VALID_JEV_RESPONSE.answers, same_utterance: same } };
};

const withoutChoice = () => {
	const { choice: _omit, ...diff } = VALID_JEV_RESPONSE.answers.difference_kind;
	return {
		...VALID_JEV_RESPONSE,
		answers: { ...VALID_JEV_RESPONSE.answers, difference_kind: diff }
	};
};

const withoutConfidence = () => {
	const { confidence: _omit, ...diff } = VALID_JEV_RESPONSE.answers.difference_kind;
	return {
		...VALID_JEV_RESPONSE,
		answers: { ...VALID_JEV_RESPONSE.answers, difference_kind: diff }
	};
};

/** confidence を差し替えた応答 */
const withConfidence = (v: unknown) => ({
	...VALID_JEV_RESPONSE,
	answers: {
		...VALID_JEV_RESPONSE.answers,
		difference_kind: { ...VALID_JEV_RESPONSE.answers.difference_kind, confidence: v }
	}
});

function expectUnavailable(json: unknown): void {
	expect(parseJudgeResponse(json)).toEqual({ available: false });
}

describe('parseJudgeResponse', () => {
	it('extracts noul/category/confidence from a full valid response', () => {
		expect(parseJudgeResponse(VALID_JEV_RESPONSE)).toEqual({
			available: true,
			noul: 0.97,
			category: 'orthography_variant',
			confidence: 0.88
		});
	});

	it('rejects non-object input', () => {
		expectUnavailable(null);
		expectUnavailable('nope');
		expectUnavailable(42);
		expectUnavailable(undefined);
	});

	it('rejects a response without answers', () => {
		expectUnavailable({});
		expectUnavailable({ model: 'typesafe/jev-1.13-20260917' });
	});

	it('rejects when answers lacks same_utterance', () => {
		expectUnavailable({ answers: { difference_kind: VALID_JEV_RESPONSE.answers.difference_kind } });
	});

	it('rejects a non-numeric noul (string)', () => {
		expectUnavailable(withNoul('0.97'));
	});

	it('rejects a missing noul', () => {
		expectUnavailable(withoutNoul());
	});

	it('rejects when difference_kind is missing', () => {
		expectUnavailable({ answers: { same_utterance: { noul: 0.97 } } });
	});

	it('rejects a missing choice', () => {
		expectUnavailable(withoutChoice());
	});

	it('rejects a choice without confidence', () => {
		expectUnavailable(withoutConfidence());
	});

	it('clamps an out-of-contract finite noul to [0, 1]', () => {
		expect(parseJudgeResponse(withNoul(1.5))).toEqual({
			available: true,
			noul: 1,
			category: 'orthography_variant',
			confidence: 0.88
		});
		expect(
			parseJudgeResponse(withNoul(-0.2))
		).toEqual({ available: true, noul: 0, category: 'orthography_variant', confidence: 0.88 });
	});

	it('rejects a non-numeric confidence', () => {
		expectUnavailable(withConfidence('high'));
	});
});
