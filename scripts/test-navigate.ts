import assert from 'node:assert/strict';
import { createNavigateController, DEFAULT_NAVIGATION_TIMEOUT_MS, parseNavigateInput } from '../lib/navigate.ts';

type Tab = {
  id: number;
  active: boolean;
  index: number;
  status?: string;
  title?: string;
  url?: string;
  windowId?: number;
};

function testParsesRequiredInputs() {
  assert.deepEqual(parseNavigateInput({ action: 'open', url: ' https://example.com ' }), {
    action: 'open',
    url: ' https://example.com ',
  });
  assert.throws(() => parseNavigateInput({ action: 'open' }), /navigate.open requires url/);
  assert.throws(() => parseNavigateInput({ action: 'switchTab' }), /navigate.switchTab requires tabId/);
}

async function testOpensCurrentTabAfterNavigationEvent() {
  const browser = createFakeBrowser();
  const controller = createNavigateController(browser);

  const pending = controller.navigate({ action: 'open', url: 'https://example.com' });
  await flushMicrotasks();

  assert.deepEqual(browser.tabs.updates[0], { tabId: 1, properties: { active: true, url: 'https://example.com' } });
  assert.equal(browser.webNavigation.onCompleted.size, 1);

  browser.webNavigation.onCompleted.emit({ tabId: 1, frameId: 0, url: 'https://example.com' });
  assert.deepEqual(await pending, {
    action: 'open',
    navigation: { status: 'completed', url: 'https://example.com' },
    tab: { id: 1, active: true, index: 0, status: 'loading', title: 'First', url: 'https://example.com', windowId: 1 },
  });
  assert.equal(browser.webNavigation.onCompleted.size, 0);
}

async function testOpensNewTabAfterNavigationEvent() {
  const browser = createFakeBrowser();
  const controller = createNavigateController(browser);

  const pending = controller.navigate({ action: 'open', target: 'new', url: 'https://new.example', active: false });
  await flushMicrotasks();

  assert.deepEqual(browser.tabs.creates[0], { url: 'https://new.example', active: false });
  browser.webNavigation.onCompleted.emit({ tabId: 2, frameId: 0, url: 'https://new.example' });

  const result = await pending;
  assert.equal(result.tab?.id, 2);
  assert.equal(result.tab?.active, false);
  assert.equal(result.tab?.url, 'https://new.example');
}

async function testListsAndSwitchesTabs() {
  const browser = createFakeBrowser();
  const controller = createNavigateController(browser);
  browser.tabs.tabs.push({ id: 99, active: false, index: 1, status: 'complete', title: 'Settings', url: 'chrome://settings', windowId: 1 });

  assert.deepEqual(await controller.navigate({ action: 'listTabs' }), {
    action: 'listTabs',
    tabs: [
      { id: 1, active: true, index: 0, status: 'complete', title: 'First', url: 'https://first.example', windowId: 1 },
    ],
  });

  browser.tabs.tabs.push({ id: 2, active: false, index: 2, status: 'complete', title: 'Second', url: 'https://second.example', windowId: 1 });
  const switched = await controller.navigate({ action: 'switchTab', tabId: 2 });
  assert.equal(switched.tab?.id, 2);
  assert.equal(switched.tab?.active, true);
  assert.equal(browser.tabs.tabs[0].active, false);
}

async function testCurrentTabRejectsUnsupportedActiveTab() {
  const browser = createFakeBrowser();
  browser.tabs.tabs[0].url = 'chrome://settings';
  const controller = createNavigateController(browser);

  await assert.rejects(controller.navigate({ action: 'currentTab' }), /http\/https active tab/);
}

async function testTargetTabOverridesActiveTab() {
  const browser = createFakeBrowser();
  browser.tabs.tabs.push({ id: 2, active: false, index: 1, status: 'complete', title: 'Second', url: 'https://second.example', windowId: 11 });
  const controller = createNavigateController({ ...browser, currentTabId: 2 });

  const current = await controller.navigate({ action: 'currentTab' });
  assert.equal(current.tab?.id, 2);

  const pending = controller.navigate({ action: 'open', url: 'https://target.example' });
  await flushMicrotasks();
  assert.deepEqual(browser.tabs.updates[0], { tabId: 2, properties: { active: true, url: 'https://target.example' } });
  browser.webNavigation.onCompleted.emit({ tabId: 2, frameId: 0, url: 'https://target.example' });
  assert.equal((await pending).tab?.id, 2);

  await assert.rejects(controller.navigate({ action: 'reload', tabId: 1 }), /locked to target tab 2/);
  await assert.rejects(controller.navigate({ action: 'open', target: 'new', url: 'https://new.example', tabId: 1 }), /locked to target tab 2/);

  const newTab = controller.navigate({ action: 'open', target: 'new', url: 'https://new.example' });
  await flushMicrotasks();
  assert.deepEqual(browser.tabs.creates[0], { url: 'https://new.example', active: true, windowId: 11 });
  browser.webNavigation.onCompleted.emit({ tabId: 3, frameId: 0, url: 'https://new.example' });
  const result = await newTab;
  assert.equal(result.tab?.id, 3);
  assert.equal(result.tab?.windowId, 11);
}

async function testSwitchTabFailsWhenLockedTargetUnavailable() {
  const closedBrowser = createFakeBrowser();
  closedBrowser.tabs.tabs = [{ id: 8, active: false, index: 1, status: 'complete', title: 'Next', url: 'https://next.example', windowId: 11 }];
  const closedController = createNavigateController({ ...closedBrowser, currentTabId: 7 });
  await assert.rejects(closedController.navigate({ action: 'switchTab', tabId: 8 }), /Target tab is no longer available: 7/);
  assert.deepEqual(closedBrowser.tabs.updates, []);

  const inoperableBrowser = createFakeBrowser();
  inoperableBrowser.tabs.tabs = [
    { id: 7, active: true, index: 0, status: 'complete', title: 'Settings', url: 'chrome://settings', windowId: 11 },
    { id: 8, active: false, index: 1, status: 'complete', title: 'Next', url: 'https://next.example', windowId: 11 },
  ];
  const inoperableController = createNavigateController({ ...inoperableBrowser, currentTabId: 7 });
  await assert.rejects(inoperableController.navigate({ action: 'switchTab', tabId: 8 }), /Target tab is not operable: chrome:\/\/settings/);
  assert.deepEqual(inoperableBrowser.tabs.updates, []);
}

async function testHistoryCurrentAndCloseActions() {
  const browser = createFakeBrowser();
  const controller = createNavigateController(browser);

  const current = await controller.navigate({ action: 'currentTab' });
  assert.equal(current.tab?.id, 1);

  const back = controller.navigate({ action: 'back' });
  await flushMicrotasks();
  assert.deepEqual(browser.tabs.backCalls, [1]);
  browser.tabs.onUpdated.emit(1, { status: 'complete' }, { ...browser.tabs.tabs[0], status: 'complete' });
  assert.equal((await back).action, 'back');

  const forward = controller.navigate({ action: 'forward', tabId: 1 });
  await flushMicrotasks();
  assert.deepEqual(browser.tabs.forwardCalls, [1]);
  browser.webNavigation.onCompleted.emit({ tabId: 1, frameId: 0, url: 'https://first.example' });
  assert.equal((await forward).action, 'forward');

  assert.deepEqual(await controller.navigate({ action: 'closeTab', tabId: 1 }), { action: 'closeTab', tabId: 1 });
  assert.equal(browser.tabs.tabs.length, 0);
}

async function testNavigationTimeoutUsesEventWaiter() {
  const browser = createFakeBrowser();
  const controller = createNavigateController(browser);

  const pending = controller.navigate({ action: 'reload', timeoutMs: 100 });
  await flushMicrotasks();

  assert.equal(browser.scheduler.delayMs, 100);
  assert.equal(browser.tabs.reloads[0], 1);
  browser.scheduler.fire();
  await assert.rejects(pending, /Navigation timed out after 100ms for tab 1/);
  assert.equal(browser.webNavigation.onCompleted.size, 0);
}

function createFakeBrowser() {
  const scheduler = createScheduler();
  const tabs = createTabsApi();
  const webNavigation = {
    onCompleted: new FakeEvent<(details: { tabId: number; frameId: number; url?: string }) => void>(),
    onErrorOccurred: new FakeEvent<(details: { tabId: number; frameId: number; url?: string; error?: string }) => void>(),
  };
  return { tabs, webNavigation, scheduler };
}

function createTabsApi() {
  const api = {
    tabs: [{ id: 1, active: true, index: 0, status: 'complete', title: 'First', url: 'https://first.example', windowId: 1 }] as Tab[],
    creates: [] as unknown[],
    updates: [] as unknown[],
    reloads: [] as number[],
    backCalls: [] as number[],
    forwardCalls: [] as number[],
    onUpdated: new FakeEvent<(tabId: number, changeInfo: { status?: string }, tab: Tab) => void>(),
    onRemoved: new FakeEvent<(tabId: number) => void>(),
    async query(query: Record<string, unknown>) {
      if (query.active && query.currentWindow) return this.tabs.filter((tab) => tab.active);
      return [...this.tabs];
    },
    async get(tabId: number) {
      return requireTab(this.tabs, tabId);
    },
    async create(properties: { url?: string; active?: boolean; windowId?: number }) {
      this.creates.push({ ...properties });
      const tab = {
        id: this.tabs.length + 1,
        active: Boolean(properties.active),
        index: this.tabs.length,
        status: 'loading',
        url: properties.url,
        windowId: properties.windowId ?? 1,
      };
      if (tab.active) this.tabs.forEach((existingTab) => (existingTab.active = false));
      this.tabs.push(tab);
      return tab;
    },
    async update(tabId: number, properties: { active?: boolean; url?: string }) {
      this.updates.push({ tabId, properties: { ...properties } });
      const tab = requireTab(this.tabs, tabId);
      if (properties.active) this.tabs.forEach((existingTab) => (existingTab.active = existingTab.id === tabId));
      if (properties.url) {
        tab.url = properties.url;
        tab.status = 'loading';
      }
      return { ...tab };
    },
    async remove(tabId: number) {
      this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
      this.onRemoved.emit(tabId);
    },
    async reload(tabId?: number) {
      this.reloads.push(tabId ?? 0);
    },
    async goBack(tabId?: number) {
      this.backCalls.push(tabId ?? 0);
    },
    async goForward(tabId?: number) {
      this.forwardCalls.push(tabId ?? 0);
    },
  };
  return api;
}

function requireTab(tabs: Tab[], tabId: number) {
  const tab = tabs.find((nextTab) => nextTab.id === tabId);
  if (!tab) throw new Error(`Missing tab: ${tabId}`);
  return tab;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createScheduler() {
  let callback: () => void = () => undefined;
  return {
    delayMs: 0,
    setTimeout(nextCallback: () => void, delayMs: number) {
      callback = nextCallback;
      this.delayMs = delayMs;
      return 1;
    },
    clearTimeout() {
      callback = () => undefined;
    },
    fire() {
      callback();
    },
  };
}

class FakeEvent<Listener extends (...args: never[]) => void> {
  listeners = new Set<Listener>();

  get size() {
    return this.listeners.size;
  }

  addListener(listener: Listener) {
    this.listeners.add(listener);
  }

  removeListener(listener: Listener) {
    this.listeners.delete(listener);
  }

  emit(...args: Parameters<Listener>) {
    for (const listener of this.listeners) listener(...args);
  }
}

assert.equal(DEFAULT_NAVIGATION_TIMEOUT_MS, 15_000);

await testParsesRequiredInputs();
await testOpensCurrentTabAfterNavigationEvent();
await testOpensNewTabAfterNavigationEvent();
await testListsAndSwitchesTabs();
await testCurrentTabRejectsUnsupportedActiveTab();
await testTargetTabOverridesActiveTab();
await testSwitchTabFailsWhenLockedTargetUnavailable();
await testHistoryCurrentAndCloseActions();
await testNavigationTimeoutUsesEventWaiter();

console.info('navigate tests passed');
