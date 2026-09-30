import type { Chapter, Sentence, Track } from './types';
import { defaultChapters, defaultSentences, defaultTracks } from './default-sentences';

const STORAGE_KEY = 'oboeru:v1';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateId(): string {
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

export interface StorageData {
	chapters: Chapter[];
	tracks: Track[];
	sentences: Sentence[];
}

function defaultTrackFor(ch: Chapter): Track {
	return { id: `tr-${ch.id}`, chapterId: ch.id, name: 'トラック1', order: 1, parentId: null };
}

/**
 * Normalise stored / imported data to the track-hierarchy schema: sub-chapters
 * become tracks of their nearest ancestor chapter (their own tracks move along,
 * so the sentence grouping survives), every chapter becomes a root (parentId
 * null) and every track gets a parentId. A sub-chapter whose root cannot be
 * resolved is kept as a root chapter instead of being converted — dropping it
 * would make everything below it unreachable. Idempotent — running it on its own
 * output changes nothing.
 */
export function migrateToV3(data: StorageData): StorageData {
	const chapterById = new Map(data.chapters.map((c) => [c.id, c]));
	// Walk up the chapter tree to the root chapter that would survive the
	// migration. `null` means "unresolvable" — a missing ancestor or a cycle.
	//
	// **Unresolvable chapters must not be dropped** (spec §移行 rule 4): converting
	// them would put the generated track's `chapterId` on a chapter that does not
	// exist, so every sentence under it becomes unreachable from the UI and from
	// `getNodeSentences` — permanently, because the shim is idempotent and would
	// not heal it. Such a chapter stays a root instead.
	const rootChapterIdOf = (chapterId: string): string | null => {
		let current = chapterId;
		const guard = new Set<string>();
		while (!guard.has(current)) {
			guard.add(current);
			const chapter = chapterById.get(current);
			if (!chapter) return null;
			const parentId = chapter.parentId ?? null;
			if (parentId === null) return chapter.id;
			current = parentId;
		}
		return null;
	};
	// A missing `parentId` key means "root", so normalise before classifying.
	const isRootChapter = (c: Chapter): boolean => (c.parentId ?? null) === null;
	const survivingChapters: Chapter[] = data.chapters
		.filter((c) => isRootChapter(c) || rootChapterIdOf(c.id) === null)
		.map((c) => ({ ...c, parentId: null }));
	// Only sub-chapters that resolve to a surviving root are converted.
	const nestedChapters: Chapter[] = data.chapters.filter(
		(c) => !isRootChapter(c) && rootChapterIdOf(c.id) !== null
	);
	// A `parentId` pointing at a track that does not exist would make the track
	// unreachable in `flattenTrackTree` (invisible in the tree, and `addSentence`
	// would attach its sentences to a different track), so repair those to null.
	//
	// **Definition matters**: the test is "the parent id is not in this payload",
	// NOT "the track cannot reach a chapter-direct root". A reachability-based
	// rule would also promote `a(parent: b) ↔ b(parent: a)` cycles to roots, which
	// breaks the cycle invariant test in `sentences.test.ts`. `flattenTrackTree`'s
	// `seen` set already makes cycle data terminate, so no further guard is needed.
	const trackIds = new Set(data.tracks.map((t) => t.id));
	const tracks: Track[] = data.tracks.map((t) => ({
		...t,
		parentId:
			t.parentId !== null && t.parentId !== undefined && trackIds.has(t.parentId)
				? t.parentId
				: null
	}));
	const sentences: Sentence[] = data.sentences.map((s) => ({ ...s }));

	if (nestedChapters.length === 0) {
		return { chapters: survivingChapters, tracks, sentences };
	}

	const usedTrackIds = new Set(tracks.map((t) => t.id));
	for (const oldChapter of nestedChapters) {
		const ownerId = rootChapterIdOf(oldChapter.id);
		// `nestedChapters` only holds resolvable chapters, so this cannot be null.
		if (ownerId === null) continue;

		// The sub-chapter's own tracks move to the ancestor chapter (spec rule 3) so
		// their sentence grouping survives. `ownTrackIds` is captured *before* the
		// tracks are re-parented, because the sentence rule below (rule 5) asks
		// whether the sentence's `trackId` was valid *before* the migration.
		const ownTracks = tracks.filter((t) => t.chapterId === oldChapter.id);
		const ownTrackIds = new Set(ownTracks.map((t) => t.id));
		let nextOrder = tracks
			.filter((t) => t.chapterId === ownerId && (t.parentId ?? null) === null)
			.reduce((max, t) => Math.max(max, t.order), 0);
		for (const t of ownTracks) {
			t.chapterId = ownerId;
			if ((t.parentId ?? null) === null) {
				// Chapter-direct tracks join the end of the ancestor chapter's list.
				// A nested track keeps its parent — the parent is re-parented too, so
				// the whole sub-tree stays reachable without losing its depth.
				t.order = ++nextOrder;
			}
		}

		const base = `tr-from-ch-${oldChapter.id}`;
		let newId = base;
		let n = 2;
		while (usedTrackIds.has(newId)) {
			newId = `${base}-${n}`;
			n++;
		}
		usedTrackIds.add(newId);
		nextOrder += 1;
		tracks.push({
			id: newId,
			chapterId: ownerId,
			name: oldChapter.name,
			order: nextOrder,
			parentId: null
		});
		for (const s of sentences) {
			if (s.chapterId !== oldChapter.id) continue;
			s.chapterId = ownerId;
			// Spec rule 5: sentences that still point at one of the re-parented
			// tracks keep it (sub-grouping and per-track order preserved). Only
			// sentences with no valid track (broken reference / pre-track data) move
			// into the chapter's own new track.
			if (!ownTrackIds.has(s.trackId)) {
				s.trackId = newId;
			}
		}
	}

	return { chapters: survivingChapters, tracks, sentences };
}

function loadData(): StorageData {
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
		const base: StorageData = Array.isArray(parsed.tracks)
			? { chapters, tracks: parsed.tracks, sentences: storedSentences }
			: {
					// Old format without tracks: synthesize a default track per chapter and
					// backfill trackId (sentences with unknown chapterId are not skipped).
					chapters,
					tracks: chapters.map(defaultTrackFor),
					sentences: storedSentences.map((s) => ({
						...s,
						trackId: s.trackId ?? `tr-${s.chapterId}`
					}))
				};
		const migrated = migrateToV3(base);
		// Lazy write-back so the shim runs once per browser.
		if (JSON.stringify(migrated) !== raw) {
			saveData(migrated);
		}
		return migrated;
	} catch {
		return {
			chapters: [...defaultChapters],
			tracks: [...defaultTracks],
			sentences: [...defaultSentences]
		};
	}
}

function saveData(data: StorageData): void {
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

export function addTrack(chapterId: string, name: string, parentTrackId: string | null = null): Track {
	if (!name.trim()) {
		throw new Error('Track name must not be empty');
	}
	const tracks = loadTracks();
	const siblings = tracks.filter(
		(t) => t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId
	);
	const maxOrder = siblings.reduce((max, t) => Math.max(max, t.order), 0);
	const track: Track = {
		id: generateId(),
		chapterId,
		name: name.trim(),
		order: maxOrder + 1,
		parentId: parentTrackId
	};
	tracks.push(track);
	saveTracks(tracks);
	return track;
}

function withoutParentId(updates: Partial<Track>): Partial<Omit<Track, 'id' | 'parentId'>> {
	const copy: Record<string, unknown> = { ...updates };
	delete copy.parentId;
	return copy as Partial<Omit<Track, 'id' | 'parentId'>>;
}

/** `parentId` is excluded on purpose: a track's parent is fixed at creation. */
export function updateTrack(id: string, updates: Partial<Omit<Track, 'id' | 'parentId'>>): void {
	const tracks = loadTracks();
	const idx = tracks.findIndex((t) => t.id === id);
	if (idx === -1) throw new Error(`Track not found: ${id}`);
	tracks[idx] = { ...tracks[idx], ...withoutParentId(updates) };
	saveTracks(tracks);
}

/**
 * Delete a track together with its whole subtree (descendant tracks + sentences),
 * strictly inside the chapter that owns the track.
 *
 * Both the walk and the sentence filter are chapter-scoped: the track id itself
 * is the only lookup key, so a cross-chapter duplicate id (importable before the
 * duplicate rule, and writable to localStorage by hand) would otherwise delete
 * the other chapter's track and sentences as well.
 *
 * An unknown id is a no-op: without the track there is no owning chapter to
 * scope to, and deleting by id alone could remove a foreign chapter's data.
 */
export function deleteTrack(id: string): void {
	const tracks = loadTracks();
	const target = tracks.find((t) => t.id === id);
	if (!target) return;
	const sentences = loadSentences();
	const doomed = getNodeDescendantTrackIds(id, tracks, target.chapterId);

	const remainingTracks = tracks.filter(
		(t) => t.chapterId !== target.chapterId || !doomed.has(t.id)
	);
	const remainingSentences = sentences.filter(
		(s) => s.chapterId !== target.chapterId || !doomed.has(s.trackId)
	);

	saveTracks(remainingTracks);
	saveSentences(remainingSentences);
}

/**
 * Flatten one chapter's track tree in depth-first (pre-order) order: the
 * chapter's direct children (parentId === null) sorted by `order`, each
 * immediately followed by its own subtree. Tracks of other chapters are never
 * collected, so a `parentId` pointing outside the chapter cannot leak nodes in.
 * The chapter filter applies at every depth, and each id is emitted at most once
 * (duplicate ids resolve first-wins), so malformed imported data cannot make the
 * walk recurse forever.
 */
export function flattenTrackTree(chapterId: string, tracks: Track[]): Track[] {
	const result: Track[] = [];
	const seen = new Set<string>();

	function walk(parentTrackId: string | null): void {
		const children = tracks
			.filter(
				(t) =>
					!seen.has(t.id) && t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId
			)
			.sort((a, b) => a.order - b.order);
		for (const child of children) {
			seen.add(child.id);
			result.push(child);
			walk(child.id);
		}
	}

	walk(null);
	return result;
}

/**
 * Ids of `trackId` plus every descendant track **of `chapterId`**. Terminates on
 * cyclic data because an id is never visited twice.
 *
 * `chapterId` is required, never optional: a track's parent is resolved by id
 * alone, so a chapter-less walk would follow another chapter's same-id track and
 * hand `deleteTrack` a subtree belonging to a different chapter. Import rejects
 * cross-chapter duplicate ids, but localStorage written before that rule (or by
 * hand) can still hold them, and the walk must stay inside the chapter either
 * way. `trackId` itself is always included even if it is unknown, so callers
 * that scope by a caller-supplied chapter stay correct for a missing track.
 */
export function getNodeDescendantTrackIds(
	trackId: string,
	tracks: Track[],
	chapterId: string
): Set<string> {
	const ids = new Set<string>([trackId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const t of tracks) {
			if (t.chapterId !== chapterId) continue;
			if (t.parentId !== null && ids.has(t.parentId) && !ids.has(t.id)) {
				ids.add(t.id);
				grew = true;
			}
		}
	}
	return ids;
}

/**
 * All tracks of a chapter in pre-order. Thin wrapper over `flattenTrackTree`
 * kept for the existing callers (addSentence / updateSentence auto-assign,
 * manage's chapter-filtered group list).
 */
export function getChapterTracks(chapterId: string, tracks: Track[]): Track[] {
	return flattenTrackTree(chapterId, tracks);
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
			const track: Track = { id: `tr-${chapterId}`, chapterId, name: 'トラック1', order: 1, parentId: null };
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
			const track: Track = { id: `tr-${next.chapterId}`, chapterId: next.chapterId, name: 'トラック1', order: 1, parentId: null };
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
 * Sort by pre-order track position first, then by `order` within each track.
 * A trackId missing from `position` (no such track) sorts last instead of
 * being dropped.
 */
function byTrackPosition(sentences: Sentence[], position: Map<string, number>): Sentence[] {
	return [...sentences].sort(
		(a, b) =>
			(position.get(a.trackId) ?? Number.MAX_SAFE_INTEGER) -
				(position.get(b.trackId) ?? Number.MAX_SAFE_INTEGER) || a.order - b.order
	);
}

/**
 * Sentences reachable from a node, in pre-order: a chapter's own tracks each
 * contributing their sentences then their subtree's; a track contributing its
 * own sentences then each child subtree's. Sentences whose trackId has no
 * matching track sort last (never dropped) — that only applies to a chapter
 * node, where the whole chapter is in scope. A track node scopes to its own
 * subtree, so a sentence outside it is unreachable by definition.
 */
export function getNodeSentences(
	nodeId: string,
	chapters: Chapter[],
	tracks: Track[],
	sentences: Sentence[]
): Sentence[] {
	const chapter = chapters.find((c) => c.id === nodeId);
	if (chapter) {
		const position = new Map(flattenTrackTree(chapter.id, tracks).map((t, i) => [t.id, i]));
		return byTrackPosition(
			sentences.filter((s) => s.chapterId === chapter.id),
			position
		);
	}
	const found = tracks.find((t) => t.id === nodeId);
	if (!found) return [];
	const position = new Map(flattenTrackTree(found.chapterId, tracks).map((t, i) => [t.id, i]));
	const scope = getNodeDescendantTrackIds(found.id, tracks, found.chapterId);
	return byTrackPosition(
		sentences.filter((s) => s.chapterId === found.chapterId && scope.has(s.trackId)),
		position
	);
}

export interface NodeRef {
	type: 'chapter' | 'track';
	id: string;
	name: string;
}

/**
 * Ancestor chain from the chapter down to `nodeId` (inclusive). Cycle-safe:
 * an already-visited track id stops the walk.
 */
export function getNodeTrail(nodeId: string, chapters: Chapter[], tracks: Track[]): NodeRef[] {
	const owner = chapters.find((c) => c.id === nodeId);
	if (owner) return [{ type: 'chapter', id: owner.id, name: owner.name }];

	const chain: Track[] = [];
	const seen = new Set<string>();
	let current: Track | undefined = tracks.find((t) => t.id === nodeId);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		chain.unshift(current);
		const parentId: string | null = current.parentId;
		current = parentId ? tracks.find((t) => t.id === parentId) : undefined;
	}
	if (chain.length === 0) return [];

	const head = chapters.find((c) => c.id === chain[0].chapterId);
	const trail: NodeRef[] = head ? [{ type: 'chapter', id: head.id, name: head.name }] : [];
	return [...trail, ...chain.map((t) => ({ type: 'track' as const, id: t.id, name: t.name }))];
}

/**
 * Kept for existing callers: the chapter's sentences in pre-order. Now a thin
 * wrapper over `getNodeSentences`.
 */
export function getChapterSentences(chapterId: string, sentences: Sentence[]): Sentence[] {
	return getNodeSentences(chapterId, loadChapters(), loadTracks(), sentences);
}
