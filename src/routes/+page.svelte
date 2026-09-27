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

	let chapters = $state<Chapter[]>([]);
	let sentences = $state<Sentence[]>([]);
	let tracks = $state<Track[]>([]);

	// Collapsed node IDs (chapter or track). Default: all nodes expanded.
	let collapsed = $state<Set<string>>(new Set());

	$effect(() => {
		chapters = loadChapters();
		sentences = loadSentences();
		tracks = loadTracks();
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

	/** Sentences of one track only — descendants are counted on their own row. */
	function ownCount(trackId: string): number {
		return sentences.filter((s) => s.trackId === trackId).length;
	}

	/** A chapter row aggregates its whole subtree; a track row shows only its own sentences. */
	function chapterTotal(chapterId: string): number {
		return flattenTrackTree(chapterId, tracks).reduce((sum, t) => sum + ownCount(t.id), 0);
	}

	/** Languages present in the chapter's subtree, JA first. Chapter rows only. */
	function chapterLanguages(chapterId: string): ('ja' | 'en')[] {
		const scope = new Set(flattenTrackTree(chapterId, tracks).map((t) => t.id));
		const langs = new Set<'ja' | 'en'>();
		for (const s of sentences) {
			if (scope.has(s.trackId)) langs.add(s.language);
		}
		return [...langs].sort((a, b) => (a === 'ja' ? -1 : 1));
	}

	/** A node is startable when its subtree holds at least one sentence. */
	function canPractice(nodeId: string): boolean {
		return getNodeSentences(nodeId, chapters, tracks, sentences).length > 0;
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
						<span class="text-sm text-muted-foreground" data-testid="track-card-count"
							>{ownCount(track.id)}文</span
						>
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
						<div class="flex items-center gap-1.5">
							{#each chapterLanguages(chapter.id) as lang (lang)}
								{@render languageBadge(lang)}
							{/each}
							<span class="text-sm text-muted-foreground" data-testid="chapter-card-count"
								>{chapterTotal(chapter.id)}文</span
							>
						</div>
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
