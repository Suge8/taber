<script lang="ts">
  import type { Component } from 'svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Input } from '$lib/components/ui/input/index.js';
  import ArrowClockwise from '@lucide/svelte/icons/refresh-cw';
  import SignIn from '@lucide/svelte/icons/log-in';
  import SignOut from '@lucide/svelte/icons/log-out';
  import Sparkle from '@lucide/svelte/icons/sparkles';
  import {
    mapOAuthLoginError,
    subscriptionCopy,
    visibleSubscriptionModels,
    type SubscriptionVendorAdapter,
  } from '$lib/subscription-login.ts';
  import type { ProviderWithModels } from '$lib/provider-store.ts';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import type { Notify } from './toast.ts';

  interface Props {
    locale: Locale;
    vendor: SubscriptionVendorAdapter;
    logo: Component<{ class?: string }>;
    provider?: ProviderWithModels;
    onChanged?: () => void | Promise<void>;
    notify?: Notify;
  }

  let { locale, vendor, logo: Logo, provider, onChanged, notify }: Props = $props();

  let t = $derived(messages[locale].provider);
  let copy = $derived(subscriptionCopy(locale, vendor.id));
  let modelsExpanded = $state(false);
  let busy = $state<'login' | 'refresh' | 'signout' | null>(null);
  let awaitingCode = $state(false);
  let manualCode = $state('');
  let accountDetail = $state('');
  let resolveManualCode = $state<((value: string) => void) | null>(null);

  const connected = $derived(Boolean(provider?.hasCredential));
  const models = $derived(visibleSubscriptionModels(provider));
  const statusText = $derived(connected ? copy.connected : busy === 'login' ? copy.loginStatus : copy.disconnected);
  const connectedDetail = $derived(
    accountDetail || models.preview[0]?.displayName || models.preview[0]?.name || copy.fallbackAccount,
  );

  $effect(() => {
    const providerId = provider?.id;
    if (!providerId || !connected) {
      accountDetail = '';
      return;
    }
    void loadDetail(providerId);
  });

  async function handleLogin() {
    busy = 'login';
    awaitingCode = vendor.supportsPaste;
    manualCode = '';
    try {
      const result = await vendor.login({
        waitForManualCode: vendor.supportsPaste
          ? ({ signal }) =>
              new Promise<string>((resolve, reject) => {
                resolveManualCode = resolve;
                const onAbort = () => {
                  cleanupManualWait();
                  reject(new Error('OAuth login was cancelled.'));
                };
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
              })
          : undefined,
      });
      accountDetail = result.detail;
      await onChanged?.();
      notify?.({ tone: 'success', icon: 'model', text: copy.saved });
    } catch (error) {
      const mapped = mapOAuthLoginError(error, copy);
      notify?.({ tone: mapped.cancelled ? 'info' : 'error', icon: 'model', text: mapped.message });
    } finally {
      cleanupManualWait();
      awaitingCode = false;
      manualCode = '';
      busy = null;
    }
  }

  function submitManualCode() {
    const value = manualCode.trim();
    if (!value || !resolveManualCode) return;
    const resolve = resolveManualCode;
    cleanupManualWait();
    resolve(value);
  }

  function cleanupManualWait() {
    resolveManualCode = null;
  }

  async function handleRefresh() {
    if (!provider) return;
    busy = 'refresh';
    try {
      const result = await vendor.refresh(provider.id);
      if (result.detail) accountDetail = result.detail;
      await onChanged?.();
      notify?.({ tone: 'success', icon: 'model', text: t.catalogUpdated });
    } catch (error) {
      notify?.({ tone: 'error', icon: 'model', text: describe(error) });
    } finally {
      busy = null;
    }
  }

  async function handleSignOut() {
    if (!provider) return;
    busy = 'signout';
    try {
      await vendor.signOut(provider.id);
      accountDetail = '';
      await onChanged?.();
      notify?.({ tone: 'success', icon: 'model', text: copy.signedOut });
    } catch (error) {
      notify?.({ tone: 'error', icon: 'model', text: describe(error) });
    } finally {
      busy = null;
    }
  }

  async function loadDetail(providerId: number) {
    try {
      accountDetail = await vendor.loadDetail(providerId);
    } catch {
      accountDetail = '';
    }
  }

  function describe(value: unknown) {
    return value instanceof Error ? value.message : String(value);
  }
</script>

{#if connected}
  <article class="bg-surface ring-line/70 fx-enter space-y-3 rounded-2xl p-4 shadow-[0_8px_28px_oklch(0_0_0_/_0.035)] ring-1" style="--fx-index: 0">
    <header class="flex items-center gap-3">
      <div class="bg-surface-2 text-foreground grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
        <Logo class="size-5" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex min-w-0 items-center gap-2">
          <h3 class="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{copy.title}</h3>
          <span class="bg-success/10 text-success shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">{statusText}</span>
        </div>
        <p class="text-muted-foreground truncate text-xs leading-relaxed">{connectedDetail}</p>
      </div>
      <div class="flex shrink-0 gap-1">
        <Button size="icon-sm" variant="ghost" onclick={handleRefresh} disabled={busy !== null} class="size-7 rounded-lg" aria-label={copy.refresh}>
          <ArrowClockwise class="size-3.5 {busy === 'refresh' ? 'animate-spin' : ''}" />
        </Button>
        <Button size="icon-sm" variant="ghost" onclick={handleSignOut} disabled={busy !== null} class="size-7 rounded-lg" aria-label={copy.signOut}>
          {#if busy === 'signout'}<ArrowClockwise class="size-3.5 animate-spin" />{:else}<SignOut class="size-3.5" />{/if}
        </Button>
      </div>
    </header>

    <div class="space-y-2" aria-live="polite">
      {#if models.all.length > 0}
        <p class="text-muted-foreground flex items-center gap-1.5 text-[12px] font-medium"><Sparkle class="size-3.5" />{t.models}</p>
        <div class="flex flex-wrap gap-1.5">
          {#each modelsExpanded ? models.all : models.preview as model (model.id)}
            <span class="bg-surface-2/70 text-foreground ring-line/60 inline-flex max-w-full items-center rounded-xl px-2.5 py-1 text-[12px] ring-1">
              <span class="truncate">{model.displayName ?? model.name}</span>
            </span>
          {/each}
          {#if models.all.length > models.preview.length}
            <button
              type="button"
              class="text-muted-foreground bg-surface-2/50 ring-line/50 hover:bg-surface-2 hover:text-foreground inline-flex items-center rounded-xl px-2.5 py-1 text-[12px] tabular-nums ring-1 transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
              aria-expanded={modelsExpanded}
              title={modelsExpanded ? t.showFewerModels : t.showAllModels(models.all.length - models.preview.length)}
              onclick={() => (modelsExpanded = !modelsExpanded)}
            >{modelsExpanded ? t.showFewerModels : `+${models.all.length - models.preview.length}…`}</button>
          {/if}
        </div>
      {:else}
        <p class="text-muted-foreground text-xs">{copy.noModels}</p>
      {/if}
    </div>
  </article>
{:else if awaitingCode}
  <article class="bg-surface ring-line/70 fx-enter space-y-3 rounded-2xl p-4 shadow-[0_8px_28px_oklch(0_0_0_/_0.035)] ring-1" style="--fx-index: 0">
    <header class="flex items-center gap-3">
      <div class="bg-surface-2 text-foreground grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
        <Logo class="size-5" />
      </div>
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex min-w-0 items-center gap-2">
          <h3 class="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{copy.title}</h3>
          <span class="bg-surface-2 text-muted-foreground shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">{statusText}</span>
        </div>
        <p class="text-muted-foreground truncate text-xs leading-relaxed">{copy.description}</p>
      </div>
    </header>
    <form
      class="flex items-center gap-2"
      onsubmit={(event) => {
        event.preventDefault();
        submitManualCode();
      }}
    >
      <Input
        bind:value={manualCode}
        placeholder={copy.pastePlaceholder}
        autocomplete="off"
        autocapitalize="characters"
        spellcheck={false}
        data-smoke="subscription-code-input"
        class="min-w-0 flex-1 font-mono tracking-wide"
      />
      <Button type="submit" size="sm" class="h-8 shrink-0 px-3" disabled={!manualCode.trim() || !resolveManualCode}>{copy.pasteSubmit}</Button>
    </form>
  </article>
{:else}
  <button
    type="button"
    data-smoke="subscription-login-{vendor.id}"
    class="group bg-surface ring-line/70 fx-enter flex w-full items-center gap-3 rounded-2xl p-4 text-left shadow-[0_8px_28px_oklch(0_0_0_/_0.03)] ring-1 transition-[background-color,transform,box-shadow] duration-150 ease-[var(--ease-out)] hover:bg-surface-2/50 hover:shadow-[0_10px_30px_oklch(0_0_0_/_0.045)] active:scale-[0.99] disabled:cursor-wait disabled:opacity-80"
    onclick={handleLogin}
    disabled={busy !== null}
    aria-label={busy === 'login' ? copy.loggingIn : copy.login}
    style="--fx-index: 0"
  >
    <span class="bg-surface-2 text-foreground grid size-10 shrink-0 place-items-center rounded-xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.45)]">
      <Logo class="size-5" />
    </span>
    <span class="min-w-0 flex-1 space-y-1">
      <span class="flex min-w-0 items-center gap-2">
        <span class="block min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">{copy.title}</span>
        <span class="bg-surface-2 text-muted-foreground shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium">{statusText}</span>
      </span>
      <span class="text-muted-foreground block text-xs leading-relaxed text-pretty">{copy.description}</span>
    </span>
    {#if busy === 'login'}
      <ArrowClockwise class="text-muted-foreground size-4 shrink-0 animate-spin" />
    {:else}
      <SignIn class="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors duration-150 ease-[var(--ease-out)]" />
    {/if}
  </button>
{/if}
