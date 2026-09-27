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
	getChapterTracks,
	flattenTrackTree,
	getNodeDescendantTrackIds,
	getNodeSentences,
	getNodeTrail,
	migrateToV3,
	type StorageData
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
		// Seeded in the *legacy* shape on purpose: the read shim turns every
		// sub-chapter into a track of its root before `deleteChapter` looks at the
		// data, so a sub-chapter can no longer be created through the public API.
		// The recursive sub-tree is deleted as the tracks converted from it.
		storage.store.set(
			STORAGE_KEY,
			JSON.stringify({
				chapters: [
					{ id: 'root', name: 'Root', parentId: null, order: 1 },
					{ id: 'child', name: 'Child', parentId: 'root', order: 1 },
					{ id: 'grandchild', name: 'Grandchild', parentId: 'child', order: 1 }
				],
				tracks: [{ id: 'tr-root', chapterId: 'root', name: 'Root Track', order: 1, parentId: null }],
				sentences: [
					{ id: 's1', chapterId: 'root', trackId: 'tr-root', text: 'root', language: 'en', order: 1 },
					{ id: 's2', chapterId: 'child', trackId: 'tr-root', text: 'child', language: 'en', order: 1 },
					{
						id: 's3',
						chapterId: 'grandchild',
						trackId: 'tr-root',
						text: 'grandchild',
						language: 'ja',
						order: 1
					}
				]
			})
		);
		// The shim has already lifted both levels into tracks of `root`.
		expect(loadTracks().map((t) => t.name)).toEqual([
			'Root Track',
			'Child',
			'Grandchild'
		]);

		deleteChapter('root');

		expect(loadChapters()).toEqual([]);
		expect(loadTracks()).toEqual([]);
		expect(loadSentences()).toEqual([]);
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
		// The chapter must exist: getChapterSentences resolves the node, and an
		// unknown node collects nothing.
		saveChapters([{ id: 'c1', name: 'C1', parentId: null, order: 1 }]);
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
		// The chapter must exist, and there must be at least one sentence that does
		// NOT belong to it — otherwise this passes through the "unknown node → []"
		// path and the chapter filter is never exercised.
		saveChapters([{ id: 'c1', name: 'C', parentId: null, order: 1 }]);
		expect(
			getChapterSentences('c1', [
				{
					id: 's-other',
					chapterId: 'other',
					trackId: 't-other',
					text: '他章の文',
					language: 'ja',
					order: 1
				}
			])
		).toEqual([]);
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
		const tracks: Track[] = [{ id: 't1', chapterId: 'c1', name: 'Track', order: 0, parentId: null }];
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

	it('creates a child track with parentId set', () => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }]);

		const created = addTrack('ch-1', 'A-1', 't1');

		expect(created.parentId).toBe('t1');
		expect(created.chapterId).toBe('ch-1');
		expect(loadTracks().find((t) => t.id === created.id)?.parentId).toBe('t1');
	});

	it('numbers children within their own parent, not across the chapter', () => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null },
			{ id: 't1-1', chapterId: 'ch-1', name: 'A-1', order: 1, parentId: 't1' }
		]);

		addTrack('ch-1', 'A-2', 't1');
		addTrack('ch-1', 'B', null);

		const tracks = loadTracks();
		expect(tracks.find((t) => t.name === 'A-2')?.order).toBe(2);
		expect(tracks.find((t) => t.name === 'B')?.order).toBe(2);
	});

	it('treats a legacy track without parentId as a direct child of the chapter', () => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		// Simulate data written before the parentId field existed
		saveTracks([{ id: 't1', chapterId: 'ch-1', name: 'A', order: 7 } as Track]);

		const created = addTrack('ch-1', 'B');

		expect(created.order).toBe(8);
		expect(created.parentId).toBeNull();
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
			{ id: 't1', chapterId: 'c1', name: 'B', order: 2, parentId: null },
			{ id: 't2', chapterId: 'c1', name: 'A', order: 1, parentId: null },
			{ id: 't3', chapterId: 'c2', name: 'Other', order: 0, parentId: null }
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
		expect(loadTracks()).toEqual([
			{ id: 'tr-c1', chapterId: 'c1', name: 'トラック1', order: 1, parentId: null }
		]);
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
			order: 1,
			parentId: null
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
		// Legacy shape: the sub-chapter's track is converted into a track of the
		// root chapter by the read shim, so "its descendants" are the tracks the
		// sub-chapters were converted into.
		storage.store.set(
			STORAGE_KEY,
			JSON.stringify({
				chapters: [
					{ id: 'root', name: 'Root', parentId: null, order: 1 },
					{ id: 'child', name: 'Child', parentId: 'root', order: 1 }
				],
				tracks: [{ id: 'tr-root', chapterId: 'root', name: 'Root Track', order: 1, parentId: null }],
				sentences: [
					{ id: 's1', chapterId: 'root', trackId: 'tr-root', text: 'root', language: 'en', order: 1 }
				]
			})
		);

		deleteChapter('root');

		const chapterIds = loadTracks().map((t) => t.chapterId);
		expect(chapterIds).not.toContain('root');
		expect(chapterIds).not.toContain('child');
		expect(loadChapters().find((c) => c.id === 'root')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Track hierarchy traversal
// ---------------------------------------------------------------------------

function mkTrack(over: Partial<Track> & { id: string }): Track {
	return { chapterId: 'ch-1', name: over.id, order: 1, parentId: null, ...over };
}

describe('flattenTrackTree', () => {
	it('returns direct children then their subtrees in pre-order', () => {
		const tracks = [
			mkTrack({ id: 't2', name: 'B', order: 2 }),
			mkTrack({ id: 't1-1', name: 'B-1', order: 1, parentId: 't1' }),
			mkTrack({ id: 't1', name: 'A', order: 1 }),
			mkTrack({ id: 't1-2', name: 'A-2', order: 2, parentId: 't1' }),
			mkTrack({ id: 't1-1-1', name: 'A-1-1', order: 1, parentId: 't1-1' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual([
			't1',
			't1-1',
			't1-1-1',
			't1-2',
			't2'
		]);
	});

	it('never collects tracks from another chapter', () => {
		const tracks = [
			mkTrack({ id: 't1', chapterId: 'ch-1' }),
			mkTrack({ id: 'x1', chapterId: 'ch-2' }),
			mkTrack({ id: 'x1-1', chapterId: 'ch-2', parentId: 'x1' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual(['t1']);
	});

	it('returns an empty array for a chapter without tracks', () => {
		expect(flattenTrackTree('ch-none', [mkTrack({ id: 't1' })])).toEqual([]);
	});

	it('keeps only the first of duplicate track ids instead of recursing forever', () => {
		const tracks = [
			mkTrack({ id: 'x', name: 'first', order: 1 }),
			mkTrack({ id: 'x', name: 'second', order: 2, parentId: 'x' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.name)).toEqual(['first']);
	});

	it('does not follow a parentId that points into another chapter', () => {
		const tracks = [
			mkTrack({ id: 't1', chapterId: 'ch-1' }),
			mkTrack({ id: 'foreign', chapterId: 'ch-2' }),
			// A ch-1 track whose parent lives in ch-2: unreachable, and it must not be
			// reachable *through* the foreign node either
			mkTrack({ id: 'orphan', chapterId: 'ch-1', parentId: 'foreign' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual(['t1']);
	});

	it('does not collect another chapter track hanging off a chapter-direct root', () => {
		const tracks = [mkTrack({ id: 't1' }), mkTrack({ id: 'x1', chapterId: 'ch-2', parentId: 't1' })];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual(['t1']);
	});

	it('applies the chapter filter below the first level too', () => {
		const tracks = [
			mkTrack({ id: 't1' }),
			mkTrack({ id: 't1-1', parentId: 't1' }),
			mkTrack({ id: 'x1-1', chapterId: 'ch-2', parentId: 't1-1' })
		];
		expect(flattenTrackTree('ch-1', tracks).map((t) => t.id)).toEqual(['t1', 't1-1']);
	});

	it('does not collect a cycle that has no chapter-direct root', () => {
		const tracks = [mkTrack({ id: 'a', parentId: 'b' }), mkTrack({ id: 'b', parentId: 'a' })];
		// Both nodes are non-root, so walk(null) never enters the cycle.
		expect(flattenTrackTree('ch-1', tracks)).toEqual([]);
	});
});

describe('getNodeDescendantTrackIds', () => {
	it('includes the track itself and all descendants', () => {
		const tracks = [
			mkTrack({ id: 't1' }),
			mkTrack({ id: 't1-1', parentId: 't1' }),
			mkTrack({ id: 't1-1-1', parentId: 't1-1' }),
			mkTrack({ id: 't2' })
		];
		expect([...getNodeDescendantTrackIds('t1', tracks)].sort()).toEqual(['t1', 't1-1', 't1-1-1']);
	});

	it('terminates on a cyclic parentId chain', () => {
		const tracks = [mkTrack({ id: 'a', parentId: 'b' }), mkTrack({ id: 'b', parentId: 'a' })];
		expect([...getNodeDescendantTrackIds('a', tracks)].sort()).toEqual(['a', 'b']);
	});
});

describe('getChapterTracks (pre-order wrapper)', () => {
	it('lists nested tracks after their parent', () => {
		const tracks = [
			mkTrack({ id: 't1' }),
			mkTrack({ id: 't1-1', parentId: 't1' }),
			mkTrack({ id: 't2', order: 2 })
		];
		expect(getChapterTracks('ch-1', tracks).map((t) => t.id)).toEqual(['t1', 't1-1', 't2']);
	});

	it('places a parent before its child even when the child has a lower order', () => {
		const tracks = [
			mkTrack({ id: 't1', order: 2 }),
			mkTrack({ id: 't1-1', parentId: 't1', order: 1 }),
			mkTrack({ id: 't2', order: 1 })
		];
		expect(getChapterTracks('ch-1', tracks).map((t) => t.id)).toEqual(['t2', 't1', 't1-1']);
	});
});

// ---------------------------------------------------------------------------
// getNodeSentences
// ---------------------------------------------------------------------------

function chapter(id: string, name = id): Chapter {
	return { id, name, parentId: null, order: 1 };
}

function sentence(over: Partial<Sentence> & { id: string }): Sentence {
	return { chapterId: 'ch-1', trackId: 't1', text: over.id, language: 'ja', order: 1, ...over };
}

describe('getNodeSentences', () => {
	const chapters = [chapter('ch-1'), chapter('ch-2')];
	// t1 has 2 own sentences; t1-1 / t1-2 are its children; t2 is a sibling
	const tracks = [
		mkTrack({ id: 't1' }),
		mkTrack({ id: 't1-1', parentId: 't1', order: 1 }),
		mkTrack({ id: 't1-2', parentId: 't1', order: 2 }),
		mkTrack({ id: 't2', order: 2 })
	];
	const sentences = [
		sentence({ id: 's-t2', trackId: 't2', order: 1 }),
		sentence({ id: 's-t1-2b', trackId: 't1-2', order: 2 }),
		sentence({ id: 's-t1-2a', trackId: 't1-2', order: 1 }),
		sentence({ id: 's-t1b', trackId: 't1', order: 2 }),
		sentence({ id: 's-t1a', trackId: 't1', order: 1 }),
		sentence({ id: 's-t1-1', trackId: 't1-1', order: 1 }),
		sentence({ id: 's-other-chapter', trackId: 't1', chapterId: 'ch-2', order: 1 })
	];

	it('collects a whole chapter in pre-order: own sentences, then each subtree', () => {
		expect(getNodeSentences('ch-1', chapters, tracks, sentences).map((s) => s.id)).toEqual([
			's-t1a',
			's-t1b',
			's-t1-1',
			's-t1-2a',
			's-t1-2b',
			's-t2'
		]);
	});

	it('collects a track subtree: own sentences first, then child subtrees', () => {
		expect(getNodeSentences('t1', chapters, tracks, sentences).map((s) => s.id)).toEqual([
			's-t1a',
			's-t1b',
			's-t1-1',
			's-t1-2a',
			's-t1-2b'
		]);
	});

	it('collects a leaf track without leaking sibling or parent sentences', () => {
		expect(getNodeSentences('t1-2', chapters, tracks, sentences).map((s) => s.id)).toEqual([
			's-t1-2a',
			's-t1-2b'
		]);
	});

	it('returns an empty array for an unknown node', () => {
		expect(getNodeSentences('nope', chapters, tracks, sentences)).toEqual([]);
	});

	it('keeps sentences with an unknown trackId instead of dropping them', () => {
		// Chapter node: the whole chapter is in scope, so a sentence pointing at a
		// track that no longer exists is still reachable and must sort last.
		// (A track node cannot express this — out-of-scope is unreachable there.)
		// A known-track sentence is mixed in so "last" is a real comparison instead
		// of a vacuous single-element list.
		const mixed = [sentence({ id: 's-t1a' }), sentence({ id: 's-orphan', trackId: 'gone' })];
		expect(getNodeSentences('ch-1', chapters, tracks, mixed).map((s) => s.id)).toEqual([
			's-t1a',
			's-orphan'
		]);
	});

	it('does not collect a sentence whose chapterId does not match the track chapter', () => {
		const stray = sentence({ id: 's-stray', trackId: 't1', chapterId: 'ch-2' });
		expect(getNodeSentences('t1', chapters, tracks, [...sentences, stray]).map((s) => s.id)).not.toContain(
			's-stray'
		);
	});
});

// ---------------------------------------------------------------------------
// getNodeTrail
// ---------------------------------------------------------------------------

describe('getNodeTrail', () => {
	const chapters = [chapter('ch-1', '1章')];
	const tracks = [
		mkTrack({ id: 't1', name: 'トラック1' }),
		mkTrack({ id: 't1-1', name: 'トラック1-1', parentId: 't1' }),
		mkTrack({ id: 't1-1-1', name: 'トラック1-1-1', parentId: 't1-1' })
	];

	it('returns a single chapter ref for a chapter node', () => {
		expect(getNodeTrail('ch-1', chapters, tracks)).toEqual([
			{ type: 'chapter', id: 'ch-1', name: '1章' }
		]);
	});

	it('returns chapter → ancestors → self for a track node', () => {
		expect(getNodeTrail('t1-1-1', chapters, tracks)).toEqual([
			{ type: 'chapter', id: 'ch-1', name: '1章' },
			{ type: 'track', id: 't1', name: 'トラック1' },
			{ type: 'track', id: 't1-1', name: 'トラック1-1' },
			{ type: 'track', id: 't1-1-1', name: 'トラック1-1-1' }
		]);
	});

	it('returns an empty array for an unknown id', () => {
		expect(getNodeTrail('nope', chapters, tracks)).toEqual([]);
	});

	it('omits the chapter when the track has no matching chapter', () => {
		expect(getNodeTrail('t1', [], tracks)).toEqual([{ type: 'track', id: 't1', name: 'トラック1' }]);
	});

	it('terminates on a cyclic parentId chain instead of hanging', () => {
		const cyclic = [mkTrack({ id: 'a', name: 'A', parentId: 'b' }), mkTrack({ id: 'b', name: 'B', parentId: 'a' })];
		// The walk stops as soon as it revisits a node, so `a` is emitted once and
		// the chain does not loop forever. Root-of-cycle order is arbitrary
		// (unshift), so this pins the shape, not the self-last guarantee that the
		// acyclic tests above cover.
		expect(getNodeTrail('a', chapters, cyclic)).toEqual([
			{ type: 'chapter', id: 'ch-1', name: '1章' },
			{ type: 'track', id: 'b', name: 'B' },
			{ type: 'track', id: 'a', name: 'A' }
		]);
	});
});

// ---------------------------------------------------------------------------
// migrateToV3
// ---------------------------------------------------------------------------

describe('migrateToV3', () => {
	const flatData: StorageData = {
		chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
		tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }],
		sentences: [
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '文1', language: 'ja', order: 1 }
		]
	};

	it('passes a v3 payload through unchanged', () => {
		expect(migrateToV3(flatData)).toEqual(flatData);
	});

	it('only adds parentId: null to tracks of a v2 payload', () => {
		const v2: StorageData = {
			...flatData,
			tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1 } as Track]
		};
		const out = migrateToV3(v2);
		expect(out.chapters).toEqual(v2.chapters);
		expect(out.sentences).toEqual(v2.sentences);
		expect(out.tracks).toEqual([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }
		]);
	});

	it('converts a child chapter into a track of its parent chapter', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }],
			sentences: [
				{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '直下', language: 'ja', order: 1 },
				{ id: 's2', chapterId: 'ch-2', trackId: 't1', text: '子', language: 'ja', order: 1 }
			]
		});
		expect(out.chapters.map((c) => c.id)).toEqual(['ch-1']);
		expect(out.tracks.map((t) => t.id)).toEqual(['t1', 'tr-from-ch-ch-2']);
		expect(out.tracks[1]).toEqual({
			id: 'tr-from-ch-ch-2',
			chapterId: 'ch-1',
			name: '子章',
			order: 2,
			parentId: null
		});
		expect(out.sentences).toEqual([
			{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '直下', language: 'ja', order: 1 },
			{ id: 's2', chapterId: 'ch-1', trackId: 'tr-from-ch-ch-2', text: '子', language: 'ja', order: 1 }
		]);
	});

	it('lifts a grandchild chapter into the nearest ancestor chapter', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 },
				{ id: 'ch-3', name: '孫章', parentId: 'ch-2', order: 1 }
			],
			tracks: [],
			sentences: [
				{ id: 's3', chapterId: 'ch-3', trackId: 't-x', text: '孫', language: 'ja', order: 1 }
			]
		});
		expect(out.chapters.map((c) => c.id)).toEqual(['ch-1']);
		expect(out.tracks.map((t) => t.id)).toEqual(['tr-from-ch-ch-2', 'tr-from-ch-ch-3']);
		expect(out.sentences[0].chapterId).toBe('ch-1');
	});

	it('is idempotent', () => {
		const once = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [],
			sentences: [
				{ id: 's2', chapterId: 'ch-2', trackId: 't-x', text: '子', language: 'ja', order: 1 }
			]
		});
		expect(migrateToV3(once)).toEqual(once);
	});

	it('repairs a parentId that points at a missing track', () => {
		const out = migrateToV3({
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: 'deleted-parent' },
				{ id: 't2', chapterId: 'ch-1', name: 'B', order: 2, parentId: 't1' }
			],
			sentences: []
		});
		expect(out.tracks.find((t) => t.id === 't1')?.parentId).toBeNull();
		// a valid parentId is untouched
		expect(out.tracks.find((t) => t.id === 't2')?.parentId).toBe('t1');
	});

	it('keeps a cyclic parentId pair (repair is existence-based, not reachability)', () => {
		const out = migrateToV3({
			chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
			tracks: [
				{ id: 'a', chapterId: 'ch-1', name: 'A', order: 1, parentId: 'b' },
				{ id: 'b', chapterId: 'ch-1', name: 'B', order: 2, parentId: 'a' }
			],
			sentences: []
		});
		expect(out.tracks.find((t) => t.id === 'a')?.parentId).toBe('b');
		expect(out.tracks.find((t) => t.id === 'b')?.parentId).toBe('a');
		// Both parents exist, so the cycle survives and stays invisible to the tree.
		expect(flattenTrackTree('ch-1', out.tracks)).toEqual([]);
	});

	it('re-numbers a converted track when the id already exists', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [
				{ id: 'tr-from-ch-ch-2', chapterId: 'ch-1', name: '既存', order: 1, parentId: null }
			],
			sentences: [
				{ id: 's2', chapterId: 'ch-2', trackId: 't-x', text: '子', language: 'ja', order: 1 }
			]
		});
		expect(out.tracks.map((t) => t.id)).toEqual(['tr-from-ch-ch-2', 'tr-from-ch-ch-2-2']);
		expect(out.sentences[0].trackId).toBe('tr-from-ch-ch-2-2');
	});

	it('places converted tracks after the existing tracks of the ancestor chapter', () => {
		const out = migrateToV3({
			chapters: [
				{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
				{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
			],
			tracks: [
				{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null },
				{ id: 't2', chapterId: 'ch-1', name: 'B', order: 2, parentId: null }
			],
			sentences: []
		});
		expect(out.tracks[2].order).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// loadData migration (through the load* accessors)
// ---------------------------------------------------------------------------

describe('loadData migration (through the load* accessors)', () => {
	it('converts a stored sub-chapter into a track and writes it back', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				chapters: [
					{ id: 'ch-1', name: '1章', parentId: null, order: 1 },
					{ id: 'ch-2', name: '子章', parentId: 'ch-1', order: 1 }
				],
				tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }],
				sentences: [
					{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: '直下', language: 'ja', order: 1 },
					{ id: 's2', chapterId: 'ch-2', trackId: 't1', text: '子', language: 'ja', order: 1 }
				]
			})
		);

		expect(loadChapters().map((c) => c.id)).toEqual(['ch-1']);
		expect(loadTracks().map((t) => t.name)).toEqual(['A', '子章']);

		const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
		expect(stored.chapters).toHaveLength(1);
		expect(stored.tracks.map((t: Track) => t.name)).toEqual(['A', '子章']);
		expect(stored.sentences.find((s: Sentence) => s.id === 's2').chapterId).toBe('ch-1');
	});

	it('backfills parentId: null on legacy tracks that have no parentId', () => {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				chapters: [{ id: 'ch-1', name: '1章', parentId: null, order: 1 }],
				tracks: [{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1 }],
				sentences: [
					{ id: 's1', chapterId: 'ch-1', trackId: 't1', text: 'あ', language: 'ja', order: 1 }
				]
			})
		);

		// Read path must hand out a fully-populated Track: the hierarchy functions
		// compare `t.parentId === null` directly, so `undefined` would misclassify
		// a legacy chapter-direct track as a child track.
		expect(loadTracks()).toEqual([
			{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }
		]);
	});

	it('leaves already-migrated data untouched (no extra write)', () => {
		saveChapters([{ id: 'ch-1', name: '1章', parentId: null, order: 1 }]);
		saveTracks([{ id: 't1', chapterId: 'ch-1', name: 'A', order: 1, parentId: null }]);
		saveSentences([]);
		const before = localStorage.getItem(STORAGE_KEY);
		storage.setItem.mockClear();
		loadChapters();
		expect(storage.setItem).not.toHaveBeenCalled();
		expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
	});
});
