<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { projectAgentEvents } from '$lib/agent-event-projection.ts';
  import { initializeDatabase, listSessions, readLatestSessionSnapshot, readSessionSnapshot, type SessionListItem, type SessionSnapshot } from '$lib/db.ts';
  import { imagePreviewFromProjection, sidebarTaskViewFromProjection, sourcesFromProjection, timelineFromProjection, type SourceLink } from '$lib/sidepanel-view.ts';
  import { getReasoningEffort, getSelectedModelId, listProvidersWithModels, setReasoningEffort, setSelectedModelId, type ProviderWithModels, type ReasoningEffort } from '$lib/provider-store.ts';
  import { detectLocale, localeManualStorageKey, localeStorageKey, messages, persistLocale, type Locale } from '$lib/sidepanel-i18n.ts';
  import FadersHorizontal from 'phosphor-svelte/lib/FadersHorizontal';
  import Plus from 'phosphor-svelte/lib/Plus';
  import BrowserAccessPanel from './BrowserAccessPanel.svelte';
  import { readBrowserControlState, type BrowserControlState } from './browser-access.ts';
  import SettingsDialog from './SettingsDialog.svelte';
  import SessionHistory from './SessionHistory.svelte';
  import SourcesBar from './SourcesBar.svelte';
  import Timeline from './Timeline.svelte';
  import Composer from './Composer.svelte';
  import type { ToastInput, ToastNotice } from './toast.ts';
  import './app.css';

  type Theme = 'light' | 'dark' | 'system';
  type TaskStatus = 'idle' | 'running' | 'failed' | 'cancelled';

  let databaseReady = $state(false);
  let providersLoaded = $state(false);
  let browserControlLoaded = $state(false);
  let databaseError = $state('');
  let taskError = $state('');

  let snapshot = $state<SessionSnapshot | undefined>(undefined);
  let currentSessionId = $state<number | null>(null);
  let sessions = $state<SessionListItem[]>([]);
  let liveTaskState = $state<'idle' | 'running'>('idle');
  let providers = $state<ProviderWithModels[]>([]);
  let browserControlState = $state<BrowserControlState | undefined>(undefined);
  let selectedModelId = $state<number | null>(null);
  let reasoningEffort = $state<ReasoningEffort>('default');
  let theme = $state<Theme>(readInitialTheme());
  let locale = $state<Locale>(detectRuntimeLocale());
  let settingsOpen = $state(false);
  let settingsTab = $state<'preferences' | 'providers'>('preferences');
  let sidepanelWindowId = $state<number | undefined>(undefined);
  let promptedForMissingModel = $state(false);
  let settingsToasts = $state<ToastNotice[]>([]);
  let nextToastId = 1;

  const events = $derived(snapshot?.agentEvents ?? []);
  const eventProjection = $derived(projectAgentEvents(events));
  const timelineEntries = $derived(timelineFromProjection(eventProjection));
  const taskView = $derived(sidebarTaskViewFromProjection(eventProjection));
  const t = $derived(messages[locale]);
  const taskStatus = $derived<TaskStatus>(liveTaskState === 'running' ? 'running' : taskView.status);
  const sources = $derived(sourcesFromProjection(eventProjection, t.sources, taskView.context));
  const imagePreview = $derived(imagePreviewFromProjection(eventProjection, t.sources));
  const availableProviders = $derived(providers.filter((provider) => provider.hasCredential));
  const hasAnyModel = $derived(availableProviders.some((provider) => provider.models.some((model) => !model.unavailable && model.visibility !== 'hide')));
  const selectedModel = $derived.by(() => {
    if (selectedModelId === null) return undefined;
    for (const provider of availableProviders) {
      const match = provider.models.find((model) => model.id === selectedModelId && !model.unavailable && model.visibility !== 'hide');
      if (match) return { provider, model: match };
    }
    return undefined;
  });
  const selectedModelLabel = $derived(selectedModel ? (selectedModel.model.displayName ?? selectedModel.model.name) : t.app.noModelSelected);
  const composerDisabled = $derived(!databaseReady);
  const missingModel = $derived(!hasAnyModel || !selectedModel);
  const showBrowserControlOnboarding = $derived(databaseReady && providersLoaded && browserControlLoaded && hasAnyModel && browserControlState?.ready !== true);

  $effect(() => {
    applyTheme(theme);
  });

  $effect(() => {
    if (!settingsOpen) settingsToasts = [];
  });

  $effect(() => {
    if (!databaseReady || !providersLoaded || showBrowserControlOnboarding) return;
    if (hasAnyModel) {
      promptedForMissingModel = false;
      return;
    }
    if (!promptedForMissingModel) {
      openSettings('providers');
      promptedForMissingModel = true;
    }
  });

  onMount(() => {
    const port = browser.runtime.connect({ name: 'taber.sidepanel' });
    void browser.windows.getCurrent().then((window) => {
      if (!window.id) return;
      sidepanelWindowId = window.id;
      port.postMessage({ type: 'taber.sidepanel.window', windowId: window.id });
    });
    const handleSidepanelClose = (message: unknown) => {
      if (isRecord(message) && message.type === 'taber.sidepanel.close') window.close();
    };
    const handleMessage = (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === 'taber.sidepanel.close') {
        window.close();
        return;
      }
      if (message.type !== 'taber.agent.event') return;
      const event = isRecord(message.event) ? message.event : undefined;
      const eventSessionId = typeof event?.sessionId === 'number' ? event.sessionId : undefined;
      if (eventSessionId === undefined || currentSessionId === null || currentSessionId === eventSessionId) void refreshSnapshot(eventSessionId);
      void refreshSessions();
    };
    const syncLocale = () => { void refreshStoredLocale(); };
    const handleStorageChange = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'local') return;
      if (localeStorageKey in changes || localeManualStorageKey in changes) void refreshStoredLocale();
    };
    port.onMessage.addListener(handleSidepanelClose);
    browser.runtime.onMessage.addListener(handleMessage);
    browser.storage.onChanged.addListener(handleStorageChange);
    window.addEventListener('storage', syncLocale);
    window.addEventListener('taber.localechange', syncLocale);
    void refreshStoredLocale();
    void boot();
    return () => {
      port.onMessage.removeListener(handleSidepanelClose);
      browser.runtime.onMessage.removeListener(handleMessage);
      browser.storage.onChanged.removeListener(handleStorageChange);
      port.disconnect();
      window.removeEventListener('storage', syncLocale);
      window.removeEventListener('taber.localechange', syncLocale);
    };
  });

  async function boot() {
    try {
      await initializeDatabase();
      databaseReady = true;
      await Promise.all([refreshProviders(), refreshBrowserControl(), refreshSessions(), refreshSnapshot()]);
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function refreshBrowserControl() {
    try {
      browserControlState = await readBrowserControlState();
      browserControlLoaded = true;
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function refreshProviders() {
    try {
      const [list, selected, effort] = await Promise.all([listProvidersWithModels(), getSelectedModelId(), getReasoningEffort()]);
      const selectableModels = list.flatMap((provider) => provider.hasCredential ? provider.models : []).filter((model) => !model.unavailable && model.visibility !== 'hide');
      providers = list;
      selectedModelId = selected && selectableModels.some((model) => model.id === selected) ? selected : selectableModels[0]?.id ?? null;
      reasoningEffort = effort;
      providersLoaded = true;
      if (selectableModels.length > 0 && browserControlState?.ready !== true) settingsOpen = false;
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function refreshSessions() {
    try {
      sessions = await listSessions();
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function refreshSnapshot(sessionId?: number) {
    try {
      snapshot = sessionId ? await readSessionSnapshot(sessionId) : await readLatestSessionSnapshot();
      currentSessionId = snapshot?.session.id ?? null;
      liveTaskState = projectAgentEvents(snapshot?.agentEvents ?? []).taskState === 'running' ? 'running' : 'idle';
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function handleSelectSession(sessionId: number) {
    await refreshSnapshot(sessionId);
  }

  function handleNewSession() {
    snapshot = undefined;
    currentSessionId = null;
    liveTaskState = 'idle';
    taskError = '';
  }

  async function handleSelectModel(id: number) {
    try {
      await setSelectedModelId(id);
      selectedModelId = id;
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function handleSelectReasoningEffort(value: ReasoningEffort) {
    try {
      await setReasoningEffort(value);
      reasoningEffort = value;
    } catch (error) {
      databaseError = describe(error);
    }
  }

  async function handleStart(text: string) {
    taskError = '';
    if (missingModel) {
      openSettings('providers');
      return;
    }
    try {
      const message = currentSessionId === null
        ? { type: 'taber.background.startTask', prompt: text, windowId: sidepanelWindowId }
        : { type: 'taber.background.startTask', prompt: text, sessionId: currentSessionId, windowId: sidepanelWindowId };
      const response = await sendStartTask(message);
      if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
      liveTaskState = 'running';
      const sessionId = isRecord(response) && typeof response.sessionId === 'number' ? response.sessionId : undefined;
      await Promise.all([refreshSessions(), refreshSnapshot(sessionId)]);
    } catch (error) {
      taskError = describe(error);
    }
  }

  async function handleBrowserControlChanged(state: BrowserControlState) {
    browserControlState = state;
  }

  async function handleBrowserControlDone() {
    await refreshBrowserControl();
  }

  async function handleStop() {
    taskError = '';
    try {
      const response = await browser.runtime.sendMessage({ type: 'taber.background.stopTask' });
      if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
    } catch (error) {
      taskError = describe(error);
    }
  }

  async function listWindowTabs() {
    const query = sidepanelWindowId === undefined ? { currentWindow: true } : { windowId: sidepanelWindowId };
    const response = await browser.runtime.sendMessage({ type: 'taber.chromeApi.request', action: 'tabs.query', args: [query] });
    if (!Array.isArray(response)) return [];
    return response
      .filter((tab): tab is { id: number; title?: string; url?: string; favIconUrl?: string; active?: boolean } => isRecord(tab) && typeof tab.id === 'number' && /^https?:/i.test(String(tab.url ?? '')))
      .map((tab) => ({ id: tab.id, title: tab.title ?? '', url: tab.url ?? '', favIconUrl: tab.favIconUrl, active: tab.active }));
  }

  async function openSource(source: SourceLink) {
    taskError = '';
    try {
      if (source.tabId) {
        const response = await browser.runtime.sendMessage({ type: 'taber.chromeApi.request', action: 'tabs.update', args: [source.tabId, { active: true }] });
        if (!isRecord(response) || typeof response.error !== 'string') return;
      }
      await browser.runtime.sendMessage({ type: 'taber.chromeApi.request', action: 'tabs.create', args: [{ url: source.url, active: true }] });
    } catch (error) {
      taskError = describe(error);
    }
  }

  function readInitialTheme(): Theme {
    if (typeof localStorage === 'undefined') return 'system';
    const value = localStorage.getItem('taber.theme');
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  }

  function detectRuntimeLocale(stored?: unknown, manual?: unknown) {
    return detectLocale({
      stored: typeof stored === 'string' ? stored : undefined,
      manual: manual === true || manual === 'true' ? true : undefined,
      browserLanguage: browser.i18n?.getUILanguage?.(),
      navigatorLanguages: typeof navigator === 'undefined' ? undefined : navigator.languages,
      navigatorLanguage: typeof navigator === 'undefined' ? undefined : navigator.language,
    });
  }

  function applyTheme(next: Theme) {
    if (typeof document === 'undefined') return;
    if (next === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', next);
    if (typeof localStorage !== 'undefined') localStorage.setItem('taber.theme', next);
  }

  function setTheme(next: Theme) { theme = next; }
  function setLocale(next: Locale) {
    locale = next;
    persistLocale(next);
    void browser.storage.local.set({ [localeStorageKey]: next, [localeManualStorageKey]: true });
  }
  async function refreshStoredLocale() {
    const stored = await browser.storage.local.get([localeStorageKey, localeManualStorageKey]);
    locale = detectRuntimeLocale(stored[localeStorageKey], stored[localeManualStorageKey]);
  }
  function openSettings(tab: 'preferences' | 'providers' = 'preferences') {
    settingsTab = tab;
    settingsOpen = true;
  }

  function sendStartTask(message: unknown) {
    const hook = (globalThis as typeof globalThis & { __taberSmokeStartTask?: (message: unknown) => Promise<unknown> | unknown }).__taberSmokeStartTask;
    if (typeof location !== 'undefined' && location.search.includes('taber-smoke=1') && hook) return hook(message);
    return browser.runtime.sendMessage(message);
  }

  function notifySettings(notice: ToastInput) {
    const id = nextToastId++;
    settingsToasts = [...settingsToasts, { ...notice, id }].slice(-3);
    window.setTimeout(() => {
      settingsToasts = settingsToasts.filter((toast) => toast.id !== id);
    }, notice.tone === 'error' ? 5200 : 3200);
  }

  function openShortcutSettings() {
    void browser.runtime.sendMessage({ type: 'taber.background.openShortcutSettings' });
  }

  function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
  function describe(error: unknown) { return error instanceof Error ? error.message : String(error); }

</script>

<svelte:head><title>Taber</title></svelte:head>

<main class="relative flex h-screen flex-col overflow-hidden bg-bg text-ink">
  <div class="pointer-events-none fixed inset-x-0 top-0 z-20 flex items-center justify-between px-3 py-2.5">
    <button
      type="button"
      class="text-muted-foreground hover:text-foreground bg-surface/85 hover:bg-surface ring-line/70 pointer-events-auto flex size-8 items-center justify-center rounded-full ring-1 backdrop-blur transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
      aria-label={t.app.settings}
      onclick={() => openSettings('preferences')}
    >
      <FadersHorizontal class="size-3.5" weight="duotone" />
    </button>

    <div class="bg-surface/85 ring-line/70 pointer-events-auto rounded-full ring-1 backdrop-blur">
      <SessionHistory {locale} {sessions} {currentSessionId} onSelect={handleSelectSession} onNew={handleNewSession} />
    </div>
  </div>

  {#if !databaseReady}
    <div class="flex-1 p-6 pt-16 text-xs text-muted-foreground">{t.app.loadingDatabase}</div>
  {:else if showBrowserControlOnboarding}
    <section class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-14">
      <BrowserAccessPanel
        {locale}
        windowId={sidepanelWindowId}
        variant="onboarding"
        notify={notifySettings}
        onChanged={handleBrowserControlChanged}
        onDone={handleBrowserControlDone}
      />
    </section>
  {:else}
    {#if hasAnyModel}
      <section class="min-h-0 flex-1 overflow-hidden pt-12">
        <Timeline {locale} entries={timelineEntries} />
      </section>

      <SourcesBar {locale} {sources} {imagePreview} onOpenSource={openSource} />
    {:else}
      <section class="fx-enter flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-hidden px-6 pt-12 text-center">
        <span aria-hidden="true" class="taber-logo-image taber-logo-watermark pointer-events-none block"></span>
        <button
          type="button"
          class="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12.5px] font-medium shadow-[0_1px_2px_oklch(0_0_0_/_0.06)] transition-[background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97]"
          onclick={() => openSettings('providers')}
        >
          <Plus class="size-3.5" weight="bold" />
          {t.provider.addFirstProvider}
        </button>
      </section>
    {/if}

    <section class="shrink-0 px-3 pb-3 pt-2">
      <Composer
        {locale}
        disabled={composerDisabled}
        running={taskStatus === 'running'}
        showQuickActions={true}
        providers={availableProviders}
        {selectedModelId}
        {selectedModelLabel}
        {missingModel}
        {reasoningEffort}
        context={taskView.context}
        onSelectModel={handleSelectModel}
        onSelectReasoningEffort={handleSelectReasoningEffort}
        onMissingModel={() => openSettings('providers')}
        onSubmit={handleStart}
        onStop={handleStop}
        listWindowTabs={listWindowTabs}
      />
      {#if taskError}<p class="text-danger mt-2 text-xs" role="alert">{taskError}</p>{/if}
    </section>
  {/if}

  {#if databaseError}
    <p class="text-danger shrink-0 px-3.5 py-2 text-xs" role="alert">{databaseError}</p>
  {/if}
</main>

<SettingsDialog
  bind:open={settingsOpen}
  bind:activeTab={settingsTab}
  {locale}
  {theme}
  setTheme={setTheme}
  setLocale={setLocale}
  openShortcutSettings={openShortcutSettings}
  refreshProviders={refreshProviders}
  windowId={sidepanelWindowId}
  onboarding={!hasAnyModel}
  notify={notifySettings}
  notices={settingsToasts}
/>

<style>
  :global(html, body, #app) {
    height: 100%;
    overflow: hidden;
  }
</style>

