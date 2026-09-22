import { describe, it, expect, vi, afterEach } from 'vitest';
import { _handleJudgeRequest } from './+server';

function post(body: unknown): Request {
	return new Request('http://localhost/api/judge', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

/** 実測レスポンス (OpenRouter / systemone) と同じ形 */
const VALID_JEV_RESPONSE = {
	model: 'typesafe/jev-1.13-20260917',
	answers: {
		same_utterance: { type: 'noul', noul: 0.97 },
		difference_kind: { choice: 'orthography_variant', confidence: 0.88 }
	}
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('_handleJudgeRequest', () => {
	it('returns 200 {available:false} when the API key is missing (no fetch)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await _handleJudgeRequest(post({ reference: 'はじめ', transcription: '初め' }), undefined);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ available: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 200 {available:false} for an invalid JSON body', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const res = await _handleJudgeRequest(post('not json'), 'key');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ available: false });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 200 {available:false} for blank reference or transcription (no fetch)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		for (const body of [
			{ reference: '', transcription: '初め' },
			{ reference: 'はじめ', transcription: '   ' },
			{ reference: 123, transcription: '初め' },
			{}
		]) {
			const res = await _handleJudgeRequest(post(body), 'key');
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ available: false });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 200 {available:false} when reference or transcription exceeds 2000 chars (no fetch)', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const tooLong = 'あ'.repeat(2001);
		for (const body of [
			{ reference: tooLong, transcription: '初め' },
			{ reference: 'はじめ', transcription: tooLong }
		]) {
			const res = await _handleJudgeRequest(post(body), 'key');
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ available: false });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('returns 200 {available:true,...} on success and calls Jev with the exact request', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(VALID_JEV_RESPONSE), { status: 200 })
		);
		vi.stubGlobal('fetch', fetchMock);
		const res = await _handleJudgeRequest(post({ reference: 'はじめ', transcription: '初め' }), 'key');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			available: true,
			noul: 0.97,
			category: 'orthography_variant',
			confidence: 0.88
		});

		// Jev called once, with the exact endpoint/headers/body
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://openrouter.ai/api/v1/systemone');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key');
		expect(JSON.parse(String(init.body))).toEqual({
			model: 'typesafe/jev-1.13',
			state: { reference: 'はじめ', transcription: '初め' },
			questions: {
				same_utterance: expect.objectContaining({ type: 'noul' }),
				difference_kind: expect.objectContaining({ type: 'choice' })
			}
		});
	});

	it('retries once on 429 and succeeds on the second call', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(VALID_JEV_RESPONSE), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const res = await _handleJudgeRequest(post({ reference: 'はじめ', transcription: '初め' }), 'key');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			available: true,
			noul: 0.97,
			category: 'orthography_variant',
			confidence: 0.88
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('returns 200 {available:false} when Jev returns an error payload', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad criteria"}}', { status: 200 }))
		);
		const res = await _handleJudgeRequest(post({ reference: 'はじめ', transcription: '初め' }), 'key');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ available: false });
	});

	it('returns 200 {available:false} when the upstream response is not JSON', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('<html>gateway error</html>', { status: 200 }))
		);
		const res = await _handleJudgeRequest(post({ reference: 'はじめ', transcription: '初め' }), 'key');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ available: false });
	});
});
