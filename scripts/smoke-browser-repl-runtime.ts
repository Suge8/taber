import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { connectCdp, connectTarget, evaluateStable, fetchJson, hasCdpEndpoint, waitForTarget, type CdpClient } from './cdp-client.mjs';
import { prepareRuntimeBrowser } from './runtime-browser.mjs';
import { AGENT_INSTRUCTIONS_VERSION } from '../lib/agent-instructions.ts';
import { createBrowserReplUserScript } from '../lib/browser-repl-page.ts';
import type { BrowserReplPageCommand } from '../lib/browser-repl.ts';

const frameFixturePath = '/taber-browser-repl-frame';
const fixtureHtml = `<!doctype html><title>BrowserRepl Smoke</title>
  <main style="height: 900px">
    <h1>BrowserRepl Smoke</h1>
    <label>Name <input id="name"></label>
    <label>项目名称 <input id="project" name="project"></label>
    <input id="company" placeholder="公司名称">
    <div id="editor" aria-label="Editor" contenteditable></div>
    <label>Choice <select id="choice"><option value="a">A</option><option value="b">B</option></select></label>
    <button id="submit" onclick="document.querySelector('#status').textContent = 'submitted ' + document.querySelector('#name').value">Submit</button>
    <p id="status">idle</p>
    <iframe id="child-frame" src="https://chatgpt.com${frameFixturePath}"></iframe>
  </main>`;
const frameFixtureHtml = `<!doctype html><title>BrowserRepl Frame Smoke</title>
  <button id="frame-submit" onclick="document.body.dataset.clicked = 'frame'">Frame Submit</button>`;

let runtime: Awaited<ReturnType<typeof prepareRuntimeBrowser>> | undefined;
let browserCdp: CdpClient | undefined;
let pageTarget: { targetId: string } | undefined;
let extensionTarget: { targetId: string } | undefined;
let pageCdp: CdpClient | undefined;
let extensionCdp: CdpClient | undefined;

try {
  runtime = await prepareRuntimeBrowser({ required: true, allowLaunch: false });
  if (runtime.skipped) throw new Error(runtime.reason);

  const fixtureUrl = 'https://chatgpt.com/taber-browser-repl-smoke';
  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  await enableUserScripts(browserCdp, runtime.cdpOrigin, runtime.extensionId);
  pageTarget = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  pageCdp = await connectTarget(await waitForTarget(runtime.cdpOrigin, (target) => target.id === pageTarget?.targetId && hasCdpEndpoint(target)));
  await pageCdp.send('Runtime.enable');
  await loadFixturePage(pageCdp, fixtureUrl);
  extensionTarget = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${runtime.extensionId}/sidepanel.html` });
  extensionCdp = await connectTarget(await waitForTarget(runtime.cdpOrigin, (target) => target.id === extensionTarget?.targetId && hasCdpEndpoint(target)));
  await extensionCdp.send('Runtime.enable');
  await waitForExtensionRuntime(extensionCdp);
  assert.equal(await hasSiteAccess(extensionCdp, fixtureUrl), true, 'Runtime smoke fixture origin must stay covered by manifest host permissions');

  const tabId = await findTabId(extensionCdp, fixtureUrl);
  await assertSidepanelLocaleRuntime(extensionCdp, tabId, runtime.extensionId);
  const foregroundModeReport = await assertRuntimeTargetLock(browserCdp, runtime.cdpOrigin, extensionCdp, pageCdp, tabId);
  let observed = await runPageCommand(extensionCdp, tabId, { helper: 'observe', args: [] });
  assert.equal(observed.summary.title, 'BrowserRepl Smoke');
  assert.equal(typeof findElement(observed, 'input').ref.stableId, 'string');
  let editor = findElementByName(observed, 'Editor');
  let select = findElement(observed, 'select');
  let button = findElement(observed, 'button');
  const browserSnapshot = await runPageCommand(extensionCdp, tabId, { helper: 'browser', args: [{ action: 'snapshot' }] });
  const browserSubmitRef = findElementByName(browserSnapshot.state, 'Submit').ref;
  assertBrowserSnapshotShape(browserSnapshot.state);
  await assertScriptingCommandRoutesToFrame(extensionCdp, pageCdp, tabId);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'browser', args: [{ action: 'click', target: { ref: browserSubmitRef } }] })).ok, true);
  const reusedBrowserRef = await runPageCommand(extensionCdp, tabId, { helper: 'browser', args: [{ action: 'click', target: { ref: browserSubmitRef } }] });
  assert.equal(reusedBrowserRef.ok, true, 'unchanged browser refs must survive ordinary page mutations');

  const browserJsAvailable = await verifyBrowserJs(extensionCdp, pageCdp, tabId);
  assert.equal(browserJsAvailable, true, 'browserjs runtime verification did not run; enable Allow User Scripts for Taber and retry');
  assert.equal(await runSandboxIframe(extensionCdp), 3);

  const overlayIconUrl = await evaluateStable(extensionCdp, `chrome.runtime.getURL('icons/icon-24.png')`);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'controlOverlay', args: [{ action: 'show', message: 'Taber 正在控制此页', iconUrl: overlayIconUrl }] })).shown, true);
  assert.equal(await evaluateStable(pageCdp, `document.querySelector('#taber-page-control-overlay [data-taber-part="badge-text"]')?.textContent`), 'Taber 正在控制此页');
  assert.match(await waitForOverlayIcon(pageCdp), /^chrome-extension:\/\//);
  assert.match(await evaluateStable(pageCdp, `document.querySelector('#taber-page-control-overlay [data-taber-part="glow"]')?.getAttribute('style') || ''`), /linear-gradient\(to bottom/);
  assert.equal(await evaluateStable(pageCdp, `getComputedStyle(document.querySelector('#taber-page-control-overlay')).pointerEvents`), 'none');
  await installOverlayReloadRelay(extensionCdp, tabId);
  await reloadFixturePage(pageCdp);
  assert.equal(await waitForOverlay(pageCdp), 'Taber 正在控制此页');
  observed = await runPageCommand(extensionCdp, tabId, { helper: 'observe', args: [] });
  editor = findElementByName(observed, 'Editor');
  select = findElement(observed, 'select');
  button = findElement(observed, 'button');

  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'scroll', args: [{ y: 200 }] })).scrolled, true);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'fill', args: [select.ref, 'b'] })).filled, true);
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#choice").value'), 'b');
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'fill', args: [editor.ref, 'editable'] })).filled, true);
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#editor").textContent'), 'editable');
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'fill', args: ['input[name="project"]', 'selector project'] })).filled, true);
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#project").value'), 'selector project');
  assert.equal(await evaluateStable(pageCdp, `Boolean(document.querySelector('#taber-page-control-overlay [data-taber-part="target"]'))`), true);
  const form = await runPageCommand(extensionCdp, tabId, { helper: 'fillForm', args: [{ fields: { 项目名称: '语义项目', 公司名称: '语义公司' } }] });
  assert.equal(form.ok, true);
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#project").value'), '语义项目');
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#company").value'), '语义公司');
  const batch = await runPageCommand(extensionCdp, tabId, { helper: 'batch', args: [[
    { action: 'fill', selector: '#name', value: 'alpha' },
    { action: 'click', target: button.ref },
    { action: 'waitFor', text: 'submitted alpha', timeoutMs: 1000 },
  ]] });
  assert.equal(batch.ok, true);

  const pickPromise = runPageCommand(extensionCdp, tabId, { helper: 'pickUserElement', args: [{ message: 'Pick submit', timeoutMs: 2000 }] });
  await clickWhenPickerIsReady(pageCdp, '#submit');
  const picked = await pickPromise;
  assert.equal(picked.selector, '#submit');
  assert.equal(picked.attributes.id, 'submit');
  const cancelKey = `pick-cancel-${Date.now()}`;
  const cancelledPick = runScriptingCommand(extensionCdp, tabId, { helper: 'pickUserElement', args: [{ message: 'Cancel pick', timeoutMs: 5000 }], cancelKey, timeoutMs: 5000 }).then(
    () => ({ ok: true, error: '' }),
    (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  await waitForPickerPrompt(pageCdp);
  assert.equal(await runtimeMessage(extensionCdp, { type: 'taber.browserRepl.cancelPageCommand', tabId, cancelKey }), true);
  const cancelled = await cancelledPick;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.error, /Task aborted|cancelled/);
  await waitForPickerGone(pageCdp);
  assert.equal(await clickAfterCancelledPicker(pageCdp), 'clicked');
  await assertWaitForCancelsPromptly(extensionCdp, tabId);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'controlOverlay', args: [{ action: 'hide' }] })).hidden, true);
  await waitForOverlayGone(pageCdp);

  const timeoutResult = await runRawPageCommand(extensionCdp, tabId, { helper: 'waitFor', args: [{ text: 'never appears', timeoutMs: 20 }] });
  assert.equal(timeoutResult.ok, false);
  assert.match(String(timeoutResult.error), /waitFor timed out after 20ms/);

  console.info(JSON.stringify({ foregroundMode: foregroundModeReport }, null, 2));
  console.info('browser repl runtime smoke passed');
} finally {
  pageCdp?.close();
  extensionCdp?.close();
  if (browserCdp && pageTarget) await browserCdp.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => undefined);
  if (browserCdp && extensionTarget) await browserCdp.send('Target.closeTarget', { targetId: extensionTarget.targetId }).catch(() => undefined);
  browserCdp?.close();
  if (runtime && !runtime.skipped) await runtime.close();
}

async function verifyBrowserJs(extensionCdp: CdpClient, pageCdp: CdpClient, tabId: number) {
  try {
    assert.equal(await runBrowserJsUserScript(extensionCdp, tabId, `document.body.dataset.browserjsFetch = String(typeof fetch); return document.title`), 'BrowserRepl Smoke');
    const consoleResult = await runRawBrowserJsResult(extensionCdp, tabId, `console.info('runtime evidence', { title: document.title }); return document.title`);
    assert.equal(consoleResult.ok, true);
    assert.equal(consoleResult.value, 'BrowserRepl Smoke');
    assert.match(consoleResult.console?.[0]?.text ?? '', /runtime evidence/);
    const failureResult = await runRawBrowserJsResult(extensionCdp, tabId, `console.error('runtime failure evidence'); return document.body`);
    assert.equal(failureResult.ok, false);
    assert.match(failureResult.error, /return value must be serializable/);
    assert.match(failureResult.error, /runtime failure evidence/);
    const dataUrlResult = await runRawBrowserJsResult(extensionCdp, tabId, `return 'data:image/png;base64,AAA='`);
    assert.equal(dataUrlResult.ok, false);
    assert.match(dataUrlResult.error, /dataUrl\/base64 payloads cannot be returned/);
    await verifyBrowserJsRuntimeBoundary(extensionCdp, pageCdp, tabId);
    assert.equal(await evaluateStable(pageCdp, 'document.body.dataset.browserjsFetch'), 'function');
    return true;
  } catch (error) {
    assert.match(String(error), /Allow User Scripts|userScripts|did not return a result|timed out/i);
    return false;
  }
}

async function verifyBrowserJsRuntimeBoundary(extensionCdp: CdpClient, pageCdp: CdpClient, tabId: number) {
  const brokerAttack = await evaluateStable(extensionCdp, `chrome.scripting.executeScript({
    target: { tabId: ${tabId} },
    func: async () => chrome.runtime.sendMessage({ type: 'taber.chromeApi.request', action: 'tabs.query', args: [{}] })
  })`);
  assert.match(brokerAttack[0].result.error, /Chrome API broker is only available to extension pages/);

  const debuggerAttack = await evaluateStable(extensionCdp, `chrome.scripting.executeScript({
    target: { tabId: ${tabId} },
    func: async () => chrome.runtime.sendMessage({ type: 'taber.debugger.request', input: { action: 'failedRequests' } })
  })`);
  assert.match(debuggerAttack[0].result.error, /Privileged Taber messages are only available to extension pages/);

  const navigateAttack = await evaluateStable(extensionCdp, `chrome.scripting.executeScript({
    target: { tabId: ${tabId} },
    func: async () => chrome.runtime.sendMessage({ type: 'taber.navigate.request', input: { action: 'currentTab' } })
  })`);
  assert.match(navigateAttack[0].result.error, /Privileged Taber messages are only available to extension pages/);

  assert.equal(await runBrowserJsUserScript(extensionCdp, tabId, `window.addEventListener('message', () => {});
    window.postMessage('taber-window-method-ok', '*');
    globalThis.postMessage('taber-global-method-ok', '*');
    window.onmessage = () => {};
    window.onmessage = null;
    return [document.title, typeof chrome, typeof browser, typeof runtime, typeof extensionRuntime, typeof fetch].join(':');`), 'BrowserRepl Smoke:undefined:undefined:undefined:undefined:function');
  await evaluateStable(pageCdp, `new Promise((resolve) => setTimeout(resolve, 0))`);
}

async function enableUserScripts(browserCdp: CdpClient, cdpOrigin: string, extensionId: string) {
  let target: { targetId: string } | undefined;
  let cdp: CdpClient | undefined;
  try {
    target = await browserCdp.send('Target.createTarget', { url: `chrome://extensions/?id=${extensionId}` });
    cdp = await connectTarget(await waitForTarget(cdpOrigin, (nextTarget) => nextTarget.id === target?.targetId && hasCdpEndpoint(nextTarget)));
    await cdp.send('Runtime.enable');
    await evaluateStable(cdp, `new Promise((resolve, reject) => {
      chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(extensionId)}, userScriptsAccess: true }, () => {
        const error = chrome.runtime.lastError?.message;
        if (error) reject(new Error(error));
        else resolve(true);
      });
    })`);
    const access = await evaluateStable(cdp, `new Promise((resolve) => chrome.developerPrivate.getExtensionInfo(${JSON.stringify(extensionId)}, (info) => resolve(info.userScriptsAccess)))`);
    assert.equal(access?.isActive, true, 'Allow User Scripts did not become active for Taber');
  } finally {
    cdp?.close();
    if (target) await browserCdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined);
  }
}

async function hasSiteAccess(cdp: CdpClient, url: string) {
  const parsed = new URL(url);
  const pattern = `${parsed.protocol}//${parsed.host}/*`;
  return evaluateStable(cdp, `new Promise((resolve) => chrome.permissions.contains({ origins: [${JSON.stringify(pattern)}] }, resolve))`);
}

async function assertSidepanelLocaleRuntime(extensionCdp: CdpClient, targetTabId: number, extensionId: string) {
  let modelServer: Awaited<ReturnType<typeof startHangingModelServer>> | undefined;
  let completingServer: Awaited<ReturnType<typeof startCompletingModelServer>> | undefined;
  try {
    modelServer = await startHangingModelServer();
    await prepareSidepanelRuntime(extensionCdp, extensionId, modelServer.baseURL, 'zh');
    await activateTab(extensionCdp, targetTabId);
    const zhPrompt = 'Sidepanel zh runtime smoke';
    await submitSidepanelPrompt(extensionCdp, zhPrompt);
    const zhStarted = await waitForStartedEventByPrompt(extensionCdp, zhPrompt);
    assertModelRequest(await waitForModelRequest(extensionCdp, modelServer, readPositiveInteger(zhStarted.sessionId, 'zh sessionId')), 'zh');
    await runtimeMessage(extensionCdp, { type: 'taber.background.stopTask' }).catch(() => undefined);

    await prepareSidepanelRuntime(extensionCdp, extensionId, modelServer.baseURL, 'en');
    await activateTab(extensionCdp, targetTabId);
    const enPrompt = 'Sidepanel en runtime smoke';
    await submitSidepanelPrompt(extensionCdp, enPrompt);
    const enStarted = await waitForStartedEventByPrompt(extensionCdp, enPrompt);
    assertModelRequest(await waitForModelRequest(extensionCdp, modelServer, readPositiveInteger(enStarted.sessionId, 'en sessionId')), 'en');
    await runtimeMessage(extensionCdp, { type: 'taber.background.stopTask' }).catch(() => undefined);

    completingServer = await startCompletingModelServer('Runtime ordinary browsing task completed.');
    await prepareSidepanelRuntime(extensionCdp, extensionId, completingServer.baseURL, 'en');
    await activateTab(extensionCdp, targetTabId);
    const prompt = 'Summarize current page for instructions version smoke';
    await submitSidepanelPrompt(extensionCdp, prompt);
    const started = await waitForStartedEventByPrompt(extensionCdp, prompt);
    assert.equal(started.payload?.instructionsVersion, AGENT_INSTRUCTIONS_VERSION, `task.started must include instructionsVersion: ${AGENT_INSTRUCTIONS_VERSION}`);
    assert.equal(started.payload?.foregroundMode, false, 'sidepanel default mode must be captured in task.started');
    const sessionId = readPositiveInteger(started.sessionId, 'completion smoke sessionId');
    const taskId = readString(started.payload?.taskId, 'completion smoke taskId');
    const configured = await waitForAgentEventByTaskId(extensionCdp, sessionId, taskId, 'runtime.configured');
    assert.equal(configured.payload?.modelName, 'runtime-target-lock-model');
    assert.equal(configured.payload?.toolSchemaVersion, 2);
    assertModelRequest(await waitForModelRequest(extensionCdp, completingServer, sessionId), 'en');
    assertModelRequest(await waitForModelRequest(extensionCdp, completingServer, sessionId), 'en');
    const completed = await waitForAgentEventByTaskId(extensionCdp, sessionId, taskId, 'task.completed');
    assert.match(String(completed.payload?.text), /Runtime ordinary browsing task completed/);
  } finally {
    await runtimeMessage(extensionCdp, { type: 'taber.background.stopTask' }).catch(() => undefined);
    await modelServer?.close();
    await completingServer?.close();
  }
}

async function prepareSidepanelRuntime(cdp: CdpClient, extensionId: string, baseURL: string, locale: 'en' | 'zh') {
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: sidepanelRuntimeSmokeSource(locale) });
  await cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel.html?taber-smoke=1` });
  await waitForExtensionRuntime(cdp);
  await waitForTaberDatabase(cdp);
  await seedRuntimeProvider(cdp, baseURL);
  await setSidepanelLocale(cdp, locale);
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitForExtensionRuntime(cdp);
  await waitForSidepanelComposer(cdp);
}

function sidepanelRuntimeSmokeSource(locale: 'en' | 'zh') {
  return `(() => {
    localStorage.setItem('taber.locale', ${JSON.stringify(locale)});
    localStorage.setItem('taber.locale.manual', 'true');
    Object.defineProperty(window, '__taberSmokeUserScriptsAvailable', { configurable: true, value: true });
    const allSites = (input) => Array.isArray(input?.origins) && input.origins.includes('http://*/*') && input.origins.includes('https://*/*');
    const install = () => {
      if (!globalThis.chrome?.permissions || chrome.permissions.__taberRuntimeSmoke) return;
      const originalContains = chrome.permissions.contains?.bind(chrome.permissions);
      chrome.permissions.contains = (input, callback) => {
        if (allSites(input)) {
          if (callback) { callback(true); return; }
          return Promise.resolve(true);
        }
        return callback ? originalContains(input, callback) : originalContains(input);
      };
      chrome.permissions.__taberRuntimeSmoke = true;
    };
    install();
  })()`;
}

async function setSidepanelLocale(cdp: CdpClient, locale: 'en' | 'zh') {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    localStorage.setItem('taber.locale', ${JSON.stringify(locale)});
    localStorage.setItem('taber.locale.manual', 'true');
    chrome.storage.local.set({ 'taber.locale': ${JSON.stringify(locale)}, 'taber.locale.manual': true }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(true);
    });
  })`);
}

async function waitForSidepanelComposer(cdp: CdpClient) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      const textarea = document.querySelector('textarea[name="message"]');
      const hasModel = document.body.innerText.includes('runtime-target-lock-model');
      if (textarea && !textarea.disabled && hasModel) { resolve(true); return; }
      if (Date.now() > deadline) { reject(new Error('sidepanel composer did not become ready: ' + document.body.innerText.slice(0, 500))); return; }
      setTimeout(poll, 50);
    };
    poll();
  })`);
}

async function submitSidepanelPrompt(cdp: CdpClient, text: string) {
  await evaluateStable(cdp, `(() => {
    const textarea = document.querySelector('textarea[name="message"]');
    if (!textarea) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('textarea value setter not found');
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const textarea = document.querySelector('textarea[name="message"]');
      const form = textarea?.closest('form');
      const button = form?.querySelector('[data-prompt-input-submit], button[aria-label="Submit"]');
      if (button && !button.disabled) { button.click(); resolve(true); return; }
      if (Date.now() > deadline) { reject(new Error('sidepanel submit button did not become enabled')); return; }
      setTimeout(poll, 50);
    };
    poll();
  })`);
}

async function assertRuntimeTargetLock(browserCdp: CdpClient, cdpOrigin: string, extensionCdp: CdpClient, pageCdp: CdpClient, firstTabId: number) {
  const secondUrl = 'https://chatgpt.com/taber-target-lock-selected';
  let secondTarget: { targetId: string } | undefined;
  let secondCdp: CdpClient | undefined;
  let modelServer: Awaited<ReturnType<typeof startHangingModelServer>> | undefined;
  try {
    modelServer = await startHangingModelServer();
    await waitForTaberDatabase(extensionCdp);
    await seedRuntimeProvider(extensionCdp, modelServer.baseURL);
    const firstTab = await getTab(extensionCdp, firstTabId);
    const windowId = readPositiveInteger(firstTab.windowId, 'first tab windowId');

    await activateTab(extensionCdp, firstTabId);
    const zhStarted = await runtimeMessage(extensionCdp, { type: 'taber.background.startTask', prompt: 'Locale zh runtime smoke', foregroundMode: false, windowId, locale: 'zh' });
    const zhSessionId = readPositiveInteger((zhStarted as Record<string, unknown>).sessionId, 'zh sessionId');
    const zhStartedEvent = await waitForAgentEvent(extensionCdp, zhSessionId, 'task.started');
    assert.equal(zhStartedEvent.payload?.foregroundMode, false);
    assertModelRequest(await waitForModelRequest(extensionCdp, modelServer, zhSessionId), 'zh');
    await runtimeMessage(extensionCdp, { type: 'taber.background.stopTask' });
    await waitForAgentEvent(extensionCdp, zhSessionId, 'task.cancelled');

    secondTarget = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
    secondCdp = await connectTarget(await waitForTarget(cdpOrigin, (target) => target.id === secondTarget?.targetId && hasCdpEndpoint(target)));
    await secondCdp.send('Runtime.enable');
    await loadFixturePage(secondCdp, secondUrl);
    const secondTabId = await findTabId(extensionCdp, secondUrl);
    const secondTab = await getTab(extensionCdp, secondTabId);

    await activateTab(extensionCdp, firstTabId);
    const started = await runtimeMessage(extensionCdp, { type: 'taber.background.startTask', prompt: 'Target lock runtime smoke', foregroundMode: false, windowId, locale: 'en' });
    const sessionId = readPositiveInteger((started as Record<string, unknown>).sessionId, 'sessionId');
    const startedEvent = await waitForAgentEvent(extensionCdp, sessionId, 'task.started');
    assert.equal(startedEvent.payload?.context?.id, firstTabId, 'task.started must lock the active tab at send time');
    assert.equal(startedEvent.payload?.context?.url, firstTab.url);
    assert.equal(startedEvent.payload?.foregroundMode, false, 'task mode must be an immutable start snapshot');
    assertModelRequest(await waitForModelRequest(extensionCdp, modelServer, sessionId), 'en');

    await activateTab(extensionCdp, secondTabId);
    const activeTab = await runtimeMessage(extensionCdp, { type: 'taber.background.currentTab', windowId }) as Record<string, unknown>;
    assert.equal(activeTab.id, secondTabId, 'manual tab switch should change browser active tab');
    const lockedCurrent = await runtimeMessage(extensionCdp, { type: 'taber.navigate.request', foregroundMode: false, windowId, targetTabId: firstTabId, input: { action: 'currentTab' } }) as Record<string, any>;
    assert.equal(lockedCurrent.tab?.id, firstTabId, 'navigate.currentTab with task target must ignore manual active-tab switches');
    await assertNoAgentEvent(extensionCdp, sessionId, 'task.targetChanged', 300, 'manual active-tab switch must not emit targetChanged');

    const focusedBefore = await isWindowFocused(extensionCdp, windowId);
    await runTaskScriptingCommand(extensionCdp, firstTabId, false);
    const backgroundModeKeptActiveTab = await activeTabId(extensionCdp, windowId) === secondTabId;
    await runTaskScriptingCommand(extensionCdp, firstTabId, true);
    const foregroundModeActivatedTarget = await activeTabId(extensionCdp, windowId) === firstTabId;
    await activateTab(extensionCdp, secondTabId);
    await runTaskScriptingCommand(extensionCdp, firstTabId, true);
    const foregroundModeReactivatedAfterUserSwitch = await activeTabId(extensionCdp, windowId) === firstTabId;
    const focusedAfter = await isWindowFocused(extensionCdp, windowId);
    await activateTab(extensionCdp, secondTabId);

    const switched = await runtimeMessage(extensionCdp, { type: 'taber.agent.switchTarget', windowId, targetTabId: secondTabId, targetTab: secondTab, reason: 'userCurrentTab' }) as Record<string, unknown>;
    assert.equal(switched.changed, true, 'explicit user target switch should update the running task');
    const changedEvent = await waitForAgentEvent(extensionCdp, sessionId, 'task.targetChanged');
    assert.equal(changedEvent.payload?.toTabId, secondTabId);
    assert.equal(backgroundModeKeptActiveTab, true, 'background mode must leave the user-selected tab active');
    assert.equal(foregroundModeActivatedTarget, true, 'foreground mode must activate the target before a page command');
    assert.equal(foregroundModeReactivatedAfterUserSwitch, true, 'the next foreground page command must reactivate the immutable target');
    assert.equal(focusedAfter, focusedBefore, 'tab activation must not change Chrome window focus');
    return {
      backgroundModeKeptActiveTab,
      foregroundModeActivatedTarget,
      foregroundModeReactivatedAfterUserSwitch,
      windowFocusUnchanged: focusedAfter === focusedBefore,
      taskStartedCapturedMode: startedEvent.payload?.foregroundMode === false,
    };
  } finally {
    await runtimeMessage(extensionCdp, { type: 'taber.background.stopTask' }).catch(() => undefined);
    await activateTab(extensionCdp, firstTabId).catch(() => undefined);
    secondCdp?.close();
    if (browserCdp && secondTarget) await browserCdp.send('Target.closeTarget', { targetId: secondTarget.targetId }).catch(() => undefined);
    await modelServer?.close();
    await waitForPageReady(pageCdp).catch(() => undefined);
  }
}

async function waitForModelRequest(cdp: CdpClient, modelServer: Awaited<ReturnType<typeof startRuntimeModelServer>>, sessionId: number) {
  return Promise.race([
    modelServer.readRequest(10_000),
    waitForAgentEvent(cdp, sessionId, 'task.failed').then((event) => {
      throw new Error(`Task failed before model request: ${String(event.payload?.error ?? 'unknown error')}`);
    }),
  ]);
}

function assertModelRequest(modelRequest: { pathname: string; body: Record<string, unknown> }, locale: 'en' | 'zh') {
  assert.equal(modelRequest.pathname, '/v1/chat/completions');
  assert.equal(modelRequest.body.model, 'runtime-target-lock-model');
  assert.equal(Object.hasOwn(modelRequest.body, 'reasoning_effort'), false, 'OpenAI-compatible runtime request must omit default reasoning_effort');
  const bodyText = JSON.stringify(modelRequest.body);
  if (locale === 'zh') {
    assert.match(bodyText, /你是 Taber/, 'zh runtime request must use Chinese system instructions');
    assert.doesNotMatch(bodyText, /You are Taber/, 'zh runtime request must not use English system instructions');
    return;
  }
  assert.match(bodyText, /You are Taber/, 'en runtime request must use English system instructions');
  assert.doesNotMatch(bodyText, /你是 Taber/, 'en runtime request must not use Chinese system instructions');
}

function startHangingModelServer() {
  return startRuntimeModelServer({});
}

function startCompletingModelServer(completionText: string) {
  return startRuntimeModelServer({ completionText, toolFirst: true });
}

async function startRuntimeModelServer(options: { completionText?: string; toolFirst?: boolean }) {
  const requests: { pathname: string; body: Record<string, unknown> }[] = [];
  let waiters: ((request: { pathname: string; body: Record<string, unknown> }) => void)[] = [];
  let postCount = 0;
  const pushRequest = (modelRequest: { pathname: string; body: Record<string, unknown> }) => {
    const resolve = waiters.shift();
    if (resolve) resolve(modelRequest);
    else requests.push(modelRequest);
  };
  const server = createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
      });
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(404, { 'access-control-allow-origin': '*' });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const modelRequest = { pathname: new URL(request.url ?? '/', 'http://127.0.0.1').pathname, body: rawBody ? JSON.parse(rawBody) : {} };
      postCount += 1;
      pushRequest(modelRequest);
      if (options.completionText === undefined) return;
      if (options.toolFirst && postCount === 1) respondToolCall(response, modelRequest.body);
      else respondChatCompletion(response, modelRequest.body, options.completionText);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model smoke server did not expose a port');
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    readRequest(timeoutMs = 5000) {
      const request = requests.shift();
      if (request) return Promise.resolve(request);
      return new Promise<{ pathname: string; body: Record<string, unknown> }>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout>;
        const waiter = (modelRequest: { pathname: string; body: Record<string, unknown> }) => {
          clearTimeout(timeout);
          resolve(modelRequest);
        };
        timeout = setTimeout(() => {
          waiters = waiters.filter((nextWaiter) => nextWaiter !== waiter);
          reject(new Error('Model smoke server did not receive a chat request'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    async close() {
      closeServerConnections(server);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function respondToolCall(response: ServerResponse, body: Record<string, unknown>) {
  const toolCall = { id: 'call_runtime_get_document', type: 'function', function: { name: 'getDocument', arguments: '{"source":"currentPage","mode":"page"}' } };
  if (body.stream === true) {
    writeSseChunks(response, body, [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: 'getDocument', arguments: '' } }] }, finish_reason: null },
      { delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }] }, finish_reason: null },
      { delta: {}, finish_reason: 'tool_calls' },
    ]);
    return;
  }
  response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'chatcmpl-runtime-smoke', object: 'chat.completion', created: 0, model: modelName(body), choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] }));
}

function respondChatCompletion(response: ServerResponse, body: Record<string, unknown>, content: string) {
  if (body.stream === true) {
    writeSseChunks(response, body, [
      { delta: { role: 'assistant' }, finish_reason: null },
      { delta: { content }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]);
    return;
  }
  response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'chatcmpl-runtime-smoke', object: 'chat.completion', created: 0, model: modelName(body), choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}

function writeSseChunks(response: ServerResponse, body: Record<string, unknown>, choices: { delta: Record<string, unknown>; finish_reason: string | null }[]) {
  response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  for (const choice of choices) {
    response.write(`data: ${JSON.stringify({ id: 'chatcmpl-runtime-smoke', object: 'chat.completion.chunk', created: 0, model: modelName(body), choices: [{ index: 0, ...choice }] })}\n\n`);
  }
  response.end('data: [DONE]\n\n');
}

function modelName(body: Record<string, unknown>) {
  return typeof body.model === 'string' ? body.model : 'runtime-target-lock-model';
}

function closeServerConnections(server: Server) {
  const api = server as Server & { closeAllConnections?: () => void; closeIdleConnections?: () => void };
  api.closeAllConnections?.();
  api.closeIdleConnections?.();
}

async function waitForTaberDatabase(cdp: CdpClient) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(async () => {
      const databases = await indexedDB.databases();
      const db = databases.find((item) => item.name === 'taber');
      if (db && Number(db.version) >= 4) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Taber database was not initialized by the extension page')); }
    }, 50);
  })`);
}

async function seedRuntimeProvider(cdp: CdpClient, baseURL: string) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const open = indexedDB.open('taber');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['providers', 'providerCredentials', 'models', 'settings'], 'readwrite');
      const now = Date.now();
      tx.objectStore('providers').put({ id: 7001, kind: 'openaiCompatible', name: 'Runtime target lock', baseURL: ${JSON.stringify(baseURL)}, createdAt: now, updatedAt: now });
      tx.objectStore('providerCredentials').put({ providerId: 7001, kind: 'apiKey', value: { apiKey: 'sk-runtime-target-lock' }, updatedAt: now });
      tx.objectStore('models').put({ id: 7001, providerId: 7001, name: 'runtime-target-lock-model', contextWindowTokens: 128000 });
      tx.objectStore('settings').put({ key: 'selectedModelId', value: 7001 });
      tx.objectStore('settings').put({ key: 'reasoningEffort', value: 'default' });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  })`);
}

async function getTab(cdp: CdpClient, tabId: number) {
  return runtimeMessage(cdp, { type: 'taber.chromeApi.request', action: 'tabs.get', args: [tabId] }) as Promise<Record<string, unknown>>;
}

async function activateTab(cdp: CdpClient, tabId: number) {
  await runtimeMessage(cdp, { type: 'taber.chromeApi.request', action: 'tabs.update', args: [tabId, { active: true }] });
}

async function activeTabId(cdp: CdpClient, windowId: number) {
  const tabs = await runtimeMessage(cdp, { type: 'taber.chromeApi.request', action: 'tabs.query', args: [{ active: true, windowId }] }) as Array<{ id?: number }>;
  return tabs[0]?.id;
}

async function isWindowFocused(cdp: CdpClient, windowId: number) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => chrome.windows.get(${windowId}, (window) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else resolve(Boolean(window.focused));
  }))`);
}

async function runTaskScriptingCommand(cdp: CdpClient, tabId: number, foregroundMode: boolean) {
  return runtimeMessage(cdp, {
    type: 'taber.browserRepl.scriptingCommand',
    tabId,
    targetTabId: tabId,
    foregroundMode,
    command: { helper: 'observe', args: [] },
  });
}

async function waitForAgentEvent(cdp: CdpClient, sessionId: number, eventType: string) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const open = indexedDB.open('taber');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['agentEvents'], 'readonly');
        const req = tx.objectStore('agentEvents').getAll();
        req.onsuccess = () => {
          const event = req.result.find((item) => item.sessionId === ${sessionId} && item.type === ${JSON.stringify(eventType)});
          db.close();
          if (event) { resolve(event); return; }
          if (Date.now() > deadline) { reject(new Error('Missing agent event: ${eventType}')); return; }
          setTimeout(poll, 50);
        };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    };
    poll();
  })`);
}

async function waitForStartedEventByPrompt(cdp: CdpClient, prompt: string) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const open = indexedDB.open('taber');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['agentEvents'], 'readonly');
        const req = tx.objectStore('agentEvents').getAll();
        req.onsuccess = () => {
          const event = [...req.result].reverse().find((item) => item.type === 'task.started' && item.payload?.prompt === ${JSON.stringify(prompt)});
          db.close();
          if (event) { resolve(event); return; }
          if (Date.now() > deadline) { reject(new Error('Missing task.started for prompt')); return; }
          setTimeout(poll, 50);
        };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    };
    poll();
  })`);
}

async function waitForAgentEventByTaskId(cdp: CdpClient, sessionId: number, taskId: string, eventType: string) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      const open = indexedDB.open('taber');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['agentEvents'], 'readonly');
        const req = tx.objectStore('agentEvents').getAll();
        req.onsuccess = () => {
          const event = req.result.find((item) => item.sessionId === ${sessionId} && item.type === ${JSON.stringify(eventType)} && item.payload?.taskId === ${JSON.stringify(taskId)});
          db.close();
          if (event) { resolve(event); return; }
          if (Date.now() > deadline) { reject(new Error('Missing agent event: ${eventType} for task ${taskId}')); return; }
          setTimeout(poll, 50);
        };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    };
    poll();
  })`);
}

async function assertNoAgentEvent(cdp: CdpClient, sessionId: number, eventType: string, durationMs: number, message: string) {
  const found = await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + ${durationMs};
    const poll = () => {
      const open = indexedDB.open('taber');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['agentEvents'], 'readonly');
        const req = tx.objectStore('agentEvents').getAll();
        req.onsuccess = () => {
          const hasEvent = req.result.some((item) => item.sessionId === ${sessionId} && item.type === ${JSON.stringify(eventType)});
          db.close();
          if (hasEvent || Date.now() > deadline) { resolve(hasEvent); return; }
          setTimeout(poll, 50);
        };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    };
    poll();
  })`);
  assert.equal(found, false, message);
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function readString(value: unknown, name: string) {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`${name} must be a non-empty string`);
}

function framePath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

async function runtimeMessage(cdp: CdpClient, message: unknown) {
  const response = await evaluateStable(cdp, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function runSandboxIframe(cdp: CdpClient) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    const runId = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error('sandbox iframe timed out')), 5000);
    window.addEventListener('message', function onMessage(event) {
      if (event.source !== iframe.contentWindow || event.data?.runId !== runId) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      if (event.data.type === 'taber.sandbox.result') resolve(event.data.value);
      else reject(new Error(event.data.error || 'sandbox failed'));
    });
    iframe.src = chrome.runtime.getURL('/sandbox.html');
    iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ type: 'taber.sandbox.run', runId, code: 'await sandbox("return args.value + 1", { value: 2 })', helperNames: [] }, '*'), { once: true });
    document.body.append(iframe);
  })`);
}

async function assertScriptingCommandRoutesToFrame(extensionCdp: CdpClient, pageCdp: CdpClient, tabId: number) {
  const frames = await runtimeMessage(extensionCdp, { type: 'taber.chromeApi.request', action: 'webNavigation.getAllFrames', args: [{ tabId }] }) as Array<{ frameId: number; url: string }>;
  const frame = frames.find((item) => framePath(item.url) === frameFixturePath);
  assert(frame, 'frame-aware smoke iframe was not registered by webNavigation.getAllFrames');
  const snapshot = await runScriptingCommand(extensionCdp, tabId, { helper: 'browser', args: [{ action: 'snapshot' }] }, frame.frameId) as Record<string, any>;
  const ref = findElementByName(snapshot.state, 'Frame Submit').ref;
  const clicked = await runScriptingCommand(extensionCdp, tabId, { helper: 'browser', args: [{ action: 'click', target: { ref } }] }, frame.frameId) as Record<string, any>;
  assert.equal(clicked.ok, true);
  assert.equal(await evaluateStable(pageCdp, `document.querySelector('#child-frame').contentDocument.body.dataset.clicked`), 'frame');
}

async function runPageCommand(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  const result = await runRawPageCommand(cdp, tabId, command);
  if (!result.ok) throw new Error(String(result.error));
  return result.value as Record<string, any>;
}

async function runRawPageCommand(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  if (usesScriptingCancel(command)) return runScriptingCommandResult(cdp, tabId, command);
  const response = await runRawUserScript(cdp, tabId, command).catch((error) => {
    if (String(error).includes('did not return a result')) return undefined;
    throw error;
  });
  if (response?.error) return runScriptingCommandResult(cdp, tabId, command);
  const result = response?.[0]?.result;
  if (!result) return runScriptingCommandResult(cdp, tabId, command);
  return result as { ok: boolean; value?: any; error?: string };
}

function usesScriptingCancel(command: BrowserReplPageCommand) {
  return command.helper === 'pickUserElement' || command.helper === 'waitFor' || (command.helper === 'batch' && Array.isArray(command.args[0]) && command.args[0].some((action) => typeof action === 'object' && action !== null && ((action as { action?: unknown }).action === 'waitFor' || (action as { type?: unknown }).type === 'waitFor')));
}

async function runBrowserJsUserScript(cdp: CdpClient, tabId: number, code: string) {
  const result = await runRawBrowserJsResult(cdp, tabId, code);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function runRawBrowserJsResult(cdp: CdpClient, tabId: number, code: string) {
  const response = await runRawUserScript(cdp, tabId, { helper: 'browserjs', args: [code, undefined] });
  const result = response?.[0]?.result;
  if (!result) throw new Error('browserjs did not return a result. Enable Allow User Scripts for Taber and retry.');
  return result;
}

async function runRawUserScript(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  const code = JSON.stringify(createBrowserReplUserScript(command));
  const world = command.helper === 'browserjs' ? ", world: 'MAIN'" : '';
  const expression = `Promise.race([
    chrome.runtime.sendMessage({ type: 'taber.chromeApi.request', action: 'userScripts.execute', args: [{ target: { tabId: ${tabId} }, js: [{ code: ${code} }], taberTimeoutMs: 8000${world} }] }),
    new Promise((resolve) => setTimeout(() => resolve({ error: 'chrome.userScripts API timed out; enable Allow User Scripts for Taber and retry' }), 9000))
  ])`;
  const response = await evaluateStable(cdp, expression);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function runScriptingCommandResult(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  try {
    return { ok: true, value: await runScriptingCommand(cdp, tabId, command) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runScriptingCommand(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand, frameId?: number) {
  const expression = `chrome.runtime.sendMessage(${JSON.stringify({ type: 'taber.browserRepl.scriptingCommand', tabId, frameId, command })})`;
  const response = await evaluateStable(cdp, expression);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function clickWhenPickerIsReady(cdp: CdpClient, selector: string) {
  await waitForPickerPrompt(cdp);
  await evaluateStable(cdp, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('picker target missing');
    target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
}

async function waitForPickerPrompt(cdp: CdpClient) {
  await waitForPicker(cdp, true, 'picker prompt missing');
}

async function waitForPickerGone(cdp: CdpClient) {
  await waitForPicker(cdp, false, 'picker prompt still present after cancel');
}

async function waitForPicker(cdp: CdpClient, visible: boolean, error: string) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const timer = setInterval(() => {
      const present = Boolean(document.querySelector('#taber-page-control-overlay [data-taber-part="picker"]'));
      if (present === ${visible}) { clearInterval(timer); resolve(true); }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error(${JSON.stringify(error)})); }
    }, 50);
  })`);
}

async function clickAfterCancelledPicker(cdp: CdpClient) {
  return evaluateStable(cdp, `(() => {
    document.body.dataset.afterCancelClick = '';
    document.querySelector('#submit').addEventListener('click', () => { document.body.dataset.afterCancelClick = 'clicked'; }, { once: true });
    document.querySelector('#submit').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return document.body.dataset.afterCancelClick;
  })()`);
}

async function assertWaitForCancelsPromptly(cdp: CdpClient, tabId: number) {
  const cancelKey = `wait-cancel-${Date.now()}`;
  const startedAt = Date.now();
  const wait = runScriptingCommand(cdp, tabId, { helper: 'waitFor', args: [{ text: 'never appears from cancel smoke', timeoutMs: 5000 }], cancelKey, timeoutMs: 5000 }).then(
    () => ({ ok: true, error: '' }),
    (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  await runtimeMessage(cdp, { type: 'taber.browserRepl.cancelPageCommand', tabId, cancelKey });
  const result = await Promise.race([
    wait,
    new Promise<{ ok: boolean; error: string }>((resolve) => setTimeout(() => resolve({ ok: true, error: 'waitFor cancel was not prompt' }), 1500)),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.error, /Task aborted|cancelled/);
  assert(Date.now() - startedAt < 2000);
}

async function installOverlayReloadRelay(cdp: CdpClient, tabId: number) {
  await evaluateStable(cdp, `(() => {
    globalThis.__taberOverlayReloadRelay?.();
    const tabId = ${tabId};
    const listener = (message) => {
      if (message?.type !== 'taber.background.tabUpdated' || message.tab?.id !== tabId) return;
      chrome.runtime.sendMessage({ type: 'taber.browserRepl.scriptingCommand', tabId, command: { helper: 'controlOverlay', args: [{ action: 'show', message: 'Taber 正在控制此页', iconUrl: chrome.runtime.getURL('icons/icon-24.png') }], timeoutMs: 3000 } }).catch(() => undefined);
    };
    chrome.runtime.onMessage.addListener(listener);
    globalThis.__taberOverlayReloadRelay = () => chrome.runtime.onMessage.removeListener(listener);
    return true;
  })()`);
}

async function waitForOverlay(cdp: CdpClient) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const text = document.querySelector('#taber-page-control-overlay [data-taber-part="badge-text"]')?.textContent;
      if (text) { clearInterval(timer); resolve(text); }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('overlay did not reappear after reload')); }
    }, 50);
  })`);
}

async function waitForOverlayIcon(cdp: CdpClient) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const image = document.querySelector('#taber-page-control-overlay [data-taber-part="badge-icon-image"]');
      if (image?.complete && image.naturalWidth > 0) { clearInterval(timer); resolve(image.getAttribute('src')); }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('overlay icon did not load')); }
    }, 50);
  })`);
}

async function waitForOverlayGone(cdp: CdpClient) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const timer = setInterval(() => {
      const present = Boolean(document.querySelector('#taber-page-control-overlay'));
      if (!present) { clearInterval(timer); resolve(true); }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('overlay still present after hide')); }
    }, 50);
  })`);
}

async function findTabId(cdp: CdpClient, url: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const tabs = await evaluateStable(cdp, `chrome.runtime.sendMessage({ type: 'taber.chromeApi.request', action: 'tabs.query', args: [{}] })`).catch(() => undefined);
    if (Array.isArray(tabs)) {
      const tab = tabs.find((nextTab: Record<string, unknown>) => nextTab.url === url);
      if (tab?.id) return Number(tab.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Missing tab: ${url}`);
}

function assertBrowserSnapshotShape(state: Record<string, any>) {
  const allowedKeys = new Set(['number', 'kind', 'tag', 'role', 'name', 'text', 'href', 'value', 'state', 'rect', 'ref']);
  const rectKeys = new Set(['x', 'y', 'width', 'height']);
  const stateKeys = new Set(['disabled', 'expanded', 'selected', 'checked']);
  assert(Array.isArray(state.elements));
  for (const element of state.elements as Record<string, any>[]) {
    assert.equal(typeof element.ref, 'string');
    assert.deepEqual(Object.keys(element).filter((key) => !allowedKeys.has(key)).sort(), [], 'browser snapshot leaked internal field');
    assert.deepEqual(Object.keys(element.rect ?? {}).filter((key) => !rectKeys.has(key)).sort(), [], 'browser snapshot leaked rect field');
    assert.deepEqual(Object.keys(element.state ?? {}).filter((key) => !stateKeys.has(key)).sort(), [], 'browser snapshot leaked state field');
  }
}

function findElement(observed: Record<string, any>, tag: string) {
  const element = observed.elements.find((nextElement: Record<string, unknown>) => nextElement.tag === tag);
  if (!element?.ref) throw new Error(`Missing observed element: ${tag}`);
  return element;
}

function findElementByName(observed: Record<string, any>, name: string) {
  const element = observed.elements.find((nextElement: Record<string, unknown>) => nextElement.name === name);
  if (!element?.ref) throw new Error(`Missing observed element: ${name}`);
  return element;
}

async function loadFixturePage(cdp: CdpClient, url: string) {
  await cdp.send('Page.enable');
  await withFixtureInterception(cdp, async () => {
    await cdp.send('Page.navigate', { url });
    await waitForPageReady(cdp);
  });
}

async function reloadFixturePage(cdp: CdpClient) {
  await withFixtureInterception(cdp, async () => {
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForPageReady(cdp);
  });
}

async function withFixtureInterception(cdp: CdpClient, run: () => Promise<void>) {
  const stopIntercepting = cdp.on('Fetch.requestPaused', (request: { requestId: string; request?: { url?: string } }) => {
    const pathname = request.request?.url ? new URL(request.request.url).pathname : '';
    const body = Buffer.from(pathname === frameFixturePath ? frameFixtureHtml : fixtureHtml).toString('base64');
    void cdp.send('Fetch.fulfillRequest', {
      requestId: request.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
      body,
    });
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://chatgpt.com/*', requestStage: 'Request' }] });
  try {
    await run();
  } finally {
    stopIntercepting();
    await cdp.send('Fetch.disable').catch(() => undefined);
  }
}

async function waitForPageReady(cdp: CdpClient) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (document.readyState === 'complete') {
        clearInterval(timer);
        resolve(true);
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('test page did not load'));
      }
    }, 50);
  })`);
}

async function waitForExtensionRuntime(cdp: CdpClient) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (document.readyState === 'complete' && chrome?.runtime?.id) {
        clearInterval(timer);
        resolve(true);
      }
      if (Date.now() > deadline) {
        const state = JSON.stringify({ readyState: document.readyState, hasChromeRuntime: Boolean(chrome?.runtime?.id), href: location.href });
        clearInterval(timer);
        reject(new Error('extension page did not become ready: ' + state));
      }
    }, 50);
  })`);
}

