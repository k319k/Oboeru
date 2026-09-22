<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { loadChapters, loadSentences, getChapterSentences } from '$lib/sentences';
	import { createLiveStt } from '$lib/livestt/engine';
	import { getLastLang } from '$lib/last-lang';
	import { ChevronRight, Loader2, Play } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { onMount } from 'svelte';
	import type { Chapter, Sentence } from '$lib/types';

	let chapters = $state<Chapter[]>([]);
	let sentences = $state<Sentence[]>([]);

	// Collapsed chapter IDs. Default: all parents expanded.
	let collapsedChapters = $state<Set<string>>(new Set());

	$effect(() => {
		chapters = loadChapters();
		sentences = loadSentences();
	});

	type WarmState = 'idle' | 'loading' | 'ready' | 'error';
	let warmState = $state<WarmState>('idle');
	let warmPercent = $state<number | null>(null);

	onMount(() => {
		// E2E drives the practice page with ?e2e=1 and mocks the engine; the top
		// page must not trigger a real model download there.
		if (import.meta.env.DEV && $page.url.searchParams.get('e2e') === '1') return;
		// The models proxy answers 503/404 (or 502 if the upstream fetch fails)
		// when no archive is served — warm resolves null and silently no-ops.
		warmState = 'loading';
		createLiveStt({
			lang: getLastLang(),
			onProgress: (p) => {
				warmPercent = p.total ? Math.round((p.loaded / p.total) * 100) : null;
			}
		})
			.then(() => {
				warmState = 'ready';
			})
			.catch(() => {
				warmState = 'error';
			});
	});

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

	// Display-layer aggregation: direct sentences + all descendants.
	function getTotalSentenceCount(chapterId: string): number {
		let total = getChapterSentences(chapterId, sentences).length;
		for (const child of getChildren(chapterId)) {
			total += getTotalSentenceCount(child.id);
		}
		return total;
	}

	function startPractice(chapterId: string) {
		goto(`/practice?chapter=${chapterId}`);
	}
</script>

<svelte:head>
	<title>おぼえる</title>
</svelte:head>

<h1 class="mb-1 text-2xl font-bold">おぼえる</h1>
{#if warmState === 'loading'}
	<p
		class="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground"
		data-testid="warm-indicator"
		aria-live="polite"
	>
		<Loader2 class="size-4 animate-spin" />
		録音アシストを準備中…
		{#if warmPercent !== null}{warmPercent}%{/if}
	</p>
{/if}
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
		{#snippet chapterNode(chapter: Chapter, depth: number)}
			<div class="tree-node" style:margin-left={`${depth * 1.5}rem`}>
				<div
					class="chapter-item flex min-h-14 items-center gap-1 rounded-xl border border-border bg-card p-2 shadow-xs transition-colors hover:bg-accent/50"
					data-testid="chapter-card"
				>
					{#if hasChildren(chapter.id)}
						<button
							class="expand-toggle inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
							onclick={() => toggleExpand(chapter.id)}
							aria-label={isExpanded(chapter.id) ? '折りたたむ' : '展開する'}
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
						<span class="text-sm text-muted-foreground">{getTotalSentenceCount(chapter.id)}文</span>
					</div>
					{#if getChapterSentences(chapter.id, sentences).length > 0}
						<Button
							class="h-11 gap-1.5 rounded-md px-5 text-base font-bold"
							data-testid="card-start"
							onclick={() => startPractice(chapter.id)}
						>
							<Play class="size-5 fill-current" />
							練習
						</Button>
					{/if}
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
{/if}
