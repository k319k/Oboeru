import type { Chapter, Sentence } from './types';
import { defaultChapters, defaultSentences } from './default-sentences';

const STORAGE_KEY = 'oboeru:v1';

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
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return [...defaultChapters];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.chapters)) return [...defaultChapters];
		return parsed.chapters as Chapter[];
	} catch {
		return [...defaultChapters];
	}
}

export function saveChapters(chapters: Chapter[]): void {
	const data = loadData();
	data.chapters = chapters;
	saveData(data);
}

export function loadSentences(): Sentence[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return [...defaultSentences];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.sentences)) return [...defaultSentences];
		return parsed.sentences as Sentence[];
	} catch {
		return [...defaultSentences];
	}
}

export function saveSentences(sentences: Sentence[]): void {
	const data = loadData();
	data.sentences = sentences;
	saveData(data);
}

// ---------------------------------------------------------------------------
// Internal read/write (shared structure)
// ---------------------------------------------------------------------------

interface StoreData {
	chapters: Chapter[];
	sentences: Sentence[];
}

function loadData(): StoreData {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return { chapters: [...defaultChapters], sentences: [...defaultSentences] };
		const parsed = JSON.parse(raw);
		return {
			chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [...defaultChapters],
			sentences: Array.isArray(parsed.sentences) ? parsed.sentences : [...defaultSentences]
		};
	} catch {
		return { chapters: [...defaultChapters], sentences: [...defaultSentences] };
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

	// Collect all descendant chapter IDs (depth-first)
	const descendantIds = collectDescendantIds(chapters, id);
	const allIds = new Set([id, ...descendantIds]);

	// Remove chapters and their sentences
	const remainingChapters = chapters.filter((c) => !allIds.has(c.id));
	const remainingSentences = sentences.filter((s) => !allIds.has(s.chapterId));

	saveChapters(remainingChapters);
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
// Sentence CRUD
// ---------------------------------------------------------------------------

export function addSentence(chapterId: string, text: string, language: 'ja' | 'en'): Sentence {
	if (!text.trim()) {
		throw new Error('Sentence text must not be empty');
	}
	if (text.length > 200) {
		throw new Error('Sentence text must not exceed 200 characters');
	}
	const sentences = loadSentences();
	const siblings = sentences.filter((s) => s.chapterId === chapterId);
	const maxOrder = siblings.reduce((max, s) => Math.max(max, s.order), 0);
	const sentence: Sentence = {
		id: generateId(),
		chapterId,
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
	sentences[idx] = { ...sentences[idx], ...updates };
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
 * Get sentences for a specific chapter, ordered by `order`.
 */
export function getChapterSentences(chapterId: string, sentences: Sentence[]): Sentence[] {
	return sentences
		.filter((s) => s.chapterId === chapterId)
		.sort((a, b) => a.order - b.order);
}
