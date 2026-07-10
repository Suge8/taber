<script lang="ts">
  import { tick } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import ArrowSquareOut from '@lucide/svelte/icons/external-link';
  import Database from '@lucide/svelte/icons/database';
  import DownloadSimple from '@lucide/svelte/icons/download';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import SidebarSimple from '@lucide/svelte/icons/panel-right';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Sun from '@lucide/svelte/icons/sun';
  import BrowserAccessPanel from './BrowserAccessPanel.svelte';
  import type { BrowserControlState } from './browser-access.ts';
  import ProviderSettings from './ProviderSettings.svelte';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import type { Notify } from './toast.ts';

  type Theme = 'light' | 'dark' | 'system';
  type SettingsTab = 'preferences' | 'providers';

  interface Props {
    open: boolean;
    activeTab?: SettingsTab;
    locale: Locale;
    theme: Theme;
    setTheme: (theme: Theme) => void;
    setLocale: (locale: Locale) => void;
    openShortcutSettings: () => void;
    onExportSessionLog?: () => void | Promise<void>;
    refreshProviders: () => void | Promise<void>;
    onBrowserControlChanged: (state: BrowserControlState) => void;
    onboarding?: boolean;
    spotlight?: boolean;
    providerSpotlight?: boolean;
    notify?: Notify;
  }

  let {
    open = $bindable(false),
    activeTab = $bindable<SettingsTab>('preferences'),
    locale,
    theme,
    setTheme,
    setLocale,
    openShortcutSettings,
    onExportSessionLog,
    refreshProviders,
    onBrowserControlChanged,
    onboarding = false,
    spotlight = false,
    providerSpotlight = false,
    notify,
  }: Props = $props();

  let t = $derived(messages[locale]);
  let shortcut = $derived(readShortcutLabel());
  let contentElement = $state<HTMLDivElement | null>(null);
  let browserAccessElement = $state<HTMLElement | null>(null);
  let diagnosticsElement = $state<HTMLElement | null>(null);
  let contentHeight = $state(0);
  let spotlightTailHeight = $state(0);
  let browserAccessRevision = $state(0);
  let activeTabIndex = $derived(activeTab === 'preferences' ? 0 : 1);
  let themeIndex = $derived(theme === 'system' ? 0 : theme === 'light' ? 1 : 2);
  let localeIndex = $derived(locale === 'zh' ? 0 : 1);
  let browserSpotlightActive = $derived(spotlight && activeTab === 'preferences');
  let providerSpotlightActive = $derived(providerSpotlight && activeTab === 'providers');
  let activeSpotlight = $derived(browserSpotlightActive || providerSpotlightActive);
  let dimClass = $derived(activeSpotlight ? 'opacity-30 pointer-events-none blur-[3px] transition-[opacity,filter] duration-300 ease-[var(--ease-out)]' : '');

  const SEGMENT_BASE =
    'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12.5px] transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]';
  const TAB_BASE =
    'relative z-10 flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]';

  $effect(() => {
    if (!open || !contentElement || typeof ResizeObserver === 'undefined') return;
    const update = () => { void measureContent(); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(contentElement);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  });

  $effect(() => {
    activeTab;
    onboarding;
    activeSpotlight;
    if (open) void measureContent();
  });

  $effect(() => {
    const spotlight = browserSpotlightActive;
    const controller = new AbortController();
    if (!open || !contentElement) {
      spotlightTailHeight = 0;
      return;
    }
    if (activeTab !== 'preferences') {
      contentElement.scrollTop = 0;
      spotlightTailHeight = 0;
      return;
    }
    void positionBrowserAccess(spotlight, browserAccessRevision, controller.signal);
    return () => controller.abort();
  });

  // Preferences clips right above the diagnostics section: it stays reachable
  // by scrolling but out of sight for most users.
  async function measureContent() {
    await tick();
    if (!contentElement) return;
    contentHeight = diagnosticsElement
      ? diagnosticsElement.getBoundingClientRect().top - contentElement.getBoundingClientRect().top + contentElement.scrollTop - 8
      : contentElement.scrollHeight;
  }

  async function positionBrowserAccess(spotlight: boolean, revision: number, signal: AbortSignal) {
    await tick();
    if (!contentElement || activeTab !== 'preferences') return;
    if (!spotlight) {
      await scrollSettingsTo(0, signal);
      if (!signal.aborted && !browserSpotlightActive) spotlightTailHeight = 0;
      return;
    }
    if (!browserAccessElement) return;

    const dialog = contentElement.closest<HTMLElement>('[data-slot="dialog-content"]');
    const animations = [dialog, browserAccessElement]
      .flatMap((element) => element?.getAnimations() ?? [])
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.allSettled(animations.map((animation) => animation.finished));
    if (signal.aborted || revision !== browserAccessRevision || !browserSpotlightActive || !open) return;

    const target = centeredScrollTop(contentElement, browserAccessElement);
    const maxScrollTop = Math.max(0, contentElement.scrollHeight - contentElement.clientHeight - spotlightTailHeight);
    spotlightTailHeight = Math.ceil(Math.max(0, target - maxScrollTop));
    await tick();
    if (signal.aborted || revision !== browserAccessRevision || !browserSpotlightActive || !open) return;
    await scrollSettingsTo(centeredScrollTop(contentElement, browserAccessElement), signal);
  }

  function centeredScrollTop(scroller: HTMLElement, target: HTMLElement) {
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return Math.max(0, scroller.scrollTop + targetRect.top + targetRect.height / 2 - scrollerRect.top - scrollerRect.height / 2);
  }

  async function scrollSettingsTo(top: number, signal: AbortSignal) {
    if (!contentElement || signal.aborted) return;
    const scroller = contentElement;
    const target = Math.min(top, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
    if (Math.abs(scroller.scrollTop - target) <= 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      scroller.scrollTop = target;
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        scroller.removeEventListener('scrollend', finish);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      scroller.addEventListener('scrollend', finish, { once: true });
      signal.addEventListener('abort', finish, { once: true });
      scroller.scrollTo({ top: target, behavior: 'smooth' });
    });
  }

  function handleBrowserAccessChanged(state: BrowserControlState) {
    onBrowserControlChanged(state);
    browserAccessRevision += 1;
  }

  function segmentClass(active: boolean) {
    return `${SEGMENT_BASE} ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`;
  }

  function tabClass(active: boolean) {
    return `${TAB_BASE} ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`;
  }

  function pillStyle(index: number, count: number, gapRem: number, paddingRem: number) {
    return `width: calc((100% - ${2 * paddingRem + gapRem * (count - 1)}rem) / ${count}); transform: translateX(calc(${index * 100}% + ${index * gapRem}rem));`;
  }

  function notifyBrowser(notice: Parameters<Notify>[0]) {
    notify?.({ ...notice, icon: notice.icon ?? 'browser' });
  }

  function notifyProvider(notice: Parameters<Notify>[0]) {
    notify?.({ ...notice, icon: notice.icon ?? 'model' });
  }

  function readShortcutLabel() {
    if (typeof navigator === 'undefined') return 'Alt E';
    return navigator.platform.toLowerCase().includes('mac') ? '⌘ E' : 'Alt E';
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content data-spotlight={activeSpotlight ? '' : null} class="flex max-h-[min(86vh,640px)] w-[min(92vw,28rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 ring-2 sm:max-w-[28rem]">
    <header class="{dimClass} flex items-center justify-between px-5 pb-3.5 pt-5">
      <Dialog.Title class="text-[16px] font-semibold tracking-tight text-foreground">{t.app.settings}</Dialog.Title>
      <Dialog.Description class="sr-only">{t.app.settings}</Dialog.Description>
    </header>

    <nav aria-label={t.app.settings} class="{dimClass} px-5 pb-2">
      <div role="tablist" class="bg-surface-2 relative grid w-full grid-cols-2 gap-1 rounded-xl p-1">
        <span aria-hidden="true" class="bg-surface pointer-events-none absolute bottom-1 left-1 top-1 rounded-lg shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-transform duration-200 ease-[var(--ease-out)]" style={pillStyle(activeTabIndex, 2, 0.25, 0.25)}></span>
        <button type="button" role="tab" aria-selected={activeTab === 'preferences'} class={tabClass(activeTab === 'preferences')} onclick={() => (activeTab = 'preferences')}>
          <SlidersHorizontal class="fx-icon-draw size-4" />
          <span>{t.app.preferences}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'providers'} class={tabClass(activeTab === 'providers')} onclick={() => (activeTab = 'providers')}>
          <Database class="fx-icon-draw size-4" strokeWidth={1.9} />
          <span>{t.app.providersTitle}</span>
        </button>
      </div>
    </nav>

    <div
      class="min-h-0 overflow-hidden transition-[height] duration-[var(--d-overlay)] ease-[var(--ease-out)]"
      style={contentHeight ? `height:min(${contentHeight}px,calc(min(86vh,640px) - 7rem));` : undefined}
    >
      <div bind:this={contentElement} class="h-full max-h-[calc(min(86vh,640px)_-_7rem)] overflow-y-auto overscroll-contain px-5 [scrollbar-gutter:stable]">
      {#if activeTab === 'preferences'}
        <div class="flex flex-col gap-6 pt-3" style={`padding-bottom:calc(1.25rem + ${spotlightTailHeight}px)`}>
          <section class="fx-enter space-y-2 {dimClass}" style="--fx-index: 0">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.app.theme}</p>
            <div class="bg-surface-2 relative grid grid-cols-3 rounded-xl p-1">
              <span aria-hidden="true" class="bg-surface pointer-events-none absolute bottom-1 left-1 top-1 rounded-lg shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-transform duration-200 ease-[var(--ease-out)]" style={pillStyle(themeIndex, 3, 0, 0.25)}></span>
              <button type="button" class={segmentClass(theme === 'system')} aria-pressed={theme === 'system'} onclick={() => setTheme('system')}><Monitor class="fx-icon-draw size-4" />{t.app.system}</button>
              <button type="button" class={segmentClass(theme === 'light')} aria-pressed={theme === 'light'} onclick={() => setTheme('light')}><Sun class="fx-icon-draw size-4" />{t.app.light}</button>
              <button type="button" class={segmentClass(theme === 'dark')} aria-pressed={theme === 'dark'} onclick={() => setTheme('dark')}><Moon class="fx-icon-draw size-4" />{t.app.dark}</button>
            </div>
          </section>

          <section class="fx-enter space-y-2 {dimClass}" style="--fx-index: 1">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.locale.label}</p>
            <div class="bg-surface-2 relative grid grid-cols-2 rounded-xl p-1">
              <span aria-hidden="true" class="bg-surface pointer-events-none absolute bottom-1 left-1 top-1 rounded-lg shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-transform duration-200 ease-[var(--ease-out)]" style={pillStyle(localeIndex, 2, 0, 0.25)}></span>
              <button type="button" class={segmentClass(locale === 'zh')} aria-label={t.locale.chinese} aria-pressed={locale === 'zh'} onclick={() => setLocale('zh')}><span aria-hidden="true" class="grid size-4 place-items-center text-[11.5px] font-semibold leading-none">中</span></button>
              <button type="button" class={segmentClass(locale === 'en')} aria-label={t.locale.english} aria-pressed={locale === 'en'} onclick={() => setLocale('en')}><span aria-hidden="true" class="grid size-4 place-items-center text-[11px] font-semibold leading-none">Aa</span></button>
            </div>
          </section>

          <section class="fx-enter space-y-2 {dimClass}" style="--fx-index: 2">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.app.shortcuts}</p>
            <button
              type="button"
              class="group hover:bg-surface-2 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-[background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.99]"
              onclick={openShortcutSettings}
            >
              <span class="flex min-w-0 items-center gap-2.5">
                <SidebarSimple class="fx-icon-draw text-muted-foreground group-hover:text-foreground size-[18px] shrink-0 transition-colors duration-150 ease-[var(--ease-out)]" strokeWidth={1.9} />
                <span class="truncate text-[13.5px] font-medium text-foreground">{t.app.toggleSidePanel}</span>
              </span>
              <span class="flex shrink-0 items-center gap-2">
                <kbd class="text-muted-foreground border bg-surface-2 rounded-lg px-2.5 py-1 font-mono text-[12.5px] tabular">{shortcut}</kbd>
                <ArrowSquareOut class="text-muted-foreground/60 size-3.5 opacity-0 transition-opacity duration-150 ease-[var(--ease-out)] group-hover:opacity-100" />
              </span>
            </button>
          </section>

          <section
            bind:this={browserAccessElement}
            class="fx-enter {browserSpotlightActive ? 'fx-spotlight' : ''}"
            style="--fx-index: 3"
          >
            <BrowserAccessPanel {locale} notify={notifyBrowser} onChanged={handleBrowserAccessChanged} />
          </section>

          <section bind:this={diagnosticsElement} class="fx-enter space-y-2 {dimClass}" style="--fx-index: 4">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.app.diagnostics}</p>
            <button
              type="button"
              class="group hover:bg-surface-2 flex w-full items-center justify-between gap-3 rounded-xl px-3 py-3 text-left transition-[background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.99] disabled:pointer-events-none disabled:opacity-45"
              disabled={!onExportSessionLog}
              onclick={() => void onExportSessionLog?.()}
            >
              <span class="flex min-w-0 items-center gap-2.5">
                <DownloadSimple class="fx-icon-draw text-muted-foreground group-hover:text-foreground size-[18px] shrink-0 transition-colors duration-150 ease-[var(--ease-out)]" strokeWidth={1.9} />
                <span class="truncate text-[13.5px] font-medium text-foreground">{t.app.exportSessionLog}</span>
              </span>
            </button>
          </section>
        </div>
      {:else}
        <div class="fx-enter pb-5 pt-3">
          <ProviderSettings {locale} variant={onboarding ? 'onboarding' : 'panel'} spotlight={providerSpotlightActive} onChanged={refreshProviders} notify={notifyProvider} />
        </div>
      {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
