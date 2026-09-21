import type { Chapter, Sentence, Track } from './types';

export const defaultChapters: Chapter[] = [
	{ id: 'ch-ja-01', name: 'はじめの一歩（日本語）', parentId: null, order: 1 },
	{ id: 'ch-en-01', name: 'First Steps（English）', parentId: null, order: 2 },
];

export const defaultTracks: Track[] = [
	{ id: 'tr-ch-ja-01', chapterId: 'ch-ja-01', name: 'トラック1', order: 1 },
	{ id: 'tr-ch-en-01', chapterId: 'ch-en-01', name: 'トラック1', order: 1 },
];

export const defaultSentences: Sentence[] = [
	// --- Japanese (10 sentences) ---
	{ id: 'ja-01', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'おはようございます。今日も一日よろしくお願いします。', language: 'ja', order: 1 },
	{ id: 'ja-02', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'すみません、この道は駅までどこまで行きますか。', language: 'ja', order: 2 },
	{ id: 'ja-03', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: '私は田中です。東京から来ました。よろしくお願いします。', language: 'ja', order: 3 },
	{ id: 'ja-04', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'これをお願いします。いくらですか。', language: 'ja', order: 4 },
	{ id: 'ja-05', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'すみません、これはどこで買えますか。', language: 'ja', order: 5 },
	{ id: 'ja-06', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: '今日の天気はいいですね。散歩に行きませんか。', language: 'ja', order: 6 },
	{ id: 'ja-07', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'お腹が空きました。近くにレストランがありますか。', language: 'ja', order: 7 },
	{ id: 'ja-08', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'すみません、写真を撮っていただけますか。', language: 'ja', order: 8 },
	{ id: 'ja-09', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: '電車は何分に来ますか。次の電車はいつですか。', language: 'ja', order: 9 },
	{ id: 'ja-10', chapterId: 'ch-ja-01', trackId: 'tr-ch-ja-01', text: 'ありがとうございました。また明日会いましょう。', language: 'ja', order: 10 },

	// --- English (10 sentences) ---
	{ id: 'en-01', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'Good morning. Nice to meet you. My name is Tanaka.', language: 'en', order: 1 },
	{ id: 'en-02', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'Excuse me, how do I get to the nearest station?', language: 'en', order: 2 },
	{ id: 'en-03', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'I would like to order this one, please. How much is it?', language: 'en', order: 3 },
	{ id: 'en-04', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'Sorry, where can I buy this?', language: 'en', order: 4 },
	{ id: 'en-05', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'The weather is nice today, isn\'t it? Shall we go for a walk?', language: 'en', order: 5 },
	{ id: 'en-06', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'I\'m hungry. Is there a restaurant around here?', language: 'en', order: 6 },
	{ id: 'en-07', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'Excuse me, could you take a photo for me, please?', language: 'en', order: 7 },
	{ id: 'en-08', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'What time does the next train come?', language: 'en', order: 8 },
	{ id: 'en-09', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'Thank you very much. Let\'s meet again tomorrow.', language: 'en', order: 9 },
	{ id: 'en-10', chapterId: 'ch-en-01', trackId: 'tr-ch-en-01', text: 'I am from Tokyo, Japan. It\'s nice to meet you.', language: 'en', order: 10 },
];
