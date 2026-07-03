import { browser } from 'wxt/browser';
import { selectOperableActiveTab } from '../lib/active-tab';
import { createAgentHostController } from '../lib/agent-host-controller';
import { createChromeApiBroker, isTrustedChromeApiSender } from '../lib/chrome-api-broker';
import { createDebuggerController, debuggerRequestType } from '../lib/debugger-tool';
import { extractImageFromPage, parseExtractImageInput, type ExtractImageInput } from '../lib/extract-image';
import { extractDocumentFromPage, parseGetDocumentInput } from '../lib/get-document';
import { createNavigateController, navigateRequestType } from '../lib/navigate';
import { createOffscreenLifecycle } from '../lib/offscreen-lifecycle';
import { runBrowserReplPageRuntime } from '../lib/browser-repl-page';
import { DEBUGGER_ENABLED } from '../lib/runtime-flags';
import type { BrowserReplPageCommand } from '../lib/browser-repl';

const offscreenLifecycle = createOffscreenLifecycle(browser.offscreen);
const chromeApiBroker = createChromeApiBroker({
  ...(browser as unknown as Record<string, unknown>),
  userScripts: { execute: executeUserScript },
  debugger: DEBUGGER_ENABLED ? browser.debugger : disabledDebuggerApi(),
} as never);

const debuggerController = DEBUGGER_ENABLED ? createDebuggerController({
  debuggerApi: browser.debugger as never,
  getCurrentTabId,
}) : undefined;
const agentHost = createAgentHostController({
  lifecycle: offscreenLifecycle,
  sendToHost: (message) => browser.runtime.sendMessage(message),
});
const sidepanelPath = 'sidepanel.html';
const toggleSidePanelCommand = 'toggle-side-panel';
const sidepanelPorts = new Map<unknown, number | undefined>();
const scriptingFallbacks = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeoutId: ReturnType<typeof setTimeout> }>();
const cancelledPageCommands = new Map<string, ReturnType<typeof setTimeout>>();
let userScriptsCanReturnResult: boolean | undefined;

function disabledDebuggerApi() {
  const fail = () => Promise.reject(new Error('debugger is only available in the Taber debug build'));
  return { attach: fail, detach: fail, sendCommand: fail };
}

export default defineBackground({
  main() {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    void browser.sidePanel.setOptions({ path: sidepanelPath, enabled: true });

    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== 'taber.sidepanel') return;
      sidepanelPorts.set(port, undefined);
      port.onMessage.addListener((message) => {
        if (isRecord(message) && message.type === 'taber.sidepanel.window' && Number.isInteger(message.windowId)) sidepanelPorts.set(port, Number(message.windowId));
      });
      port.onDisconnect.addListener(() => sidepanelPorts.delete(port));
    });

    browser.commands.onCommand.addListener((command, tab) => {
      if (command === toggleSidePanelCommand) void toggleSidePanel(tab?.windowId);
    });

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const response = handleTaberMessage(message, sender);
      if (!response) return false;

      void response.then(sendResponse, (error) => {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      });

      return true;
    });
  },
});

function handleTaberMessage(message: unknown, sender?: { id?: string; url?: string; origin?: string }) {
  if (!isRecord(message) || typeof message.type !== 'string') return undefined;
  if (isPrivilegedMessageType(message.type) && !isTrustedChromeApiSender(sender, browser.runtime.id)) {
    const error = message.type === 'taber.chromeApi.request' ? 'Chrome API broker is only available to extension pages' : 'Privileged Taber messages are only available to extension pages';
    return Promise.reject(new Error(error));
  }

  if (message.type === 'taber.scripting.result') return Promise.resolve(handleScriptingFallbackResult(message));
  if (message.type === 'taber.browserRepl.isPageCommandCancelled') return Promise.resolve(typeof message.cancelKey === 'string' && cancelledPageCommands.has(message.cancelKey));
  if (message.type === 'taber.browserRepl.cancelPageCommand') return cancelBrowserReplPageCommand(message);
  if (message.type === 'taber.browserRepl.scriptingCommand') return executeBrowserReplScriptingCommand(message);
  if (message.type === 'taber.chromeApi.request') return chromeApiBroker(message);
  if (message.type === 'taber.getDocument.extractPage') return extractPageDocument(message);
  if (message.type === 'taber.extractImage.captureVisibleTab') return captureVisibleTab(message);
  if (message.type === 'taber.extractImage.extractPage') return extractPageImage(message);
  if (message.type === debuggerRequestType) return debug(message);
  if (message.type === navigateRequestType) return navigate(message);
  if (message.type === 'taber.offscreen.ensure') return offscreenLifecycle.ensureDocument();
  if (message.type === 'taber.offscreen.close') return agentHost.closeNow();
  if (message.type === 'taber.offscreen.hasDocument') return offscreenLifecycle.hasDocument();
  if (message.type === 'taber.background.agentActive') return Promise.resolve(agentHost.markActive());
  if (message.type === 'taber.background.agentIdle') return Promise.resolve(agentHost.markIdle());
  if (message.type === 'taber.background.closeIdleHost') return agentHost.closeNow();
  if (message.type === 'taber.background.openShortcutSettings') return browser.windows.create({ url: 'chrome://extensions/shortcuts', type: 'popup', width: 980, height: 760 });
  if (message.type === 'taber.background.currentTab') return currentTab(readWindowId(message.windowId));
  if (message.type === 'taber.background.startTask') return startTask(message);
  if (message.type === 'taber.background.stopTask') return agentHost.stopTask();

  return undefined;
}

async function getCurrentTabId() {
  return requireTabId(await currentTab());
}

async function currentTab(windowId?: number) {
  const tabs = await queryActiveTabs(windowId);
  const tab = selectOperableActiveTab(tabs);
  if (!tab) throw new Error('No operable active tab in the side panel window');
  return tab;
}

async function queryTabs(query: Record<string, unknown>, windowId?: number) {
  if (query.active === true && query.currentWindow === true && query.windowId === undefined) return queryActiveTabs(windowId);
  return browser.tabs.query(query);
}

async function queryActiveTabs(windowId?: number) {
  const targetWindowId = windowId ?? latestSidepanelWindowId();
  if (targetWindowId !== undefined) return browser.tabs.query({ active: true, windowId: targetWindowId });
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ['normal'] });
  return windows.flatMap((window) => window.tabs ?? []).filter((tab) => tab.active);
}

function latestSidepanelWindowId() {
  return [...sidepanelPorts.values()].findLast((windowId) => windowId !== undefined);
}

function requireTabId(tab: { id?: number }) {
  if (!tab.id) throw new Error('No operable active tab in the side panel window');
  return tab.id;
}

async function toggleSidePanel(windowId?: number) {
  const targetWindowId = windowId ?? (await browser.windows.getCurrent()).id;
  if (targetWindowId && hasSidePanelInWindow(targetWindowId)) {
    await closeSidePanel(targetWindowId);
    return;
  }
  if (!targetWindowId) throw new Error('No current window for side panel');
  await browser.sidePanel.open({ windowId: targetWindowId });
}

async function closeSidePanel(windowId?: number) {
  const targetWindowId = windowId ?? (await browser.windows.getCurrent()).id;
  const sidePanelApi = browser.sidePanel as typeof browser.sidePanel & { close?: (options: { windowId: number }) => Promise<void> };
  if (targetWindowId && sidePanelApi.close) {
    await sidePanelApi.close({ windowId: targetWindowId }).catch(() => sendCloseSidePanelMessage(targetWindowId));
    return;
  }
  await sendCloseSidePanelMessage(targetWindowId);
}

async function sendCloseSidePanelMessage(windowId?: number) {
  for (const [port, sidepanelWindowId] of sidepanelPorts) {
    if (windowId === undefined || sidepanelWindowId === windowId) (port as { postMessage(message: unknown): void }).postMessage({ type: 'taber.sidepanel.close' });
  }
}

function hasSidePanelInWindow(windowId: number) {
  return [...sidepanelPorts.values()].includes(windowId);
}

async function debug(message: Record<string, unknown>) {
  if (!debuggerController) throw new Error('debugger is only available in the Taber debug build');
  const input = isRecord(message.input) ? message.input : {};
  if (Number.isInteger(input.tabId) && Number(input.tabId) > 0) return debuggerController.run(input);
  const tab = await currentTab(readWindowId(message.windowId));
  return debuggerController.run({ ...input, tabId: tab.id });
}

function navigate(message: Record<string, unknown>) {
  return createNavigateController({
    tabs: {
      query: (query: Record<string, unknown>) => queryTabs(query, readWindowId(message.windowId)),
      get: (tabId: number) => browser.tabs.get(tabId),
      create: (properties: Record<string, unknown>) => browser.tabs.create(properties),
      update: (tabId: number, properties: Record<string, unknown>) => browser.tabs.update(tabId, properties),
      remove: (tabId: number) => browser.tabs.remove(tabId),
      reload: (tabId?: number) => (tabId === undefined ? browser.tabs.reload() : browser.tabs.reload(tabId)),
      goBack: (tabId?: number) => (tabId === undefined ? browser.tabs.goBack() : browser.tabs.goBack(tabId)),
      goForward: (tabId?: number) => (tabId === undefined ? browser.tabs.goForward() : browser.tabs.goForward(tabId)),
      onUpdated: browser.tabs.onUpdated,
      onRemoved: browser.tabs.onRemoved,
    } as never,
    webNavigation: browser.webNavigation as never,
  }).navigate(message.input);
}

function readWindowId(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function extractPageDocument(message: Record<string, unknown>) {
  if (!Number.isInteger(message.tabId) || Number(message.tabId) <= 0) throw new Error('taber.getDocument.extractPage requires tabId');
  const input = parseGetDocumentInput(isRecord(message.input) ? message.input : {});
  if (input.source !== 'currentPage') throw new Error('taber.getDocument.extractPage requires source=currentPage');
  return browser.scripting.executeScript({
    target: { tabId: Number(message.tabId) },
    func: extractDocumentFromPage,
    args: [input],
  }).then((result) => result[0]?.result);
}

function captureVisibleTab(message: Record<string, unknown>) {
  const input = parseExtractImageInput(isRecord(message.input) ? message.input : {});
  if (input.source !== 'viewport') throw new Error('taber.extractImage.captureVisibleTab only supports source=viewport');
  return currentTab(readWindowId(message.windowId)).then((tab) => browser.tabs.captureVisibleTab(tab.windowId, captureVisibleTabDetails(input)));
}

function captureVisibleTabDetails(input: Extract<ExtractImageInput, { source: 'viewport' }>) {
  if (input.format === 'jpeg') return { format: 'jpeg' as const, ...(input.jpegQuality === undefined ? {} : { quality: input.jpegQuality }) };
  return { format: 'png' as const };
}

function extractPageImage(message: Record<string, unknown>) {
  if (!Number.isInteger(message.tabId) || Number(message.tabId) <= 0) throw new Error('taber.extractImage.extractPage requires tabId');
  const input = parseExtractImageInput(isRecord(message.input) ? message.input : {});
  if (input.source === 'viewport') throw new Error('taber.extractImage.extractPage does not support viewport; use captureVisibleTab');
  return browser.scripting.executeScript({
    target: { tabId: Number(message.tabId) },
    func: extractImageFromPage,
    args: [input],
  }).then((result) => result[0]?.result);
}

function startTask(message: Record<string, unknown>) {
  if (typeof message.prompt !== 'string') throw new Error('Task prompt is required');
  return agentHost.startTask({ prompt: message.prompt, sessionId: readSessionId(message.sessionId), windowId: readWindowId(message.windowId) });
}

function isPrivilegedMessageType(type: string) {
  return [
    'taber.chromeApi.request',
    'taber.browserRepl.cancelPageCommand',
    'taber.browserRepl.scriptingCommand',
    'taber.getDocument.extractPage',
    'taber.extractImage.captureVisibleTab',
    'taber.extractImage.extractPage',
    debuggerRequestType,
    navigateRequestType,
    'taber.offscreen.ensure',
    'taber.offscreen.close',
    'taber.offscreen.hasDocument',
    'taber.background.agentActive',
    'taber.background.agentIdle',
    'taber.background.closeIdleHost',
    'taber.background.openShortcutSettings',
    'taber.background.currentTab',
    'taber.background.startTask',
    'taber.background.stopTask',
  ].includes(type);
}

function readSessionId(value: unknown) {
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`Invalid session id: ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function executeUserScript(injection: { target: unknown; js?: { code?: string }[]; taberTimeoutMs?: number }) {
  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: {
      userScripts?: { execute(...args: unknown[]): Promise<unknown> };
      scripting?: { executeScript(details: unknown): Promise<unknown> };
    };
  }).chrome;
  const { taberTimeoutMs, ...chromeInjection } = injection;
  if (chromeApi?.userScripts?.execute && userScriptsCanReturnResult !== false) {
    const result = await withUserScriptTimeout(chromeApi.userScripts.execute(chromeInjection), taberTimeoutMs);
    if (hasInjectionResult(result)) {
      userScriptsCanReturnResult = true;
      return result;
    }
    userScriptsCanReturnResult = false;
  }

  throw new Error('chrome.userScripts API did not return a result');
}

function withUserScriptTimeout(promise: Promise<unknown>, timeoutMs?: number) {
  const duration = readScriptingTimeout(timeoutMs);
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error('chrome.userScripts API timed out; enable Allow User Scripts for Taber and retry')), duration);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function executeBrowserReplScriptingCommand(message: Record<string, unknown>) {
  if (!Number.isInteger(message.tabId) || Number(message.tabId) <= 0) throw new Error('taber.browserRepl.scriptingCommand requires tabId');
  const chromeApi = (globalThis as typeof globalThis & { chrome?: { scripting?: { executeScript(details: unknown): Promise<unknown> } } }).chrome;
  if (!chromeApi?.scripting?.executeScript) throw new Error('chrome.scripting API is unavailable');

  const command = (isRecord(message.command) ? message.command : {}) as BrowserReplPageCommand;
  const requestId = typeof command.cancelKey === 'string' ? command.cancelKey : crypto.randomUUID();
  const timeoutMs = readScriptingTimeout(command.timeoutMs);
  const promise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      scriptingFallbacks.delete(requestId);
      reject(new Error('scripting fallback timed out'));
    }, timeoutMs);
    scriptingFallbacks.set(requestId, { resolve, reject, timeoutId });
  });

  const executeScript = chromeApi.scripting.executeScript({
    target: { tabId: Number(message.tabId) },
    world: 'ISOLATED',
    func: runBrowserReplPageRuntime,
    args: [command, requestId],
  }).catch((error) => {
    clearScriptingFallback(requestId);
    throw error;
  });

  return executeScript.then(() => promise);
}

function clearScriptingFallback(requestId: string) {
  const pending = scriptingFallbacks.get(requestId);
  if (!pending) return undefined;
  scriptingFallbacks.delete(requestId);
  clearTimeout(pending.timeoutId);
  return pending;
}

function cancelBrowserReplPageCommand(message: Record<string, unknown>) {
  if (typeof message.cancelKey !== 'string') return Promise.resolve(false);
  rememberCancelledPageCommand(message.cancelKey);
  const pending = scriptingFallbacks.get(message.cancelKey);
  if (pending) {
    scriptingFallbacks.delete(message.cancelKey);
    clearTimeout(pending.timeoutId);
    pending.reject(new Error('Task aborted'));
  }
  if (!Number.isInteger(message.tabId) || Number(message.tabId) <= 0) return Promise.resolve(Boolean(pending));
  return browser.tabs.sendMessage(Number(message.tabId), { type: 'taber.browserRepl.cancelPageCommand', cancelKey: message.cancelKey }).then(
    () => true,
    () => Boolean(pending),
  );
}

function rememberCancelledPageCommand(cancelKey: string) {
  clearTimeout(cancelledPageCommands.get(cancelKey));
  cancelledPageCommands.set(cancelKey, setTimeout(() => cancelledPageCommands.delete(cancelKey), 120_000));
}

function readScriptingTimeout(value: unknown) {
  if (!Number.isInteger(value) || Number(value) <= 0) return 30_000;
  return Math.min(Number(value), 120_000);
}

function handleScriptingFallbackResult(message: Record<string, unknown>) {
  if (typeof message.requestId !== 'string') return false;
  const pending = scriptingFallbacks.get(message.requestId);
  if (!pending) return false;
  scriptingFallbacks.delete(message.requestId);
  clearTimeout(pending.timeoutId);
  if (message.ok) pending.resolve(message.value);
  else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'scripting fallback failed'));
  return true;
}

function hasInjectionResult(value: unknown) {
  return Array.isArray(value) && value.some((item) => isRecord(item) && item.result !== undefined && item.result !== null);
}
