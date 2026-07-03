<script lang="ts">
  import { tick } from 'svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
  import Database from 'phosphor-svelte/lib/Database';
  import Monitor from 'phosphor-svelte/lib/Monitor';
  import Moon from 'phosphor-svelte/lib/Moon';
  import SidebarSimple from 'phosphor-svelte/lib/SidebarSimple';
  import SlidersHorizontal from 'phosphor-svelte/lib/SlidersHorizontal';
  import Sun from 'phosphor-svelte/lib/Sun';
  import BrowserAccessPanel from './BrowserAccessPanel.svelte';
  import ProviderSettings from './ProviderSettings.svelte';
  import ToastStack from './ToastStack.svelte';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import type { Notify, ToastNotice } from './toast.ts';

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
    refreshProviders: () => void | Promise<void>;
    windowId?: number;
    onboarding?: boolean;
    notify?: Notify;
    notices?: ToastNotice[];
  }

  let {
    open = $bindable(false),
    activeTab = $bindable<SettingsTab>('preferences'),
    locale,
    theme,
    setTheme,
    setLocale,
    openShortcutSettings,
    refreshProviders,
    windowId,
    onboarding = false,
    notify,
    notices = [],
  }: Props = $props();

  let t = $derived(messages[locale]);
  let shortcut = $derived(readShortcutLabel());
  let contentElement = $state<HTMLDivElement | null>(null);
  let contentHeight = $state(0);
  let activeTabIndex = $derived(activeTab === 'preferences' ? 0 : 1);
  let themeIndex = $derived(theme === 'system' ? 0 : theme === 'light' ? 1 : 2);
  let localeIndex = $derived(locale === 'zh' ? 0 : 1);

  const SEGMENT_BASE =
    'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]';
  const TAB_BASE =
    'relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]';

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
    if (open) void measureContent();
  });

  async function measureContent() {
    await tick();
    if (!contentElement) return;
    contentHeight = contentElement.scrollHeight;
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

  function readShortcutLabel() {
    if (typeof navigator === 'undefined') return 'Alt E';
    return navigator.platform.toLowerCase().includes('mac') ? '⌘ E' : 'Alt E';
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex max-h-[min(86vh,640px)] w-[min(92vw,28rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-[28rem]">
    <ToastStack items={notices} placement="dialog" />
    <header class="flex items-center justify-between px-5 pb-3 pt-4">
      <Dialog.Title class="text-[15px] font-semibold tracking-tight text-foreground">{t.app.settings}</Dialog.Title>
      <Dialog.Description class="sr-only">{t.app.settings}</Dialog.Description>
    </header>

    <nav aria-label={t.app.settings} class="px-5 pb-2">
      <div role="tablist" class="bg-surface-2 relative grid w-full grid-cols-2 gap-1 rounded-lg p-1">
        <span aria-hidden="true" class="bg-surface pointer-events-none absolute bottom-1 left-1 top-1 rounded-md shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-transform duration-200 ease-[var(--ease-out)]" style={pillStyle(activeTabIndex, 2, 0.25, 0.25)}></span>
        <button type="button" role="tab" aria-selected={activeTab === 'preferences'} class={tabClass(activeTab === 'preferences')} onclick={() => (activeTab = 'preferences')}>
          <SlidersHorizontal class="size-3.5" />
          <span>{t.app.preferences}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'providers'} class={tabClass(activeTab === 'providers')} onclick={() => (activeTab = 'providers')}>
          <Database class="size-3.5" weight="duotone" />
          <span>{t.app.providersTitle}</span>
        </button>
      </div>
    </nav>

    <div
      class="min-h-0 overflow-hidden transition-[height] duration-[var(--d-overlay)] ease-[var(--ease-out)]"
      style={contentHeight ? `height:min(${contentHeight}px,calc(min(86vh,640px) - 6.5rem));` : undefined}
    >
      <div bind:this={contentElement} class="max-h-[calc(min(86vh,640px)_-_6.5rem)] overflow-y-auto overscroll-contain px-5 [scrollbar-gutter:stable]">
      {#if activeTab === 'preferences'}
        <div class="flex flex-col gap-6 pb-5 pt-3">
          <section class="fx-enter space-y-2" style="--fx-index: 0">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.app.theme}</p>
            <div class="bg-surface-2 relative grid grid-cols-3 rounded-lg p-0.5">
              <span aria-hidden="true" class="bg-surface pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 rounded-md shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-transform duration-200 ease-[var(--ease-out)]" style={pillStyle(themeIndex, 3, 0, 0.125)}></span>
              <button type="button" class={segmentClass(theme === 'system')} aria-pressed={theme === 'system'} onclick={() => setTheme('system')}><Monitor class="size-3.5" />{t.app.system}</button>
              <button type="button" class={segmentClass(theme === 'light')} aria-pressed={theme === 'light'} onclick={() => setTheme('light')}><Sun class="size-3.5" />{t.app.light}</button>
              <button type="button" class={segmentClass(theme === 'dark')} aria-pressed={theme === 'dark'} onclick={() => setTheme('dark')}><Moon class="size-3.5" />{t.app.dark}</button>
            </div>
          </section>

          <section class="fx-enter space-y-2" style="--fx-index: 1">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.locale.label}</p>
            <div class="bg-surface-2 relative grid grid-cols-2 rounded-lg p-0.5">
              <span aria-hidden="true" class="bg-surface pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 rounded-md shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-transform duration-200 ease-[var(--ease-out)]" style={pillStyle(localeIndex, 2, 0, 0.125)}></span>
              <button type="button" class={segmentClass(locale === 'zh')} aria-label={t.locale.chinese} aria-pressed={locale === 'zh'} onclick={() => setLocale('zh')}><span aria-hidden="true" class="grid size-3.5 place-items-center text-[10.5px] font-semibold leading-none">中</span></button>
              <button type="button" class={segmentClass(locale === 'en')} aria-label={t.locale.english} aria-pressed={locale === 'en'} onclick={() => setLocale('en')}><span aria-hidden="true" class="grid size-3.5 place-items-center text-[10px] font-semibold leading-none">Aa</span></button>
            </div>
          </section>

          <section class="fx-enter space-y-2" style="--fx-index: 2">
            <BrowserAccessPanel {locale} {windowId} {notify} />
          </section>

          <section class="fx-enter space-y-2" style="--fx-index: 3">
            <p class="text-muted-foreground text-[11px] font-medium tracking-[0.04em] uppercase">{t.app.shortcuts}</p>
            <button
              type="button"
              class="group hover:bg-surface-2 flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition-[background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.99]"
              onclick={openShortcutSettings}
            >
              <span class="flex min-w-0 items-center gap-2.5">
                <SidebarSimple class="text-muted-foreground group-hover:text-foreground size-4 shrink-0 transition-colors duration-150 ease-[var(--ease-out)]" weight="duotone" />
                <span class="truncate text-[13px] font-medium text-foreground">{t.app.toggleSidePanel}</span>
              </span>
              <span class="flex shrink-0 items-center gap-2">
                <kbd class="text-muted-foreground border bg-surface-2 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular">{shortcut}</kbd>
                <ArrowSquareOut class="text-muted-foreground/60 size-3.5 opacity-0 transition-opacity duration-150 ease-[var(--ease-out)] group-hover:opacity-100" />
              </span>
            </button>
          </section>
        </div>
      {:else}
        <div class="fx-enter pb-5 pt-3">
          <ProviderSettings {locale} variant={onboarding ? 'onboarding' : 'panel'} onChanged={refreshProviders} {notify} />
        </div>
      {/if}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
