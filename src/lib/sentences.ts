import type { Chapter, Sentence, Track } from './types';
import { defaultChapters, defaultSentences, defaultTracks } from './default-sentences';

const STORAGE_KEY = 'oboeru:v1';

// 不明な trackId の文は末尾へ（破棄しない）
const UNKNOWN_TRACK_ORDER = 999;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------------------
// localStorage helpers (with corrupt-JSON fallback)
// ---------------------------------------------------------------------------

export function loadChapters(): Chapter[] {
	return loadData().chapters;
}

export function saveChapters(chapters: Chapter[]): void {
	const data = loadData();
	data.chapters = chapters;
	saveData(data);
}

export function loadSentences(): Sentence[] {
	return loadData().sentences;
}

export function saveSentences(sentences: Sentence[]): void {
	const data = loadData();
	data.sentences = sentences;
	saveData(data);
}

export function loadTracks(): Track[] {
	return loadData().tracks;
}

export function saveTracks(tracks: Track[]): void {
	const data = loadData();
	data.tracks = tracks;
	saveData(data);
}

// ---------------------------------------------------------------------------
// Internal read/write (shared structure)
// ---------------------------------------------------------------------------

interface StoreData {
	chapters: Chapter[];
	tracks: Track[];
	sentences: Sentence[];
}

function defaultTrackFor(ch: Chapter): Track {
	return { id: `tr-${ch.id}`, chapterId: ch.id, name: 'トラック1', order: 1 };
}

function loadData(): StoreData {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) {
			return {
				chapters: [...defaultChapters],
				tracks: [...defaultTracks],
				sentences: [...defaultSentences]
			};
		}
		const parsed = JSON.parse(raw);
		const chapters: Chapter[] = Array.isArray(parsed.chapters)
			? parsed.chapters
			: [...defaultChapters];
		const storedSentences: Sentence[] = Array.isArray(parsed.sentences)
			? parsed.sentences
			: [...defaultSentences];
		if (!Array.isArray(parsed.tracks)) {
			// Old format without tracks: synthesize a default track per chapter and
			// backfill trackId (sentences with unknown chapterId are not skipped).
			return {
				chapters,
				tracks: chapters.map(defaultTrackFor),
				sentences: storedSentences.map((s) => ({
					...s,
					trackId: s.trackId ?? `tr-${s.chapterId}`
				}))
			};
		}
		return { chapters, tracks: parsed.tracks, sentences: storedSentences };
	} catch {
		return {
			chapters: [...defaultChapters],
			tracks: [...defaultTracks],
			sentences: [...defaultSentences]
		};
	}
}

function saveData(data: StoreData): void {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Chapter CRUD
// ---------------------------------------------------------------------------

export function addChapter(name: string, parentId: string | null): Chapter {
	if (!name.trim()) {
		throw new Error('Chapter name must not be empty');
	}
	const chapters = loadChapters();
	const siblings = chapters.filter((c) => c.parentId === parentId);
	const maxOrder = siblings.reduce((max, c) => Math.max(max, c.order), 0);
	const chapter: Chapter = {
		id: generateId(),
		name: name.trim(),
		parentId,
		order: maxOrder + 1
	};
	chapters.push(chapter);
	saveChapters(chapters);
	return chapter;
}

export function updateChapter(id: string, updates: Partial<Omit<Chapter, 'id'>>): void {
	const chapters = loadChapters();
	const idx = chapters.findIndex((c) => c.id === id);
	if (idx === -1) throw new Error(`Chapter not found: ${id}`);
	chapters[idx] = { ...chapters[idx], ...updates };
	saveChapters(chapters);
}

export function deleteChapter(id: string): void {
	const chapters = loadChapters();
	const sentences = loadSentences();
	const tracks = loadTracks();

	// Collect all descendant chapter IDs (depth-first)
	const descendantIds = collectDescendantIds(chapters, id);
	const allIds = new Set([id, ...descendantIds]);

	// Remove chapters, their tracks and their sentences
	const remainingChapters = chapters.filter((c) => !allIds.has(c.id));
	const remainingSentences = sentences.filter((s) => !allIds.has(s.chapterId));
	const remainingTracks = tracks.filter((t) => !allIds.has(t.chapterId));

	saveChapters(remainingChapters);
	saveTracks(remainingTracks);
	saveSentences(remainingSentences);
}

function collectDescendantIds(chapters: Chapter[], parentId: string): string[] {
	const children = chapters.filter((c) => c.parentId === parentId);
	const ids: string[] = [];
	for (const child of children) {
		ids.push(child.id);
		ids.push(...collectDescendantIds(chapters, child.id));
	}
	return ids;
}

// ---------------------------------------------------------------------------
// Track CRUD
// ---------------------------------------------------------------------------

export function addTrack(chapterId: string, name: string): Track {
	if (!name.trim()) {
		throw new Error('Track name must not be empty');
	}
	const tracks = loadTracks();
	const siblings = tracks.filter((t) => t.chapterId === chapterId);
	const maxOrder = siblings.reduce((max, t) => Math.max(max, t.order), 0);
	const track: Track = {
		id: generateId(),
		chapterId,
		name: name.trim(),
		order: maxOrder + 1
	};
	tracks.push(track);
	saveTracks(tracks);
	return track;
}

export function updateTrack(id: string, updates: Partial<Omit<Track, 'id'>>): void {
	const tracks = loadTracks();
	const idx = tracks.findIndex((t) => t.id === id);
	if (idx === -1) throw new Error(`Track not found: ${id}`);
	tracks[idx] = { ...tracks[idx], ...updates };
	saveTracks(tracks);
}

export function deleteTrack(id: string): void {
	const tracks = loadTracks();
	const sentences = loadSentences();

	const remainingTracks = tracks.filter((t) => t.id !== id);
	const remainingSentences = sentences.filter((s) => s.trackId !== id);

	saveTracks(remainingTracks);
	saveSentences(remainingSentences);
}

/**
 * Get tracks for a specific chapter, ordered by `order`.
 */
export function getChapterTracks(chapterId: string, tracks: Track[]): Track[] {
	return tracks
		.filter((t) => t.chapterId === chapterId)
		.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------------------
// Sentence CRUD
// ---------------------------------------------------------------------------

/**
 * Add a sentence to a chapter.
 * An empty-string `trackId` is treated as omitted: it auto-resolves to the
 * chapter's first track (creating a default track when the chapter has none).
 */
export function addSentence(
	chapterId: string,
	text: string,
	language: 'ja' | 'en',
	trackId?: string
): Sentence {
	if (!text.trim()) {
		throw new Error('Sentence text must not be empty');
	}
	if (text.length > 200) {
		throw new Error('Sentence text must not exceed 200 characters');
	}
	const tracks = loadTracks();
	let resolvedTrackId = trackId;
	if (!resolvedTrackId) {
		const chapterTracks = getChapterTracks(chapterId, tracks);
		if (chapterTracks.length === 0) {
			const track: Track = { id: `tr-${chapterId}`, chapterId, name: 'トラック1', order: 1 };
			tracks.push(track);
			saveTracks(tracks);
			resolvedTrackId = track.id;
		} else {
			resolvedTrackId = chapterTracks[0].id;
		}
	}
	const sentences = loadSentences();
	const siblings = sentences.filter(
		(s) => s.chapterId === chapterId && s.trackId === resolvedTrackId
	);
	const maxOrder = siblings.reduce((max, s) => Math.max(max, s.order), 0);
	const sentence: Sentence = {
		id: generateId(),
		chapterId,
		trackId: resolvedTrackId,
		text: text.trim(),
		language,
		order: maxOrder + 1
	};
	sentences.push(sentence);
	saveSentences(sentences);
	return sentence;
}

export function updateSentence(id: string, updates: Partial<Omit<Sentence, 'id'>>): void {
	const sentences = loadSentences();
	const idx = sentences.findIndex((s) => s.id === id);
	if (idx === -1) throw new Error(`Sentence not found: ${id}`);
	if (updates.text !== undefined) {
		if (!updates.text.trim()) {
			throw new Error('Sentence text must not be empty');
		}
		if (updates.text.length > 200) {
			throw new Error('Sentence text must not exceed 200 characters');
		}
	}
	const next: Sentence = { ...sentences[idx], ...updates };
	// Track integrity: the saved trackId must belong to the sentence's chapter.
	// Chapter moves without a (valid) trackId resolve the chapter's first track,
	// auto-creating the default one for trackless chapters (mirrors addSentence).
	const chapterTracks = getChapterTracks(next.chapterId, loadTracks());
	if (!chapterTracks.some((t) => t.id === next.trackId)) {
		if (chapterTracks.length === 0) {
			const track: Track = { id: `tr-${next.chapterId}`, chapterId: next.chapterId, name: 'トラック1', order: 1 };
			saveTracks([...loadTracks(), track]);
			next.trackId = track.id;
		} else {
			next.trackId = chapterTracks[0].id;
		}
	}
	sentences[idx] = next;
	saveSentences(sentences);
}

export function deleteSentence(id: string): void {
	const sentences = loadSentences();
	const remaining = sentences.filter((s) => s.id !== id);
	saveSentences(remaining);
}

// ---------------------------------------------------------------------------
// Tree utilities
// ---------------------------------------------------------------------------

/**
 * Flatten the chapter tree in depth-first order by `order` field, unlimited depth.
 * Root-level chapters (parentId === null) come first, sorted by order.
 * For each chapter, its children (sorted by order) follow recursively.
 */
export function flattenChapterTree(chapters: Chapter[]): Chapter[] {
	const result: Chapter[] = [];
	const roots = chapters
		.filter((c) => c.parentId === null)
		.sort((a, b) => a.order - b.order);

	function walk(parentId: string | null): void {
		const children = chapters
			.filter((c) => c.parentId === parentId)
			.sort((a, b) => a.order - b.order);
		for (const child of children) {
			result.push(child);
			walk(child.id);
		}
	}

	// Add roots first
	for (const root of roots) {
		result.push(root);
		walk(root.id);
	}

	return result;
}

/**
 * Get sentences for a specific chapter, ordered by track order first,
 * then by `order` within each track.
 * Sentences whose trackId has no matching track sort last.
 */
export function getChapterSentences(chapterId: string, sentences: Sentence[]): Sentence[] {
	const trackOrder = new Map(loadTracks().map((t) => [t.id, t.order]));
	return sentences
		.filter((s) => s.chapterId === chapterId)
		.sort(
			(a, b) =>
				(trackOrder.get(a.trackId) ?? UNKNOWN_TRACK_ORDER) - (trackOrder.get(b.trackId) ?? UNKNOWN_TRACK_ORDER) ||
				a.order - b.order
		);
}
