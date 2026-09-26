<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Home, Settings } from '@lucide/svelte';
	// Side-effect import: $lib/theme applies the stored theme to <html> and
	// subscribes to matchMedia on module load. Nothing here renders the theme,
	// but the initialisation must run on every route — without this import the
	// top page never follows the OS colour scheme.
	import '$lib/theme';
	import { unlockAudio } from '$lib/tts';
	import '../app.css';
	let { children } = $props();
	let pathname = $derived(page.url.pathname);
	let isPractice = $derived(pathname === '/practice');
	onMount(() => {
		const unlock = () => unlockAudio();
		document.addEventListener('pointerdown', unlock, { once: true });
		document.addEventListener('keydown', unlock, { once: true });
		return () => {
			document.removeEventListener('pointerdown', unlock);
			document.removeEventListener('keydown', unlock);
		};
	});
</script>

<div class="flex min-h-dvh flex-col">
	<a
		href="#main-content"
		class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
	>
		メインコンテンツへ
	</a>

	{#if pathname !== '/practice'}
		<header class="border-b border-border bg-background">
			<nav
				class="mx-auto flex h-14 w-full max-w-5xl items-center gap-1 px-4"
				aria-label="メインナビゲーション"
			>
				<a
					href="/"
					class:active={pathname === '/'}
					class="flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				>
					<Home class="size-4" />
					おぼえる
				</a>
				<a
					href="/manage"
					class:active={pathname === '/manage'}
					class="flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				>
					<Settings class="size-4" />
					管理
				</a>
			</nav>
		</header>
	{/if}

	<!-- The practice route is a 3-zone app shell (fixed header / scrolling
	     body / fixed action zone) and pins its own root to `h-dvh`. Its
	     vertical padding is therefore owned by the practice root itself, so
	     <main> must not add any here — a second py-* would push the root's
	     100dvh past the viewport and bring back document-level scrolling,
	     which would drag the action zone out of view. Every other route
	     keeps the normal py-6 breathing room. -->
	<main
		id="main-content"
		tabindex="-1"
		class="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-4 outline-none"
		class:py-6={!isPractice}
	>
		{@render children()}
	</main>
</div>

<style>
	/* AA green for text on both themes (--primary #58cc02 is 2.09:1 on white,
	   --success is 5.08:1 light / 6.04:1 dark). */
	nav a.active {
		color: var(--success);
		font-weight: 600;
	}
</style>