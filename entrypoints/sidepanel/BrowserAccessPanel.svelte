<script lang="ts">
  import { onMount } from 'svelte';
  import Check from 'phosphor-svelte/lib/Check';
  import ArrowRight from 'phosphor-svelte/lib/ArrowRight';
  import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
  import CodeSimple from 'phosphor-svelte/lib/CodeSimple';
  import GlobeSimple from 'phosphor-svelte/lib/GlobeSimple';
  import { browser } from 'wxt/browser';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import { Button } from '$lib/components/ui/button/index.js';
  import { readBrowserControlState, requestAllSitesAccess, type BrowserControlState } from './browser-access.ts';
  import type { Notify } from './toast.ts';

  interface Props {
    locale: Locale;
    spotlight?: boolean;
    notify?: Notify;
    onChanged?: (state: BrowserControlState) => void | Promise<void>;
    onDone?: () => void | Promise<void>;
  }

  let { locale, spotlight = false, notify, onChanged, onDone }: Props = $props();
  let accessState: BrowserControlState = $state({ allSites: false, pageScriptConsent: false, userScriptsAvailable: false, ready: false });
  let loading = $state(true);
  let busy = $state('');
  let error = $state('');

  let t = $derived(messages[locale].browserAccess);
  let userScriptsGranted = $derived(accessState.userScriptsAvailable);
  let allSitesGranted = $derived(accessState.allSites);
  let allPermissionsGranted = $derived(userScriptsGranted && allSitesGranted);

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
    busy = 'all-sites';
    error = '';
    try {
      const granted = await requestAllSitesAccess();
      await refresh();
      if (!granted) return;
      notify?.({ tone: 'success', text: t.saved });
      if (accessState.ready) await onDone?.();
    } catch (nextError) {
      error = describe(nextError) || t.failed;
      notify?.({ tone: 'error', text: error });
    } finally {
      busy = '';
    }
  }

  function openExtensionDetails() {
    void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}`, active: true }).catch(() => undefined);
  }

  function describe(value: unknown) {
    return value instanceof Error ? value.message : String(value);
  }
</script>

<section class="space-y-2 {spotlight ? 'fx-spotlight' : ''}">
  <header>
    <p class="text-[13px] font-semibold text-foreground">{t.title}</p>
  </header>

  <ol class="space-y-2">
    <li
      class="rounded-xl border px-3 py-2.5 transition-colors duration-300 ease-[var(--ease-out)] {userScriptsGranted
        ? allPermissionsGranted ? 'permission-card-complete' : 'permission-card-granted'
        : 'permission-card-pending'}"
    >
      <div class="grid grid-cols-[auto_1fr_auto] items-start gap-3">
        <span
          class="mt-px grid size-5 shrink-0 place-items-center rounded-md border transition-colors duration-300 ease-[var(--ease-out)] {userScriptsGranted
            ? allPermissionsGranted ? 'permission-badge-complete' : 'permission-badge-granted'
            : 'border-line/80 bg-surface/40 text-transparent'}"
        >
          {#if userScriptsGranted}
            <Check class="size-3" weight="bold" />
          {/if}
        </span>
        <div class="min-w-0 space-y-1">
          <p class="flex items-center gap-1.5 text-[12.5px] font-medium transition-colors duration-300 ease-[var(--ease-out)] {userScriptsGranted ? 'text-muted-foreground' : 'text-foreground'}">
            <CodeSimple class="text-muted-foreground size-3.5 shrink-0" weight="bold" />
            <span>{t.userScripts}</span>
          </p>
          <div class="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] leading-relaxed">
            {#each t.userScriptsDescription.split('|') as step, i}
              {#if i > 0}<ArrowRight class="size-3 shrink-0" weight="bold" />{/if}
              <span>{step}</span>
            {/each}
          </div>
        </div>
        <div class="flex shrink-0 items-center pt-0.5">
          {#if !userScriptsGranted}
            <Button size="sm" variant="outline" disabled={busy !== ''} onclick={openExtensionDetails}>
              <ArrowSquareOut class="size-3.5" />
              {t.openExtensionDetails}
            </Button>
          {/if}
        </div>
      </div>
    </li>

    <li
      class="rounded-xl border px-3 py-2.5 transition-colors duration-300 ease-[var(--ease-out)] {allSitesGranted
        ? allPermissionsGranted ? 'permission-card-complete' : 'permission-card-granted'
        : 'permission-card-pending'}"
    >
      <div class="grid grid-cols-[auto_1fr_auto] items-start gap-3">
        <span
          class="mt-px grid size-5 shrink-0 place-items-center rounded-md border transition-colors duration-300 ease-[var(--ease-out)] {allSitesGranted
            ? allPermissionsGranted ? 'permission-badge-complete' : 'permission-badge-granted'
            : 'border-line/80 bg-surface/40 text-transparent'}"
        >
          {#if allSitesGranted}
            <Check class="size-3" weight="bold" />
          {/if}
        </span>
        <div class="min-w-0 space-y-1">
          <p class="flex items-center gap-1.5 text-[12.5px] font-medium transition-colors duration-300 ease-[var(--ease-out)] {allSitesGranted ? 'text-muted-foreground' : 'text-foreground'}">
            <GlobeSimple class="text-muted-foreground size-3.5 shrink-0" weight="bold" />
            <span>{t.allSites}</span>
          </p>
          <p class="text-muted-foreground text-[11px] leading-relaxed">{t.allSitesDescription}</p>
        </div>
        <div class="flex shrink-0 items-center pt-0.5">
          {#if !allSitesGranted}
            <Button size="sm" variant="default" disabled={busy !== ''} onclick={grantAllSites}>
              {busy === 'all-sites' ? '…' : t.allowAllSites}
            </Button>
          {/if}
        </div>
      </div>
    </li>
  </ol>

  {#if error}
    <p class="text-danger mt-1 text-xs" role="alert">{error}</p>
  {/if}
</section>
