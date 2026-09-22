<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Volume2, Loader2, Mic } from '@lucide/svelte';
	import { toast, Toaster } from 'svelte-sonner';
	import {
		loadChapters,
		loadSentences,
		loadTracks,
		flattenChapterTree,
		getChapterSentences
	} from '$lib/sentences';
	import { speak, cancelSpeech, prefetchTts } from '$lib/tts';
	import { startRecording } from '$lib/recorder';
	import { transcribe } from '$lib/transcribe';
	import { similarity } from '$lib/similarity';
	import { tokenizeSentence, ProgressAligner } from '$lib/alignment';
	import { createLiveStt, terminateLiveStt } from '$lib/livestt/engine';
	import type { LiveSttEngine, LiveWord } from '$lib/livestt/types';
	import type { MockWordStep } from '$lib/livestt/mock-engine';
	import { loadSettings } from '$lib/settings';
	import {
		loadPracticePrefs,
		loadPracticeProgress,
		savePracticeProgress,
		clearPracticeProgress,
		type PracticeProgress
	} from '$lib/practice-prefs';
	import type { Sentence, PracticeState, Track } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
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

	/** Which subsystem failed — decides the retry button shown in error feedback. */
	type ErrorKind = 'tts' | 'record' | 'transcribe';
	let errorKind: ErrorKind | null = $state(null);
	/** Blob of the failed transcription attempt, kept so 「もう一度採点」 can resend it. */
	let pendingBlob: Blob | null = $state(null);

	// Session outcome tracking for the summary (memory only, not persisted).
	let endedEarly: boolean = $state(false);
	let passedIds: string[] = $state([]);
	let failedEntries: Sentence[] = $state([]);

	// Active recorder while phase === 'recording' (released on phase exit).
	let rec: {
		stop: () => Promise<Blob>;
		completed: Promise<Blob>;
		onProgress?: (elapsedMs: number) => void;
		onLevel?: (rms: number) => void;
	} | null = null;
	let recordingElapsedMs: number = $state(0);
	let recordingLevel: number = $state(0);

	// Push-to-talk (T13). Recording starts ONLY while the user holds Space
	// or the on-screen hold button; releasing stops + scores.
	/** Pressing below this counts as a stray tap — hint instead of scoring. */
	const MIN_HOLD_MS = 500;
	/** startRecording is in flight (mic acquisition / graph setup). */
	let micConnecting: boolean = $state(false);
	/** The last push failed to acquire the mic — surfaced on the ready screen. */
	let micError: boolean = $state(false);
	/** The last release was a short tap — hint shown on the ready screen. */
	let shortPressHint: boolean = $state(false);
	/** performance.now() when the recording actually began. */
	let holdStartedAt: number = 0;
	/** Space was released while the mic was still connecting. */
	let holdPendingRelease: boolean = false;
	/** Only the newest hold attempt may claim its recorder resolve. */
	let holdAttemptId: number = 0;
	/** A pointer hold is active (button pointerdown seen, release pending). */
	let pointerHolding: boolean = false;

	// Warm mic stream (T13): acquired during show/tts so a push starts
	// recording instantly; kept open for the session, released at the end.
	let warmStream: MediaStream | null = null;

	// Settings snapshot (loaded once when the session starts)
	let threshold: number = $state(80);
	let ttsRate: number = $state(1.0);
	let voiceURI: string | null = $state(null);
	let retryFrom: 'tts' | 'rerecord' = $state('tts');

	let chapterName: string = $state('');

	// Tracks of the practiced chapter (loaded once at session start) — powers
	// the current-track badge in the header.
	let tracks: Track[] = $state([]);

	// End-of-session confirmation dialog (終了 button / Esc)
	let endDialogOpen: boolean = $state(false);

	// Operation prefs (T9): dwell speeds + auto-advance, loaded once on mount.
	let autoAdvance: boolean = $state(true);
	let correctDwellMs: number = $state(800);
	let incorrectDwellMs: number = $state(2000);

	// Mid-session restore (T9). The phase machine is held behind the restore
	// dialog (sessionReady) until the user picks 続ける / 最初から.
	let currentChapterId: string | null = null;
	let sessionReady: boolean = $state(false);
	let pendingRestore: PracticeProgress | null = null;
	let restoreDialogOpen: boolean = $state(false);

	// Pending dwell timer (auto-advance / auto-retry), cancelled by manual controls.
	let dwellTimer: ReturnType<typeof setTimeout> | null = null;

	// Live word display (T8) — a visual aid only (aria-hidden stream); the
	// phase announcements and the final diff stay authoritative.
	let liveMode: 'pending' | 'on' | 'off' = $state('pending');
	let liveTokens: string[] = $state([]);
	let liveMatched: number[] = $state([]);
	let liveChips: { word: string; at: number }[] = $state([]);
	let liveGhost: { index: number; text: string } | null = $state(null);

	// Non-reactive live wiring — disposed by the phase effects below.
	let liveEngine: LiveSttEngine | null = null;
	let liveAligner: ProgressAligner | null = null;
	let liveAttemptId = 0;
	let ghostTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingGhost: { index: number; text: string } | null = null;

	/** Ghost updates are debounced so fast partial streams don't flicker. */
	const LIVE_GHOST_DEBOUNCE_MS = 300;
	/** 16 kHz is the rate the live engine consumes (vosk recognizer + tap). */
	const LIVE_SAMPLE_RATE = 16000;

	// ---------------------------------------------------------------------------
	// Derived
	// ---------------------------------------------------------------------------

	let currentSentence = $derived(sentences[currentIndex] ?? null);
	let progress = $derived(
		sentences.length > 0 ? `${currentIndex + 1} / ${sentences.length}` : ''
	);
	// Track name of the current sentence ('' when unknown / unnamed).
	// Re-derives when sentences is replaced (間違えた文だけやり直す) or moves.
	let currentTrackName = $derived(
		tracks.find((t) => t.id === sentences[currentIndex]?.trackId)?.name ?? ''
	);
	// The badge only makes sense when the chapter actually splits into tracks —
	// single-track chapters keep the classic header (badge hidden, plain progress).
	let chapterTrackCount = $derived(
		sentences[0] ? tracks.filter((t) => t.chapterId === sentences[0]?.chapterId).length : 0
	);
	let showTrackBadge = $derived(chapterTrackCount > 1 && currentTrackName !== '');
	let averageScore = $derived(
		completedCount > 0 ? Math.round(totalScore / completedCount) : 0
	);

	// 0-100% visual level from the recorder's RMS (0.25 rms ≈ full scale).
	let levelPct = $derived(Math.min(100, Math.round(recordingLevel * 400)));

	let errorRetryLabel = $derived.by(() => {
		switch (errorKind) {
			case 'tts':
				return 'もう一度再生';
			case 'record':
				return 'もう一度録音';
			case 'transcribe':
				return 'もう一度採点';
			default:
				return 'もう一度試す';
		}
	});

	// Word-level diff for feedback: target tokens colored by the final
	// transcription via ProgressAligner (match=green+underline,
	// mismatch=red+strikethrough, unread=gray). Null when there is nothing
	// to diff (no transcript / error feedback).
	interface DiffToken {
		text: string;
		status: 'match' | 'mismatch' | 'unread';
	}
	let diffTokens = $derived.by<DiffToken[] | null>(() => {
		const s = currentSentence;
		if (phase !== 'feedback' || score === null || errorMessage || !s) return null;
		if (!transcribedText.trim()) return null;

		const targetTokens = tokenizeSentence(s.text, s.language);
		if (targetTokens.length === 0) return null;

		const aligner = new ProgressAligner(targetTokens);
		const statusByIndex = new Map<number, 'match' | 'mismatch'>();
		for (const word of tokenizeSentence(transcribedText, s.language)) {
			const verdict = aligner.feed(word);
			if (verdict) statusByIndex.set(verdict.tokenIndex, verdict.status);
		}
		return targetTokens.map((text, i) => ({
			text,
			status: statusByIndex.get(i) ?? 'unread'
		}));
	});

	// Screen-reader announcement for phase transitions and the score.
	let phaseLabel = $derived.by(() => {
		switch (phase) {
			case 'show':
				return '文を表示中';
			case 'tts':
				return '読み上げ中';
			case 'hidden':
				return '録音準備完了';
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

	function resetAttemptState(): void {
		score = null;
		transcribedText = '';
		errorMessage = '';
		errorKind = null;
		pendingBlob = null;
	}

	function advanceToNext(): void {
		cancelDwell();
		if (currentIndex + 1 >= sentences.length) {
			phase = 'summary';
		} else {
			currentIndex++;
			resetAttemptState();
			phase = 'show';
		}
	}

	function retrySentence(): void {
		cancelDwell();
		resetAttemptState();
		phase = retryFrom === 'tts' ? 'tts' : 'hidden';
	}

	/** Retry after an error feedback, resuming at the failing subsystem. */
	function retryFromError(): void {
		if (!errorKind) return;
		cancelDwell();
		const kind = errorKind;
		// Read the blob BEFORE resetting — 「もう一度採点」 resends the same audio.
		const blob = pendingBlob;
		resetAttemptState();
		if (kind === 'tts') {
			phase = 'tts';
			return;
		}
		if (kind === 'record') {
			phase = 'hidden';
			return;
		}
		// transcribe: re-score the SAME blob kept from the failed attempt.
		if (!blob) {
			phase = 'hidden';
			return;
		}
		phase = 'transcribing';
		void doTranscribe(blob);
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
		if (phase !== 'show' && phase !== 'feedback') return;
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
		endedEarly = true;
		phase = 'summary';
	}

	/** Restart the session with only the sentences that never passed (memory only). */
	function retryFailedOnly(): void {
		if (failedEntries.length === 0) return;
		sentences = [...failedEntries];
		currentIndex = 0;
		resetAttemptState();
		skippedCount = 0;
		totalScore = 0;
		completedCount = 0;
		passedIds = [];
		failedEntries = [];
		endedEarly = false;
		phase = 'show';
	}

	// ---------------------------------------------------------------------------
	// Push-to-talk (T13): hold Space or the hold button to record
	// ---------------------------------------------------------------------------

	/** Pre-acquire the mic during show/tts so a push starts recording instantly. */
	async function warmMic(): Promise<void> {
		if (warmStream) return;
		try {
			warmStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {
			// Best-effort warm-up — the real error surfaces at push time.
			warmStream = null;
		}
	}

	/** Release the warm-up stream (summary / unmount). */
	function releaseWarmMic(): void {
		warmStream?.getTracks().forEach((t) => t.stop());
		warmStream = null;
	}

	/** Ready-screen retry after a denied mic: re-warm re-prompts the permission. */
	function retryMic(): void {
		micError = false;
		shortPressHint = false;
		void warmMic();
	}

	/**
	 * Begin a hold: cancel any TTS and start recording immediately (Space
	 * during show/tts/hidden). The ready view shows マイクを準備中… while
	 * the recorder connects; `recording` begins the moment it resolves.
	 */
	function beginHold(): void {
		if (phase !== 'show' && phase !== 'tts' && phase !== 'hidden') return;
		if (micConnecting) return;
		if (restoreDialogOpen || endDialogOpen) return;
		const s = currentSentence;
		if (!s) return;

		cancelSpeech();
		cancelDwell();
		resetAttemptState();
		micError = false;
		shortPressHint = false;
		holdPendingRelease = false;
		const attemptId = ++holdAttemptId;
		micConnecting = true;
		// show/tts jump to the ready view (準備中… until the mic resolves).
		phase = 'hidden';

		startRecording({
			// Hold-to-record: silence never ends the recording (30s force-stop
			// stays as the safety net). Feeds the live STT when it is ready.
			autoStop: false,
			onAudioFrame: (samples) => liveEngine?.feed(samples)
		})
			.then((r) => {
				micConnecting = false;
				if (attemptId !== holdAttemptId || phase !== 'hidden') {
					// Superseded or skipped while connecting — release the mic.
					r.stop().catch((err: unknown) => {
						console.error('Failed to release recorder:', err);
					});
					return;
				}
				rec = r;
				phase = 'recording';
				holdStartedAt = performance.now();
				r.onProgress = (ms) => {
					recordingElapsedMs = ms;
				};
				r.onLevel = (rms) => {
					recordingLevel = rms;
				};
				// Start the warmed live engine now; frames fed before start()
				// are ring-buffered engine-side, so nothing is lost.
				const engine = liveEngine;
				if (engine) {
					const engineAttempt = liveAttemptId;
					void engine.start(LIVE_SAMPLE_RATE).catch(() => {
						if (engineAttempt === liveAttemptId) liveMode = 'off';
					});
				}
				// Space was released while the mic was connecting — treat the
				// instant stop as a short tap.
				if (holdPendingRelease) endHold();
				// Transition on ANY stop (release / 30s forced). The transcribe
				// trigger stays here.
				void r.completed
					.then((blob) => {
						if (phase !== 'recording') return; // left the phase — discard
						phase = 'transcribing';
						pendingBlob = blob;
						void doTranscribe(blob);
					})
					.catch((err: unknown) => {
						if (phase !== 'recording') return;
						errorMessage = `録音エラー: ${err instanceof Error ? err.message : '不明なエラー'}`;
						errorKind = 'record';
						phase = 'feedback';
					});
			})
			.catch(() => {
				micConnecting = false;
				if (attemptId !== holdAttemptId || phase !== 'hidden') return;
				// Mic denied/unavailable — surface on the ready screen with a retry.
				micError = true;
			});
	}

	/** End a hold: release ≥ MIN_HOLD_MS scores, a shorter tap shows a hint. */
	function endHold(): void {
		if (micConnecting) {
			holdPendingRelease = true;
			return;
		}
		if (phase !== 'recording' || !rec) return;
		const heldMs = performance.now() - holdStartedAt;
		if (heldMs < MIN_HOLD_MS) {
			// Stray tap — discard the blob (the recording-phase cleanup stops
			// the recorder) and coach a longer hold instead of scoring it.
			shortPressHint = true;
			phase = 'hidden';
			return;
		}
		rec.stop().catch((err: unknown) => {
			console.error('Failed to stop recorder:', err);
		});
	}

	/**
	 * Pointer entry of the hold: the hold button only sees pointerdown —
	 * the moment recording starts the button unmounts, so pointerup /
	 * pointercancel are caught at document level (effect below) while a
	 * hold is live.
	 */
	function startPointerHold(): void {
		pointerHolding = true;
		beginHold();
	}

	function endPointerHold(): void {
		if (!pointerHolding) return;
		pointerHolding = false;
		endHold();
	}

	// ---------------------------------------------------------------------------
	// Live word display (T8)
	// ---------------------------------------------------------------------------

	function clearLiveGhost(): void {
		if (ghostTimer !== null) {
			clearTimeout(ghostTimer);
			ghostTimer = null;
		}
		pendingGhost = null;
		liveGhost = null;
	}

	function handleLiveWord(word: LiveWord): void {
		const aligner = liveAligner;
		if (!aligner) return;
		const verdict = aligner.feed(word.word);
		// A confirmed word supersedes any pending ghost.
		clearLiveGhost();
		if (!verdict) return;
		if (verdict.status === 'match') {
			liveMatched = [...liveMatched, verdict.tokenIndex];
		} else {
			// Mismatch chips stay in the spoken stream; the pending slot stays empty.
			liveChips = [...liveChips, { word: word.word, at: verdict.tokenIndex }];
		}
	}

	function handleLivePartial(word: LiveWord): void {
		const aligner = liveAligner;
		if (!aligner) return;
		const state = aligner.feedPartial(word.word);
		pendingGhost =
			state && state.ghost ? { index: state.nextTokenIndex, text: state.ghost } : null;
		if (ghostTimer !== null) clearTimeout(ghostTimer);
		ghostTimer = setTimeout(() => {
			ghostTimer = null;
			liveGhost = pendingGhost;
		}, LIVE_GHOST_DEBOUNCE_MS);
	}

	/** Idempotent — safe to call from every cleanup path. */
	function disposeLiveEngine(): void {
		clearLiveGhost();
		liveAligner = null;
		if (liveEngine) {
			const engine = liveEngine;
			liveEngine = null;
			engine.dispose();
		}
	}

	const E2E_MISMATCH_WORD = 'バナナ';

	/** Script the mock engine from the target tokens: green slots + one red chip + one ghost. */
	function buildE2eScript(tokens: string[]): MockWordStep[] {
		const steps: MockWordStep[] = [];
		tokens.forEach((token, i) => {
			const isLast = i === tokens.length - 1;
			if (isLast && tokens.length > 1) {
				steps.push({
					word: token.slice(0, Math.max(1, Math.ceil(token.length / 2))),
					delayMs: 350,
					partial: true
				});
				steps.push({ word: token, delayMs: 1500 });
			} else {
				steps.push({ word: token, delayMs: i === 0 ? 600 : 400 });
			}
			if (i === 0 && tokens.length > 1) {
				steps.push({ word: E2E_MISMATCH_WORD, delayMs: 400 });
			}
		});
		return steps;
	}

	/** Live engine acquisition. DEV ?e2e=1 injects the scripted mock (never shipped). */
	async function acquireLiveEngine(s: Sentence): Promise<LiveSttEngine | null> {
		if (import.meta.env.DEV && page.url.searchParams.get('e2e') === '1') {
			if (page.url.searchParams.has('liveFail')) return null;
			const { createMockEngine } = await import('$lib/livestt/mock-engine');
			return createMockEngine(buildE2eScript(tokenizeSentence(s.text, s.language)));
		}
		return createLiveStt({ lang: s.language });
	}

	// ---------------------------------------------------------------------------
	// Keyboard shortcuts (disabled while the dialog is open / while typing)
	// ---------------------------------------------------------------------------

	function primaryAction(): void {
		switch (phase) {
			case 'show':
			case 'tts':
				// 読み飛ばして録音準備(プッシュ待ち)へ
				cancelSpeech();
				cancelDwell();
				phase = 'hidden';
				return;
			case 'feedback':
				if (errorMessage) {
					retryFromError();
					return;
				}
				if (score === null) return;
				if (score >= threshold) advanceToNext();
				else retrySentence();
				return;
			default:
				return;
		}
	}

	// Registered on document in the CAPTURE phase so Escape is handled before
	// bits-ui's document-level listener — otherwise the dialog's own close and
	// this handler's reopen race within a single Escape keypress.
	$effect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.ctrlKey || e.metaKey || e.altKey) return;

			// While the restore dialog is up, it owns the keyboard — bits-ui
			// handles its own Escape-to-cancel (→ 最初から).
			if (restoreDialogOpen) return;

			const el = e.target instanceof HTMLElement ? e.target : document.activeElement;
			const isTyping =
				el instanceof HTMLElement &&
				(el.tagName === 'INPUT' ||
					el.tagName === 'TEXTAREA' ||
					el.tagName === 'SELECT' ||
					el.isContentEditable);
			if (isTyping) return;

			if (e.key === 'Escape') {
				if (endDialogOpen) {
					e.preventDefault();
					e.stopPropagation();
					endDialogOpen = false;
				} else if (phase !== 'summary') {
					endDialogOpen = true;
				}
				return;
			}

			if (phase === 'summary' || endDialogOpen) return;

			switch (e.key) {
				case ' ': {
					// Push-to-talk: hold = record, focus-independent (a focused
					// action button must not swallow the push; its native
					// Space-activation is cancelled by preventDefault). repeat
					// keydowns are the OS auto-repeat of an already-held key.
					if (e.repeat) return;
					e.preventDefault();
					if (phase === 'feedback') {
						// Tap = 次へ / もう一度試す (keydown only; release is inert).
						primaryAction();
					} else {
						beginHold();
					}
					return;
				}
				case 'Enter': {
					// A focused button/link activates itself natively — don't double-fire.
					if (el instanceof HTMLElement && el.closest('button, a[href], [role="button"]')) {
						return;
					}
					e.preventDefault();
					primaryAction();
					return;
				}
				case 'r':
				case 'R':
					replaySentence();
					return;
				case 's':
				case 'S':
					skip();
					return;
			}
		};
		const onKeyUp = (e: KeyboardEvent): void => {
			// Release ends the hold (→ transcribing / short-tap hint).
			if (e.key !== ' ') return;
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			if (restoreDialogOpen || endDialogOpen) return;
			endHold();
		};
		document.addEventListener('keydown', onKeyDown, { capture: true });
		document.addEventListener('keyup', onKeyUp, { capture: true });
		return () => {
			document.removeEventListener('keydown', onKeyDown, { capture: true });
			document.removeEventListener('keyup', onKeyUp, { capture: true });
		};
	});

	// Pointer mirror of the keyup handler: live while a hold is connecting
	// or recording, because the hold button unmounts the moment the phase
	// moves on (release anywhere still ends the hold).
	$effect(() => {
		if (!micConnecting && phase !== 'recording') return;
		const onPointerEnd = (): void => endPointerHold();
		document.addEventListener('pointerup', onPointerEnd, { capture: true });
		document.addEventListener('pointercancel', onPointerEnd, { capture: true });
		return () => {
			document.removeEventListener('pointerup', onPointerEnd, { capture: true });
			document.removeEventListener('pointercancel', onPointerEnd, { capture: true });
		};
	});

	// ---------------------------------------------------------------------------
	// State effects — drive the automatic loop
	// ---------------------------------------------------------------------------

	// show: let the user read, warm the TTS cache, then speak
	$effect(() => {
		if (phase !== 'show' || !sessionReady) return;
		const s = currentSentence;
		if (!s) return;

		// Fire-and-forget prefetch (T3 cache). Prefetch rejects on failure —
		// swallow here; the tts effect's speak() reports the real error.
		void prefetchTts(s.text, s.language, { rate: ttsRate, voiceURI }).catch(() => {
			// Non-fatal — speak() surfaces the failure to the user.
		});

		const timer = setTimeout(() => {
			if (phase === 'show') phase = 'tts';
		}, 800);

		return () => clearTimeout(timer);
	});

	// tts: read aloud (cache hit = no fetch), prefetch the next sentence
	$effect(() => {
		if (phase !== 'tts') return;
		const s = currentSentence;
		if (!s) return;

		const next = sentences[currentIndex + 1];
		if (next) {
			void prefetchTts(next.text, next.language, { rate: ttsRate, voiceURI }).catch(() => {
				// Non-fatal — the next sentence's speak() reports the failure.
			});
		}

		speak(s.text, s.language, { rate: ttsRate, voiceURI })
			.then(() => {
				if (phase === 'tts') phase = 'hidden';
			})
			.catch((err: unknown) => {
				if (phase !== 'tts') return;
				errorMessage = `TTS エラー: ${err instanceof Error ? err.message : '不明なエラー'}`;
				errorKind = 'tts';
				phase = 'feedback';
			});

		return () => {};
	});

	// hidden: ready-for-push state (T13). No auto recording — the mic is
	// warmed and the live STT engine is acquired; the actual recording
	// starts when the user pushes (Space keydown / hold-button pointerdown,
	// see beginHold).
	$effect(() => {
		if (phase !== 'hidden') return;
		const s = currentSentence;
		if (!s) return;

		recordingElapsedMs = 0;
		recordingLevel = 0;

		// Live STT (T8): reset the attempt display and acquire the engine in
		// the background. engine.start() is deferred to the push — frames fed
		// before start() are ring-buffered engine-side, so nothing is lost.
		const attemptId = ++liveAttemptId;
		const tokens = tokenizeSentence(s.text, s.language);
		liveTokens = tokens;
		liveMatched = [];
		liveChips = [];
		clearLiveGhost();
		liveMode = tokens.length === 0 ? 'off' : 'pending';
		liveAligner = tokens.length === 0 ? null : new ProgressAligner(tokens);

		acquireLiveEngine(s)
			.then((engine) => {
				if (attemptId !== liveAttemptId) {
					// The attempt ended while the model was loading.
					engine?.dispose();
					return;
				}
				if (!engine) {
					liveMode = 'off';
					return;
				}
				liveEngine = engine;
				engine.onWord(handleLiveWord);
				engine.onPartial(handleLivePartial);
				liveMode = 'on';
			})
			.catch(() => {
				if (attemptId === liveAttemptId) liveMode = 'off';
			});

		void warmMic();

		return () => {};
	});

	// Release the recorder when leaving the recording phase (終了/スキップ
	// etc.). The blob is discarded — do NOT transcribe. The live engine dies
	// with the attempt (covers recording → transcribing, skip and stop).
	$effect(() => {
		if (phase !== 'recording') return;
		return () => {
			disposeLiveEngine();
			if (rec) {
				const r = rec;
				rec = null;
				r.stop().catch((err: unknown) => {
					console.error('Failed to release recorder:', err);
				});
			}
		};
	});

	// Reaching the summary also ends a live attempt that never made it to
	// the recording phase (終了 during hidden) and frees the warm mic.
	$effect(() => {
		if (phase === 'summary') {
			disposeLiveEngine();
			releaseWarmMic();
		}
	});

	// Practice unmount: free the per-attempt engine, the warm mic and the
	// shared Model.
	$effect(() => {
		return () => {
			disposeLiveEngine();
			releaseWarmMic();
			void terminateLiveStt();
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
			pendingBlob = null;
			const sim = Math.round(similarity(s.text, text));

			// Jev semantic judge: rescue orthography-variant failures. Only called
			// when the similarity score alone would fail (a pass is already decided).
			let finalScore = sim;
			if (sim < threshold) {
				const judgeController = new AbortController();
				const judgeTimeoutId = setTimeout(() => judgeController.abort(), 10_000);
				try {
					const res = await fetch('/api/judge', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ reference: s.text, transcription: text }),
						signal: judgeController.signal
					});
					const judge = await res.json();
					if (judge?.available === true && typeof judge.noul === 'number' && judge.noul > 0) {
						finalScore = Math.max(sim, Math.round(judge.noul * 100));
					}
				} catch (err) {
					// judge unavailable → keep sim (existing behavior)
					console.debug('judge fallback:', err);
				} finally {
					clearTimeout(judgeTimeoutId);
				}
				// The judge call is a second await: skip/stop may have moved the
				// attempt meanwhile — re-guard like the transcribe path above.
				if (phase !== 'transcribing' || currentIndex !== indexAtStart) return;
			}

			score = finalScore;
			totalScore += finalScore;
			completedCount++;
			if (finalScore >= threshold) {
				if (!passedIds.includes(s.id)) passedIds.push(s.id);
				failedEntries = failedEntries.filter((entry) => entry.id !== s.id);
				phase = 'feedback';
				if (autoAdvance) scheduleDwell(correctDwellMs, () => advanceToNext());
			} else {
				if (!failedEntries.some((entry) => entry.id === s.id)) failedEntries.push(s);
				phase = 'feedback';
				if (autoAdvance) scheduleDwell(incorrectDwellMs, () => retrySentence());
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
			// Keep pendingBlob so 「もう一度採点」 can resend the same audio.
			errorKind = 'transcribe';
			phase = 'feedback';
		}
	}

	// ---------------------------------------------------------------------------
	// Session restore (T9)
	// ---------------------------------------------------------------------------

	function startSession(): void {
		sessionReady = true;
		phase = 'show';
	}

	function applyRestore(): void {
		if (!pendingRestore) return;
		const saved = pendingRestore;
		pendingRestore = null;
		// A saved index may fall outside after edits — clamp into the chapter.
		currentIndex = Math.min(Math.max(saved.currentIndex, 0), sentences.length - 1);
		completedCount = saved.completedCount;
		totalScore = saved.totalScore;
		skippedCount = saved.skippedCount;
		startSession();
	}

	function startFresh(): void {
		pendingRestore = null;
		clearPracticeProgress();
		currentIndex = 0;
		completedCount = 0;
		totalScore = 0;
		skippedCount = 0;
		startSession();
	}

	/** Any close without 続ける (cancel / Esc / overlay) starts over. */
	function handleRestoreOpenChange(open: boolean): void {
		restoreDialogOpen = open;
		if (!open && !sessionReady) startFresh();
	}

	// Track the session in sessionStorage so a reload can offer to resume.
	// A passing feedback rounds forward (the attempt is settled); every other
	// phase keeps the snapshot at the current sentence — recording /
	// transcribing therefore round back to the last show origin.
	$effect(() => {
		if (!sessionReady) return;
		if (phase === 'summary') {
			clearPracticeProgress();
			return;
		}
		if (!currentChapterId) return;
		const index =
			phase === 'feedback' && score !== null && !errorMessage && score >= threshold
				? currentIndex + 1
				: currentIndex;
		savePracticeProgress({
			chapterId: currentChapterId,
			currentIndex: index,
			completedCount,
			totalScore,
			skippedCount,
			savedAt: Date.now()
		});
	});

	// ---------------------------------------------------------------------------
	// Init
	// ---------------------------------------------------------------------------

	onMount(() => {
		const settings = loadSettings();
		threshold = settings.threshold;
		ttsRate = settings.ttsRate;
		voiceURI = settings.voiceURI;
		retryFrom = settings.retryFrom;

		const prefs = loadPracticePrefs();
		autoAdvance = prefs.autoAdvance;
		correctDwellMs = prefs.correctDwellMs;
		incorrectDwellMs = prefs.incorrectDwellMs;

		const chapterId = page.url.searchParams.get('chapter');
		if (!chapterId) {
			errorMessage = '章 ID が指定されていません';
			endedEarly = true;
			phase = 'summary';
			return;
		}

		const allChapters = loadChapters();
		const flatChapters = flattenChapterTree(allChapters);
		const targetChapter = flatChapters.find((c) => c.id === chapterId);

		if (!targetChapter) {
			errorMessage = `章が見つかりません: ${chapterId}`;
			endedEarly = true;
			phase = 'summary';
			return;
		}

		chapterName = targetChapter.name;

		const allSentences = loadSentences();
		const chapterSentences = getChapterSentences(chapterId, allSentences);

		if (chapterSentences.length === 0) {
			errorMessage = 'この章には文がありません';
			endedEarly = true;
			phase = 'summary';
			return;
		}

		sentences = chapterSentences;
		currentIndex = 0;
		currentChapterId = chapterId;
		tracks = loadTracks();

		const saved = loadPracticeProgress(chapterId);
		const hasProgress =
			saved !== null &&
			(saved.currentIndex > 0 || saved.completedCount > 0 || saved.skippedCount > 0);
		if (hasProgress && saved) {
			pendingRestore = saved;
			restoreDialogOpen = true;
		} else {
			startSession();
		}
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
			<h1 class="text-2xl font-bold" data-testid="summary-title">
				{endedEarly ? 'おつかれさま!' : '練習完了!'}
			</h1>

			{#if errorMessage}
				<p class="text-sm text-destructive" data-testid="error-message">{errorMessage}</p>
			{/if}

			<div class="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle>完了文数</CardTitle>
					</CardHeader>
					<CardContent>
						<p class="text-3xl font-bold tabular-nums" data-testid="summary-completed">
							{passedIds.length} / {sentences.length}
						</p>
						<p class="mt-1 text-sm text-muted-foreground">
							総文数
							<span class="tabular-nums" data-testid="summary-sentences">
								{sentences.length}
							</span>
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

			{#if failedEntries.length > 0}
				<div class="w-full max-w-md text-left">
					<p class="mb-2 text-sm font-medium">間違えた文 ({failedEntries.length}問)</p>
					<ul class="flex flex-col gap-2" data-testid="summary-failed-list">
						{#each failedEntries as failed (failed.id)}
							<li
								class="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
								data-testid="summary-failed-item"
							>
								{failed.text}
							</li>
						{/each}
					</ul>
					<Button class="mt-4 h-11 w-full" data-testid="retry-failed-btn" onclick={retryFailedOnly}>
						間違えた文だけやり直す
					</Button>
				</div>
			{/if}

			<Button href="/" class="h-11" data-testid="home-link">トップに戻る</Button>
		</div>
	{:else}
		<!-- ==================== PRACTICE VIEW ==================== -->

		<header class="flex items-center gap-3" data-testid="practice-header">
			<h1 class="min-w-0 shrink-0 truncate text-sm font-bold sm:text-base" data-testid="chapter-name">
				{chapterName}
			</h1>
			{#if showTrackBadge}
				<Badge class="max-w-28 shrink-0 truncate" data-testid="track-badge">
					{currentTrackName}
				</Badge>
			{/if}
			<div class="flex min-w-0 flex-1 flex-col items-center gap-1" data-testid="progress">
				<Progress
					value={currentIndex + 1}
					max={sentences.length}
					class="h-3 w-full rounded-full"
					aria-label="進捗"
					data-testid="progress-bar"
				/>
				<span class="text-xs text-muted-foreground tabular-nums">
					{#if showTrackBadge}{currentTrackName} · {progress}{:else}{progress}{/if}
				</span>
			</div>
			<Button
				variant="outline"
				class="h-11 shrink-0 px-4"
				onclick={() => (endDialogOpen = true)}
				data-testid="stop-btn"
			>
				終了 <kbd class="kbd-hint">Esc</kbd>
			</Button>
		</header>

		<div
			class="flex min-h-40 flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-muted/40 p-8 dark:bg-transparent"
		>
			{#if phase === 'show' || phase === 'tts'}
				{#if currentSentence}
					<p class="text-xs font-medium text-muted-foreground" data-testid="phase-hint">
						{phase === 'show' ? '聴いてね' : '読み上げ中'}
					</p>
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
							<Volume2 /> もう一度聴く <kbd class="kbd-hint">R</kbd>
						</Button>
					{/if}
				{/if}
			{:else if phase === 'hidden'}
				{#if micConnecting}
					<p
						class="flex items-center gap-2 text-base text-muted-foreground"
						data-testid="sentence-hidden"
					>
						<Loader2 class="animate-spin" size={18} aria-hidden="true" /> マイクを準備中…
					</p>
				{:else if micError}
					<div class="flex flex-col items-center gap-4 text-center">
						<p class="text-sm text-destructive" data-testid="error-message">
							マイクの使用が拒否されました
						</p>
						<Button
							variant="outline"
							class="h-11"
							data-testid="error-retry-btn"
							onclick={retryMic}
						>
							マイクをもう一度許可
						</Button>
					</div>
				{:else}
					<div class="flex flex-col items-center gap-5" data-testid="record-ready">
						<p class="text-base font-medium" data-testid="record-ready-hint">
							Spaceを押しながら読み上げてね
						</p>
					<button
						type="button"
						class="record-hold-btn"
						data-hold-btn
						data-testid="record-hold-btn"
						aria-label="押している間、録音します"
						onpointerdown={startPointerHold}
						oncontextmenu={(e) => e.preventDefault()}
					>
							<Mic class="size-5" aria-hidden="true" />
							押して録音
							<kbd class="kbd-hint">Space</kbd>
						</button>
						{#if shortPressHint}
							<p class="text-sm font-medium text-destructive" data-testid="short-press-hint">
								もう少し長く押してね
							</p>
						{/if}
					</div>
				{/if}
			{:else if phase === 'recording'}
				<div class="flex flex-col items-center gap-4" data-testid="sentence-recording">
					<p class="flex items-center gap-2 text-base text-muted-foreground">
						<span
							class="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-destructive"
							aria-hidden="true"
						></span>
						録音中
					</p>
					<p class="flex items-baseline gap-2 text-sm text-muted-foreground tabular-nums">
						<span data-testid="recording-timer">
							{(recordingElapsedMs / 1000).toFixed(1)} 秒
						</span>
						<span class="text-xs" data-testid="max-duration-note">最長30秒で自動採点</span>
					</p>
					<div
						class="flex w-56 flex-col gap-1"
						data-testid="level-meter"
						role="img"
						aria-label={`録音レベル ${levelPct}%`}
					>
						<div class="h-3 w-full overflow-hidden rounded-full bg-muted">
							<div
								class="h-full rounded-full bg-primary"
								style:width={`${levelPct}%`}
								data-testid="level-meter-fill"
							></div>
						</div>
					<span class="text-xs text-muted-foreground tabular-nums" data-testid="level-value">
						レベル {levelPct}%
					</span>
				</div>
				{#if liveMode !== 'off' && liveTokens.length > 0}
					<div
						class="flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-2"
						data-testid="live-word-stream"
						aria-hidden="true"
					>
						{#each liveTokens as token, i (i)}
							{#each liveChips.filter((chip) => chip.at === i) as chip, ci (ci)}
								<span class="word-chip" data-testid="word-chip">{chip.word}</span>
							{/each}
							{#if liveMatched.includes(i)}
								<span class="word-slot match" data-testid="word-slot">{token}</span>
							{:else if liveGhost?.index === i}
								<span class="word-slot ghost" data-testid="word-ghost">{liveGhost.text}</span>
							{:else}
								<span class="word-slot" data-testid="word-slot"></span>
							{/if}
						{/each}
						{#each liveChips.filter((chip) => chip.at >= liveTokens.length) as chip, ci (ci)}
							<span class="word-chip" data-testid="word-chip">{chip.word}</span>
						{/each}
					</div>
				{:else if liveMode === 'off'}
					<p class="text-xs text-muted-foreground" data-testid="live-off-notice">
						ライブ表示なしで練習します
					</p>
				{/if}
				<p class="text-sm font-medium" data-testid="release-hint">離すと採点します</p>
				</div>
			{:else if phase === 'transcribing'}
				<p
					class="flex items-center gap-2 text-base text-muted-foreground"
					data-testid="sentence-transcribing"
				>
					<Loader2 class="animate-spin" size={18} aria-hidden="true" /> 聞き取ってるよ…
				</p>
			{:else if phase === 'feedback'}
				{#if errorMessage}
					<div class="flex flex-col items-center gap-4 text-center">
						<p class="text-center text-sm text-destructive" data-testid="error-message">
							{errorMessage}
						</p>
						<Button
							variant="outline"
							class="h-11"
							data-testid="error-retry-btn"
							onclick={retryFromError}
						>
							{errorRetryLabel}
						</Button>
					</div>
				{:else if score !== null}
					<div class="flex flex-col items-center gap-4 text-center" data-testid="feedback">
						<div class="flex flex-col items-center">
							<p class="text-sm font-medium text-muted-foreground" data-testid="score-label">
								類似度
							</p>
							<p
								class="score text-5xl font-bold tabular-nums"
								class:pass={score >= threshold}
								class:fail={score < threshold}
								class:celebrate={score >= threshold}
								data-testid="score"
							>
								{score}%
							</p>
						</div>
						{#if diffTokens}
							<p class="max-w-full text-lg leading-loose" data-testid="word-diff">
								{#each diffTokens as token, i (i)}
									<span
										class="diff-token"
										data-status={token.status}
										data-testid="diff-token">{token.text}</span
									>
								{/each}
							</p>
							<p class="diff-legend" data-testid="diff-legend">
								<span class="legend-item">
									<span class="legend-swatch" data-status="match" aria-hidden="true"></span>
									正しく読めた
								</span>
								<span class="legend-item">
									<span class="legend-swatch" data-status="mismatch" aria-hidden="true"></span>
									聞き取りに差
								</span>
								<span class="legend-item">
									<span class="legend-swatch" data-status="unread" aria-hidden="true"></span>
									未読
								</span>
							</p>
						{/if}
						{#if transcribedText}
							<p class="text-sm text-muted-foreground italic" data-testid="transcribed-text">
								「{transcribedText}」
							</p>
						{/if}
						<div
							class="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-center"
						>
							<Button
								variant="outline"
								class="h-11 w-full sm:w-auto"
								data-testid="replay-btn"
								onclick={replaySentence}
							>
								<Volume2 /> もう一度聴く <kbd class="kbd-hint">R</kbd>
							</Button>
							{#if score >= threshold}
								<Button class="h-11 w-full sm:w-auto" data-testid="next-btn" onclick={advanceToNext}>
									次へ <kbd class="kbd-hint">Space</kbd>
								</Button>
							{:else}
								<Button
									variant="secondary"
									class="h-11 w-full sm:w-auto"
									data-testid="retry-btn"
									onclick={retrySentence}
								>
									もう一度試す <kbd class="kbd-hint">Space</kbd>
								</Button>
							{/if}
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<div class="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-center">
			<Button variant="outline" class="h-11 w-full sm:w-auto" onclick={skip} data-testid="skip-btn">スキップ <kbd class="kbd-hint">S</kbd></Button>
		</div>
	{/if}

	{#if phase === 'feedback' && score !== null && score >= threshold && !errorMessage}
		<p class="sr-only" aria-live="polite">合格</p>
	{/if}

	<!-- Controlled open (open= one-way + onOpenChange sync): avoids the
	     bind:open double-$bindable round-trip where a stale child re-render
	     can clobber the parent's write mid-flush. -->
	<AlertDialog open={endDialogOpen} onOpenChange={(v) => (endDialogOpen = v)}>
		<AlertDialogContent data-testid="end-dialog">
			<AlertDialogHeader>
				<AlertDialogTitle>セッションを終了しますか?</AlertDialogTitle>
				<AlertDialogDescription>
					進行状況は保存されません。終了するとサマリーが表示されます。
				</AlertDialogDescription>
			</AlertDialogHeader>
			<AlertDialogFooter>
				<AlertDialogCancel class="h-11" data-testid="cancel-end-btn">キャンセル</AlertDialogCancel>
				<!-- bits-ui's AlertDialog.Action does not close the dialog by itself — close explicitly. -->
				<AlertDialogAction
					variant="destructive"
					class="h-11"
					data-testid="confirm-end-btn"
					onclick={() => {
						endDialogOpen = false;
						stop();
					}}
				>
					終了
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialogContent>
	</AlertDialog>

	<!-- Restore dialog (T9): the session holds behind it; closing without
	     続ける (cancel / Esc / overlay) falls through to 最初から. -->
	<AlertDialog open={restoreDialogOpen} onOpenChange={handleRestoreOpenChange}>
		<AlertDialogContent data-testid="restore-dialog">
			<AlertDialogHeader>
				<AlertDialogTitle>前回の続きから再開しますか?</AlertDialogTitle>
				<AlertDialogDescription>
					{chapterName}の練習途中の状態が残っています。
				</AlertDialogDescription>
			</AlertDialogHeader>
			<AlertDialogFooter>
				<AlertDialogCancel class="h-11" data-testid="start-over-btn">最初から</AlertDialogCancel>
				<AlertDialogAction
					class="h-11"
					data-testid="resume-btn"
					onclick={() => {
						restoreDialogOpen = false;
						applyRestore();
					}}
				>
					続ける
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

	/* Celebration on pass — duration/easing declared at the use site
	   (keyframes + --ease-back-out come from app.css; reduced-motion
	   disables the animation globally). */
	.score.celebrate {
		animation: celebration-pop 400ms var(--ease-back-out) both;
	}

	/* Word diff. Color is never the only cue: match is underlined,
	   mismatch is struck through, unread is muted (no decoration). */
	.diff-token {
		margin-inline-end: 0.3em;
	}

	.diff-token[data-status='match'] {
		color: var(--correct);
		text-decoration: underline;
		text-underline-offset: 4px;
	}

	.diff-token[data-status='mismatch'] {
		color: var(--incorrect);
		text-decoration: line-through;
	}

	.diff-token[data-status='unread'] {
		/* Unread stays gray but sits closer to the body text than
		   muted-foreground so it does not read as disabled — it is still
		   decoration-free (distinct from match/mismatch shapes). */
		color: color-mix(in oklab, var(--foreground) 62%, var(--muted-foreground));
	}

	/* Diff legend (T13). Swatches echo the token colors so the legend never
	   relies on naming alone. */
	.diff-legend {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.25rem 1rem;
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.legend-swatch {
		display: inline-block;
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 0.25rem;
	}

	.legend-swatch[data-status='match'] {
		background: color-mix(in oklab, var(--correct) 85%, var(--background));
	}

	.legend-swatch[data-status='mismatch'] {
		background: color-mix(in oklab, var(--incorrect) 85%, var(--background));
	}

	.legend-swatch[data-status='unread'] {
		background: color-mix(in oklab, var(--foreground) 62%, var(--muted-foreground));
	}

	/* Push-to-talk hold button (T13). Same 3D press language as the design
	   system buttons (translate-y + shrinking hard shadow) scaled up for the
	   primary hold interaction. touch-action/user-select keep a long press
	   from scrolling or text-selecting on touch devices. */
	.record-hold-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.625rem;
		min-height: 4.5rem;
		padding: 1rem 2.5rem;
		border: none;
		border-radius: var(--radius-xl);
		background: var(--primary);
		color: var(--primary-foreground);
		font-size: 1.125rem;
		font-weight: 700;
		font-family: inherit;
		box-shadow: 0 5px 0 0 color-mix(in oklab, var(--primary) 75%, black);
		cursor: pointer;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		transition:
			transform var(--motion-press, 180ms) var(--ease-out-standard, ease),
			box-shadow var(--motion-press, 180ms) var(--ease-out-standard, ease);
	}

	.record-hold-btn:active {
		transform: translateY(4px);
		box-shadow: 0 1px 0 0 color-mix(in oklab, var(--primary) 75%, black);
	}

	.record-hold-btn:focus-visible {
		outline: 3px solid var(--ring);
		outline-offset: 2px;
	}

	/* Key-cap hint badges (T13): small rounded keycaps trailing button labels
	   ([Space] / [R] / [S] / [Esc]). */
	.kbd-hint {
		display: inline-block;
		padding: 0.05rem 0.45rem;
		border: 1px solid color-mix(in oklab, var(--foreground) 18%, transparent);
		border-bottom-width: 2px;
		border-radius: 0.375rem;
		background: var(--background);
		color: var(--muted-foreground);
		font-family: inherit;
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1.5;
		white-space: nowrap;
	}

	/* Live word stream (T8). Empty slots are opaque blocks with a dashed
	   underline — the target text only appears in confirmed (green) slots.
	   Fill + underline-shape change accompany the color so the state never
	   relies on color alone. */
	.word-slot {
		display: inline-block;
		min-width: 2.75rem;
		padding: 0 0.4rem 0.1rem;
		border-bottom: 2px dashed color-mix(in oklab, var(--muted-foreground) 55%, transparent);
		border-radius: 3px 3px 0 0;
		background: var(--muted);
		font-weight: 600;
		line-height: 1.6;
		text-align: center;
	}

	.word-slot.match {
		color: var(--correct);
		/* 7% tint over the page background keeps the green text >= 4.5:1 in
		   both themes (tints toward --muted push light mode under 4.5). */
		background: color-mix(in oklab, var(--correct) 7%, var(--background));
		border-bottom: 2px solid var(--correct);
		animation: word-reveal 200ms var(--ease-out-standard) both;
	}

	.word-slot.ghost {
		color: var(--muted-foreground);
		background: var(--muted);
		border-bottom-style: solid;
		animation: word-reveal 200ms var(--ease-out-standard) both;
	}

	.word-chip {
		display: inline-block;
		padding: 0 0.5rem;
		border: 1px solid color-mix(in oklab, var(--incorrect) 45%, transparent);
		border-radius: 9999px;
		color: var(--incorrect);
		font-size: 0.875rem;
		font-weight: 600;
		animation: word-reveal 200ms var(--ease-out-standard) both;
	}
</style>
