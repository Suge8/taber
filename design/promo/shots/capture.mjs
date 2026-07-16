// Promo raw screenshots: seed a golden session into Dexie, capture the sidepanel
// at 2x DPR in light/dark themes. Run from repo root:
//   node design/promo/shots/capture.mjs
// Requires .output/chrome-mv3 (pnpm build:chrome). Launches its own headless Chrome.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, connectTarget, delay, evaluate, fetchJson, hasCdpEndpoint, waitForTarget } from '../../../scripts/cdp-client.mjs';
import { prepareRuntimeBrowser } from '../../../scripts/runtime-browser.mjs';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'raw');
const VIEWPORT = { width: 440, height: 900 };

let runtime;
let browserCdp;
let cdp;
try {
  runtime = await prepareRuntimeBrowser({ required: true });
  const sidepanelUrl = `chrome-extension://${runtime.extensionId}/sidepanel.html?taber-smoke=1`;
  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  const created = await browserCdp.send('Target.createTarget', { url: sidepanelUrl });
  const target = await waitForTarget(runtime.cdpOrigin, (t) => t.id === created.targetId && hasCdpEndpoint(t), 15_000);
  cdp = await connectTarget(target);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: stubExpression() });
  await evaluate(cdp, stubExpression()).catch(() => undefined);

  for (const theme of ['light', 'dark']) {
    await evaluate(cdp, prefsExpression(theme));
    await evaluate(cdp, seedExpression());
    await reload();
    await waitForText('Best deal', 10_000);
    await delay(3000); // favicons + fonts
    await logImageHealth();
    await shoot(theme, 'task-result');

    await expandActivityGroup();
    await delay(600);
    await shoot(theme, 'timeline-expanded');
    await reload();
    await waitForText('Best deal', 10_000);

    await clickByText('Skills');
    await delay(900);
    await shoot(theme, 'skills');
    await reload();
    await waitForText('Best deal', 10_000);

    await startNewChat();
    await delay(900);
    await shoot(theme, 'empty-state');

    await evaluate(cdp, seedRunningExpression());
    await reload();
    await waitForText('AI Builders Summit', 10_000);
    await delay(1500);
    await freezeUi();
    await shoot(theme, 'running');
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });

    await expandRunningGroup();
    await delay(800);
    await freezeUi();
    await shoot(theme, 'running-expanded');
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });
  }
  console.log(`done → ${outDir}`);
} finally {
  cdp?.close();
  browserCdp?.close();
  await runtime?.close?.();
}

async function shoot(theme, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const dir = path.join(outDir, theme);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`shot ${theme}/${name}`);
}

async function reload() {
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error('reload timed out')); }, 8000);
    const stop = cdp.on('Page.loadEventFired', () => { clearTimeout(timeout); stop(); resolve(true); });
  });
  await cdp.send('Page.reload');
  await loaded;
  await delay(400);
}

function waitForText(text, timeoutMs) {
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const timer = setInterval(() => {
      if (document.body?.innerText?.includes(${JSON.stringify(text)})) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('text not found: ' + ${JSON.stringify(text)} + ' — body: ' + (document.body?.innerText ?? '').slice(0, 400))); }
    }, 100);
  })`);
}

function clickByText(label) {
  return evaluate(cdp, `(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')];
    const hit = nodes.find((node) => node.textContent.trim() === ${JSON.stringify(label)} || node.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!hit) throw new Error('no control labelled ' + ${JSON.stringify(label)} + '; candidates: ' + nodes.map((n) => n.getAttribute('aria-label') || n.textContent.trim()).filter(Boolean).slice(0, 30).join(' | '));
    hit.click();
    return true;
  })()`);
}

function expandActivityGroup() {
  return clickGroupHeader('Completed');
}

function expandRunningGroup() {
  return clickGroupHeader('steps');
}

function clickGroupHeader(marker) {
  return evaluate(cdp, `(() => {
    const toggle = [...document.querySelectorAll('button')].find((node) => node.textContent.includes(${JSON.stringify(marker)}));
    if (!toggle) throw new Error('no activity header matching ${marker}');
    toggle.click();
    return true;
  })()`);
}

async function startNewChat() {
  await clickByText('Session history');
  await delay(700);
  await clickByText('New session');
}

// Freeze scripts so the live elapsed-time odometer is never caught mid-roll.
async function freezeUi() {
  await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  await delay(900);
}

async function logImageHealth() {
  const report = await evaluate(cdp, `JSON.stringify([...document.images].map((img) => ({ src: img.currentSrc.slice(0, 80), ok: img.complete && img.naturalWidth > 0 })))`);
  console.log('images:', report);
}

function prefsExpression(theme) {
  return `(() => {
    localStorage.setItem('taber.theme', ${JSON.stringify(theme)});
    localStorage.setItem('taber.locale', 'en');
    localStorage.setItem('taber.locale.manual', 'true');
    localStorage.setItem('__taberSmokeAllSitesGranted', 'true');
    if (globalThis.chrome?.storage?.local) chrome.storage.local.set({ 'taber.locale': 'en', 'taber.locale.manual': true });
    return true;
  })()`;
}

function stubExpression() {
  return `(() => {
    window.__taberSmokeUserScriptsAvailable = true;
    const isAllSites = (input) => {
      const origins = Array.isArray(input?.origins) ? input.origins : [];
      return origins.includes('http://*/*') && origins.includes('https://*/*');
    };
    const patch = (api) => {
      if (!api?.permissions || api.permissions.__taberPromo) return;
      const contains = api.permissions.contains?.bind(api.permissions);
      Object.defineProperty(api.permissions, 'contains', { configurable: true, value: (input, callback) => {
        if (isAllSites(input)) { if (callback) { callback(true); return; } return Promise.resolve(true); }
        return callback ? contains(input, callback) : contains(input);
      } });
      Object.defineProperty(api.permissions, '__taberPromo', { configurable: true, value: true });
    };
    patch(globalThis.chrome);
    if (globalThis.browser !== globalThis.chrome) patch(globalThis.browser);
    return true;
  })()`;
}

function seedExpression() {
  const now = Date.now();
  const start = now - 4 * 60_000;
  let at = start;
  const step = (ms) => (at += ms);
  const events = [];
  let eventId = 0;
  const push = (type, payload) => events.push({ id: (eventId += 1), sessionId: 1, type, payload, createdAt: at });

  const google = 'https://www.google.com/search?q=sony+wh-1000xm5+best+price';
  const amazon = 'https://www.amazon.com/dp/B09XS7JWHH';
  const bestbuy = 'https://www.bestbuy.com/site/sony-wh1000xm5-wireless-headphones/6505727.p';

  push('task.started', { taskId: 'promo-1', prompt: 'Find the best price for the Sony WH-1000XM5 and tell me where to buy today', context: { id: 41, windowId: 2, title: 'Google', url: 'https://www.google.com/', favIconUrl: 'https://www.google.com/favicon.ico' } });
  step(900);
  const run = (toolCallId, toolName, input, output, startMs, workMs) => {
    step(startMs);
    push('tool.started', { taskId: 'promo-1', toolCallId, toolName, input });
    step(workMs);
    push('tool.completed', { taskId: 'promo-1', toolCallId, toolName, input, output });
  };
  run('c1', 'navigate', { action: 'open', url: google }, { action: 'open', url: google, title: 'sony wh-1000xm5 best price - Google Search' }, 200, 2400);
  run('c2', 'getDocument', { source: 'currentPage', mode: 'article' }, { ok: true, source: 'currentPage', mode: 'article', url: google, title: 'sony wh-1000xm5 best price - Google Search', contentChars: 18432, truncated: false }, 400, 3100);
  run('c3', 'navigate', { action: 'open', url: amazon }, { action: 'open', url: amazon, title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones - Amazon.com' }, 600, 3800);
  run('c4', 'getDocument', { source: 'currentPage', mode: 'article' }, { ok: true, source: 'currentPage', mode: 'article', url: amazon, title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones - Amazon.com', contentChars: 22815, truncated: false }, 500, 3400);
  run('c5', 'browser', { action: 'click', target: 'See all buying options' }, { ok: true, action: 'click', target: 'See all buying options', outcome: 'clicked' }, 700, 2600);
  run('c6', 'getDocument', { source: 'currentPage', mode: 'article' }, { ok: true, source: 'currentPage', mode: 'article', url: amazon, title: 'Buying options: Sony WH-1000XM5', contentChars: 9612, truncated: false }, 400, 2900);
  run('c7', 'navigate', { action: 'open', url: bestbuy }, { action: 'open', url: bestbuy, title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones - Best Buy' }, 600, 4100);
  run('c8', 'getDocument', { source: 'currentPage', mode: 'article' }, { ok: true, source: 'currentPage', mode: 'article', url: bestbuy, title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones - Best Buy', contentChars: 19204, truncated: false }, 500, 3600);
  run('c9', 'navigate', { action: 'open', url: 'https://electronics.sony.com/audio/headphones/wh-1000xm5' }, { action: 'open', url: 'https://electronics.sony.com/audio/headphones/wh-1000xm5', title: 'WH-1000XM5 Wireless Noise Canceling Headphones - Sony' }, 600, 3900);
  run('c10', 'getDocument', { source: 'currentPage', mode: 'article' }, { ok: true, source: 'currentPage', mode: 'article', url: 'https://electronics.sony.com/audio/headphones/wh-1000xm5', title: 'WH-1000XM5 - Sony Electronics', contentChars: 14380, truncated: false }, 400, 3200);
  step(1200);
  const answer = [
    '**Best deal: $328 at Amazon** — 18% under list price, sold and shipped by Amazon.',
    '',
    '- **Amazon** — **$328**, in stock, arrives tomorrow',
    '- **Best Buy** — **$349**, free store pickup today',
    '- **Sony Direct** — **$399** list, bundles a 2-year warranty',
    '',
    'All three are the 2025 revision in black. If you want them today, Best Buy pickup is the fastest; otherwise Amazon is the clear winner on price.',
  ].join('\n');
  push('message.created', { taskId: 'promo-1', messageId: 'answer-1', role: 'assistant', text: answer });
  step(300);
  push('task.completed', { taskId: 'promo-1', text: 'Best deal: $328 at Amazon.' });

  return seedDbExpression({
    sessions: [{ id: 1, title: 'Sony WH-1000XM5 best price', pinned: false, createdAt: start - 5000, updatedAt: at }],
    events,
    selectedSessionId: 1,
  });
}

function seedRunningExpression() {
  const now = Date.now();
  const start = now - 26_000;
  let at = start;
  const step = (ms) => (at += ms);
  const events = [];
  let eventId = 100;
  const push = (type, payload) => events.push({ id: (eventId += 1), sessionId: 2, type, payload, createdAt: at });

  const site = 'https://www.eventbrite.com/e/ai-builders-summit-2026-registration-1024481975237';
  push('task.started', { taskId: 'promo-2', prompt: 'Register me for the AI Builders Summit conference with my profile details', context: { id: 44, windowId: 2, title: 'AI Builders Summit 2026 — Eventbrite', url: 'https://www.eventbrite.com/', favIconUrl: 'https://www.eventbrite.com/favicon.ico' } });
  step(800);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r1', toolName: 'navigate', input: { action: 'open', url: site } });
  step(2600);
  push('tool.completed', { taskId: 'promo-2', toolCallId: 'r1', toolName: 'navigate', input: { action: 'open', url: site }, output: { action: 'open', url: site, title: 'AI Builders Summit 2026 Registration — Eventbrite' } });
  step(700);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r2', toolName: 'getDocument', input: { source: 'currentPage', mode: 'article' } });
  step(2900);
  push('tool.completed', { taskId: 'promo-2', toolCallId: 'r2', toolName: 'getDocument', input: { source: 'currentPage', mode: 'article' }, output: { ok: true, source: 'currentPage', mode: 'article', url: site, title: 'AI Builders Summit 2026 Registration — Eventbrite', contentChars: 7412, truncated: false } });
  step(900);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r3', toolName: 'browser', input: { action: 'click', target: 'Get tickets' } });
  step(1900);
  push('tool.completed', { taskId: 'promo-2', toolCallId: 'r3', toolName: 'browser', input: { action: 'click', target: 'Get tickets' }, output: { ok: true, action: 'click', target: 'Get tickets', outcome: 'clicked' } });
  step(700);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r4', toolName: 'browser', input: { action: 'fill', target: 'Full name' } });
  step(2200);
  push('tool.completed', { taskId: 'promo-2', toolCallId: 'r4', toolName: 'browser', input: { action: 'fill', target: 'Full name' }, output: { ok: true, action: 'fill', target: 'Full name', outcome: 'filled' } });
  step(500);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r5', toolName: 'browser', input: { action: 'fill', target: 'Work email' } });
  step(2100);
  push('tool.completed', { taskId: 'promo-2', toolCallId: 'r5', toolName: 'browser', input: { action: 'fill', target: 'Work email' }, output: { ok: true, action: 'fill', target: 'Work email', outcome: 'filled' } });
  step(500);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r6', toolName: 'browser', input: { action: 'fill', target: 'Company' } });
  step(1800);
  push('tool.completed', { taskId: 'promo-2', toolCallId: 'r6', toolName: 'browser', input: { action: 'fill', target: 'Company' }, output: { ok: true, action: 'fill', target: 'Company', outcome: 'filled' } });
  step(600);
  push('tool.started', { taskId: 'promo-2', toolCallId: 'r7', toolName: 'browser', input: { action: 'click', target: 'Review registration' } });

  return seedDbExpression({
    sessions: [{ id: 2, title: 'Conference registration', pinned: false, createdAt: start - 2000, updatedAt: at }],
    events,
    keepExisting: true,
    selectedSessionId: 2,
  });
}

function seedDbExpression({ sessions, events, keepExisting = false, selectedSessionId }) {
  return `
(async () => {
  const open = indexedDB.open('taber');
  open.onupgradeneeded = () => {
    const db = open.result;
    const ensure = (name, options, indexes = []) => {
      if (db.objectStoreNames.contains(name)) return;
      const store = db.createObjectStore(name, options);
      for (const index of indexes) store.createIndex(index, index);
    };
    ensure('providers', { keyPath: 'id', autoIncrement: true }, ['kind', 'name']);
    ensure('providerCredentials', { keyPath: 'providerId' }, ['kind']);
    ensure('models', { keyPath: 'id', autoIncrement: true }, ['providerId', 'name']);
    ensure('sessions', { keyPath: 'id', autoIncrement: true }, ['updatedAt', 'pinned']);
    ensure('agentEvents', { keyPath: 'id', autoIncrement: true }, ['sessionId', 'createdAt', 'type']);
    ensure('settings', { keyPath: 'key' });
  };
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const stores = ['providers', 'providerCredentials', 'models', 'sessions', 'agentEvents', 'settings'];
  ${keepExisting ? '' : `await new Promise((resolve, reject) => {
    const clearTx = db.transaction(stores, 'readwrite');
    for (const store of stores) clearTx.objectStore(store).clear();
    clearTx.oncomplete = resolve;
    clearTx.onerror = () => reject(clearTx.error);
  });`}
  const tx = db.transaction(stores, 'readwrite');
  const put = (store, value) => tx.objectStore(store).put(value);
  const now = Date.now();
  put('providers', { id: 1, kind: 'openaiCompatible', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', createdAt: now - 86400000, updatedAt: now - 86400000 });
  put('providerCredentials', { providerId: 1, kind: 'apiKey', value: { apiKey: 'sk-promo' }, updatedAt: now - 86400000 });
  put('models', { id: 1, providerId: 1, name: 'GPT-5.6', contextWindowTokens: 400000, supportedReasoningEfforts: ['low', 'medium', 'high'] });
  put('settings', { key: 'selectedModelId', value: 1 });
  put('settings', { key: 'selectedSessionId', value: ${JSON.stringify(selectedSessionId ?? null)} });
  put('settings', { key: 'reasoningEffort', value: 'high' });
  put('settings', { key: 'browserPageScriptConsent', value: true });
  for (const session of ${JSON.stringify(sessions)}) put('sessions', session);
  for (const event of ${JSON.stringify(events)}) put('agentEvents', event);
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
  return true;
})()`;
}
