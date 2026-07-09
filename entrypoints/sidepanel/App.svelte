<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from 'wxt/browser';
  import { projectAgentEvents } from '$lib/agent-event-projection.ts';
  import { createSession, initializeDatabase, listSessions, readLatestSessionSnapshot, readSessionSnapshot, type SessionListItem, type SessionSnapshot, type WorkspaceFile } from '$lib/db.ts';
  import { MAX_FILE_BYTES, deleteSessionFile, listSessionFiles, writeSessionFile } from '$lib/workspace-files.ts';
  import { controlledTargetFromContext, imagePreviewFromProjection, settingsTabStartsBrowserControlGuide, shouldAdvanceToProviderSetup, sidebarTaskViewFromProjection, sourcesFromProjection, timelineFromProjection, type SettingsTab, type SourceLink } from '$lib/sidepanel-view.ts';
  import { getReasoningEffort, getSelectedModelId, listProvidersWithModels, normalizeReasoningEffortForModel, setReasoningEffort, setSelectedModelId, type ProviderWithModels, type ReasoningEffort } from '$lib/provider-store.ts';
  import { detectLocale, localeManualStorageKey, localeStorageKey, messages, persistLocale, type Locale } from '$lib/sidepanel-i18n.ts';
  import FadersHorizontal from 'phosphor-svelte/lib/FadersHorizontal';
  import Sparkle from 'phosphor-svelte/lib/Sparkle';
  import { readBrowserControlState, type BrowserControlState } from './browser-access.ts';
  import SettingsDialog from './SettingsDialog.svelte';
  import SessionHistory from './SessionHistory.svelte';
  import FilesStrip from './FilesStrip.svelte';
  import SourcesBar from './SourcesBar.svelte';
  import Timeline from './Timeline.svelte';
  import ToastStack from './ToastStack.svelte';
  import Composer from './Composer.svelte';
  import type { ToastInput, ToastNotice, ToastTone } from './toast.ts';
  import './app.css';

  type Theme = 'light' | 'dark' | 'system';
  type TaskStatus = 'idle' | 'running' | 'failed' | 'cancelled';

  let databaseReady = $state(false);
  let providersLoaded = $state(false);
  let browserControlLoaded = $state(false);

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
  let settingsTab = $state<SettingsTab>('preferences');
  let sidepanelWindowId = $state<number | undefined>(undefined);
  let promptedForMissingModel = $state(false);
  let promptedForBrowserControl = $state(false);
  let toasts = $state<ToastNotice[]>([]);
  let sessionFiles = $state<WorkspaceFile[]>([]);
  let nextToastId = 1;

  const events = $derived(snapshot?.agentEvents ?? []);
  const eventProjection = $derived(projectAgentEvents(events));

  $effect(() => {
    events.length;
    void refreshSessionFiles(currentSessionId);
  });
  const timelineEntries = $derived(timelineFromProjection(eventProjection));
  const taskView = $derived(sidebarTaskViewFromProjection(eventProjection));
  const t = $derived(messages[locale]);
  const taskStatus = $derived<TaskStatus>(liveTaskState === 'running' ? 'running' : taskView.status);
  const sources = $derived(sourcesFromProjection(eventProjection, t.sources, taskView.context));
  const controlledTarget = $derived(controlledTargetFromContext(taskView.context, { ...t.sources, controlledPage: taskStatus === 'running' ? t.sources.controlledPage : t.sources.lastPage }));
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
  const composerDisabled = $derived(!databaseReady || sidepanelWindowId === undefined);
  const missingModel = $derived(!hasAnyModel || !selectedModel);
  const missingBrowserControl = $derived(databaseReady && providersLoaded && browserControlLoaded && browserControlState?.ready !== true);
  const providerSetupSpotlight = $derived(databaseReady && providersLoaded && browserControlLoaded && !missingBrowserControl && !hasAnyModel);
  const setupMissing = $derived(missingModel || missingBrowserControl);

  $effect(() => {
    applyTheme(theme);
  });

  $effect(() => {
    if (!databaseReady || !providersLoaded || !browserControlLoaded) return;
    if (setupMissing) return;
    promptedForBrowserControl = false;
    promptedForMissingModel = false;
  });

  $effect(() => {
    if (!databaseReady || !providersLoaded || !browserControlLoaded) return;
    if (shouldAdvanceToProviderSetup({ settingsOpen, promptedForBrowserControl, missingBrowserControl, hasAnyModel, promptedForMissingModel })) {
      openSettings('providers');
      promptedForMissingModel = true;
      return;
    }
    if (settingsOpen) return;
    if (missingBrowserControl) {
      if (!promptedForBrowserControl) openSettings('preferences');
      return;
    }
    if (!hasAnyModel && !promptedForMissingModel) {
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
      reportLoadError(error);
    }
  }

  async function refreshBrowserControl() {
    try {
      browserControlState = await readBrowserControlState();
      browserControlLoaded = true;
    } catch (error) {
      reportLoadError(error, 'browser');
    }
  }

  async function refreshProviders() {
    try {
      const [list, selected, effort] = await Promise.all([listProvidersWithModels(), getSelectedModelId(), getReasoningEffort()]);
      const selectableModels = list.flatMap((provider) => provider.hasCredential ? provider.models : []).filter((model) => !model.unavailable && model.visibility !== 'hide');
      const selectedId = selected && selectableModels.some((model) => model.id === selected) ? selected : selectableModels[0]?.id ?? null;
      const model = selectableModels.find((item) => item.id === selectedId);
      const normalizedEffort = normalizeReasoningEffortForModel(effort, model);
      providers = list;
      selectedModelId = selectedId;
      reasoningEffort = normalizedEffort;
      if (normalizedEffort !== effort) await setReasoningEffort(normalizedEffort);
      providersLoaded = true;
    } catch (error) {
      reportLoadError(error, 'model');
    }
  }

  async function refreshSessions() {
    try {
      sessions = await listSessions();
    } catch (error) {
      reportLoadError(error);
    }
  }

  async function refreshSnapshot(sessionId?: number) {
    try {
      snapshot = sessionId ? await readSessionSnapshot(sessionId) : await readLatestSessionSnapshot();
      currentSessionId = snapshot?.session.id ?? null;
      liveTaskState = projectAgentEvents(snapshot?.agentEvents ?? []).taskState === 'running' ? 'running' : 'idle';
    } catch (error) {
      reportLoadError(error);
    }
  }

  async function handleSelectSession(sessionId: number) {
    await refreshSnapshot(sessionId);
  }

  function handleNewSession() {
    snapshot = undefined;
    currentSessionId = null;
    liveTaskState = 'idle';
  }

  async function handleSelectModel(id: number) {
    try {
      await setSelectedModelId(id);
      selectedModelId = id;
      const model = providers.flatMap((provider) => provider.models).find((item) => item.id === id);
      const normalizedEffort = normalizeReasoningEffortForModel(reasoningEffort, model);
      if (normalizedEffort !== reasoningEffort) {
        await setReasoningEffort(normalizedEffort);
        reasoningEffort = normalizedEffort;
      }
    } catch (error) {
      notifyProblem(error, 'error', 'model');
    }
  }

  async function handleSelectReasoningEffort(value: ReasoningEffort) {
    try {
      const normalizedEffort = normalizeReasoningEffortForModel(value, selectedModel?.model);
      await setReasoningEffort(normalizedEffort);
      reasoningEffort = normalizedEffort;
    } catch (error) {
      notifyProblem(error, 'error', 'model');
    }
  }

  async function handleStart(text: string) {
    if (missingModel) {
      openSettings('providers');
      return;
    }
    if (sidepanelWindowId === undefined) {
      notify({ tone: 'info', icon: 'browser', text: t.app.loadingWindow });
      return;
    }
    try {
      const message = currentSessionId === null
        ? { type: 'taber.background.startTask', prompt: text, windowId: sidepanelWindowId, locale }
        : { type: 'taber.background.startTask', prompt: text, sessionId: currentSessionId, windowId: sidepanelWindowId, locale };
      const response = await sendStartTask(message);
      if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
      liveTaskState = 'running';
      const sessionId = isRecord(response) && typeof response.sessionId === 'number' ? response.sessionId : undefined;
      await Promise.all([refreshSessions(), refreshSnapshot(sessionId)]);
    } catch (error) {
      notifyProblem(error, 'error', 'task');
    }
  }

  async function refreshSessionFiles(sessionId: number | null) {
    if (!databaseReady || sessionId === null) {
      sessionFiles = [];
      return;
    }
    try {
      sessionFiles = await listSessionFiles(sessionId);
    } catch {
      sessionFiles = [];
    }
  }

  async function handleAttachFile(file: File): Promise<string | undefined> {
    if (file.size > MAX_FILE_BYTES) {
      notify({ tone: 'info', icon: 'browser', text: t.quick.attachTooLarge });
      return undefined;
    }
    try {
      if (currentSessionId === null) {
        const session = await createSession({ title: file.name.slice(0, 80) });
        currentSessionId = session.id;
        await refreshSessions();
      }
      const saved = await writeSessionFile({ sessionId: currentSessionId, name: file.name, data: await file.arrayBuffer() });
      await refreshSessionFiles(currentSessionId);
      return saved.name;
    } catch (error) {
      notifyProblem(error, 'error', 'task');
      return undefined;
    }
  }

  async function handleDeleteFile(file: WorkspaceFile) {
    await deleteSessionFile(file.id);
    await refreshSessionFiles(currentSessionId);
  }

  async function handleStop() {
    try {
      const response = await browser.runtime.sendMessage({ type: 'taber.background.stopTask' });
      if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
    } catch (error) {
      notifyProblem(error, 'error', 'task');
    }
  }

  async function listWindowTabs() {
    try {
      return (await queryWindowTabs({})).map((tab) => ({ id: tab.id, title: tab.title ?? '', url: tabUrl(tab), favIconUrl: tab.favIconUrl, active: tab.active }));
    } catch (error) {
      notifyProblem(error, 'error', 'browser');
      return [];
    }
  }

  async function queryWindowTabs(extraQuery: Record<string, unknown>) {
    const query = { ...(sidepanelWindowId === undefined ? { currentWindow: true } : { windowId: sidepanelWindowId }), ...extraQuery };
    const response = await sendChromeApiRequest('tabs.query', [query]);
    if (!Array.isArray(response)) return [];
    return response.filter((tab): tab is { id: number; windowId?: number; title?: string; url?: string; pendingUrl?: string; favIconUrl?: string; active?: boolean } => isRecord(tab) && typeof tab.id === 'number' && /^https?:/i.test(tabUrl(tab)));
  }

  function tabUrl(tab: { url?: unknown; pendingUrl?: unknown }) {
    return typeof tab.pendingUrl === 'string' ? tab.pendingUrl : typeof tab.url === 'string' ? tab.url : '';
  }

  async function openSource(source: SourceLink) {
    try {
      if (source.tabId) {
        const response = await sendChromeApiRequest('tabs.update', [source.tabId, { active: true }]);
        if (!isRecord(response) || typeof response.error !== 'string') return;
      }
      await sendChromeApiRequest('tabs.create', [{ url: source.url, active: true }]);
    } catch (error) {
      notifyProblem(error, 'error', 'browser');
    }
  }

  async function useCurrentTabAsTarget() {
    if (taskStatus !== 'running') {
      notify({ tone: 'warning', icon: 'browser', text: t.sources.switchRequiresRunning });
      return;
    }
    try {
      const activeTab = (await queryWindowTabs({ active: true }))[0];
      if (!activeTab) {
        notify({ tone: 'warning', icon: 'browser', text: t.sources.noOperableActiveTab });
        return;
      }
      const targetTab = { id: activeTab.id, windowId: activeTab.windowId ?? sidepanelWindowId, title: activeTab.title, url: tabUrl(activeTab), favIconUrl: activeTab.favIconUrl };
      const response = await sendSwitchTarget({ type: 'taber.agent.switchTarget', windowId: targetTab.windowId, targetTabId: targetTab.id, targetTab, reason: 'userCurrentTab' });
      if (!isRecord(response)) throw new Error(t.sources.switchUnavailable);
      if (typeof response.error === 'string') throw new Error(response.error);
      await refreshSnapshot(currentSessionId ?? undefined);
    } catch (error) {
      notifyProblem(error, 'error', 'browser');
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
  function openSettings(tab: SettingsTab = 'preferences') {
    settingsTab = tab;
    settingsOpen = true;
    if (settingsTabStartsBrowserControlGuide(tab, missingBrowserControl)) promptedForBrowserControl = true;
  }

  function sendStartTask(message: unknown) {
    const hook = smokeHooks().__taberSmokeStartTask;
    if (isSmokePage() && hook) return hook(message);
    return browser.runtime.sendMessage(message);
  }

  function sendSwitchTarget(message: unknown) {
    const hook = smokeHooks().__taberSmokeSwitchTarget;
    if (isSmokePage() && hook) return hook(message);
    return browser.runtime.sendMessage(message);
  }

  function sendChromeApiRequest(action: string, args: unknown[]) {
    const hook = smokeHooks().__taberSmokeChromeApiRequest;
    if (isSmokePage() && hook) return hook(action, args);
    return browser.runtime.sendMessage({ type: 'taber.chromeApi.request', action, args });
  }

  function smokeHooks() {
    return globalThis as typeof globalThis & {
      __taberSmokeStartTask?: (message: unknown) => Promise<unknown> | unknown;
      __taberSmokeSwitchTarget?: (message: unknown) => Promise<unknown> | unknown;
      __taberSmokeChromeApiRequest?: (action: string, args: unknown[]) => Promise<unknown> | unknown;
    };
  }

  function isSmokePage() {
    return typeof location !== 'undefined' && location.search.includes('taber-smoke=1');
  }

  function notify(notice: ToastInput) {
    const id = nextToastId++;
    toasts = [...toasts, { ...notice, id }].slice(-3);
    window.setTimeout(() => {
      toasts = toasts.filter((toast) => toast.id !== id);
    }, notice.tone === 'error' || notice.tone === 'warning' ? 5200 : 3200);
  }

  function notifyProblem(error: unknown, fallbackTone: ToastTone = 'error', icon?: ToastInput['icon']) {
    const text = describe(error);
    const noOperableActiveTab = isNoOperableActiveTabError(text);
    notify({ tone: noOperableActiveTab ? 'warning' : fallbackTone, icon: noOperableActiveTab ? 'browser' : icon, text: friendlyError(text) });
  }

  function reportLoadError(error: unknown, icon: ToastInput['icon'] = 'database') {
    notify({ tone: 'error', icon, text: friendlyError(describe(error)) });
  }

  function friendlyError(text: string) {
    return isNoOperableActiveTabError(text) ? t.sources.noOperableActiveTab : text;
  }

  function isNoOperableActiveTabError(text: string) {
    return /^No operable http\/https active tab in (the side panel|current) window$/i.test(text);
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

  {#if databaseReady && setupMissing}
    <section class="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-7 overflow-hidden px-6 pt-12 text-center">
      <span aria-hidden="true" class="taber-logo-image taber-logo-watermark fx-enter pointer-events-none block" style="--fx-index:0"></span>
      <div class="fx-enter space-y-1.5" style="--fx-index:1">
        <h2 class="text-[15px] font-semibold tracking-tight text-foreground">{t.app.welcomeHeading}</h2>
      </div>
      <button
        type="button"
        class="fx-enter inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-[12.5px] font-medium text-primary-foreground shadow-[0_1px_3px_oklch(0_0_0_/_0.08)] transition-[background-color,box-shadow,transform] duration-150 ease-[var(--ease-out)] hover:bg-primary/90 active:scale-[0.97]"
        style="--fx-index:2"
        onclick={() => openSettings(missingBrowserControl ? 'preferences' : 'providers')}
      >
        <Sparkle class="size-3.5" weight="fill" />
        {t.app.getStarted}
      </button>
    </section>
  {:else if databaseReady}
    <section class="min-h-0 flex-1 overflow-hidden pt-12">
      <Timeline {locale} entries={timelineEntries} />
    </section>

    <SourcesBar {locale} {sources} target={controlledTarget} running={taskStatus === 'running'} {imagePreview} onOpenSource={openSource} onUseCurrentTab={useCurrentTabAsTarget} />

    <FilesStrip {locale} files={sessionFiles} onDelete={handleDeleteFile} />

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
        onAttachFile={handleAttachFile}
        listWindowTabs={listWindowTabs}
        {notify}
      />
    </section>
  {/if}

</main>

<ToastStack items={toasts} />

<SettingsDialog
  bind:open={settingsOpen}
  bind:activeTab={settingsTab}
  {locale}
  {theme}
  setTheme={setTheme}
  setLocale={setLocale}
  openShortcutSettings={openShortcutSettings}
  refreshProviders={refreshProviders}
  refreshBrowserControl={refreshBrowserControl}
  onboarding={!hasAnyModel}
  spotlight={missingBrowserControl}
  providerSpotlight={providerSetupSpotlight}
  {notify}
/>

<style>
  :global(html, body, #app) {
    height: 100%;
    overflow: hidden;
  }
</style>

