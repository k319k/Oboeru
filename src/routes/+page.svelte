<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		loadChapters,
		loadSentences,
		loadTracks,
		flattenTrackTree,
		getNodeSentences
	} from '$lib/sentences';
	import { ChevronRight, Play } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import type { Chapter, Sentence, Track } from '$lib/types';
	import {
		loadHistory,
		computeNodeStats,
		formatRelativeDay,
		type HistoryData,
		type NodeStats
	} from '$lib/history';
	import { loadSettings } from '$lib/settings';

	let chapters = $state<Chapter[]>([]);
	let sentences = $state<Sentence[]>([]);
	let tracks = $state<Track[]>([]);

	// Collapsed node IDs (chapter or track). Default: all nodes expanded.
	let collapsed = $state<Set<string>>(new Set());

	let history = $state<HistoryData>({ version: 1, sessions: [], sentences: {} });
	let threshold = $state(80);
	// Captured once per history load so relative dates do not drift mid-render.
	let nowMs = $state(Date.now());

	$effect(() => {
		chapters = loadChapters();
		sentences = loadSentences();
		tracks = loadTracks();
	});

	// Independent of the content load above: practice and history live in
	// separate storage keys, so the row's pass/hard verdict follows the
	// threshold the user last saved rather than a hard-coded 80.
	$effect(() => {
		history = loadHistory();
		threshold = loadSettings().threshold;
		nowMs = Date.now();
	});

	// Chapters are roots only — the hierarchy below them belongs to tracks.
	function rootChapters(): Chapter[] {
		return chapters
			.filter((c) => c.parentId === null)
			.sort((a, b) => a.order - b.order);
	}

	/** Direct children of a track; `parentTrackId === null` means "direct children of the chapter". */
	function getTrackChildren(chapterId: string, parentTrackId: string | null): Track[] {
		return tracks
			.filter((t) => t.chapterId === chapterId && (t.parentId ?? null) === parentTrackId)
			.sort((a, b) => a.order - b.order);
	}

	/**
	 * One `getNodeSentences` call per node id, computed once per data change and
	 * then read by every row. It is the single source of truth for all three
	 * numbers a row shows, so a chapter's count and its 練習 button can never
	 * disagree (counting by track id while the button counted by chapterId showed
	 * `0文` next to a button whenever a track id was broken).
	 */
	let sentencesByNode = $derived.by(() => {
		const map = new Map<string, Sentence[]>();
		for (const chapter of rootChapters()) {
			map.set(chapter.id, getNodeSentences(chapter.id, chapters, tracks, sentences));
			for (const track of flattenTrackTree(chapter.id, tracks)) {
				map.set(track.id, getNodeSentences(track.id, chapters, tracks, sentences));
			}
		}
		return map;
	});

	function nodeSentences(nodeId: string): Sentence[] {
		return sentencesByNode.get(nodeId) ?? [];
	}

	/**
	 * One aggregation per row, read by every number, percentage and dot.
	 * The display set is getNodeSentences(nodeId) — the same sentences
	 * /practice?node=nodeId walks — so the row's denominator is the real
	 * session length and canPractice() cannot disagree with it.
	 */
	let statsByNode = $derived.by(() => {
		const map = new Map<string, NodeStats>();
		for (const [id, list] of sentencesByNode) {
			map.set(
				id,
				computeNodeStats(list, chapters.some((c) => c.id === id), history.sentences, threshold)
			);
		}
		return map;
	});

	function nodeStats(nodeId: string): NodeStats {
		return (
			statsByNode.get(nodeId) ?? {
				total: 0,
				passed: 0,
				practiced: 0,
				hard: 0,
				avgLastScore: null,
				lastPracticedAt: null,
				dots: []
			}
		);
	}

	function percent(part: number, total: number): number {
		return total === 0 ? 0 : Math.round((part / total) * 100);
	}

	/** "0/N 合格 · 87%" — or the plain "N文" when the node holds no sentences. */
	function progressLabel(stats: NodeStats): string {
		if (stats.total === 0) return `${stats.total}文`;
		return `${stats.passed}/${stats.total} 合格 · ${percent(stats.passed, stats.total)}%`;
	}

	/** Languages present in the chapter's subtree, JA first. Chapter rows only. */
	function chapterLanguages(chapterId: string): ('ja' | 'en')[] {
		const langs = new Set<'ja' | 'en'>();
		for (const s of nodeSentences(chapterId)) langs.add(s.language);
		return [...langs].sort((a, b) => (a === 'ja' ? -1 : 1));
	}

	/**
	 * A node is startable when its subtree holds at least one sentence.
	 *
	 * Subtree-based on purpose, and the row's count is subtree-based too: both
	 * read `nodeSentences`, so `M > 0` and this predicate can never disagree.
	 * A track whose sentences all live in a child track starts the child's
	 * sentences, so it shows `0/1 合格` next to its 練習 button rather than a
	 * `0文` count that would claim the button has nothing to practise.
	 */
	function canPractice(nodeId: string): boolean {
		return nodeSentences(nodeId).length > 0;
	}

	function isExpanded(id: string): boolean {
		return !collapsed.has(id);
	}

	function toggleExpand(id: string) {
		const next = new Set(collapsed);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		collapsed = next;
	}

	function startPractice(nodeId: string) {
		goto(`/practice?node=${nodeId}`);
	}
</script>

<svelte:head>
	<title>おぼえる</title>
</svelte:head>

<h1 class="mb-1 text-2xl font-bold">おぼえる</h1>
<p class="mb-6 text-sm text-muted-foreground">カードの練習ボタンですぐに開始できます</p>

{#if chapters.length === 0}
	<div class="py-8 text-center">
		<p>データがありません。管理画面で追加してください</p>
		<a href="/manage" class="inline-flex min-h-11 items-center text-success underline"
			>管理画面で追加する</a
		>
	</div>
{:else}
	<div class="chapter-tree mb-4 flex flex-col gap-2">
		{#snippet languageBadge(lang: 'ja' | 'en')}
			<span
				class="language-badge inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold {lang ===
				'ja'
					? 'bg-lang-ja text-lang-ja-foreground'
					: 'bg-lang-en text-lang-en-foreground'}"
				title={lang === 'ja' ? '日本語' : 'English'}
			>
				{lang}
			</span>
		{/snippet}

		{#snippet trackNode(track: Track, depth: number)}
			<div class="tree-node" style:margin-left={`${depth * 1.5}rem`}>
				<div
					class="track-item flex min-h-14 items-center gap-1 rounded-xl border border-border bg-card p-2 shadow-xs transition-colors hover:bg-accent/50"
					data-testid="track-card"
				>
					{#if getTrackChildren(track.chapterId, track.id).length > 0}
						<button
							class="expand-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
							onclick={() => toggleExpand(track.id)}
							aria-label={isExpanded(track.id) ? '折りたたむ' : '展開する'}
							aria-expanded={isExpanded(track.id)}
						>
							<ChevronRight
								class={isExpanded(track.id)
									? 'h-5 w-5 rotate-90 transition-transform'
									: 'h-5 w-5 transition-transform'}
							/>
						</button>
					{:else}
						<span class="w-4 shrink-0" aria-hidden="true"></span>
					{/if}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="truncate text-base font-semibold" data-testid="track-card-name"
							>{track.name}</span
						>
						<span class="truncate text-sm text-muted-foreground" data-testid="track-card-count"
							>{progressLabel(nodeStats(track.id))}</span
						>
						{#if nodeStats(track.id).practiced > 0}
							<span class="text-sm text-muted-foreground" data-testid="track-last">
								最終 {formatRelativeDay(nodeStats(track.id).lastPracticedAt ?? nowMs, nowMs)}
							</span>
							<div
								class="flex flex-wrap gap-[3px]"
								role="img"
								aria-label={`合格 ${nodeStats(track.id).passed} 文 / 苦手 ${nodeStats(track.id).hard} 文 / 未着手 ${nodeStats(track.id).total - nodeStats(track.id).practiced} 文`}
								data-testid="track-dots"
							>
								{#each nodeStats(track.id).dots as dot, i (i)}
									<span
										class="size-[7px] rounded-[2px] bg-border"
										class:bg-success={dot === 'passed'}
										class:bg-amber-500={dot === 'hard'}
										data-dot={dot}
									></span>
								{/each}
							</div>
						{/if}
					</div>
					{#if canPractice(track.id)}
						<Button
							class="h-11 gap-1.5 rounded-md px-5 text-base font-bold"
							data-testid="card-start"
							aria-label={`${track.name} の練習を開始`}
							onclick={() => startPractice(track.id)}
						>
							<Play class="size-5 fill-current" />
							練習
						</Button>
					{/if}
				</div>
				{#if isExpanded(track.id)}
					{#each getTrackChildren(track.chapterId, track.id) as child (child.id)}
						{@render trackNode(child, depth + 1)}
					{/each}
				{/if}
			</div>
		{/snippet}

		{#snippet chapterNode(chapter: Chapter, depth: number)}
			<div class="tree-node" style:margin-left={`${depth * 1.5}rem`}>
				<div
					class="chapter-item flex min-h-14 items-center gap-1 rounded-xl border border-border bg-card p-2 shadow-xs transition-colors hover:bg-accent/50"
					data-testid="chapter-card"
				>
					{#if getTrackChildren(chapter.id, null).length > 0}
						<button
							class="expand-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
							onclick={() => toggleExpand(chapter.id)}
							aria-label={isExpanded(chapter.id) ? '折りたたむ' : '展開する'}
							aria-expanded={isExpanded(chapter.id)}
						>
							<ChevronRight
								class={isExpanded(chapter.id)
									? 'h-5 w-5 rotate-90 transition-transform'
									: 'h-5 w-5 transition-transform'}
							/>
						</button>
					{:else}
						<span class="w-4 shrink-0" aria-hidden="true"></span>
					{/if}
					<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2">
						<span class="chapter-name truncate text-base font-semibold">{chapter.name}</span>
						<div class="flex items-center gap-1.5 overflow-hidden">
							{#each chapterLanguages(chapter.id) as lang (lang)}
								{@render languageBadge(lang)}
							{/each}
							<span
								class="truncate text-sm text-muted-foreground"
								data-testid="chapter-card-count">{progressLabel(nodeStats(chapter.id))}</span
							>
						</div>
						<div
							class="h-1 w-full overflow-hidden rounded-full bg-border"
							aria-hidden="true"
							data-testid="chapter-progress"
						>
							<div
								class="h-full rounded-full bg-success"
								style:width={`${percent(nodeStats(chapter.id).passed, nodeStats(chapter.id).total)}%`}
							></div>
						</div>
						{#if nodeStats(chapter.id).practiced > 0}
							<span class="truncate text-sm text-muted-foreground" data-testid="chapter-last">
								最終 {formatRelativeDay(nodeStats(chapter.id).lastPracticedAt ?? nowMs, nowMs)} · 苦手 {nodeStats(chapter.id).hard} 文
							</span>
						{/if}
					</div>
					{#if canPractice(chapter.id)}
						<Button
							class="h-11 gap-1.5 rounded-md px-5 text-base font-bold"
							data-testid="card-start"
							aria-label={`${chapter.name} の練習を開始`}
							onclick={() => startPractice(chapter.id)}
						>
							<Play class="size-5 fill-current" />
							練習
						</Button>
					{/if}
				</div>
				{#if isExpanded(chapter.id)}
					{#each getTrackChildren(chapter.id, null) as track (track.id)}
						{@render trackNode(track, depth + 1)}
					{/each}
				{/if}
			</div>
		{/snippet}

		{#each rootChapters() as chapter (chapter.id)}
			{@render chapterNode(chapter, 0)}
		{/each}
	</div>
{/if}
