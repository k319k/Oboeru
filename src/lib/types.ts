export interface Chapter {
	id: string;
	name: string;
	parentId: string | null;
	order: number;
}

export interface Track {
	id: string;
	chapterId: string;
	name: string;
	order: number;
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
