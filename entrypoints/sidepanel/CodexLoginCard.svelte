<script lang="ts">
  import { browser } from 'wxt/browser';
  import { Button } from '$lib/components/ui/button/index.js';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import SignIn from 'phosphor-svelte/lib/SignIn';
  import SignOut from 'phosphor-svelte/lib/SignOut';
  import Sparkle from 'phosphor-svelte/lib/Sparkle';
  import WarningCircle from 'phosphor-svelte/lib/WarningCircle';
  import { connectOpenAICodex, readCodexTokens, readFreshCodexTokens, refreshCodexModels } from '$lib/codex-provider.ts';
  import { loginOpenAICodex } from '$lib/codex-oauth.ts';
  import { signOutOpenAICodex } from '$lib/provider-config-flow.ts';
  import type { ProviderWithModels } from '$lib/provider-store.ts';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import OpenAILogo from './OpenAILogo.svelte';
  import type { Notify } from './toast.ts';

  interface Props {
    locale: Locale;
    provider?: ProviderWithModels;
    onChanged?: () => void | Promise<void>;
    notify?: Notify;
  }

  let { locale, provider, onChanged, notify }: Props = $props();
  let t = $derived(messages[locale].provider);
  let busy = $state<'login' | 'refresh' | 'signout' | null>(null);
  let error = $state('');
  let email = $state('');

  const connected = $derived(Boolean(provider?.hasCredential));
  const visibleModels = $derived((provider?.models ?? []).filter((model) => !model.unavailable && model.visibility !== 'hide'));
  const sampleModels = $derived(visibleModels.slice(0, 4));
  const statusText = $derived(connected ? t.codexConnected : t.codexDisconnected);

  $effect(() => {
    const providerId = provider?.id;
    if (!providerId || !connected) {
      email = '';
      return;
    }
    void loadEmail(providerId);
  });

  async function handleLogin() {
    busy = 'login';
    error = '';
    try {
      const tokens = await loginOpenAICodex({ tabs: browser.tabs, identity: browser.identity, webNavigation: browser.webNavigation });
      await connectOpenAICodex(tokens);
      email = tokens.email ?? '';
      await onChanged?.();
      notify?.({ tone: 'success', text: t.codexSaved });
    } catch (loginError) {
      const result = describeLoginError(loginError);
      if (result.cancelled) {
        notify?.({ tone: 'info', text: result.message });
      } else {
        error = result.message;
        notify?.({ tone: 'error', text: result.message });
      }
    } finally {
      busy = null;
    }
  }

  async function handleRefresh() {
    if (!provider) return;
    busy = 'refresh';
    error = '';
    try {
      const tokens = await readFreshCodexTokens(provider.id);
      await refreshCodexModels(provider.id, tokens);
      await onChanged?.();
      notify?.({ tone: 'success', text: t.catalogUpdated });
    } catch (refreshError) {
      error = describe(refreshError);
      notify?.({ tone: 'error', text: error });
    } finally {
      busy = null;
    }
  }

  async function handleSignOut() {
    if (!provider) return;
    busy = 'signout';
    error = '';
    try {
      await signOutOpenAICodex(provider.id);
      email = '';
      await onChanged?.();
      notify?.({ tone: 'success', text: t.codexSignedOut });
    } catch (signOutError) {
      error = describe(signOutError);
      notify?.({ tone: 'error', text: error });
    } finally {
      busy = null;
    }
  }

  async function loadEmail(providerId: number) {
    try {
      email = (await readCodexTokens(providerId))?.email ?? '';
    } catch {
      email = '';
    }
  }

  function describeLoginError(value: unknown) {
    const message = describe(value);
    if (message === 'OAuth tab was closed before completing login.' || message === 'OAuth login was cancelled.') return { cancelled: true, message: t.codexLoginCancelled };
    if (message === 'OAuth login timed out.') return { cancelled: false, message: t.codexLoginTimedOut };
    return { cancelled: false, message };
  }

  function describe(value: unknown) {
    return value instanceof Error ? value.message : String(value);
  }
</script>

{#if connected}
  <article class="bg-surface ring-line/70 fx-enter space-y-3 rounded-2xl p-4 shadow-[0_8px_28px_oklch(0_0_0_/_0.035)] ring-1" style="--fx-index: 0">
    <header class="flex items-center gap-3">
      <div class="bg-surface-2 text-foreground grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
        <OpenAILogo class="size-5" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex min-w-0 items-center gap-2">
          <h3 class="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{t.codexTitle}</h3>
          <span class="bg-success/10 text-success shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">{statusText}</span>
        </div>
        <p class="text-muted-foreground text-xs leading-relaxed text-pretty">{email || t.codexConnected}</p>
      </div>
      <div class="flex shrink-0 gap-1">
        <Button size="icon-sm" variant="ghost" onclick={handleRefresh} disabled={busy !== null} class="size-7 rounded-lg" aria-label={t.codexRefresh}>
          <ArrowClockwise class="size-3.5 {busy === 'refresh' ? 'animate-spin' : ''}" />
        </Button>
        <Button size="icon-sm" variant="ghost" onclick={handleSignOut} disabled={busy !== null} class="size-7 rounded-lg" aria-label={t.codexSignOut}>
          {#if busy === 'signout'}<ArrowClockwise class="size-3.5 animate-spin" />{:else}<SignOut class="size-3.5" />{/if}
        </Button>
      </div>
    </header>

    {#if error}
      <p class="text-danger bg-danger/5 ring-danger/15 fx-enter flex items-start gap-2 rounded-xl px-3 py-2 text-xs ring-1" role="alert">
        <WarningCircle class="mt-0.5 size-3.5 shrink-0" />
        <span>{error}</span>
      </p>
    {/if}

    <div class="space-y-2" aria-live="polite">
      {#if visibleModels.length > 0}
        <p class="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium"><Sparkle class="size-3.5" />{t.models}</p>
        <div class="flex flex-wrap gap-1.5">
          {#each sampleModels as model (model.id)}
            <span class="bg-surface-2/70 text-foreground ring-line/60 inline-flex max-w-full items-center rounded-xl px-2.5 py-1 text-[12px] ring-1">
              <span class="truncate">{model.displayName ?? model.name}</span>
            </span>
          {/each}
          {#if visibleModels.length > sampleModels.length}
            <span class="text-muted-foreground bg-surface-2/50 ring-line/50 inline-flex items-center rounded-xl px-2.5 py-1 text-[12px] tabular-nums ring-1">+{visibleModels.length - sampleModels.length}</span>
          {/if}
        </div>
      {:else}
        <p class="text-muted-foreground text-xs">{t.codexNoModels}</p>
      {/if}
    </div>

  </article>
{:else}
  <div class="space-y-2">
    <button
      type="button"
      data-smoke="codex-login"
      class="group bg-surface ring-line/70 fx-enter flex w-full items-center gap-3 rounded-2xl p-4 text-left shadow-[0_8px_28px_oklch(0_0_0_/_0.03)] ring-1 transition-[background-color,transform,box-shadow] duration-150 ease-[var(--ease-out)] hover:bg-surface-2/50 hover:shadow-[0_10px_30px_oklch(0_0_0_/_0.045)] active:scale-[0.99] disabled:cursor-wait disabled:opacity-80"
      onclick={handleLogin}
      disabled={busy !== null}
      aria-label={busy === 'login' ? t.codexLoggingIn : t.codexLogin}
      style="--fx-index: 0"
    >
      <span class="bg-surface-2 text-foreground grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
        <OpenAILogo class="size-5" />
      </span>
      <span class="min-w-0 flex-1 space-y-1">
        <span class="flex min-w-0 items-center gap-2">
          <span class="block min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{t.codexTitle}</span>
          <span class="bg-surface-2 text-muted-foreground shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">{statusText}</span>
        </span>
        <span class="text-muted-foreground block text-xs leading-relaxed text-pretty">{t.codexDescription}</span>
      </span>
      {#if busy === 'login'}
        <ArrowClockwise class="text-muted-foreground size-4 shrink-0 animate-spin" />
      {:else}
        <SignIn class="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors duration-150 ease-[var(--ease-out)]" />
      {/if}
    </button>

    {#if error}
      <p class="text-danger bg-danger/5 ring-danger/15 fx-enter flex items-start gap-2 rounded-xl px-3 py-2 text-xs ring-1" role="alert">
        <WarningCircle class="mt-0.5 size-3.5 shrink-0" />
        <span>{error}</span>
      </p>
    {/if}
  </div>
{/if}
