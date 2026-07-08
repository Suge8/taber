import { effectiveTabUrl, isOperableTab } from './active-tab.ts';

export const navigateRequestType = 'taber.navigate.request';
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
export const MAX_NAVIGATION_TIMEOUT_MS = 60_000;

export type NavigateAction =
  | 'open'
  | 'back'
  | 'forward'
  | 'reload'
  | 'listTabs'
  | 'switchTab'
  | 'closeTab'
  | 'currentTab';

export type NavigateInput = {
  action: NavigateAction;
  url?: string;
  target?: 'current' | 'new';
  tabId?: number;
  active?: boolean;
  timeoutMs?: number;
};

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
  navigation?: { status: 'completed'; url?: string };
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
    url: { type: 'string', description: 'URL to open. Required for action=open.' },
    target: { type: 'string', enum: ['current', 'new'], description: 'Open in current tab or new tab.' },
    tabId: { type: 'integer', minimum: 1, description: 'Tab id. Required for switchTab and closeTab.' },
    active: { type: 'boolean', description: 'Whether a newly opened tab should become active. Defaults to true.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_NAVIGATION_TIMEOUT_MS },
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
}) {
  const scheduler = options.scheduler ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId as ReturnType<typeof globalThis.setTimeout>),
  };

  async function navigate(inputValue: unknown): Promise<NavigateResult> {
    const input = parseNavigateInput(inputValue);

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
        const tabId = requireInputTabId(input);
        assertOperableTab(await options.tabs.get(tabId));
        const tab = await options.tabs.update(tabId, { active: true });
        return { action: input.action, tab: toNavigateTab(assertOperableTab(tab)) };
      }
      case 'closeTab': {
        const tabId = lockedInputTabId(input);
        await options.tabs.remove(tabId);
        return { action: input.action, tabId };
      }
      case 'currentTab':
        return { action: input.action, tab: toNavigateTab(await currentTab()) };
      default:
        return assertNever(input.action);
    }
  }

  async function openTab(input: NavigateInput): Promise<NavigateResult> {
    const url = requireUrl(input);
    if ((input.target ?? 'current') === 'new') {
      if (input.tabId !== undefined) assertUnlockedInputTab(input, input.tabId);
      const tab = await options.tabs.create({ url, active: input.active ?? true, ...await lockedTargetWindow() });
      const navigation = await waitForTabNavigation(requireTabId(tab), timeoutMs(input), true);
      return { action: input.action, navigation, tab: toNavigateTab(assertOperableTab(await options.tabs.get(requireTabId(tab)))) };
    }

    const tabId = await currentTabId(input);
    const waiter = waitForTabNavigation(tabId, timeoutMs(input));
    try {
      await options.tabs.update(tabId, { active: true, url });
      return { action: input.action, navigation: await waiter, tab: toNavigateTab(assertOperableTab(await options.tabs.get(tabId))) };
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async function moveInHistory(input: NavigateInput, direction: 'back' | 'forward'): Promise<NavigateResult> {
    const tabId = await currentTabId(input);
    const waiter = waitForTabNavigation(tabId, timeoutMs(input));
    try {
      await options.tabs.update(tabId, { active: true });
      if (direction === 'back') await options.tabs.goBack(tabId);
      else await options.tabs.goForward(tabId);
      return { action: input.action, navigation: await waiter, tab: toNavigateTab(assertOperableTab(await options.tabs.get(tabId))) };
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async function reloadTab(input: NavigateInput): Promise<NavigateResult> {
    const tabId = await currentTabId(input);
    const waiter = waitForTabNavigation(tabId, timeoutMs(input));
    try {
      await options.tabs.update(tabId, { active: true });
      await options.tabs.reload(tabId);
      return { action: input.action, navigation: await waiter, tab: toNavigateTab(assertOperableTab(await options.tabs.get(tabId))) };
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
    let tab: BrowserTab;
    try {
      tab = await options.tabs.get(options.currentTabId as number);
    } catch {
      throw new Error(`Target tab is no longer available: ${options.currentTabId}`);
    }
    if (!isOperableTab(tab)) throw new Error(`Target tab is not operable: ${effectiveTabUrl(tab) || requireTabId(tab)}`);
    return tab;
  }

  async function currentTabId(input: NavigateInput) {
    const tabId = input.tabId ?? requireTabId(await currentTab());
    assertUnlockedInputTab(input, tabId);
    return tabId;
  }

  async function lockedTargetWindow() {
    if (options.currentTabId === undefined) return {};
    const windowId = (await currentTab()).windowId;
    if (!Number.isInteger(windowId) || Number(windowId) <= 0) throw new Error(`Target tab window id is missing: ${options.currentTabId}`);
    return { windowId: Number(windowId) };
  }

  function lockedInputTabId(input: NavigateInput) {
    const tabId = requireInputTabId(input);
    assertUnlockedInputTab(input, tabId);
    return tabId;
  }

  function assertUnlockedInputTab(input: NavigateInput, tabId: number) {
    if (options.currentTabId === undefined || tabId === options.currentTabId) return;
    throw new Error(`navigate.${input.action} is locked to target tab ${options.currentTabId}; received tabId ${tabId}. Use navigate.switchTab to change the task target.`);
  }

  function waitForTabNavigation(tabId: number, timeoutMs: number, checkExisting = false) {
    let settled = false;
    let timeoutId: unknown;
    let cleanup = () => undefined;

    const promise = new Promise<{ status: 'completed'; url?: string }>((resolve, reject) => {
      const complete = (url?: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ status: 'completed', url });
      };
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
        if (details.tabId === tabId && details.frameId === 0) {
          fail(new Error(details.error ?? `Navigation failed for tab ${tabId}`));
        }
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
      timeoutId = scheduler.setTimeout(() => {
        fail(new Error(`Navigation timed out after ${timeoutMs}ms for tab ${tabId}`));
      }, timeoutMs);

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

  const input: NavigateInput = { action: value.action };
  if ('url' in value) input.url = readString(value.url, 'url');
  if ('target' in value) input.target = readTarget(value.target);
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  if ('active' in value) input.active = readBoolean(value.active, 'active');
  if ('timeoutMs' in value) input.timeoutMs = readPositiveInteger(value.timeoutMs, 'timeoutMs');

  if (input.timeoutMs && input.timeoutMs > MAX_NAVIGATION_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be <= ${MAX_NAVIGATION_TIMEOUT_MS}`);
  }
  if (input.action === 'open') requireUrl(input);
  if (input.action === 'switchTab' || input.action === 'closeTab') requireInputTabId(input);

  return input;
}

function requireUrl(input: NavigateInput) {
  if (!input.url?.trim()) throw new Error('navigate.open requires url');
  return input.url.trim();
}

function requireInputTabId(input: NavigateInput) {
  if (!input.tabId) throw new Error(`navigate.${input.action} requires tabId`);
  return input.tabId;
}

function requireTabId(tab: BrowserTab) {
  if (!Number.isInteger(tab.id) || Number(tab.id) <= 0) throw new Error('Chrome tab id is missing');
  return Number(tab.id);
}

function timeoutMs(input: NavigateInput) {
  return input.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
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

function readBoolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled navigate action: ${String(value)}`);
}
