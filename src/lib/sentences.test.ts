import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Chapter, Sentence } from './types';
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
	getChapterSentences
} from './sentences';
import { defaultChapters, defaultSentences } from './default-sentences';

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
			{ id: 's1', chapterId: 'c1', text: 'Hello', language: 'en', order: 0 }
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
			{ id: 's1', chapterId: 'c1', text: 'first', language: 'ja', order: 2 },
			{ id: 's2', chapterId: 'c1', text: 'second', language: 'ja', order: 0 },
			{ id: 's3', chapterId: 'c1', text: 'third', language: 'ja', order: 1 },
			{ id: 's4', chapterId: 'other', text: 'other', language: 'en', order: 0 }
		];
		const result = getChapterSentences('c1', sentences);
		expect(result.map((s) => s.id)).toEqual(['s2', 's3', 's1']);
	});

	it('returns empty array when no sentences match', () => {
		expect(getChapterSentences('missing', [])).toEqual([]);
	});
});
