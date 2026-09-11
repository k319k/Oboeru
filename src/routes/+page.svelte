<script lang="ts">
	import { loadChapters, loadSentences, getChapterSentences } from '$lib/sentences';
	import { ChevronRight } from '@lucide/svelte';
	import type { Chapter, Sentence } from '$lib/types';

	let chapters = $state<Chapter[]>([]);
	let sentences = $state<Sentence[]>([]);
	let selectedChapterId = $state<string | null>(null);

	// Collapsed chapter IDs. Default: all parents expanded.
	let collapsedChapters = $state<Set<string>>(new Set());

	$effect(() => {
		chapters = loadChapters();
		sentences = loadSentences();
	});

	let selectedChapter = $derived(chapters.find((c) => c.id === selectedChapterId));
	let chapterSentenceCount = $derived(
		selectedChapterId ? getChapterSentences(selectedChapterId, sentences).length : 0
	);
	let canStart = $derived(selectedChapterId !== null && chapterSentenceCount > 0);

	// Build the tree from parentId (same pattern as manage/+page.svelte getChildren).
	function getChildren(chapterId: string | null): Chapter[] {
		return chapters
			.filter((c) => c.parentId === chapterId)
			.sort((a, b) => a.order - b.order);
	}

	function hasChildren(chapterId: string): boolean {
		return chapters.some((c) => c.parentId === chapterId);
	}

	function isExpanded(chapterId: string): boolean {
		return !collapsedChapters.has(chapterId);
	}

	function toggleExpand(chapterId: string) {
		const next = new Set(collapsedChapters);
		if (next.has(chapterId)) {
			next.delete(chapterId);
		} else {
			next.add(chapterId);
		}
		collapsedChapters = next;
	}

	function startPractice() {
		if (selectedChapterId) {
			window.location.href = `/practice?chapter=${selectedChapterId}`;
		}
	}
</script>

<svelte:head>
	<title>おぼえる</title>
</svelte:head>

<h1 class="mb-2 text-2xl font-bold">おぼえる</h1>
<p>文章を選んで練習を開始しましょう</p>

{#if chapters.length === 0}
	<div class="py-8 text-center">
		<p>データがありません。管理画面で追加してください</p>
		<a href="/manage" class="inline-flex min-h-11 items-center text-primary underline dark:text-blue-400"
			>管理画面で追加する</a
		>
	</div>
{:else}
	<div class="chapter-tree my-4 flex flex-col gap-1">
		{#snippet chapterNode(chapter: Chapter, depth: number)}
			<div class="tree-node" style:margin-left={`${depth * 1.5}rem`}>
				<div class="flex items-center gap-1">
					{#if hasChildren(chapter.id)}
						<button
							class="expand-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
							onclick={() => toggleExpand(chapter.id)}
							aria-label={isExpanded(chapter.id) ? '折りたたむ' : '展開する'}
						>
							<ChevronRight
								class={isExpanded(chapter.id)
									? 'h-4 w-4 rotate-90 transition-transform'
									: 'h-4 w-4 transition-transform'}
							/>
						</button>
					{:else}
						<span class="w-6 shrink-0" aria-hidden="true"></span>
					{/if}
					<button
						class="chapter-item flex flex-1 items-center justify-between gap-2 rounded-md border border-border bg-card px-4 py-3 text-left text-foreground transition-colors hover:bg-accent"
						class:selected={selectedChapterId === chapter.id}
						onclick={() => (selectedChapterId = chapter.id)}
					>
						<span>{chapter.name}</span>
						<span class="text-sm text-muted-foreground">{getChapterSentences(chapter.id, sentences).length}文</span>
					</button>
				</div>
				{#if isExpanded(chapter.id)}
					{#each getChildren(chapter.id) as child (child.id)}
						{@render chapterNode(child, depth + 1)}
					{/each}
				{/if}
			</div>
		{/snippet}

		{#each getChildren(null) as chapter (chapter.id)}
			{@render chapterNode(chapter, 0)}
		{/each}
	</div>

	<div class="practice-start mt-4 text-center">
		<p class="mb-2">
			{#if selectedChapterId}
				{selectedChapter?.name} — {chapterSentenceCount}文
			{:else}
				チャプターを選択してください
			{/if}
		</p>
		<button
			onclick={startPractice}
			disabled={!canStart}
			class="rounded-md bg-primary px-8 py-3 text-lg text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
		>
			練習開始
		</button>
	</div>
{/if}

<style>
	.chapter-item.selected {
		border-color: var(--primary);
		background: color-mix(in oklab, var(--primary) 10%, transparent);
	}
</style>