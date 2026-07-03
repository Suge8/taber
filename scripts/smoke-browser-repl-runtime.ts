import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connectCdp, connectTarget, evaluateStable, fetchJson, hasCdpEndpoint, waitForTarget, type CdpClient } from './cdp-client.mjs';
import { prepareRuntimeBrowser } from './runtime-browser.mjs';
import { createBrowserReplUserScript } from '../lib/browser-repl-page.ts';
import type { BrowserReplPageCommand } from '../lib/browser-repl.ts';

let runtime: Awaited<ReturnType<typeof prepareRuntimeBrowser>> | undefined;
let server: Awaited<ReturnType<typeof startTestServer>> | undefined;
let browserCdp: CdpClient | undefined;
let pageTarget: { targetId: string } | undefined;
let extensionTarget: { targetId: string } | undefined;
let pageCdp: CdpClient | undefined;
let extensionCdp: CdpClient | undefined;

try {
  runtime = await prepareRuntimeBrowser({ required: true, allowLaunch: false });
  if (runtime.skipped) throw new Error(runtime.reason);

  server = await startTestServer();
  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  pageTarget = await browserCdp.send('Target.createTarget', { url: server.url });
  extensionTarget = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${runtime.extensionId}/sidepanel.html` });
  pageCdp = await connectTarget(await waitForTarget(runtime.cdpOrigin, (target) => target.id === pageTarget?.targetId && hasCdpEndpoint(target)));
  extensionCdp = await connectTarget(await waitForTarget(runtime.cdpOrigin, (target) => target.id === extensionTarget?.targetId && hasCdpEndpoint(target)));
  await pageCdp.send('Runtime.enable');
  await extensionCdp.send('Runtime.enable');
  await waitForPageReady(pageCdp);
  await waitForExtensionRuntime(extensionCdp);
  await grantSiteAccess(extensionCdp, server.url);

  const tabId = await findTabId(extensionCdp, server.url);
  const observed = await runPageCommand(extensionCdp, tabId, { helper: 'observe', args: [] });
  assert.equal(observed.summary.title, 'BrowserRepl Smoke');
  const input = findElement(observed, 'input');
  const editor = findElementByName(observed, 'Editor');
  const select = findElement(observed, 'select');
  const button = findElement(observed, 'button');
  assert.equal(typeof input.ref.stableId, 'string');

  const browserJsAvailable = await verifyBrowserJs(extensionCdp, pageCdp, tabId);
  assert.equal(typeof browserJsAvailable, 'boolean');
  assert.equal(await runSandboxIframe(extensionCdp), 3);

  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'scroll', args: [{ y: 200 }] })).scrolled, true);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'fill', args: [select.ref, 'b'] })).filled, true);
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#choice").value'), 'b');
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'fill', args: [editor.ref, 'editable'] })).filled, true);
  assert.equal(await evaluateStable(pageCdp, 'document.querySelector("#editor").textContent'), 'editable');
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'fill', args: [input.ref, 'alpha'] })).filled, true);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'click', args: [button.ref] })).clicked, true);
  assert.equal((await runPageCommand(extensionCdp, tabId, { helper: 'waitFor', args: [{ text: 'submitted alpha', timeoutMs: 1000 }] })).matched, true);

  await verifyDocumentImageTools(extensionCdp, tabId);

  const timeoutResult = await runRawPageCommand(extensionCdp, tabId, { helper: 'waitFor', args: [{ text: 'never appears', timeoutMs: 20 }] });
  assert.equal(timeoutResult.ok, false);
  assert.match(String(timeoutResult.error), /waitFor timed out after 20ms/);

  console.info('browser repl runtime smoke passed');
} finally {
  pageCdp?.close();
  extensionCdp?.close();
  if (browserCdp && pageTarget) await browserCdp.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => undefined);
  if (browserCdp && extensionTarget) await browserCdp.send('Target.closeTarget', { targetId: extensionTarget.targetId }).catch(() => undefined);
  browserCdp?.close();
  if (runtime && !runtime.skipped) await runtime.close();
  await server?.close();
}

async function verifyBrowserJs(extensionCdp: CdpClient, pageCdp: CdpClient, tabId: number) {
  try {
    assert.equal(await runBrowserJsUserScript(extensionCdp, tabId, `document.body.dataset.browserjsFetch = String(typeof fetch); return document.title`), 'BrowserRepl Smoke');
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

async function verifyDocumentImageTools(extensionCdp: CdpClient, tabId: number) {
  const documentResult = await runtimeMessage(extensionCdp, { type: 'taber.getDocument.extractPage', tabId, input: { source: 'currentPage', mode: 'page', includeTables: true } });
  assert.equal(documentResult.title, 'BrowserRepl Smoke');
  assert.equal(documentResult.selection, '');
  assert.match(documentResult.html, /Runtime table/);
  assert.equal('markdown' in documentResult, false);
  assert.equal('tables' in documentResult, false);

  const image = await runtimeMessage(extensionCdp, { type: 'taber.extractImage.extractPage', tabId, input: { source: 'imageElement', selector: '#product' } });
  assert.equal(image.ok, true);
  assert.match(image.url, /pixel\.png$/);
  const canvas = await runtimeMessage(extensionCdp, { type: 'taber.extractImage.extractPage', tabId, input: { source: 'canvas', selector: '#chart' } });
  assert.equal(canvas.ok, true);
  assert.match(canvas.dataUrl, /^data:image\/png/);
  const background = await runtimeMessage(extensionCdp, { type: 'taber.extractImage.extractPage', tabId, input: { source: 'backgroundImage', selector: '#hero' } });
  assert.equal(background.ok, true);
  assert.match(background.url, /pixel\.png$/);
  await runtimeMessage(extensionCdp, { type: 'taber.extractImage.captureVisibleTab', input: { source: 'viewport', format: 'png' } }).then(
    (value) => assert.match(value, /^data:image\/png/),
    (error) => assert.match(String(error), /<all_urls>|activeTab/),
  );
}

async function grantSiteAccess(cdp: CdpClient, url: string) {
  const pattern = `${new URL(url).origin}/*`;
  const result = await cdp.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => chrome.permissions.request({ origins: [${JSON.stringify(pattern)}] }, resolve))`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'permissions.request failed');
  if (result.result.value !== true) throw new Error(`Runtime smoke could not grant site access for ${pattern}`);
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
    iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ type: 'taber.sandbox.run', runId, code: 'return await sandbox("return args.value + 1", { value: 2 })', helperNames: [] }, '*'), { once: true });
    document.body.append(iframe);
  })`);
}

async function runPageCommand(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  const result = await runRawPageCommand(cdp, tabId, command);
  if (!result.ok) throw new Error(String(result.error));
  return result.value as Record<string, any>;
}

async function runRawPageCommand(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  const response = await runRawUserScript(cdp, tabId, command).catch((error) => {
    if (String(error).includes('did not return a result')) return undefined;
    throw error;
  });
  if (response?.error) return runScriptingCommandResult(cdp, tabId, command);
  const result = response?.[0]?.result;
  if (!result) return runScriptingCommandResult(cdp, tabId, command);
  return result as { ok: boolean; value?: any; error?: string };
}

async function runBrowserJsUserScript(cdp: CdpClient, tabId: number, code: string) {
  const response = await runRawUserScript(cdp, tabId, { helper: 'browserjs', args: [code, undefined] });
  const result = response?.[0]?.result;
  if (!result) throw new Error('browserjs did not return a result. Enable Allow User Scripts for Taber and retry.');
  if (!result.ok) throw new Error(result.error);
  return result.value;
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

async function runScriptingCommand(cdp: CdpClient, tabId: number, command: BrowserReplPageCommand) {
  const expression = `chrome.runtime.sendMessage(${JSON.stringify({ type: 'taber.browserRepl.scriptingCommand', tabId, command })})`;
  const response = await evaluateStable(cdp, expression);
  if (response?.error) throw new Error(response.error);
  return response;
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

async function startTestServer() {
  const html = `<!doctype html><title>BrowserRepl Smoke</title>
    <main style="height: 900px">
      <h1>Runtime table</h1>
      <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Answer</td><td>42</td></tr></tbody></table>
      <img id="product" src="/pixel.png" alt="Product image">
      <canvas id="chart" width="16" height="16"></canvas>
      <div id="hero" style="background-image:url('/pixel.png'); width:16px; height:16px"></div>
      <label>Name <input id="name"></label>
      <div id="editor" aria-label="Editor" contenteditable></div>
      <label>Choice <select id="choice"><option value="a">A</option><option value="b">B</option></select></label>
      <button id="submit" onclick="document.querySelector('#status').textContent = 'submitted ' + document.querySelector('#name').value">Submit</button>
      <p id="status">idle</p>
      <script>const c = document.querySelector('#chart').getContext('2d'); c.fillStyle = '#1d4ed8'; c.fillRect(0, 0, 16, 16);</script>
    </main>`;
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luz5WQAAAABJRU5ErkJggg==', 'base64');
  const server = createServer((request, response) => {
    if (request.url === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(pixel);
      return;
    }
    if (request.url === '/fail') {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('failed');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not start');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
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

