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
		});
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
