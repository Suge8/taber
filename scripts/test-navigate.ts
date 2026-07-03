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

  assert.deepEqual(await controller.navigate({ action: 'listTabs' }), {
    action: 'listTabs',
    tabs: [
      { id: 1, active: true, index: 0, status: 'complete', title: 'First', url: 'https://first.example', windowId: 1 },
    ],
  });

  browser.tabs.tabs.push({ id: 2, active: false, index: 1, status: 'complete', title: 'Second', url: 'https://second.example', windowId: 1 });
  const switched = await controller.navigate({ action: 'switchTab', tabId: 2 });
  assert.equal(switched.tab?.id, 2);
  assert.equal(switched.tab?.active, true);
  assert.equal(browser.tabs.tabs[0].active, false);
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
    async create(properties: { url?: string; active?: boolean }) {
      this.creates.push({ ...properties });
      const tab = {
        id: this.tabs.length + 1,
        active: Boolean(properties.active),
        index: this.tabs.length,
        status: 'loading',
        url: properties.url,
        windowId: 1,
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
await testHistoryCurrentAndCloseActions();
await testNavigationTimeoutUsesEventWaiter();

console.info('navigate tests passed');
