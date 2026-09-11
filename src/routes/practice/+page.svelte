<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Volume2 } from '@lucide/svelte';
	import { toast, Toaster } from 'svelte-sonner';
	import {
		loadChapters,
		loadSentences,
		flattenChapterTree,
		getChapterSentences
	} from '$lib/sentences';
	import { speak, cancelSpeech } from '$lib/tts';
	import { startRecording } from '$lib/recorder';
	import { transcribe } from '$lib/transcribe';
	import { similarity } from '$lib/similarity';
	import { loadSettings } from '$lib/settings';
	import { CORRECT_DWELL_MS, INCORRECT_DWELL_MS } from '$lib/constants';
	import type { Sentence, PracticeState } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';

	// ---------------------------------------------------------------------------
	// State
	// ---------------------------------------------------------------------------

	let phase: PracticeState = $state('show');
	let sentences: Sentence[] = $state([]);
	let currentIndex: number = $state(0);
	let score: number | null = $state(null);
	let transcribedText: string = $state('');
	let errorMessage: string = $state('');
	let skippedCount: number = $state(0);
	let totalScore: number = $state(0);
	let completedCount: number = $state(0);

	// Active recorder while phase === 'recording' (released on phase exit).
	let rec: {
		stop: () => Promise<Blob>;
		completed: Promise<Blob>;
		onProgress?: (elapsedMs: number) => void;
	} | null = null;
	let recordingElapsedMs: number = $state(0);

	// Settings snapshot (loaded once when the session starts)
	let threshold: number = $state(80);
	let ttsRate: number = $state(1.0);
	let voiceURI: string | null = $state(null);
	let retryFrom: 'tts' | 'rerecord' = $state('tts');

	// End-of-session confirmation dialog (終了 button)
	let endDialogOpen: boolean = $state(false);

	// Pending dwell timer (auto-advance / auto-retry), cancelled by manual controls.
	let dwellTimer: ReturnType<typeof setTimeout> | null = null;

	// ---------------------------------------------------------------------------
	// Derived
	// ---------------------------------------------------------------------------

	let currentSentence = $derived(sentences[currentIndex] ?? null);
	let progress = $derived(
		sentences.length > 0 ? `${currentIndex + 1} / ${sentences.length}` : ''
	);
	let averageScore = $derived(
		completedCount > 0 ? Math.round(totalScore / completedCount) : 0
	);

	// Screen-reader announcement for phase transitions and the score.
	let phaseLabel = $derived.by(() => {
		switch (phase) {
			case 'show':
				return '文を表示中';
			case 'tts':
				return '読み上げ中';
			case 'hidden':
				return '録音準備中';
			case 'recording':
				return '録音中';
			case 'transcribing':
				return '文字起こし中';
			case 'feedback':
				return score !== null ? `スコア ${score}%` : 'フィードバック';
			case 'summary':
				return '練習完了';
		}
	});

	// ---------------------------------------------------------------------------
	// Transitions
	// ---------------------------------------------------------------------------

	function advanceToNext(): void {
		cancelDwell();
		if (currentIndex + 1 >= sentences.length) {
			phase = 'summary';
		} else {
			currentIndex++;
			score = null;
			transcribedText = '';
			errorMessage = '';
			phase = 'show';
		}
	}

	function retrySentence(): void {
		cancelDwell();
		score = null;
		transcribedText = '';
		errorMessage = '';
		phase = retryFrom === 'tts' ? 'tts' : 'hidden';
	}

	/** Dwell-time transition, guarded so skip/stop during the wait is respected. */
	function scheduleDwell(ms: number, onDone: () => void): void {
		const indexAtSchedule = currentIndex;
		dwellTimer = setTimeout(() => {
			dwellTimer = null;
			if (phase !== 'feedback' || currentIndex !== indexAtSchedule) return;
			onDone();
		}, ms);
	}

	/** Cancel a pending dwell timer (manual 次へ / もう一度試す / スキップ / 終了). */
	function cancelDwell(): void {
		if (dwellTimer !== null) {
			clearTimeout(dwellTimer);
			dwellTimer = null;
		}
	}

	/** もう一度聴く: replay the sentence from show or feedback. */
	function replaySentence(): void {
		const s = currentSentence;
		if (!s) return;
		cancelSpeech();
		cancelDwell();
		if (phase === 'show') {
			// Skip the reading dwell and speak now (the tts effect owns the speak call).
			phase = 'tts';
			return;
		}
		// feedback phase: replay the sentence; the user decides when to move on.
		void speak(s.text, s.language, { rate: ttsRate, voiceURI }).catch((err: unknown) => {
			toast.error(
				`音声再生に失敗しました: ${err instanceof Error ? err.message : '不明なエラー'}`
			);
		});
	}

	function skip(): void {
		if (phase === 'summary') return;
		skippedCount++;
		cancelSpeech();
		advanceToNext();
	}

	function stop(): void {
		if (phase === 'summary') return;
		cancelSpeech();
		cancelDwell();
		phase = 'summary';
	}

	/** Manual stop of the active recording (録音停止 button). */
	function stopRecording(): void {
		if (phase !== 'recording' || !rec) return;
		rec.stop().catch((err: unknown) => {
			console.error('Failed to stop recorder:', err);
		});
	}

	// ---------------------------------------------------------------------------
	// State effects — drive the automatic loop
	// ---------------------------------------------------------------------------

	// show: let the user read, then speak
	$effect(() => {
		if (phase !== 'show') return;
		if (!currentSentence) return;

		const timer = setTimeout(() => {
			if (phase === 'show') phase = 'tts';
		}, 800);

		return () => clearTimeout(timer);
	});

	// tts: read aloud, then hide the text and start recording
	$effect(() => {
		if (phase !== 'tts') return;
		const s = currentSentence;
		if (!s) return;

		speak(s.text, s.language, { rate: ttsRate, voiceURI })
			.then(() => {
				if (phase === 'tts') phase = 'hidden';
			})
			.catch((err: unknown) => {
				if (phase !== 'tts') return;
				errorMessage = `TTS エラー: ${err instanceof Error ? err.message : '不明なエラー'}`;
				phase = 'feedback';
			});

		return () => {};
	});

	// hidden: acquire the mic, record, then transcribe
	$effect(() => {
		if (phase !== 'hidden') return;

		recordingElapsedMs = 0;

		startRecording()
			.then((r) => {
				if (phase !== 'hidden') {
					// User skipped/stopped while the mic was being acquired — release it.
					r.stop().catch((err: unknown) => {
						console.error('Failed to release recorder:', err);
					});
					return;
				}
				rec = r;
				phase = 'recording';
				r.onProgress = (ms) => {
					recordingElapsedMs = ms;
				};
				// Transition on ANY stop (silence auto-stop / 30s forced /
				// manual stop). The transcribe trigger stays here.
				void r.completed
					.then((blob) => {
						if (phase !== 'recording') return; // left the phase — discard
						phase = 'transcribing';
						void doTranscribe(blob);
					})
					.catch((err: unknown) => {
						if (phase !== 'recording') return;
						errorMessage = `録音エラー: ${err instanceof Error ? err.message : '不明なエラー'}`;
						phase = 'feedback';
					});
			})
			.catch((err: unknown) => {
				if (phase === 'hidden') {
					errorMessage = 'マイクの使用が拒否されました';
					phase = 'feedback';
				} else if (phase === 'recording') {
					errorMessage = `録音エラー: ${err instanceof Error ? err.message : '不明なエラー'}`;
					phase = 'feedback';
				}
			});

		return () => {};
	});

	// Release the recorder when leaving the recording phase (終了/スキップ
	// etc.). The blob is discarded — do NOT transcribe.
	$effect(() => {
		if (phase !== 'recording') return;
		return () => {
			if (rec) {
				const r = rec;
				rec = null;
				r.stop().catch((err: unknown) => {
					console.error('Failed to release recorder:', err);
				});
			}
		};
	});

	// ---------------------------------------------------------------------------
	// Transcription + scoring
	// ---------------------------------------------------------------------------

	async function doTranscribe(blob: Blob): Promise<void> {
		const s = currentSentence;
		if (!s) return;
		const indexAtStart = currentIndex;

		try {
			const text = await transcribe(blob, s.language);
			if (phase !== 'transcribing' || currentIndex !== indexAtStart) return;

			transcribedText = text;
			const scoreValue = Math.round(similarity(s.text, text));
			score = scoreValue;
			totalScore += scoreValue;
			completedCount++;
			phase = 'feedback';

			if (scoreValue >= threshold) {
				scheduleDwell(CORRECT_DWELL_MS, () => advanceToNext());
			} else {
				scheduleDwell(INCORRECT_DWELL_MS, () => retrySentence());
			}
		} catch (err: unknown) {
			if (phase !== 'transcribing' || currentIndex !== indexAtStart) return;

			const msg =
				err && typeof err === 'object' && 'message' in err
					? String((err as { message: unknown }).message)
					: '不明なエラー';

			if (msg.includes('429') || msg.includes('Rate limit') || msg.includes('混雑')) {
				errorMessage = '混雑中です。しばらくお待ちください。';
			} else {
				errorMessage = `文字起こしエラー: ${msg}`;
			}
			phase = 'feedback';
		}
	}

	// ---------------------------------------------------------------------------
	// Init
	// ---------------------------------------------------------------------------

	onMount(() => {
		const settings = loadSettings();
		threshold = settings.threshold;
		ttsRate = settings.ttsRate;
		voiceURI = settings.voiceURI;
		retryFrom = settings.retryFrom;

		const chapterId = page.url.searchParams.get('chapter');
		if (!chapterId) {
			errorMessage = '章 ID が指定されていません';
			phase = 'summary';
			return;
		}

		const allChapters = loadChapters();
		const flatChapters = flattenChapterTree(allChapters);
		const targetChapter = flatChapters.find((c) => c.id === chapterId);

		if (!targetChapter) {
			errorMessage = `章が見つかりません: ${chapterId}`;
			phase = 'summary';
			return;
		}

		const allSentences = loadSentences();
		const chapterSentences = getChapterSentences(chapterId, allSentences);

		if (chapterSentences.length === 0) {
			errorMessage = 'この章には文がありません';
			phase = 'summary';
			return;
		}

		sentences = chapterSentences;
		currentIndex = 0;
		phase = 'show';
	});
</script>

<svelte:head>
	<title>練習 - おぼえる</title>
</svelte:head>

<div class="mx-auto flex min-h-dvh w-full max-w-2xl flex-col gap-6 px-4 py-6">
	<p class="sr-only" role="status" aria-live="polite">{phaseLabel}</p>

	{#if phase === 'summary'}
		<!-- ==================== SUMMARY VIEW ==================== -->
		<div
			class="flex flex-1 flex-col items-center justify-center gap-6 text-center"
			data-testid="summary"
		>
			<h1 class="text-2xl font-bold">練習完了</h1>

			{#if errorMessage}
				<p class="text-sm text-destructive" data-testid="error-message">{errorMessage}</p>
			{/if}

			<div class="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle>総文数</CardTitle>
					</CardHeader>
					<CardContent>
						<p class="text-3xl font-bold tabular-nums" data-testid="summary-sentences">
							{sentences.length}
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>平均類似度</CardTitle>
					</CardHeader>
					<CardContent>
						<p class="text-3xl font-bold tabular-nums" data-testid="summary-average">
							{averageScore}%
						</p>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>スキップ</CardTitle>
					</CardHeader>
					<CardContent>
						<p class="text-3xl font-bold tabular-nums" data-testid="summary-skipped">
							{skippedCount}
						</p>
					</CardContent>
				</Card>
			</div>

			<Button href="/" class="h-11" data-testid="home-link">トップに戻る</Button>
		</div>
	{:else}
		<!-- ==================== PRACTICE VIEW ==================== -->

		<div class="flex flex-col items-center gap-2" data-testid="progress">
			<Progress
				value={currentIndex + 1}
				max={sentences.length}
				class="w-full max-w-md"
				aria-label="進捗"
				data-testid="progress-bar"
			/>
			<span class="text-sm text-muted-foreground tabular-nums">{progress}</span>
		</div>

		<div
			class="flex min-h-40 flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-muted/40 p-8"
		>
			{#if phase === 'show' || phase === 'tts'}
				{#if currentSentence}
					<p class="text-center text-2xl font-medium leading-relaxed" data-testid="sentence-text">
						{currentSentence.text}
					</p>
					{#if phase === 'show'}
						<Button
							variant="outline"
							class="mt-2 h-11"
							data-testid="replay-btn"
							onclick={replaySentence}
						>
							<Volume2 /> もう一度聴く
						</Button>
					{/if}
				{/if}
			{:else if phase === 'hidden'}
				<p class="text-base text-muted-foreground" data-testid="sentence-hidden">非表示中…</p>
			{:else if phase === 'recording'}
				<div class="flex flex-col items-center gap-4">
					<p class="text-base text-muted-foreground" data-testid="sentence-recording">録音中…</p>
					<p class="text-sm text-muted-foreground tabular-nums" data-testid="recording-timer">
						{(recordingElapsedMs / 1000).toFixed(1)} 秒
					</p>
					<Button
						variant="destructive"
						onclick={stopRecording}
						class="h-11"
						data-testid="stop-recording-btn"
					>
						録音停止
					</Button>
				</div>
			{:else if phase === 'transcribing'}
				<p class="text-base text-muted-foreground" data-testid="sentence-transcribing">
					文字起こし中…
				</p>
			{:else if phase === 'feedback'}
				{#if errorMessage}
					<p class="text-center text-sm text-destructive" data-testid="error-message">
						{errorMessage}
					</p>
				{:else if score !== null}
					<div class="flex flex-col items-center gap-4 text-center" data-testid="feedback">
						<p
							class="score text-5xl font-bold tabular-nums"
							class:pass={score >= threshold}
							class:fail={score < threshold}
							data-testid="score"
						>
							{score}%
						</p>
						{#if transcribedText}
							<p class="text-sm text-muted-foreground italic" data-testid="transcribed-text">
								「{transcribedText}」
							</p>
						{/if}
						<div class="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
							<Button variant="outline" class="h-11 w-full sm:w-auto" data-testid="replay-btn" onclick={replaySentence}>
								<Volume2 /> もう一度聴く
							</Button>
							{#if score >= threshold}
								<Button class="h-11 w-full sm:w-auto" data-testid="next-btn" onclick={advanceToNext}>次へ</Button>
							{:else}
								<Button variant="secondary" class="h-11 w-full sm:w-auto" data-testid="retry-btn" onclick={retrySentence}>
									もう一度試す
								</Button>
							{/if}
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<div class="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
			<Button variant="outline" class="h-11 w-full sm:w-auto" onclick={skip} data-testid="skip-btn">スキップ</Button>
			<Button
				variant="destructive"
				class="h-11 w-full sm:w-auto"
				onclick={() => (endDialogOpen = true)}
				data-testid="stop-btn"
			>
				終了
			</Button>
		</div>
	{/if}

	<AlertDialog bind:open={endDialogOpen}>
		<AlertDialogContent data-testid="end-dialog">
			<AlertDialogHeader>
				<AlertDialogTitle>セッションを終了しますか?</AlertDialogTitle>
				<AlertDialogDescription>
					進行状況は保存されません。終了するとサマリーが表示されます。
				</AlertDialogDescription>
			</AlertDialogHeader>
			<AlertDialogFooter>
				<AlertDialogCancel class="h-11" data-testid="cancel-end-btn">キャンセル</AlertDialogCancel>
				<AlertDialogAction variant="destructive" class="h-11" data-testid="confirm-end-btn" onclick={stop}>
					終了
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialogContent>
	</AlertDialog>

	<Toaster position="bottom-center" richColors />
</div>

<style>
	/* Pass/fail score colors (state classes asserted by tests). */
	.score.pass {
		color: var(--success);
	}

	.score.fail {
		color: var(--destructive);
	}
</style>