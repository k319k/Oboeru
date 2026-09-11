<script lang="ts">
	import { page } from '$app/state';
	import { Home, Settings, Sun, Moon } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { getResolvedTheme, subscribeTheme, toggleTheme } from '$lib/theme';
	import '../app.css';
	let { children } = $props();
	let pathname = $derived(page.url.pathname);
	let resolvedTheme = $state(getResolvedTheme());
	$effect(() => {
		return subscribeTheme(() => {
			resolvedTheme = getResolvedTheme();
		});
	});
</script>

<div class="flex min-h-dvh flex-col">
	<a
		href="#main-content"
		class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
	>
		メインコンテンツへ
	</a>

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
			<div class="ml-auto">
				<Button
					variant="ghost"
					size="icon"
					aria-label="テーマ切替"
					class="size-11 text-muted-foreground"
					onclick={toggleTheme}
				>
					{#if resolvedTheme === 'dark'}
						<Moon />
					{:else}
						<Sun />
					{/if}
				</Button>
			</div>
		</nav>
	</header>

	<main id="main-content" tabindex="-1" class="mx-auto w-full max-w-5xl flex-1 px-4 py-6 outline-none">
		{@render children()}
	</main>
</div>

<style>
	nav a.active {
		color: var(--color-primary);
		font-weight: 600;
	}

	/* --primary (#2563eb) is 3.83:1 on the dark background — use a lighter
	   blue for the active link in dark mode (blue-400 = 7.79:1 on #0a0a0a). */
	:global(.dark) nav a.active {
		color: #60a5fa;
	}
</style>