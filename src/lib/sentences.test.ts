import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Chapter, Sentence, Track } from './types';
import {
	loadChapters,
	saveChapters,
	loadSentences,
	saveSentences,
	addChapter,
	updateChapter,
	deleteChapter,
	addSentence,
	updateSentence,
	deleteSentence,
	flattenChapterTree,
	getChapterSentences,
	loadTracks,
	saveTracks,
	addTrack,
	updateTrack,
	deleteTrack,
	getChapterTracks
} from './sentences';
import { defaultChapters, defaultSentences, defaultTracks } from './default-sentences';

const STORAGE_KEY = 'oboeru:v1';

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

function createStorageMock() {
	const store = new Map<string, string>();
	const getItem = vi.fn((key: string) => (store.has(key) ? store.get(key)! : null));
	const setItem = vi.fn((key: string, value: string) => {
		store.set(key, value);
	});
	const removeItem = vi.fn((key: string) => {
		store.delete(key);
	});
	const clear = vi.fn(() => {
		store.clear();
	});
	return { store, getItem, setItem, removeItem, clear };
}

let storage: ReturnType<typeof createStorageMock>;

beforeEach(() => {
	storage = createStorageMock();
	vi.stubGlobal('localStorage', {
		getItem: storage.getItem,
		setItem: storage.setItem,
		removeItem: storage.removeItem,
		clear: storage.clear
	});
});

// ---------------------------------------------------------------------------
// load / save
// ---------------------------------------------------------------------------

describe('loadChapters / saveChapters', () => {
	it('returns defaults when localStorage is empty', () => {
		expect(loadChapters()).toEqual(defaultChapters);
	});

	it('saves and loads chapters', () => {
		const chapters: Chapter[] = [{ id: 'c1', name: 'Test', parentId: null, order: 0 }];
		saveChapters(chapters);
		expect(storage.setItem).toHaveBeenCalled();
		expect(loadChapters()).toEqual(chapters);
	});

	it('falls back to defaults on corrupt JSON', () => {
		storage.store.set(STORAGE_KEY, '{broken');
		expect(() => loadChapters()).not.toThrow();
		expect(loadChapters()).toEqual(defaultChapters);
	});

	it('falls back to defaults when chapters array is missing', () => {
		storage.store.set(STORAGE_KEY, JSON.stringify({ sentences: [] }));
		expect(loadChapters()).toEqual(defaultChapters);
	});
});

describe('loadSentences / saveSentences', () => {
	it('returns defaults when localStorage is empty', () => {
		expect(loadSentences()).toEqual(defaultSentences);
	});

	it('saves and loads sentences', () => {
		const sentences: Sentence[] = [
			{ id: 's1', chapterId: 'c1', trackId: 'tr-c1', text: 'Hello', language: 'en', order: 0 }
		];
		saveSentences(sentences);
		expect(loadSentences()).toEqual(sentences);
	});

	it('falls back to defaults on corrupt JSON', () => {
		storage.store.set(STORAGE_KEY, 'not-json');
		expect(() => loadSentences()).not.toThrow();
		expect(loadSentences()).toEqual(defaultSentences);
	});
});

// ---------------------------------------------------------------------------
// Chapter CRUD
// ---------------------------------------------------------------------------

describe('addChapter', () => {
	it('adds a root chapter with generated id and next order', () => {
		const chapter = addChapter('New Chapter', null);
		expect(chapter.id).toBeTruthy();
		expect(chapter.name).toBe('New Chapter');
		expect(chapter.parentId).toBeNull();
		expect(chapter.order).toBeGreaterThan(0);
		expect(loadChapters()).toContainEqual(chapter);
	});

	it('adds a child chapter under a parent', () => {
		const parent = addChapter('Parent', null);
		const child = addChapter('Child', parent.id);
		expect(child.parentId).toBe(parent.id);
	});

	it('rejects empty name', () => {
		expect(() => addChapter('   ', null)).toThrow();
	});
});

describe('updateChapter', () => {
	it('updates chapter fields', () => {
		const chapter = addChapter('Original', null);
		updateChapter(chapter.id, { name: 'Renamed' });
		const updated = loadChapters().find((c) => c.id === chapter.id);
		expect(updated?.name).toBe('Renamed');
	});

	it('throws when chapter does not exist', () => {
		expect(() => updateChapter('nope', { name: 'x' })).toThrow();
	});
});

describe('deleteChapter', () => {
	it('deletes a chapter and its sentences', () => {
		const chapter = addChapter('To Delete', null);
		addSentence(chapter.id, 'some text', 'ja');
		deleteChapter(chapter.id);
		expect(loadChapters().find((c) => c.id === chapter.id)).toBeUndefined();
		expect(loadSentences().filter((s) => s.chapterId === chapter.id)).toHaveLength(0);
	});

	it('deletes descendant chapters and their sentences recursively', () => {
		const root = addChapter('Root', null);
		const child = addChapter('Child', root.id);
		const grandchild = addChapter('Grandchild', child.id);
		addSentence(child.id, 'child sentence', 'en');
		addSentence(grandchild.id, 'grandchild sentence', 'ja');

		deleteChapter(root.id);

		const chapters = loadChapters();
		expect(chapters.find((c) => c.id === root.id)).toBeUndefined();
		expect(chapters.find((c) => c.id === child.id)).toBeUndefined();
		expect(chapters.find((c) => c.id === grandchild.id)).toBeUndefined();

		const sentences = loadSentences();
		expect(sentences.filter((s) => s.chapterId === child.id)).toHaveLength(0);
		expect(sentences.filter((s) => s.chapterId === grandchild.id)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Sentence CRUD
// ---------------------------------------------------------------------------

describe('addSentence', () => {
	it('adds a sentence with generated id and next order', () => {
		const chapter = addChapter('C', null);
		const sentence = addSentence(chapter.id, 'Hello world', 'en');
		expect(sentence.id).toBeTruthy();
		expect(sentence.chapterId).toBe(chapter.id);
		expect(sentence.text).toBe('Hello world');
		expect(sentence.language).toBe('en');
		expect(loadSentences()).toContainEqual(sentence);
	});

	it('rejects empty text', () => {
		const chapter = addChapter('C', null);
		expect(() => addSentence(chapter.id, '   ', 'ja')).toThrow();
	});

	it('rejects text longer than 200 characters', () => {
		const chapter = addChapter('C', null);
		const longText = 'a'.repeat(201);
		expect(() => addSentence(chapter.id, longText, 'ja')).toThrow();
	});

	it('accepts text of exactly 200 characters', () => {
		const chapter = addChapter('C', null);
		const text = 'a'.repeat(200);
		const sentence = addSentence(chapter.id, text, 'ja');
		expect(sentence.text).toHaveLength(200);
	});
});

describe('updateSentence', () => {
	it('updates sentence fields', () => {
		const chapter = addChapter('C', null);
		const sentence = addSentence(chapter.id, 'original', 'ja');
		updateSentence(sentence.id, { text: 'updated', language: 'en' });
		const updated = loadSentences().find((s) => s.id === sentence.id);
		expect(updated?.text).toBe('updated');
		expect(updated?.language).toBe('en');
	});

	it('rejects empty text on update', () => {
		const chapter = addChapter('C', null);
		const sentence = addSentence(chapter.id, 'original', 'ja');
		expect(() => updateSentence(sentence.id, { text: '  ' })).toThrow();
	});

	it('rejects text longer than 200 chars on update', () => {
		const chapter = addChapter('C', null);
		const sentence = addSentence(chapter.id, 'original', 'ja');
		expect(() => updateSentence(sentence.id, { text: 'b'.repeat(201) })).toThrow();
	});

	it('throws when sentence does not exist', () => {
		expect(() => updateSentence('nope', { text: 'x' })).toThrow();
	});
});

describe('deleteSentence', () => {
	it('deletes a sentence', () => {
		const chapter = addChapter('C', null);
		const sentence = addSentence(chapter.id, 'to delete', 'ja');
		deleteSentence(sentence.id);
		expect(loadSentences().find((s) => s.id === sentence.id)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// flattenChapterTree
// ---------------------------------------------------------------------------

describe('flattenChapterTree', () => {
	it('flattens a simple tree in depth-first order by order field', () => {
		const chapters: Chapter[] = [
			{ id: 'a', name: 'A', parentId: null, order: 0 },
			{ id: 'b', name: 'B', parentId: null, order: 1 },
			{ id: 'a1', name: 'A1', parentId: 'a', order: 0 },
			{ id: 'a2', name: 'A2', parentId: 'a', order: 1 },
			{ id: 'b1', name: 'B1', parentId: 'b', order: 0 }
		];
		const flat = flattenChapterTree(chapters);
		expect(flat.map((c) => c.id)).toEqual(['a', 'a1', 'a2', 'b', 'b1']);
	});

	it('handles unlimited depth', () => {
		const chapters: Chapter[] = [
			{ id: 'l1', name: 'L1', parentId: null, order: 0 },
			{ id: 'l2', name: 'L2', parentId: 'l1', order: 0 },
			{ id: 'l3', name: 'L3', parentId: 'l2', order: 0 },
			{ id: 'l4', name: 'L4', parentId: 'l3', order: 0 },
			{ id: 'l5', name: 'L5', parentId: 'l4', order: 0 }
		];
		const flat = flattenChapterTree(chapters);
		expect(flat.map((c) => c.id)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
	});

	it('sorts siblings by order', () => {
		const chapters: Chapter[] = [
			{ id: 'a', name: 'A', parentId: null, order: 5 },
			{ id: 'b', name: 'B', parentId: null, order: 1 },
			{ id: 'c', name: 'C', parentId: null, order: 3 }
		];
		const flat = flattenChapterTree(chapters);
		expect(flat.map((c) => c.id)).toEqual(['b', 'c', 'a']);
	});

	it('returns empty array for empty input', () => {
		expect(flattenChapterTree([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// getChapterSentences
// ---------------------------------------------------------------------------

describe('getChapterSentences', () => {
	it('returns sentences for a chapter ordered by order', () => {
		const sentences: Sentence[] = [
			{ id: 's1', chapterId: 'c1', trackId: 'tr-c1', text: 'first', language: 'ja', order: 2 },
			{ id: 's2', chapterId: 'c1', trackId: 'tr-c1', text: 'second', language: 'ja', order: 0 },
			{ id: 's3', chapterId: 'c1', trackId: 'tr-c1', text: 'third', language: 'ja', order: 1 },
			{ id: 's4', chapterId: 'other', trackId: 'tr-c2', text: 'other', language: 'en', order: 0 }
		];
		const result = getChapterSentences('c1', sentences);
		expect(result.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
	});

	it('returns empty array when no sentences match', () => {
		expect(getChapterSentences('missing', [])).toEqual([]);
	});

	it('orders sentences by track order first, then sentence order', () => {
		const chapter = addChapter('C', null);
		const trackA = addTrack(chapter.id, 'A');
		const trackB = addTrack(chapter.id, 'B');
		const sentences: Sentence[] = [
			{ id: 's1', chapterId: chapter.id, trackId: trackB.id, text: 'b1', language: 'ja', order: 1 },
			{ id: 's2', chapterId: chapter.id, trackId: trackA.id, text: 'a2', language: 'ja', order: 2 },
			{ id: 's3', chapterId: chapter.id, trackId: trackB.id, text: 'b2', language: 'ja', order: 2 },
			{ id: 's4', chapterId: chapter.id, trackId: trackA.id, text: 'a1', language: 'ja', order: 1 }
		];
		saveSentences(sentences);

		const result = getChapterSentences(chapter.id, loadSentences());
		expect(result.map((s) => s.id)).toEqual(['s4', 's2', 's1', 's3']);
	});

	it('sorts sentences with an unknown trackId last without dropping them', () => {
		const chapter = addChapter('C', null);
		const track = addTrack(chapter.id, 'T');
		const sentences: Sentence[] = [
			{
				id: 's1',
				chapterId: chapter.id,
				trackId: 'tr-unknown',
				text: 'orphan',
				language: 'ja',
				order: 1
			},
			{
				id: 's2',
				chapterId: chapter.id,
				trackId: track.id,
				text: 'in track',
				language: 'ja',
				order: 2
			}
		];
		saveSentences(sentences);

		const result = getChapterSentences(chapter.id, loadSentences());
		expect(result).toHaveLength(2);
		expect(result.map((s) => s.id)).toEqual(['s2', 's1']);
	});
});

// ---------------------------------------------------------------------------
// loadTracks / saveTracks
// ---------------------------------------------------------------------------

describe('loadTracks / saveTracks', () => {
	it('returns default tracks when localStorage is empty', () => {
		expect(loadTracks()).toEqual(defaultTracks);
	});

	it('saves and loads tracks', () => {
		const tracks: Track[] = [{ id: 't1', chapterId: 'c1', name: 'Track', order: 0 }];
		saveTracks(tracks);
		expect(storage.setItem).toHaveBeenCalled();
		expect(loadTracks()).toEqual(tracks);
	});

	it('falls back to defaults on corrupt JSON', () => {
		storage.store.set(STORAGE_KEY, '{broken');
		expect(() => loadTracks()).not.toThrow();
		expect(loadTracks()).toEqual(defaultTracks);
	});
});

// ---------------------------------------------------------------------------
// Track CRUD
// ---------------------------------------------------------------------------

describe('addTrack', () => {
	it('adds a track with generated id and chapter-scoped next order', () => {
		const chapter = addChapter('C', null);
		const other = addChapter('Other', null);
		const t1 = addTrack(chapter.id, 'Track 1');
		const t2 = addTrack(chapter.id, 'Track 2');
		const t3 = addTrack(other.id, 'Other Track');
		expect(t1.id).toBeTruthy();
		expect(t1.chapterId).toBe(chapter.id);
		expect(t1.name).toBe('Track 1');
		expect(t1.order).toBe(1);
		expect(t2.order).toBe(2);
		expect(t3.order).toBe(1);
		expect(loadTracks()).toContainEqual(t1);
	});

	it('trims the track name', () => {
		const chapter = addChapter('C', null);
		const track = addTrack(chapter.id, '  Padded  ');
		expect(track.name).toBe('Padded');
	});

	it('rejects empty name', () => {
		const chapter = addChapter('C', null);
		expect(() => addTrack(chapter.id, '   ')).toThrow();
	});
});

describe('updateTrack', () => {
	it('updates track fields', () => {
		const chapter = addChapter('C', null);
		const track = addTrack(chapter.id, 'Original');
		updateTrack(track.id, { name: 'Renamed', order: 5 });
		const updated = loadTracks().find((t) => t.id === track.id);
		expect(updated?.name).toBe('Renamed');
		expect(updated?.order).toBe(5);
	});

	it('throws when track does not exist', () => {
		expect(() => updateTrack('nope', { name: 'x' })).toThrow();
	});
});

describe('deleteTrack', () => {
	it('deletes a track and its sentences', () => {
		const chapter = addChapter('C', null);
		const track = addTrack(chapter.id, 'T');
		const otherTrack = addTrack(chapter.id, 'Other');
		const sentence = addSentence(chapter.id, 'in track', 'ja', track.id);
		const keptSentence = addSentence(chapter.id, 'in other track', 'ja', otherTrack.id);

		deleteTrack(track.id);

		expect(loadTracks().find((t) => t.id === track.id)).toBeUndefined();
		expect(loadSentences().find((s) => s.id === sentence.id)).toBeUndefined();
		expect(loadSentences().find((s) => s.id === keptSentence.id)).toBeDefined();
	});
});

describe('getChapterTracks', () => {
	it('returns tracks for a chapter ordered by order', () => {
		const tracks: Track[] = [
			{ id: 't1', chapterId: 'c1', name: 'B', order: 2 },
			{ id: 't2', chapterId: 'c1', name: 'A', order: 1 },
			{ id: 't3', chapterId: 'c2', name: 'Other', order: 0 }
		];
		const result = getChapterTracks('c1', tracks);
		expect(result.map((t) => t.id)).toEqual(['t2', 't1']);
	});

	it('returns empty array when no tracks match', () => {
		expect(getChapterTracks('missing', [])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Old-format read shim
// ---------------------------------------------------------------------------

describe('old-format read shim', () => {
	const oldData = {
		chapters: [{ id: 'c1', name: 'C1', parentId: null, order: 1 }],
		sentences: [
			{ id: 's1', chapterId: 'c1', text: 'hello', language: 'ja', order: 1 },
			{ id: 's2', chapterId: 'unknown-chapter', text: 'orphan', language: 'en', order: 2 }
		]
	};

	it('synthesizes a default track per chapter when stored data has no tracks', () => {
		storage.store.set(STORAGE_KEY, JSON.stringify(oldData));
		expect(loadTracks()).toEqual([{ id: 'tr-c1', chapterId: 'c1', name: 'トラック1', order: 1 }]);
	});

	it('backfills trackId on sentences without skipping unknown chapters', () => {
		storage.store.set(STORAGE_KEY, JSON.stringify(oldData));
		const sentences = loadSentences();
		expect(sentences.find((s) => s.id === 's1')?.trackId).toBe('tr-c1');
		expect(sentences.find((s) => s.id === 's2')?.trackId).toBe('tr-unknown-chapter');
	});

	it('persists tracks and trackId on the next save so new saves use the new format', () => {
		storage.store.set(STORAGE_KEY, JSON.stringify(oldData));
		saveChapters(loadChapters());
		const parsed = JSON.parse(storage.store.get(STORAGE_KEY)!);
		expect(Array.isArray(parsed.tracks)).toBe(true);
		expect(parsed.sentences[0].trackId).toBe('tr-c1');
	});
});

// ---------------------------------------------------------------------------
// addSentence with tracks
// ---------------------------------------------------------------------------

describe('addSentence with tracks', () => {
	it('uses the chapter first track when trackId is omitted', () => {
		const chapter = addChapter('C', null);
		const first = addTrack(chapter.id, 'First');
		addTrack(chapter.id, 'Second');
		const sentence = addSentence(chapter.id, 'hello', 'ja');
		expect(sentence.trackId).toBe(first.id);
	});

	it('auto-creates the default track when the chapter has no tracks', () => {
		const chapter = addChapter('C', null);
		const sentence = addSentence(chapter.id, 'hello', 'ja');
		expect(sentence.trackId).toBe(`tr-${chapter.id}`);
		expect(loadTracks()).toContainEqual({
			id: `tr-${chapter.id}`,
			chapterId: chapter.id,
			name: 'トラック1',
			order: 1
		});
	});

	it('assigns order scoped to the chapter and track', () => {
		const chapter = addChapter('C', null);
		const t1 = addTrack(chapter.id, 'First');
		const t2 = addTrack(chapter.id, 'Second');
		const s1 = addSentence(chapter.id, 'one', 'ja', t1.id);
		const s2 = addSentence(chapter.id, 'two', 'ja', t2.id);
		const s3 = addSentence(chapter.id, 'three', 'ja', t1.id);
		expect(s1.order).toBe(1);
		expect(s2.order).toBe(1);
		expect(s3.order).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// deleteChapter with tracks
// ---------------------------------------------------------------------------

describe('deleteChapter with tracks', () => {
	it('deletes tracks of the chapter and its descendants', () => {
		const root = addChapter('Root', null);
		const child = addChapter('Child', root.id);
		addTrack(root.id, 'Root Track');
		addTrack(child.id, 'Child Track');

		deleteChapter(root.id);

		const chapterIds = loadTracks().map((t) => t.chapterId);
		expect(chapterIds).not.toContain(root.id);
		expect(chapterIds).not.toContain(child.id);
	});
});
