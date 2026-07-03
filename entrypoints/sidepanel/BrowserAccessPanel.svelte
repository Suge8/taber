<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import { Button } from '$lib/components/ui/button/index.js';
  import { completeBrowserControl, readBrowserControlState, requestAllSitesAccess, type BrowserControlState } from './browser-access.ts';
  import type { Notify } from './toast.ts';

  interface Props {
    locale: Locale;
    windowId?: number;
    variant?: 'settings' | 'onboarding';
    notify?: Notify;
    onChanged?: (state: BrowserControlState) => void | Promise<void>;
    onDone?: () => void | Promise<void>;
  }

  let { locale, variant = 'settings', notify, onChanged, onDone }: Props = $props();
  let accessState: BrowserControlState = $state({ allSites: false, pageScriptConsent: false, userScriptsAvailable: false, ready: false });
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');

  let t = $derived(messages[locale].browserAccess);

  onMount(() => {
    void refresh();
    const sync = () => { void refresh(); };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  });

  async function refresh() {
    loading = true;
    try {
      accessState = await readBrowserControlState();
      error = '';
      await onChanged?.(accessState);
    } catch (nextError) {
      error = describe(nextError);
    } finally {
      loading = false;
    }
  }

  async function grantAllSites() {
    await run('all-sites', async () => {
      const granted = await requestAllSitesAccess();
      if (!granted) throw new Error(t.denied);
    });
  }

  async function complete() {
    await run('done', async () => {
      accessState = await completeBrowserControl();
      await onDone?.();
    });
  }

  function openExtensionDetails() {
    void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}`, active: true }).catch(() => undefined);
  }

  async function run(key: string, action: () => Promise<void>) {
    busy = key;
    error = '';
    try {
      await action();
      await refresh();
      notify?.({ tone: 'success', text: t.saved });
    } catch (nextError) {
      error = describe(nextError) || t.failed;
      notify?.({ tone: 'error', text: error });
    } finally {
      busy = '';
    }
  }

  function statusLabel(ok: boolean) {
    if (loading) return '…';
    return ok ? t.allowed : t.notAllowed;
  }

  function describe(value: unknown) {
    return value instanceof Error ? value.message : String(value);
  }
</script>

<section class={`fx-enter space-y-3 ${variant === 'onboarding' ? 'rounded-2xl border border-line/80 bg-surface/80 p-4' : ''}`}>
  <div class="space-y-1">
    <p class="text-[13px] font-semibold text-foreground">{t.title}</p>
    <p class="text-muted-foreground text-[12px] leading-relaxed">{t.description}</p>
  </div>

  <div class="space-y-2">
    <div class="rounded-xl border border-line/70 bg-surface p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <p class="text-[12.5px] font-medium text-foreground">{t.userScripts}</p>
          <p class="text-muted-foreground text-[11.5px] leading-relaxed">{t.userScriptsDescription}</p>
        </div>
        <span class="shrink-0 rounded-full border border-line/70 px-2 py-0.5 text-[10.5px] text-muted-foreground">{statusLabel(accessState.userScriptsAvailable)}</span>
      </div>
      <Button class="mt-3 h-8 w-full text-[12px]" variant="outline" disabled={busy !== ''} onclick={openExtensionDetails}>{t.openExtensionDetails}</Button>
    </div>

    <div class="rounded-xl border border-line/70 bg-surface p-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <p class="text-[12.5px] font-medium text-foreground">{t.allSites}</p>
          <p class="text-muted-foreground text-[11.5px] leading-relaxed">{t.allSitesDescription}</p>
        </div>
        <span class="shrink-0 rounded-full border border-line/70 px-2 py-0.5 text-[10.5px] text-muted-foreground">{statusLabel(accessState.allSites)}</span>
      </div>
      <Button class="mt-3 h-8 w-full text-[12px]" variant="outline" disabled={busy !== '' || accessState.allSites} onclick={grantAllSites}>{busy === 'all-sites' ? '…' : t.allowAllSites}</Button>
    </div>
  </div>

  {#if error}
    <p class="text-danger text-xs" role="alert">{error}</p>
  {/if}

  {#if variant === 'onboarding'}
    <Button class="h-9 w-full text-[12.5px]" disabled={busy !== '' || !accessState.ready} onclick={complete}>{busy === 'done' ? '…' : t.done}</Button>
  {/if}
</section>
