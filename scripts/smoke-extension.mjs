import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCdp, connectTarget, evaluate, fetchJson, hasCdpEndpoint, waitForTarget } from './cdp-client.mjs';
import { prepareRuntimeBrowser } from './runtime-browser.mjs';

const drySmoke = process.argv.includes('--dry-smoke');
const requireRuntimeExtension = process.argv.includes('--require-runtime-extension-loaded');
const failAfterEnsure = process.argv.includes('--fail-after-ensure');

if (drySmoke) {
  await verifyDrySmoke();
  console.info('dry extension smoke passed');
  process.exit(0);
}

if (!requireRuntimeExtension && !process.env.TABER_EXTENSION_ID) {
  throw new Error('Runtime smoke requires --require-runtime-extension-loaded, --dry-smoke, or TABER_EXTENSION_ID.');
}

let runtime;
let browserCdp;
let pageTarget;
let pageCdp;
let offscreenCdp;

try {
  runtime = await prepareRuntimeBrowser({ required: true, allowLaunch: false });
  if (runtime.skipped) throw new Error(runtime.reason);

  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  pageTarget = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${runtime.extensionId}/sidepanel.html?taber-smoke=1` });
  const sidepanel = await waitForTarget(runtime.cdpOrigin, (target) => target.id === pageTarget.targetId && hasCdpEndpoint(target), 15000);
  pageCdp = await connectTarget(sidepanel);
  await pageCdp.send('Runtime.enable');
  await pageCdp.send('Page.enable');

  const sidepanelState = await evaluate(pageCdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const hasOnboardingUi = (text) => Boolean(document.getElementById('onboarding-api-key'))
      || Boolean(document.querySelector('[data-smoke="add-api-provider"], [data-smoke="subscription-hub"], [data-smoke^="subscription-login-"]'))
      || /Welcome to Taber|Get started|Permissions|Website access|Allow User Scripts|API provider|权限|网站访问/.test(text);
    const tick = () => {
      const text = document.body?.innerText || '';
      const hasOnboarding = hasOnboardingUi(text);
      const hasComposer = Boolean(document.querySelector('textarea[name="message"]'));
      const runtimeId = globalThis.chrome?.runtime?.id;
      if (runtimeId && (hasOnboarding || hasComposer)) {
        resolve({ text, hasOnboarding, hasComposer, runtimeId });
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(text || JSON.stringify({ readyState: document.readyState, runtimeId }) || 'sidepanel did not render'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  })`);
  assert(sidepanelState.runtimeId === runtime.extensionId, 'sidepanel runtime id mismatch');
  assert(sidepanelState.hasOnboarding || sidepanelState.hasComposer, 'sidepanel UI missing');

  await sendRuntimeMessage(pageCdp, 'taber.offscreen.close');
  assert((await sendRuntimeMessage(pageCdp, 'taber.offscreen.hasDocument')) === false, 'offscreen was not reset');
  await verifySidepanelApi(runtime.cdpOrigin, runtime.extensionId);

  assert((await sendRuntimeMessage(pageCdp, 'taber.offscreen.ensure')) === true, 'offscreen ensure failed');
  assert((await sendRuntimeMessage(pageCdp, 'taber.offscreen.hasDocument')) === true, 'offscreen hasDocument false');

  const offscreen = await waitForTarget(
    runtime.cdpOrigin,
    (target) => target.url === `chrome-extension://${runtime.extensionId}/offscreen.html` && hasCdpEndpoint(target),
  );
  offscreenCdp = await connectTarget(offscreen);
  await offscreenCdp.send('Runtime.enable');

  const offscreenState = await evaluate(offscreenCdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (document.body.dataset.ready === 'true') {
        clearInterval(timer);
        resolve({ ready: true });
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(JSON.stringify({ ready: document.body.dataset.ready })));
      }
    }, 50);
  })`);
  assert(offscreenState.ready === true, 'offscreen not ready');
  if (failAfterEnsure) throw new Error('intentional smoke failure after offscreen ensure');

  console.info('runtime extension smoke passed');
} finally {
  if (pageCdp) await sendRuntimeMessage(pageCdp, 'taber.offscreen.close').catch(() => undefined);
  offscreenCdp?.close();
  pageCdp?.close();
  if (browserCdp && pageTarget) await browserCdp.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => undefined);
  browserCdp?.close();
  if (runtime && !runtime.skipped) await runtime.close();
}

function sendRuntimeMessage(cdp, type) {
  return evaluate(cdp, `chrome.runtime.sendMessage({ type: ${JSON.stringify(type)} })`);
}

async function verifySidepanelApi(cdpOrigin, extensionId) {
  const worker = await waitForTarget(
    cdpOrigin,
    (target) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`) && hasCdpEndpoint(target),
  );
  const workerCdp = await connectTarget(worker);
  await workerCdp.send('Runtime.enable');

  try {
    const state = await evaluate(
      workerCdp,
      `Promise.all([chrome.sidePanel.getOptions({}), chrome.sidePanel.getPanelBehavior()])
        .then(([options, behavior]) => ({ options, behavior }))`,
    );
    assert(state.options.path === 'sidepanel.html', 'sidepanel path mismatch');
    assert(state.options.enabled === true, 'sidepanel not enabled');
    assert(state.behavior.openPanelOnActionClick === true, 'sidepanel action click disabled');
  } finally {
    workerCdp.close();
  }
}

async function verifyDrySmoke() {
  const extensionDir = '.output/chrome-mv3';
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));

  assert(manifest.name === 'Taber', 'manifest name missing');
  assert(manifest.side_panel?.default_path === 'sidepanel.html', 'sidepanel entry missing');
  assert(manifest.sandbox?.pages?.includes('sandbox.html'), 'sandbox entry missing');
  assert(manifest.permissions?.includes('offscreen'), 'offscreen permission missing');

  for (const file of ['background.js', 'sidepanel.html', 'offscreen.html', 'sandbox.html']) {
    await access(path.join(extensionDir, file));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
