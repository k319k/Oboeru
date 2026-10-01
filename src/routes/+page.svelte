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
		computeStreak,
		formatRelativeDay,
		loadHistoryUiState,
		saveHistoryUiState,
		type HistoryData,
		type NodeStats,
		type SessionRecord
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
	// Derived, not state: the loading effect writes `history` and gets a fresh
	// object back from loadHistory(), so reading `history` inside that same
	// effect makes it its own dependency and Svelte throws
	// effect_update_depth_exceeded during hydration. A derived has no write of
	// its own, so the streak can never drift from the history it summarises.
	// Both halves are passed: the sentence stats alone collapse a
	// repeated-chapter streak to one day (each stat keeps only its most recent
	// practice), the session rows carry the per-day log.
	let streak = $derived(computeStreak(history.sentences, history.sessions, nowMs));
	// The session log is long and secondary, so it starts closed and the
	// choice is remembered across reloads.
	let historyOpen = $state(false);
	let historyLimit = $state(20);

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
		historyOpen = loadHistoryUiState().open;
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

	// The miss is unreachable in practice (every rendered row's id is in
	// sentencesByNode), but a hand-written NodeStats literal here duplicated the
	// interface field-for-field and could drift the moment a field was added.
	// computeNodeStats([], false, {}, threshold) is the empty answer by
	// definition and cannot.
	function nodeStats(nodeId: string): NodeStats {
		return statsByNode.get(nodeId) ?? computeNodeStats([], false, {}, threshold);
	}

	/**
	 * A share, for the chapter progress BAR's width only. Never a label: a
	 * percentage of passes says nothing about how well the sentences are being
	 * read. The text label is `avgScore` — see progressLabel() below.
	 */
	function percent(part: number, total: number): number {
		return total === 0 ? 0 : Math.round((part / total) * 100);
	}

	/**
	 * "24/32 合格 · 87%" — `N/M` is the pass count and the percentage is the
	 * node's AVERAGE SCORE, not a pass ratio. The user's request: 「直近10回
	 * …の平均で出すべき」. They are different numbers and only one of them
	 * explains the verdict: six sentences all averaging 89.5 read
	 * "6/6 合格 · 100%" as a pass ratio, which hides every score below the
	 * threshold; as an average it reads "6/6 合格 · 90%", and the pair
	 * "0/6 合格 · 46%" is the only line that says 「直すならここ」.
	 *
	 * Nothing practised yet → no percentage at all. `avgScore` is null then, and
	 * printing "· 0%" would assert a score of 0 for a node nobody has attempted.
	 *
	 * The plain "N文" form (a node with no sentences) is unchanged.
	 */
	function progressLabel(stats: NodeStats): string {
		if (stats.total === 0) return `${stats.total}文`;
		const passed = `${stats.passed}/${stats.total} 合格`;
		return stats.avgScore === null ? passed : `${passed} · ${stats.avgScore}%`;
	}

	function toggleHistory(): void {
		historyOpen = !historyOpen;
		saveHistoryUiState({ open: historyOpen });
	}

	function showMoreHistory(): void {
		historyLimit += 20;
	}

	/**
	 * The node's display name and whether it has since been deleted.
	 *
	 * Split into two fields rather than one assembled string so `(削除済み)` can
	 * sit OUTSIDE the truncated name: with a long name the marker is the only
	 * thing telling the user the chapter is gone, and a whole-line `truncate`
	 * would cut it off. The live name wins when the node still exists, so a
	 * rename overwrites the stored one on screen (spec §表示 2段).
	 */
	function sessionName(record: SessionRecord): { name: string; deleted: boolean } {
		const live =
			tracks.find((t) => t.id === record.nodeId)?.name ??
			chapters.find((c) => c.id === record.nodeId)?.name;
		if (live) return { name: live, deleted: false };
		return { name: record.nodeName, deleted: true };
	}

	function sessionAverage(record: SessionRecord): number {
		return record.attempted > 0 ? Math.round(record.totalScore / record.attempted) : 0;
	}

	function formatStamp(ts: number): string {
		const d = new Date(ts);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

{#if streak.totalAttempts > 0}
	<p
		class="mb-4 inline-flex min-h-11 max-w-full items-center gap-1.5 self-start rounded-full border border-border px-4 text-sm text-muted-foreground"
		data-testid="streak-pill"
	>
		連続 {streak.days} 日 · のべ {streak.totalAttempts} 文
	</p>
{/if}

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
<!-- Gated on total > 0: a track whose subtree is empty would otherwise render an
					     empty `role="img"` directly under a row that already reads `0文`,
					     which is screen-reader noise with no meaning. -->
					{#if nodeStats(track.id).total > 0}
						<div
							class="flex flex-wrap gap-[3px]"
							role="img"
							aria-label={`合格 ${nodeStats(track.id).passed} 文 / 苦手 ${nodeStats(track.id).hard} 文 / 未着手 ${nodeStats(track.id).total - nodeStats(track.id).practiced} 文`}
							data-testid="track-dots"
						>
							{#each nodeStats(track.id).dots as dot, i (i)}
								<!-- All three backgrounds conditional, never one static plus a
								     conditional. Tailwind puts every colour utility in a single
								     `utilities` layer at equal specificity, so the winner is the
								     generated stylesheet's source order — NOT the attribute order
								     here — and a static `bg-border` lost to `bg-amber-500` in
								     practice, painting 苦手 the same grey as 未着手. Exactly one
								     class is ever present. Pinned by tests/history.spec.ts
								     ("each dot state paints its own colour"). -->
								<span
									class="size-[7px] rounded-[2px]"
									class:bg-border={dot === 'untouched'}
									class:bg-success={dot === 'passed'}
									class:bg-amber-500={dot === 'hard'}
									data-dot={dot}
								></span>
							{/each}
						</div>
					{/if}
{#if nodeStats(track.id).practiced > 0}
						<!-- 直近 N 回 = minSamples, the SMALLEST window in this row, so the
						     number never claims more evidence than the row's weakest
						     sentence has. 直近 1 回 is deliberate: it says the verdict rests
						     on one attempt, which is exactly what the pre-window version
						     of this row hid. -->
						<span class="text-sm text-muted-foreground" data-testid="track-last">
							最終 {formatRelativeDay(nodeStats(track.id).lastPracticedAt ?? nowMs, nowMs)} · 直近
							{nodeStats(track.id).minSamples} 回
						</span>
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
						<!-- `flex-wrap`, deliberately. The badges keep their intrinsic width
						     and the COUNT drops to its own line when the two badges plus the
						     count do not fit: this column is 172px at 390px, two badges take
						     ~52px of it, and `120/120 合格 · 95%` is 134px — so the average,
						     the number the user asked for, was clipped 19px (measured) with no
						     page overflow at all, because `overflow-hidden` cuts it inside its own
						     box. With one badge (160px total) nothing wraps and the row is
						     byte-identical to before, so a single-language chapter pays nothing
						     for this. `truncate` stays as the last-resort guard for a count
						     wider than the whole column (4-digit denominators). -->
						<div class="flex flex-wrap items-center gap-1.5 overflow-hidden">
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
							<!-- The BAR is the pass ratio, the LABEL is avgScore. Deliberate:
							     a bar is a share of a whole, and 「合格した文がどれだけあるか」
							     is exactly what a share answers. Feeding the average here
							     would claim 「8割の文が合格」 when it is 「平均 8割」.
							     history.spec.ts pins the two apart on a row where they
							     disagree (label 70% / bar 50%). -->
							<div
								class="h-full rounded-full bg-success"
								style:width={`${percent(nodeStats(chapter.id).passed, nodeStats(chapter.id).total)}%`}
							></div>
						</div>
						{#if nodeStats(chapter.id).practiced > 0}
							<!-- Wraps, never truncates. This line grew by `· 直近 N 回` and the
							     chapter row's text column measures 172px at 390px (the expand
							     toggle and the 練習 button take the rest), so `truncate`
							     clipped 30-70px here — 直近 10 回 was invisible on exactly the
							     row where the evidence matters most. Measured at 390px
							     (doc overflow 0, clip 0, card 92px → 112px); see
							     .superpowers/sdd/2026-10-01-practice-history-score-window-report.md -->
							<span class="text-sm text-muted-foreground" data-testid="chapter-last">
								最終 {formatRelativeDay(nodeStats(chapter.id).lastPracticedAt ?? nowMs, nowMs)} · 苦手
								{nodeStats(chapter.id).hard} 文 · 直近 {nodeStats(chapter.id).minSamples} 回
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

<!-- History outlives the content tree: deleting every chapter must not delete
     the record of practising them. -->
{#if history.sessions.length > 0}
	{@const visible = history.sessions.slice(0, historyLimit)}
	<section class="mt-6 border-t border-border pt-4" data-testid="history-section">
		<h2>
			<button
				type="button"
				class="flex min-h-11 w-full items-center gap-2 text-left text-base font-semibold"
				aria-expanded={historyOpen}
				aria-controls="history-log"
				onclick={toggleHistory}
				data-testid="history-toggle"
			>
				<ChevronRight
					class={historyOpen
						? 'h-5 w-5 rotate-90 transition-transform'
						: 'h-5 w-5 transition-transform'}
				/>
				練習履歴 ({history.sessions.length})
			</button>
		</h2>
		{#if historyOpen}
			<div id="history-log" class="flex flex-col gap-1 pt-2" data-testid="history-log">
				{#each visible as record (record.id)}
					{@const session = sessionName(record)}
					<!-- Two lines, because the row mixes one unbounded field with several
					     bounded ones. Truncating the whole line would hide the score and
					     the skip count — the reason a history row exists. Truncating only
					     the name is safe because everything else on the second line is
					     short by construction: `MM/DD HH:MM`, two counts, and 途中で終了
					     (which wraps between kanji anyway). Same treatment as
					     `chapter-name truncate` / `track-card-name truncate`.

					     What actually prevents the horizontal overflow is `truncate` on
					     the name — its `overflow: hidden` makes the flex automatic
					     minimum size 0 (css-flexbox §4.5), so the item may shrink below
					     its min-content (a 120-char Latin name), and it then clips.
					     Measured at 390px: dropping all three `min-w-0` here and
					     keeping only `truncate` still overflows 0px, whereas dropping
					     only `truncate` overflows ~645px even with every `min-w-0`
					     present.

					     `min-w-0` is therefore DEFENSIVE, not load-bearing: it changes
					     nothing while `truncate` is on the same element. Kept because if
					     the truncation is ever replaced (or moves to an ancestor) the
					     automatic minimum size comes back and the spill returns with
					     it. Same wording as AGENTS.md's `level-meter` `min-w-0`. -->
					<p
						class="flex min-w-0 flex-col gap-0.5 text-sm text-muted-foreground"
						data-testid="history-item"
					>
						<span class="flex min-w-0 items-center gap-1">
							<span
								class="min-w-0 flex-1 truncate font-medium"
								data-testid="history-item-name">{session.name}</span
							>
							{#if session.deleted}<span class="shrink-0">(削除済み)</span>{/if}
						</span>
						<span>
							{formatStamp(record.startedAt)} · {record.passedSentences} 文 合格 · 平均
							{sessionAverage(record)}% · スキップ
							{record.skipped}{record.endedEarly ? ' · 途中で終了' : ''}
						</span>
					</p>
				{/each}
				{#if visible.length < history.sessions.length}
					<button
						type="button"
						class="mt-2 inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm"
						onclick={showMoreHistory}
						data-testid="history-more"
					>
						さらに表示 (残り {history.sessions.length - visible.length} 件)
					</button>
				{/if}
			</div>
		{/if}
	</section>
{/if}
