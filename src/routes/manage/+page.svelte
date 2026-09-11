<script lang="ts">
	import { loadSettings, saveSettings, type Settings } from '$lib/settings';
	import { CURATED_VOICES } from '$lib/tts-voices';
	import { cn } from '$lib/utils';
	import {
		loadChapters,
		loadSentences,
		saveChapters,
		saveSentences,
		addChapter,
		updateChapter,
		deleteChapter,
		addSentence,
		updateSentence,
		deleteSentence,
		flattenChapterTree,
		getChapterSentences
	} from '$lib/sentences';
	import type { Chapter, Sentence } from '$lib/types';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import * as Slider from '$lib/components/ui/slider';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	let settings = $state<Settings>(loadSettings());
	let chapters = $state<Chapter[]>([]);
	let sentences = $state<Sentence[]>([]);
	let importMessage = $state<{ type: 'success' | 'error'; text: string } | null>(null);

	// Chapter tree expanded state
	let expandedChapters = $state<Set<string>>(new Set());

	// Chapter form state
	let editingChapterId = $state<string | null>(null);
	let editingChapterName = $state('');
	let addingChildToId = $state<string | null>(null);
	let newChildName = $state('');
	let addingRootChapter = $state(false);
	let newRootName = $state('');
	let chapterValidationError = $state('');

	// Sentence form state
	let editingSentenceId = $state<string | null>(null);
	let editingSentenceText = $state('');
	let editingSentenceLanguage = $state<'ja' | 'en'>('ja');
	let editingSentenceChapterId = $state('');
	let addingSentence = $state(false);
	let newSentenceText = $state('');
	let newSentenceLanguage = $state<'ja' | 'en'>('ja');
	let newSentenceChapterId = $state('');
	let sentenceValidationError = $state('');

	// Filter state
	let filterLanguage = $state<'all' | 'ja' | 'en'>('all');
	let filterChapterId = $state<string>('all');

	// Delete confirmation dialogs
	let deleteChapterDialogOpen = $state(false);
	let deleteChapterTarget = $state<Chapter | null>(null);
	let deleteSentenceDialogOpen = $state(false);
	let deleteSentenceTarget = $state<Sentence | null>(null);

	// Form field refs (for auto-focus when a form opens)
	let newRootNameRef = $state<HTMLInputElement | null>(null);
	let newChildNameRef = $state<HTMLInputElement | null>(null);
	let editChapterNameRef = $state<HTMLInputElement | null>(null);
	let newSentenceTextRef = $state<HTMLTextAreaElement | null>(null);
	let editSentenceTextRef = $state<HTMLTextAreaElement | null>(null);

	// --- Derived ---
	let flatChapters = $derived(flattenChapterTree(chapters));

	let filteredSentences = $derived.by(() => {
		let result = sentences;

		if (filterLanguage !== 'all') {
			result = result.filter((s) => s.language === filterLanguage);
		}

		if (filterChapterId !== 'all') {
			// Include sentences from selected chapter and all its descendants
			const chapterIds = collectChapterIds(chapters, filterChapterId);
			result = result.filter((s) => chapterIds.has(s.chapterId));
		}

		return result;
	});

	let chapterSentenceCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const s of sentences) {
			counts.set(s.chapterId, (counts.get(s.chapterId) || 0) + 1);
		}
		return counts;
	});

	let newSentenceOverLimit = $derived(newSentenceText.length > 200);
	let editingSentenceOverLimit = $derived(editingSentenceText.length > 200);

	// --- Helper functions ---
	function collectChapterIds(allChapters: Chapter[], chapterId: string): Set<string> {
		const ids = new Set<string>([chapterId]);
		const children = allChapters.filter((c) => c.parentId === chapterId);
		for (const child of children) {
			for (const id of collectChapterIds(allChapters, child.id)) {
				ids.add(id);
			}
		}
		return ids;
	}

	function getChildren(chapterId: string | null): Chapter[] {
		return flatChapters.filter((c) => c.parentId === chapterId);
	}

	function getChapterName(chapterId: string): string {
		const chapter = chapters.find((c) => c.id === chapterId);
		return chapter?.name || '';
	}

	function languageLabel(language: 'ja' | 'en' | 'all'): string {
		return language === 'ja' ? '日本語' : language === 'en' ? 'English' : 'すべて';
	}

	function chapterFilterLabel(chapterId: string): string {
		return chapterId === 'all' ? 'すべて' : getChapterName(chapterId);
	}

	function voiceLabel(voiceURI: string | null): string {
		if (!voiceURI) return 'デフォルト (言語に応じて自動)';
		const voice = CURATED_VOICES.find((v) => v.name === voiceURI);
		return voice ? `${voice.label} (${voice.languageCode})` : voiceURI;
	}

	// Load data on mount
	$effect(() => {
		chapters = loadChapters();
		sentences = loadSentences();
	});

	// --- Chapter operations ---
	function toggleExpand(chapterId: string) {
		const newSet = new Set(expandedChapters);
		if (newSet.has(chapterId)) {
			newSet.delete(chapterId);
		} else {
			newSet.add(chapterId);
		}
		expandedChapters = newSet;
	}

	function startAddRootChapter() {
		cancelAllEdits();
		addingRootChapter = true;
		newRootName = '';
		chapterValidationError = '';
	}

	function confirmAddRootChapter() {
		if (!newRootName.trim()) {
			chapterValidationError = 'チャプター名は必須です';
			return;
		}
		addChapter(newRootName.trim(), null);
		addingRootChapter = false;
		newRootName = '';
		chapterValidationError = '';
		refreshData();
	}

	function cancelAddRootChapter() {
		addingRootChapter = false;
		newRootName = '';
		chapterValidationError = '';
	}

	function startAddChildChapter(parentId: string) {
		cancelAllEdits();
		addingChildToId = parentId;
		newChildName = '';
		chapterValidationError = '';
		// Expand parent
		const newSet = new Set(expandedChapters);
		newSet.add(parentId);
		expandedChapters = newSet;
	}

	function confirmAddChildChapter() {
		if (!newChildName.trim()) {
			chapterValidationError = 'チャプター名は必須です';
			return;
		}
		if (!addingChildToId) return;
		addChapter(newChildName.trim(), addingChildToId);
		const parentId = addingChildToId;
		addingChildToId = null;
		newChildName = '';
		chapterValidationError = '';
		refreshData();
		// Ensure parent is expanded
		const newSet = new Set(expandedChapters);
		newSet.add(parentId);
		expandedChapters = newSet;
	}

	function cancelAddChildChapter() {
		addingChildToId = null;
		newChildName = '';
		chapterValidationError = '';
	}

	function startEditChapter(chapter: Chapter) {
		cancelAllEdits();
		editingChapterId = chapter.id;
		editingChapterName = chapter.name;
		chapterValidationError = '';
	}

	function confirmEditChapter() {
		if (!editingChapterId) return;
		if (!editingChapterName.trim()) {
			chapterValidationError = 'チャプター名は必須です';
			return;
		}
		updateChapter(editingChapterId, { name: editingChapterName.trim() });
		editingChapterId = null;
		editingChapterName = '';
		chapterValidationError = '';
		refreshData();
	}

	function cancelEditChapter() {
		editingChapterId = null;
		editingChapterName = '';
		chapterValidationError = '';
	}

	function confirmDeleteChapter() {
		if (!deleteChapterTarget) return;
		deleteChapter(deleteChapterTarget.id);
		deleteChapterTarget = null;
		refreshData();
	}

	// --- Chapter reorder (swap order with adjacent sibling) ---

	function getSiblings(chapterId: string): Chapter[] {
		const chapter = chapters.find((c) => c.id === chapterId);
		if (!chapter) return [];
		return chapters
			.filter((c) => c.parentId === chapter.parentId)
			.sort((a, b) => a.order - b.order);
	}

	function canMove(chapter: Chapter, direction: -1 | 1): boolean {
		const siblings = getSiblings(chapter.id);
		const idx = siblings.findIndex((c) => c.id === chapter.id);
		if (idx === -1) return false;
		const target = idx + direction;
		return target >= 0 && target < siblings.length;
	}

	function moveChapter(chapter: Chapter, direction: -1 | 1): void {
		const siblings = getSiblings(chapter.id);
		const idx = siblings.findIndex((c) => c.id === chapter.id);
		const target = idx + direction;
		if (idx === -1 || target < 0 || target >= siblings.length) return;
		const other = siblings[target];
		// Swap order values so the tree re-sorts correctly
		updateChapter(chapter.id, { order: other.order });
		updateChapter(other.id, { order: chapter.order });
		refreshData();
	}

	// --- Sentence operations ---
	function startAddSentence() {
		cancelAllEdits();
		addingSentence = true;
		newSentenceText = '';
		newSentenceLanguage = 'ja';
		newSentenceChapterId = filterChapterId !== 'all' ? filterChapterId : chapters[0]?.id || '';
		sentenceValidationError = '';
	}

	function confirmAddSentence() {
		if (!newSentenceText.trim()) {
			sentenceValidationError = '文章テキストは必須です';
			return;
		}
		if (newSentenceText.length > 200) {
			sentenceValidationError = '200文字以内で入力してください';
			return;
		}
		if (!newSentenceChapterId) {
			sentenceValidationError = 'チャプターを選択してください';
			return;
		}
		addSentence(newSentenceChapterId, newSentenceText.trim(), newSentenceLanguage);
		addingSentence = false;
		newSentenceText = '';
		sentenceValidationError = '';
		refreshData();
	}

	function cancelAddSentence() {
		addingSentence = false;
		newSentenceText = '';
		sentenceValidationError = '';
	}

	function startEditSentence(sentence: Sentence) {
		cancelAllEdits();
		editingSentenceId = sentence.id;
		editingSentenceText = sentence.text;
		editingSentenceLanguage = sentence.language;
		editingSentenceChapterId = sentence.chapterId;
		sentenceValidationError = '';
	}

	function confirmEditSentence() {
		if (!editingSentenceId || !editingSentenceText.trim()) {
			sentenceValidationError = '文章テキストは必須です';
			return;
		}
		if (editingSentenceText.length > 200) {
			sentenceValidationError = '200文字以内で入力してください';
			return;
		}
		updateSentence(editingSentenceId, {
			text: editingSentenceText.trim(),
			language: editingSentenceLanguage,
			chapterId: editingSentenceChapterId
		});
		editingSentenceId = null;
		sentenceValidationError = '';
		refreshData();
	}

	function cancelEditSentence() {
		editingSentenceId = null;
		sentenceValidationError = '';
	}

	function confirmDeleteSentence() {
		if (!deleteSentenceTarget) return;
		deleteSentence(deleteSentenceTarget.id);
		deleteSentenceTarget = null;
		refreshData();
	}

	function cancelAllEdits() {
		editingChapterId = null;
		addingChildToId = null;
		addingRootChapter = false;
		addingSentence = false;
		editingSentenceId = null;
		sentenceValidationError = '';
		chapterValidationError = '';
	}

	function refreshData() {
		chapters = loadChapters();
		sentences = loadSentences();
		// Reset chapter filter if the selected chapter no longer exists
		if (filterChapterId !== 'all' && !chapters.some((c) => c.id === filterChapterId)) {
			filterChapterId = 'all';
		}
	}

	// --- Keyboard handlers ---
	function handleChapterKeydown(e: KeyboardEvent, action: () => void, cancel: () => void) {
		if (e.key === 'Enter') action();
		if (e.key === 'Escape') cancel();
	}

	// Auto-focus the first field when a form opens
	$effect(() => {
		if (addingRootChapter) newRootNameRef?.focus();
		if (addingChildToId) newChildNameRef?.focus();
		if (editingChapterId) editChapterNameRef?.focus();
		if (addingSentence) newSentenceTextRef?.focus();
		if (editingSentenceId) editSentenceTextRef?.focus();
	});

	// ---------------------------------------------------------------------------
	// Export
	// ---------------------------------------------------------------------------

	function handleExport(): void {
		const data = {
			version: 1,
			exportedAt: new Date().toISOString(),
			chapters,
			sentences
		};

		const json = JSON.stringify(data, null, 2);
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);

		const now = new Date();
		const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
		const filename = `oboeru-export-${dateStr}.json`;

		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		// Append to the DOM before clicking — a detached <a> never fires the
		// download in headless Chromium (Playwright's waitForEvent('download')).
		document.body.appendChild(a);
		a.click();
		a.remove();
		// Defer revoking the object URL so the browser has time to initiate the
		// download; revoking synchronously can cancel it before it starts.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	// ---------------------------------------------------------------------------
	// Import
	// ---------------------------------------------------------------------------

	function validateImportJson(data: unknown): { valid: boolean; error?: string } {
		if (typeof data !== 'object' || data === null) {
			return { valid: false, error: '不正なJSONファイルです' };
		}
		const obj = data as Record<string, unknown>;
		if (obj.version !== 1) {
			return { valid: false, error: '対応していないバージョンです' };
		}
		if (!Array.isArray(obj.chapters)) {
			return { valid: false, error: 'チャプターデータがありません' };
		}
		if (!Array.isArray(obj.sentences)) {
			return { valid: false, error: '文章データがありません' };
		}

		// Validate required fields for chapters
		for (const ch of obj.chapters) {
			if (typeof ch !== 'object' || ch === null) {
				return { valid: false, error: '不正なチャプターデータです' };
			}
			const chapter = ch as Record<string, unknown>;
			if (typeof chapter.id !== 'string' || typeof chapter.name !== 'string') {
				return { valid: false, error: 'チャプターに必須フィールドがありません' };
			}
		}

		// Validate required fields for sentences
		for (const s of obj.sentences) {
			if (typeof s !== 'object' || s === null) {
				return { valid: false, error: '不正な文章データです' };
			}
			const sentence = s as Record<string, unknown>;
			if (
				typeof sentence.id !== 'string' ||
				typeof sentence.chapterId !== 'string' ||
				typeof sentence.text !== 'string'
			) {
				return { valid: false, error: '文章に必須フィールドがありません' };
			}
		}

		return { valid: true };
	}

	function handleImport(event: Event): void {
		importMessage = null;
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			try {
				const data = JSON.parse(reader.result as string);
				const validation = validateImportJson(data);
				if (!validation.valid) {
					importMessage = { type: 'error', text: validation.error! };
					return;
				}

				const importedChapters = data.chapters as Chapter[];
				const importedSentences = data.sentences as Sentence[];

				// Merge by ID: existing → overwrite, new → add
				const existingChapters = loadChapters();
				const chapterMap = new Map(existingChapters.map((c) => [c.id, c]));
				for (const ch of importedChapters) {
					chapterMap.set(ch.id, ch);
				}
				const mergedChapters = Array.from(chapterMap.values());
				saveChapters(mergedChapters);

				const existingSentences = loadSentences();
				const sentenceMap = new Map(existingSentences.map((s) => [s.id, s]));
				for (const s of importedSentences) {
					sentenceMap.set(s.id, s);
				}
				const mergedSentences = Array.from(sentenceMap.values());
				saveSentences(mergedSentences);

				// Update local state
				chapters = mergedChapters;
				sentences = mergedSentences;

				const importedChapterCount = importedChapters.length;
				const importedSentenceCount = importedSentences.length;
				importMessage = {
					type: 'success',
					text: `${importedChapterCount}件のチャプター、${importedSentenceCount}件の文章をインポートしました`
				};
			} catch {
				importMessage = { type: 'error', text: '不正なJSONファイルです' };
			}
		};
		reader.readAsText(file);
		// Reset input so the same file can be re-imported
		input.value = '';
	}

	// ---------------------------------------------------------------------------
	// Settings
	// ---------------------------------------------------------------------------

	function handleThresholdChange(value: number): void {
		settings = { ...settings, threshold: value };
		saveSettings(settings);
	}

	function handleTtsRateChange(value: number): void {
		settings = { ...settings, ttsRate: value };
		saveSettings(settings);
	}

	function handleVoiceChange(value: string): void {
		settings = { ...settings, voiceURI: value || null };
		saveSettings(settings);
	}

	function handleRetryFromChange(value: 'tts' | 'rerecord'): void {
		settings = { ...settings, retryFrom: value };
		saveSettings(settings);
	}
</script>

<svelte:head>
	<title>管理 - おぼえる</title>
</svelte:head>

<div>
	<h1 class="mb-6 text-2xl font-bold">管理</h1>

	<div class="mb-8 grid grid-cols-1 gap-8 md:grid-cols-2">
		<!-- ====================================================================== -->
		<!-- Chapter Tree Section                                                   -->
		<!-- ====================================================================== -->

		<section class="rounded-lg border border-border bg-muted/50 p-4" aria-labelledby="chapters-heading">
			<h2 id="chapters-heading" class="mb-3 text-lg font-semibold">チャプター</h2>

			<Button onclick={startAddRootChapter} disabled={addingRootChapter} class="h-11" data-testid="add-root-chapter">
				新しいチャプター
			</Button>

			{#if addingRootChapter}
				<div class="mt-2 flex flex-col gap-2 rounded-md border border-border bg-background p-2">
					<Input
						type="text"
						bind:value={newRootName}
						bind:ref={newRootNameRef}
						placeholder="チャプター名"
						onkeydown={(e) => handleChapterKeydown(e, confirmAddRootChapter, cancelAddRootChapter)}
						data-testid="new-chapter-name"
					/>
					{#if chapterValidationError}
						<div
							class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
							role="alert"
							data-testid="chapter-validation-error"
						>
							{chapterValidationError}
						</div>
					{/if}
					<div class="flex gap-2">
						<Button size="sm" class="h-11" onclick={confirmAddRootChapter} data-testid="confirm-add-chapter">追加</Button>
						<Button size="sm" variant="outline" class="h-11" onclick={cancelAddRootChapter}>キャンセル</Button>
					</div>
				</div>
			{/if}

			{#snippet chapterNode(chapter: Chapter, depth: number)}
				<div
					class="tree-node mb-1"
					role="treeitem"
					aria-selected="false"
					style:margin-left={`${depth * 1.5}rem`}
					aria-expanded={expandedChapters.has(chapter.id)}
				>
					<div class="chapter-row flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
						<Button
							variant="ghost"
							size="icon-xs"
							class="expand-toggle h-11 w-11 text-xs text-muted-foreground"
							onclick={() => toggleExpand(chapter.id)}
							aria-label={expandedChapters.has(chapter.id) ? '折りたたむ' : '展開する'}
						>
							{#if getChildren(chapter.id).length > 0}
								{expandedChapters.has(chapter.id) ? '▼' : '▶'}
							{:else}
								<span class="inline-block w-4"></span>
							{/if}
						</Button>

						{#if editingChapterId === chapter.id}
							<div class="flex flex-1 flex-col gap-2 rounded-md border border-border bg-muted/50 p-2">
								<Input
									type="text"
									bind:value={editingChapterName}
									bind:ref={editChapterNameRef}
									onkeydown={(e) =>
										handleChapterKeydown(e, confirmEditChapter, cancelEditChapter)}
									data-testid="edit-chapter-name"
								/>
								{#if chapterValidationError}
									<div
										class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
										role="alert"
										data-testid="chapter-validation-error"
									>
										{chapterValidationError}
									</div>
								{/if}
								<div class="flex gap-2">
									<Button size="sm" class="h-11" onclick={confirmEditChapter} data-testid="confirm-edit-chapter">保存</Button>
									<Button size="sm" variant="outline" class="h-11" onclick={cancelEditChapter}>キャンセル</Button>
								</div>
							</div>
						{:else}
							<span class="chapter-name min-w-0 flex-1 truncate font-medium" data-testid="chapter-name">{chapter.name}</span>
							<span class="sentence-count text-xs whitespace-nowrap text-muted-foreground">
								({chapterSentenceCounts.get(chapter.id) || 0}文)
							</span>
							<div class="chapter-actions flex shrink-0 flex-wrap gap-1">
								<Button
									size="sm"
									variant="outline"
									onclick={() => startAddChildChapter(chapter.id)}
									aria-label="子チャプターを追加"
									data-testid="add-child-chapter"
									class="h-11 sm:h-8"
								>
									+ 子
								</Button>
								<Button
									size="sm"
									variant="outline"
									onclick={() => moveChapter(chapter, -1)}
									aria-label="上へ移動"
									data-testid="move-chapter-up"
									disabled={!canMove(chapter, -1)}
									class="h-11 sm:h-8"
								>
									↑
								</Button>
								<Button
									size="sm"
									variant="outline"
									onclick={() => moveChapter(chapter, 1)}
									aria-label="下へ移動"
									data-testid="move-chapter-down"
									disabled={!canMove(chapter, 1)}
									class="h-11 sm:h-8"
								>
									↓
								</Button>
								<Button
									size="sm"
									variant="outline"
									onclick={() => startEditChapter(chapter)}
									aria-label="名前を編集"
									data-testid="edit-chapter"
									class="h-11 sm:h-8"
								>
									編集
								</Button>
								<Button
									size="sm"
									variant="destructive"
									onclick={() => {
										deleteChapterTarget = chapter;
										deleteChapterDialogOpen = true;
									}}
									aria-label="削除"
									data-testid="delete-chapter"
									class="h-11 sm:h-8"
								>
									削除
								</Button>
							</div>
						{/if}
					</div>

					{#if addingChildToId === chapter.id}
						<div class="child-form ml-10 mt-1 flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-2">
							<Input
								type="text"
								bind:value={newChildName}
								bind:ref={newChildNameRef}
								placeholder="子チャプター名"
								onkeydown={(e) =>
									handleChapterKeydown(e, confirmAddChildChapter, cancelAddChildChapter)}
								data-testid="new-child-chapter-name"
							/>
							{#if chapterValidationError}
								<div
									class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
									role="alert"
									data-testid="chapter-validation-error"
								>
									{chapterValidationError}
								</div>
							{/if}
							<div class="flex gap-2">
								<Button size="sm" class="h-11" onclick={confirmAddChildChapter} data-testid="confirm-add-child">追加</Button>
								<Button size="sm" variant="outline" class="h-11" onclick={cancelAddChildChapter}>キャンセル</Button>
							</div>
						</div>
					{/if}

					{#if expandedChapters.has(chapter.id)}
						<div class="children mt-1" role="group">
							{#each getChildren(chapter.id) as child (child.id)}
								{@render chapterNode(child, depth + 1)}
							{/each}
						</div>
					{/if}
				</div>
			{/snippet}

			<div class="chapter-tree mt-2" role="tree" aria-label="チャプターツリー">
				{#each getChildren(null) as chapter (chapter.id)}
					{@render chapterNode(chapter, 0)}
				{/each}
			</div>
		</section>

		<!-- ====================================================================== -->
		<!-- Sentence Section                                                        -->
		<!-- ====================================================================== -->

		<section class="rounded-lg border border-border bg-muted/50 p-4" aria-labelledby="sentences-heading">
			<h2 id="sentences-heading" class="mb-3 text-lg font-semibold">文章</h2>

			<!-- Filter Bar -->
			<div class="mb-4 flex flex-wrap gap-4 rounded-md border border-border bg-background p-3">
				<div class="flex items-center gap-2">
					<Label for="language-filter">言語:</Label>
					<Select.Root
						type="single"
						value={filterLanguage}
						onValueChange={(v: string) => (filterLanguage = v as 'all' | 'ja' | 'en')}
					>
						<Select.Trigger id="language-filter" data-testid="language-filter" class="w-36 data-[size=default]:h-11 sm:data-[size=default]:h-9">
							<span data-slot="select-value">{languageLabel(filterLanguage)}</span>
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="all">すべて</Select.Item>
							<Select.Item value="ja">日本語</Select.Item>
							<Select.Item value="en">English</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
				<div class="flex items-center gap-2">
					<Label for="chapter-filter">チャプター:</Label>
					<Select.Root
						type="single"
						value={filterChapterId}
						onValueChange={(v: string) => (filterChapterId = v)}
					>
						<Select.Trigger id="chapter-filter" data-testid="chapter-filter" class="w-48 data-[size=default]:h-11 sm:data-[size=default]:h-9">
							<span data-slot="select-value">{chapterFilterLabel(filterChapterId)}</span>
						</Select.Trigger>
						<Select.Content>
							<Select.Item value="all">すべて</Select.Item>
							{#each flatChapters as chapter (chapter.id)}
								<Select.Item value={chapter.id}>{chapter.name}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			<Button onclick={startAddSentence} disabled={addingSentence} class="h-11" data-testid="add-sentence">
				新しい文章
			</Button>

			{#if addingSentence}
				<div class="sentence-form mb-4 mt-2 flex flex-col gap-2 rounded-md border border-border bg-background p-2">
					<Textarea
						bind:value={newSentenceText}
						bind:ref={newSentenceTextRef}
						placeholder="文章テキスト（200文字以内）"
						maxlength={201}
						onkeydown={(e) => {
							if (e.key === 'Escape') cancelAddSentence();
						}}
						data-testid="new-sentence-text"
					/>
					<div
						class="char-count text-right text-xs text-muted-foreground"
						class:font-semibold={newSentenceOverLimit}
						class:text-destructive={newSentenceOverLimit}
					>
						{newSentenceText.length}/200
					</div>
					<div class="flex gap-3">
						<div class="flex flex-1 flex-col gap-1">
							<Label for="new-sentence-lang">言語:</Label>
							<Select.Root
								type="single"
								value={newSentenceLanguage}
								onValueChange={(v: string) => (newSentenceLanguage = v as 'ja' | 'en')}
							>
								<Select.Trigger id="new-sentence-lang" data-testid="new-sentence-lang" class="w-full">
									<span data-slot="select-value">{languageLabel(newSentenceLanguage)}</span>
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="ja">日本語</Select.Item>
									<Select.Item value="en">English</Select.Item>
								</Select.Content>
							</Select.Root>
						</div>
						<div class="flex flex-1 flex-col gap-1">
							<Label for="new-sentence-chapter">チャプター:</Label>
							<Select.Root
								type="single"
								value={newSentenceChapterId}
								onValueChange={(v: string) => (newSentenceChapterId = v)}
							>
								<Select.Trigger id="new-sentence-chapter" data-testid="new-sentence-chapter" class="w-full">
									<span data-slot="select-value">{getChapterName(newSentenceChapterId) || '選択してください'}</span>
								</Select.Trigger>
								<Select.Content>
									{#each flatChapters as chapter (chapter.id)}
										<Select.Item value={chapter.id}>{chapter.name}</Select.Item>
									{/each}
								</Select.Content>
							</Select.Root>
						</div>
					</div>
					{#if sentenceValidationError}
						<div
							class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
							role="alert"
							data-testid="sentence-validation-error"
						>
							{sentenceValidationError}
						</div>
					{/if}
					<div class="flex gap-2">
						<Button size="sm" class="h-11" onclick={confirmAddSentence} data-testid="confirm-add-sentence">追加</Button>
						<Button size="sm" variant="outline" class="h-11" onclick={cancelAddSentence}>キャンセル</Button>
					</div>
				</div>
			{/if}

			<div class="sentence-list mt-3 flex flex-col gap-2">
				{#each filteredSentences as sentence (sentence.id)}
					<div class="sentence-item overflow-hidden rounded-md border border-border bg-background">
						{#if editingSentenceId === sentence.id}
							<div class="flex flex-col gap-2 p-2">
								<Textarea
									bind:value={editingSentenceText}
									bind:ref={editSentenceTextRef}
									maxlength={201}
									onkeydown={(e) => {
										if (e.key === 'Escape') cancelEditSentence();
									}}
									data-testid="edit-sentence-text"
								/>
								<div
									class="char-count text-right text-xs text-muted-foreground"
									class:font-semibold={editingSentenceOverLimit}
									class:text-destructive={editingSentenceOverLimit}
								>
									{editingSentenceText.length}/200
								</div>
								<div class="flex gap-3">
									<div class="flex flex-1 flex-col gap-1">
										<Label for="edit-sentence-lang-{sentence.id}">言語:</Label>
										<Select.Root
											type="single"
											value={editingSentenceLanguage}
											onValueChange={(v: string) => (editingSentenceLanguage = v as 'ja' | 'en')}
										>
											<Select.Trigger id="edit-sentence-lang-{sentence.id}" data-testid="edit-sentence-lang" class="w-full">
												<span data-slot="select-value">{languageLabel(editingSentenceLanguage)}</span>
											</Select.Trigger>
											<Select.Content>
												<Select.Item value="ja">日本語</Select.Item>
												<Select.Item value="en">English</Select.Item>
											</Select.Content>
										</Select.Root>
									</div>
									<div class="flex flex-1 flex-col gap-1">
										<Label for="edit-sentence-chapter-{sentence.id}">チャプター:</Label>
										<Select.Root
											type="single"
											value={editingSentenceChapterId}
											onValueChange={(v: string) => (editingSentenceChapterId = v)}
										>
											<Select.Trigger id="edit-sentence-chapter-{sentence.id}" data-testid="edit-sentence-chapter" class="w-full">
												<span data-slot="select-value">{getChapterName(editingSentenceChapterId) || '選択してください'}</span>
											</Select.Trigger>
											<Select.Content>
												{#each flatChapters as chapter (chapter.id)}
													<Select.Item value={chapter.id}>{chapter.name}</Select.Item>
												{/each}
											</Select.Content>
										</Select.Root>
									</div>
								</div>
								{#if sentenceValidationError}
									<div
										class="rounded-md border border-destructive/30 bg-background p-2 text-xs text-destructive"
										role="alert"
										data-testid="sentence-validation-error"
									>
										{sentenceValidationError}
									</div>
								{/if}
								<div class="flex gap-2">
									<Button size="sm" class="h-11" onclick={confirmEditSentence} data-testid="confirm-edit-sentence">保存</Button>
									<Button size="sm" variant="outline" class="h-11" onclick={cancelEditSentence}>キャンセル</Button>
								</div>
							</div>
						{:else}
							<div class="sentence-content p-3">
								<div class="sentence-header mb-2 flex flex-wrap items-center gap-2">
									<span class="sentence-text min-w-0 flex-1 text-sm" data-testid="sentence-text">{sentence.text}</span>
									<span
										class="language-badge rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase {sentence.language === 'ja'
											? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
											: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'}"
									>
										{sentence.language === 'ja' ? '日本語' : 'English'}
									</span>
									<span class="chapter-badge max-w-30 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
										{getChapterName(sentence.chapterId)}
									</span>
								</div>
								<div class="sentence-actions flex flex-wrap gap-1">
									<Button
										size="sm"
										variant="outline"
										onclick={() => startEditSentence(sentence)}
										aria-label="文章を編集"
										data-testid="edit-sentence"
										class="h-11 sm:h-8"
									>
										編集
									</Button>
									<Button
										size="sm"
										variant="destructive"
										onclick={() => {
											deleteSentenceTarget = sentence;
											deleteSentenceDialogOpen = true;
										}}
										aria-label="文章を削除"
										data-testid="delete-sentence"
										class="h-11 sm:h-8"
									>
										削除
									</Button>
								</div>
							</div>
						{/if}
					</div>
				{:else}
					<div class="empty-state rounded-md border border-dashed border-border bg-muted/50 p-8 text-center text-muted-foreground">
						{#if filterLanguage !== 'all' || filterChapterId !== 'all'}
							<p>フィルターに一致する文章がありません</p>
						{:else}
							<p>まだ文章がありません。「新しい文章」を追加してください。</p>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	</div>

	<!-- ====================================================================== -->
	<!-- JSON Export                                                            -->
	<!-- ====================================================================== -->

	<section class="mb-8 rounded-lg border border-border p-4" aria-labelledby="export-heading">
		<h2 id="export-heading" class="mb-2 text-lg font-semibold">データのエクスポート</h2>
		<p class="mb-3 text-sm text-muted-foreground">現在のチャプターと文章をJSONファイルとしてダウンロードします。</p>
		<Button onclick={handleExport} class="h-11" data-testid="export-button">エクスポート</Button>
	</section>

	<!-- ====================================================================== -->
	<!-- JSON Import                                                            -->
	<!-- ====================================================================== -->

	<section class="mb-8 rounded-lg border border-border p-4" aria-labelledby="import-heading">
		<h2 id="import-heading" class="mb-2 text-lg font-semibold">データのインポート</h2>
		<p class="mb-3 text-sm text-muted-foreground">JSONファイルからチャプターと文章をインポートします。既存データはIDベースでマージされます。</p>
		<label
			for="import-input"
			class={cn(buttonVariants({ variant: 'default' }), 'h-11 cursor-pointer')}
		>
			ファイルを選択
			<input
				id="import-input"
				type="file"
				accept=".json"
				onchange={handleImport}
				data-testid="import-input"
				class="sr-only"
			/>
		</label>
		{#if importMessage}
			<p
				class="mt-3 rounded-md border p-2 text-sm {importMessage.type === 'success'
					? 'success border-success/30 bg-success/10 text-success'
					: 'error border-destructive/30 bg-background text-destructive'}"
				role="status"
				data-testid="import-message"
			>
				{importMessage.text}
			</p>
		{/if}
	</section>

	<!-- ====================================================================== -->
	<!-- Settings                                                               -->
	<!-- ====================================================================== -->

	<section class="rounded-lg border border-border p-4" aria-labelledby="settings-heading">
		<h2 id="settings-heading" class="mb-3 text-lg font-semibold">設定</h2>

		<!-- Threshold -->
		<div class="setting-row mb-4 flex flex-col gap-1.5">
			<Label for="threshold-slider">
				認識閾値: <span data-testid="threshold-value">{settings.threshold}</span>%
			</Label>
			<Slider.Root
				id="threshold-slider"
				type="single"
				value={settings.threshold}
				onValueChange={(v: number) => handleThresholdChange(v)}
				min={0}
				max={100}
				step={1}
				class="max-w-80"
				ariaLabel="認識閾値"
				data-testid="threshold-slider"
			/>
		</div>

		<!-- TTS Speed -->
		<div class="setting-row mb-4 flex flex-col gap-1.5">
			<Label for="tts-speed-slider">
				TTS速度: <span data-testid="tts-rate-value">{settings.ttsRate.toFixed(1)}</span>
			</Label>
			<Slider.Root
				id="tts-speed-slider"
				type="single"
				value={settings.ttsRate}
				onValueChange={(v: number) => handleTtsRateChange(v)}
				min={0.5}
				max={2.0}
				step={0.1}
				class="max-w-80"
				ariaLabel="TTS速度"
				data-testid="tts-speed-slider"
			/>
		</div>

		<!-- Voice -->
		<div class="setting-row mb-4 flex flex-col gap-1.5">
			<Label for="voice-select">音声:</Label>
			<Select.Root
				type="single"
				value={settings.voiceURI ?? ''}
				onValueChange={(v: string) => handleVoiceChange(v)}
			>
				<Select.Trigger id="voice-select" data-testid="voice-select" class="w-72 data-[size=default]:h-11 sm:data-[size=default]:h-9">
					<span data-slot="select-value">{voiceLabel(settings.voiceURI)}</span>
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="">デフォルト (言語に応じて自動)</Select.Item>
					<Select.Label>日本語</Select.Label>
					{#each CURATED_VOICES.filter((v) => v.lang === 'ja') as voice (voice.name)}
						<Select.Item value={voice.name}>{voice.label}</Select.Item>
					{/each}
					<Select.Separator />
					<Select.Label>English</Select.Label>
					{#each CURATED_VOICES.filter((v) => v.lang === 'en') as voice (voice.name)}
						<Select.Item value={voice.name}>{voice.label}</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>

		<!-- Retry From -->
		<fieldset class="setting-row mb-4 flex flex-col gap-1.5 border-0 p-0">
			<legend class="mb-1.5 text-sm font-medium">リトライ方法:</legend>
			<RadioGroup.Root
				value={settings.retryFrom}
				onValueChange={(v) => handleRetryFromChange(v as 'tts' | 'rerecord')}
				class="flex gap-4"
			>
				<Label class="flex items-center gap-2 font-normal">
					<RadioGroup.Item value="tts" data-testid="retry-tts" class="size-11 sm:size-4" />
					TTSから再生
				</Label>
				<Label class="flex items-center gap-2 font-normal">
					<RadioGroup.Item value="rerecord" data-testid="retry-rerecord" class="size-11 sm:size-4" />
					もう一度録音
				</Label>
			</RadioGroup.Root>
		</fieldset>
	</section>

	<!-- ====================================================================== -->
	<!-- Delete confirmation dialogs                                            -->
	<!-- ====================================================================== -->

	<AlertDialog.Root bind:open={deleteChapterDialogOpen}>
		<AlertDialog.Content>
			<AlertDialog.Header>
				<AlertDialog.Title>チャプターを削除</AlertDialog.Title>
				<AlertDialog.Description>
					このチャプターとすべての子孫チャプター・含まれる文章を削除しますか？<br />「{deleteChapterTarget?.name}」
				</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel class="h-11" data-testid="cancel-delete-chapter">キャンセル</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					class="h-11"
					onclick={confirmDeleteChapter}
					data-testid="confirm-delete-chapter"
				>
					削除
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>

	<AlertDialog.Root bind:open={deleteSentenceDialogOpen}>
		<AlertDialog.Content>
			<AlertDialog.Header>
				<AlertDialog.Title>文章を削除</AlertDialog.Title>
				<AlertDialog.Description>この文章を削除しますか？</AlertDialog.Description>
			</AlertDialog.Header>
			<AlertDialog.Footer>
				<AlertDialog.Cancel class="h-11" data-testid="cancel-delete-sentence">キャンセル</AlertDialog.Cancel>
				<AlertDialog.Action
					variant="destructive"
					class="h-11"
					onclick={confirmDeleteSentence}
					data-testid="confirm-delete-sentence"
				>
					削除
				</AlertDialog.Action>
			</AlertDialog.Footer>
		</AlertDialog.Content>
	</AlertDialog.Root>
</div>