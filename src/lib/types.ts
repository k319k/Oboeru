export interface Chapter {
	id: string;
	name: string;
	parentId: string | null;
	order: number;
}

export interface Track {
	id: string;
	chapterId: string;      // 最上位章。所属章を間接的に指定する冗長フィールド
	name: string;
	order: number;          // 同一親 (章 or 親トラック) 内での順序
	parentId: string | null; // NEW。親トラック。null なら章直下
}

export interface Sentence {
	id: string;
	chapterId: string;
	trackId: string;
	text: string;
	language: 'ja' | 'en';
	order: number;
}

export interface Settings {
	threshold: number; // 0-100, default 80
	ttsRate: number; // 0.5-2.0, default 1.0
	voiceURI: string | null;
	retryFrom: 'tts' | 'rerecord';
}

export type PracticeState =
	| 'show'
	| 'tts'
	| 'hidden'
	| 'recording'
	| 'transcribing'
	| 'feedback'
	| 'summary';
