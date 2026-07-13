import { effectiveTabUrl, isOperableTab } from './active-tab.ts';

export const navigateRequestType = 'taber.navigate.request';
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;

export type NavigateAction =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'listTabs'
  | 'switchTab'
  | 'closeTab'
  | 'currentTab';

export type NavigateInput =
  | { action: 'open'; url: string; target?: 'new' }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'listTabs' }
  | { action: 'currentTab' }
  | { action: 'switchTab'; tabId: number }
  | { action: 'closeTab'; tabId: number };

export type NavigateTab = {
  id: number;
  active: boolean;
  index: number;
  status?: string;
  title?: string;
  url?: string;
  favIconUrl?: string;
  windowId?: number;
};

export type NavigateResult = {
  action: NavigateAction;
  tab?: NavigateTab;
  tabs?: NavigateTab[];
  tabId?: number;
  navigation?: { status: 'completed' | 'timeout'; url?: string };
};

export type NavigateRequest = {
  type: typeof navigateRequestType;
  input: NavigateInput;
};

export const navigateInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'back', 'forward', 'reload', 'listTabs', 'switchTab', 'closeTab', 'currentTab'],
    },
    url: { type: 'string', description: 'Only for action=open. URL to open.' },
    target: { type: 'string', enum: ['current', 'new'], description: 'Only for action=open. Omit for the current target; use new to open and retarget to a new tab.' },
    tabId: { type: 'integer', minimum: 1, description: 'Only for action=switchTab or closeTab. Omit for every other action; the current task target is implicit.' },
  },
} as const;

type BrowserTab = {
  id?: number;
  active?: boolean;
  index?: number;
  status?: string;
  title?: string;
  url?: string;
  pendingUrl?: string;
  favIconUrl?: string;
  windowId?: number;
};

type TabsApi = {
  query(query: Record<string, unknown>): Promise<BrowserTab[]>;
  get(tabId: number): Promise<BrowserTab>;
  create(properties: Record<string, unknown>): Promise<BrowserTab>;
  update(tabId: number, properties: Record<string, unknown>): Promise<BrowserTab>;
  remove(tabId: number): Promise<void>;
  reload(tabId?: number): Promise<void>;
  goBack(tabId?: number): Promise<void>;
  goForward(tabId?: number): Promise<void>;
  onUpdated: BrowserEvent<(tabId: number, changeInfo: { status?: string }, tab: BrowserTab) => void>;
  onRemoved: BrowserEvent<(tabId: number) => void>;
};

type NavigationDetails = { tabId: number; frameId: number; url?: string; error?: string };

type WebNavigationApi = {
  onCompleted: BrowserEvent<(details: NavigationDetails) => void>;
  onErrorOccurred: BrowserEvent<(details: NavigationDetails) => void>;
};

type BrowserEvent<Listener extends (...args: never[]) => void> = {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
};

type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timeoutId: unknown): void;
};

export function createNavigateController(options: {
  tabs: TabsApi;
  webNavigation: WebNavigationApi;
  scheduler?: Scheduler;
  currentTabId?: number;
  foregroundMode: boolean;
  navigationTimeoutMs?: number;
}) {
  const scheduler = options.scheduler ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId as ReturnType<typeof globalThis.setTimeout>),
  };
  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  if (!Number.isInteger(navigationTimeoutMs) || navigationTimeoutMs <= 0) throw new Error('navigationTimeoutMs must be a positive integer');

  async function navigate(inputValue: unknown): Promise<NavigateResult> {
    const input = parseNavigateInput(inputValue);
    assertLockedTabId(input);

    switch (input.action) {
      case 'open':
        return openTab(input);
      case 'back':
        return moveInHistory(input, 'back');
      case 'forward':
        return moveInHistory(input, 'forward');
      case 'reload':
        return reloadTab(input);
      case 'listTabs':
        return { action: input.action, tabs: (await options.tabs.query({})).filter(isOperableTab).map(toNavigateTab) };
      case 'switchTab': {
        if (options.currentTabId !== undefined) await currentTab();
        const tabId = input.tabId;
        const tab = assertOperableTab(await options.tabs.get(tabId));
        return { action: input.action, tab: toNavigateTab(await activateForTaskMode(tab)) };
      }
      case 'closeTab': {
        const tabId = input.tabId;
        await options.tabs.remove(tabId);
        return { action: input.action, tabId };
      }
      case 'currentTab':
        return { action: input.action, tab: toNavigateTab(await currentTab()) };
      default:
        return assertNever(input);
    }
  }

  async function openTab(input: Extract<NavigateInput, { action: 'open' }>): Promise<NavigateResult> {
    if (input.target === 'new') {
      const tab = await options.tabs.create({ url: input.url, active: options.foregroundMode, ...await lockedTargetWindow() });
      const navigation = await waitForTabNavigation(requireTabId(tab), navigationTimeoutMs, true);
      return { action: input.action, navigation, tab: toNavigateTab(assertOperableTab(await options.tabs.get(requireTabId(tab)))) };
    }

    const tabId = await currentTabId();
    await activateTabForTaskMode(tabId);
    const waiter = waitForTabNavigation(tabId, navigationTimeoutMs);
    try {
      await options.tabs.update(tabId, { url: input.url });
      return { action: input.action, navigation: await waiter, tab: toNavigateTab(assertOperableTab(await options.tabs.get(tabId))) };
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async function moveInHistory(input: Extract<NavigateInput, { action: 'back' | 'forward' }>, direction: 'back' | 'forward'): Promise<NavigateResult> {
    const tabId = await currentTabId();
    await activateTabForTaskMode(tabId);
    const waiter = waitForTabNavigation(tabId, navigationTimeoutMs);
    try {
      if (direction === 'back') await options.tabs.goBack(tabId);
      else await options.tabs.goForward(tabId);
      return { action: input.action, navigation: await waiter, tab: toNavigateTab(await options.tabs.get(tabId)) };
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async function reloadTab(input: Extract<NavigateInput, { action: 'reload' }>): Promise<NavigateResult> {
    const tabId = await currentTabId();
    await activateTabForTaskMode(tabId);
    const waiter = waitForTabNavigation(tabId, navigationTimeoutMs);
    try {
      await options.tabs.reload(tabId);
      return { action: input.action, navigation: await waiter, tab: toNavigateTab(await options.tabs.get(tabId)) };
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async function currentTab() {
    if (options.currentTabId !== undefined) return lockedCurrentTab();
    const tabs = await options.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(isOperableTab);
    if (!tab) throw new Error('No operable http/https active tab in current window');
    return tab;
  }

  async function lockedCurrentTab() {
    // Non-operable targets (chrome://, new tab) are still navigable: open/reload
    // can steer them to a real page, so only require that the tab exists.
    try {
      return await options.tabs.get(options.currentTabId as number);
    } catch {
      throw new Error(`Target tab is no longer available: ${options.currentTabId}`);
    }
  }

  async function currentTabId() {
    if (options.currentTabId !== undefined) return requireTabId(await lockedCurrentTab());
    return requireTabId(await currentTab());
  }

  async function lockedTargetWindow() {
    if (options.currentTabId === undefined) return {};
    const windowId = (await currentTab()).windowId;
    if (!Number.isInteger(windowId) || Number(windowId) <= 0) throw new Error(`Target tab window id is missing: ${options.currentTabId}`);
    return { windowId: Number(windowId) };
  }

  async function activateTabForTaskMode(tabId: number) {
    if (!options.foregroundMode) return;
    await activateForTaskMode(await options.tabs.get(tabId));
  }

  async function activateForTaskMode(tab: BrowserTab) {
    if (!options.foregroundMode || tab.active) return tab;
    return options.tabs.update(requireTabId(tab), { active: true });
  }

  function assertLockedTabId(input: NavigateInput) {
    if (options.currentTabId === undefined || input.action !== 'closeTab' || input.tabId === options.currentTabId) return;
    throw new Error(`navigate.closeTab is locked to target tab ${options.currentTabId}; received tabId ${input.tabId}. Use navigate.switchTab to change the task target.`);
  }

  function waitForTabNavigation(tabId: number, timeoutMs: number, checkExisting = false) {
    let settled = false;
    let timeoutId: unknown;
    let cleanup = () => undefined;

    const promise = new Promise<{ status: 'completed' | 'timeout'; url?: string }>((resolve, reject) => {
      const settle = (status: 'completed' | 'timeout', url?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status, url });
      };
      const complete = (url?: string) => settle('completed', url);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onCompleted = (details: NavigationDetails) => {
        if (details.tabId === tabId && details.frameId === 0) complete(details.url);
      };
      const onErrorOccurred = (details: NavigationDetails) => {
        if (details.tabId !== tabId || details.frameId !== 0) return;
        // ERR_ABORTED usually means the navigation was superseded (SPA redirect,
        // location.replace). Keep waiting for the replacing navigation instead
        // of failing; the timeout still bounds the wait.
        if (details.error === 'net::ERR_ABORTED') return;
        fail(new Error(details.error ?? `Navigation failed for tab ${tabId}`));
      };
      const onUpdated = (updatedTabId: number, changeInfo: { status?: string }, tab: BrowserTab) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') complete(effectiveTabUrl(tab));
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tabId) fail(new Error(`Tab closed before navigation completed: ${tabId}`));
      };
      cleanup = () => {
        scheduler.clearTimeout(timeoutId);
        options.webNavigation.onCompleted.removeListener(onCompleted);
        options.webNavigation.onErrorOccurred.removeListener(onErrorOccurred);
        options.tabs.onUpdated.removeListener(onUpdated);
        options.tabs.onRemoved.removeListener(onRemoved);
      };

      options.webNavigation.onCompleted.addListener(onCompleted);
      options.webNavigation.onErrorOccurred.addListener(onErrorOccurred);
      options.tabs.onUpdated.addListener(onUpdated);
      options.tabs.onRemoved.addListener(onRemoved);
      // Heavy pages can delay the load event long past usability. Report timeout
      // as a degraded success with tab state instead of an error, so the model
      // inspects the page rather than retrying the same navigation.
      timeoutId = scheduler.setTimeout(() => settle('timeout'), timeoutMs);

      if (checkExisting) {
        void options.tabs.get(tabId).then((tab) => {
          if (tab.status === 'complete') complete(effectiveTabUrl(tab));
        }, () => undefined);
      }
    });

    return Object.assign(promise, {
      cancel() {
        if (settled) return;
        settled = true;
        cleanup();
      },
    });
  }

  return { navigate };
}

export function parseNavigateInput(value: unknown): NavigateInput {
  if (!isRecord(value)) throw new Error('Navigate input must be an object');
  if (!isNavigateAction(value.action)) throw new Error(`Invalid navigate action: ${String(value.action)}`);
  if ('active' in value) throw new Error('active is not a supported navigate field');

  if (value.action === 'open') {
    if (!('url' in value)) throw new Error('navigate.open requires url');
    const url = readString(value.url, 'url').trim();
    if (!url) throw new Error('navigate.open requires url');
    const target = 'target' in value ? readTarget(value.target) : undefined;
    return { action: 'open', url, ...(target === 'new' ? { target } : {}) };
  }
  if (value.action === 'switchTab' || value.action === 'closeTab') {
    if (!('tabId' in value)) throw new Error(`navigate.${value.action} requires tabId`);
    return { action: value.action, tabId: readPositiveInteger(value.tabId, 'tabId') };
  }
  return { action: value.action };
}

function requireTabId(tab: BrowserTab) {
  if (!Number.isInteger(tab.id) || Number(tab.id) <= 0) throw new Error('Chrome tab id is missing');
  return Number(tab.id);
}

function assertOperableTab<T extends BrowserTab>(tab: T) {
  if (isOperableTab(tab)) return tab;
  throw new Error(`Tab is not operable: ${effectiveTabUrl(tab) || requireTabId(tab)}`);
}

function toNavigateTab(tab: BrowserTab): NavigateTab {
  return {
    id: requireTabId(tab),
    active: Boolean(tab.active),
    index: Number.isInteger(tab.index) ? Number(tab.index) : 0,
    status: tab.status,
    title: tab.title,
    url: effectiveTabUrl(tab),
    ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
    windowId: tab.windowId,
  };
}

function isNavigateAction(value: unknown): value is NavigateAction {
  return (
    value === 'open' ||
    value === 'back' ||
    value === 'forward' ||
    value === 'reload' ||
    value === 'listTabs' ||
    value === 'switchTab' ||
    value === 'closeTab' ||
    value === 'currentTab'
  );
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function readTarget(value: unknown) {
  if (value === 'current' || value === 'new') return value;
  throw new Error(`Invalid navigate target: ${String(value)}`);
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled navigate action: ${String(value)}`);
}
