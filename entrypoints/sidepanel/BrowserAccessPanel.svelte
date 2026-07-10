<script lang="ts">
  import { onMount } from 'svelte';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ArrowSquareOut from '@lucide/svelte/icons/external-link';
  import Check from '@lucide/svelte/icons/check';
  import CodeSimple from '@lucide/svelte/icons/square-code';
  import GlobeSimple from '@lucide/svelte/icons/globe';
  import { browser } from 'wxt/browser';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import { Button } from '$lib/components/ui/button/index.js';
  import { readBrowserControlState, requestAllSitesAccess, type BrowserControlState } from './browser-access.ts';
  import type { Notify } from './toast.ts';

  interface Props {
    locale: Locale;
    notify?: Notify;
    onChanged?: (state: BrowserControlState) => void | Promise<void>;
  }

  let { locale, notify, onChanged }: Props = $props();
  let accessState: BrowserControlState = $state({ allSites: false, pageScriptConsent: false, userScriptsAvailable: false, ready: false });
  let loading = $state(true);
  let busy = $state('');

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
      await onChanged?.(accessState);
    } catch (nextError) {
      notify?.({ tone: 'error', icon: 'browser', text: describe(nextError) });
    } finally {
      loading = false;
    }
  }

  async function grantAllSites() {
    busy = 'all-sites';
    try {
      const granted = await requestAllSitesAccess();
      await refresh();
      if (!granted) return;
      notify?.({ tone: 'success', icon: 'browser', text: t.saved });
    } catch (nextError) {
      notify?.({ tone: 'error', icon: 'browser', text: describe(nextError) || t.failed });
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

<section class="space-y-2">
  <header>
    <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.title}</p>
  </header>

  <ol class="space-y-2">
    <li
      class="rounded-2xl border px-3.5 py-3 transition-colors duration-300 ease-[var(--ease-out)] {userScriptsGranted
        ? allPermissionsGranted ? 'permission-card-complete' : 'permission-card-granted'
        : 'permission-card-pending'}"
    >
      <div class="grid grid-cols-[auto_1fr_auto] items-start gap-3">
        <span
          class="mt-px grid size-5 shrink-0 place-items-center transition-colors duration-300 ease-[var(--ease-out)] {userScriptsGranted
            ? 'text-success'
            : 'border-line/80 bg-surface/40 rounded-md border text-transparent'}"
        >
          {#if userScriptsGranted}
            <Check class="size-4" strokeWidth={3} />
          {/if}
        </span>
        <div class="min-w-0 space-y-1">
          <p class="flex items-center gap-1.5 text-[13px] font-medium transition-colors duration-300 ease-[var(--ease-out)] {userScriptsGranted ? 'text-muted-foreground' : 'text-foreground'}">
            <CodeSimple class="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.9} />
            <span>{t.userScripts}</span>
          </p>
          <div class="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] leading-relaxed">
            {#each t.userScriptsDescription.split('|') as step, i}
              {#if i > 0}<ArrowRight class="size-3 shrink-0" strokeWidth={2.1} />{/if}
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
      class="rounded-2xl border px-3.5 py-3 transition-colors duration-300 ease-[var(--ease-out)] {allSitesGranted
        ? allPermissionsGranted ? 'permission-card-complete' : 'permission-card-granted'
        : 'permission-card-pending'}"
    >
      <div class="grid grid-cols-[auto_1fr_auto] items-start gap-3">
        <span
          class="mt-px grid size-5 shrink-0 place-items-center transition-colors duration-300 ease-[var(--ease-out)] {allSitesGranted
            ? 'text-success'
            : 'border-line/80 bg-surface/40 rounded-md border text-transparent'}"
        >
          {#if allSitesGranted}
            <Check class="size-4" strokeWidth={3} />
          {/if}
        </span>
        <div class="min-w-0 space-y-1">
          <p class="flex items-center gap-1.5 text-[13px] font-medium transition-colors duration-300 ease-[var(--ease-out)] {allSitesGranted ? 'text-muted-foreground' : 'text-foreground'}">
            <GlobeSimple class="text-muted-foreground size-3.5 shrink-0" strokeWidth={1.9} />
            <span>{t.allSites}</span>
          </p>
          <p class="text-muted-foreground text-[11.5px] leading-relaxed">{t.allSitesDescription}</p>
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

</section>
