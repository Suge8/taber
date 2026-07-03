import { access, readFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { connectCdp, connectTarget, delay, evaluate, fetchJson, hasCdpEndpoint, readTargets, waitFor, waitForTarget } from './cdp-client.mjs';

const execFileAsync = promisify(execFile);
const defaultCdpOrigin = 'http://127.0.0.1:9258';
const defaultBrowserApp = '/Applications/Google Chrome.app';
const extensionDir = path.resolve(process.env.TABER_EXTENSION_DIR ?? '.output/chrome-mv3');

export async function prepareRuntimeBrowser({ required = false, allowLaunch = true } = {}) {
  const cdpOrigin = process.env.TABER_CDP_ORIGIN ?? defaultCdpOrigin;
  const configured = process.env.TABER_CDP_ORIGIN || process.env.TABER_EXTENSION_ID;
  const browserApp = allowLaunch ? await findRuntimeBrowserApp() : undefined;

  if (!configured && !browserApp && !required) return { skipped: true, reason: runtimeUnavailableReason() };
  if (!configured && !browserApp) throw new Error(runtimeUnavailableReason());

  let launchedBrowser = false;
  let extensionId = process.env.TABER_EXTENSION_ID;
  if (extensionId && !(await isCdpReachable(cdpOrigin))) {
    if (!allowLaunch) throw new Error(`CDP ${cdpOrigin} is not reachable for TABER_EXTENSION_ID=${extensionId}.`);
    extensionId = undefined;
  }
  extensionId ??= await findTaberExtensionId(cdpOrigin);

  if (!extensionId) {
    if (!allowLaunch) throw new Error(`Runtime smoke could not attach to Taber at ${cdpOrigin}. Run pnpm run test:ci:runtime or pass TABER_CDP_ORIGIN/TABER_EXTENSION_ID.`);
    if (await isCdpReachable(cdpOrigin)) throw new Error(`CDP ${cdpOrigin} is already running without Taber. Close it or set TABER_EXTENSION_ID. Refusing to open another browser on a fallback port.`);
    await verifyExtensionManifest();
    await launchBrowser(cdpOrigin, browserApp);
    launchedBrowser = true;
    try {
      extensionId = await loadUnpackedTaberExtension(cdpOrigin);
    } catch (error) {
      await closeBrowserIfReachable(cdpOrigin).catch(() => undefined);
      throw error;
    }
  }

  if (!extensionId) {
    if (launchedBrowser) await closeBrowserIfReachable(cdpOrigin).catch(() => undefined);
    throw new Error('Taber extension was not found in the configured browser');
  }

  return {
    skipped: false,
    cdpOrigin,
    extensionId,
    launchedBrowser,
    async close() {
      if (launchedBrowser) await closeBrowserIfReachable(cdpOrigin);
    },
  };
}

export async function findRuntimeBrowserApp() {
  const configured = process.env.TABER_BROWSER_APP;
  if (configured) {
    if (await exists(configured)) return configured;
    throw new Error(`TABER_BROWSER_APP does not exist: ${configured}`);
  }
  return await exists(defaultBrowserApp) ? defaultBrowserApp : undefined;
}

export async function findTaberExtensionId(cdpOrigin) {
  for (const target of await readTargets(cdpOrigin).catch(() => [])) {
    if (target.type !== 'service_worker' || !target.url.startsWith('chrome-extension://') || !hasCdpEndpoint(target)) continue;
    const cdp = await connectTarget(target).catch(() => undefined);
    if (!cdp) continue;
    try {
      await cdp.send('Runtime.enable');
      if ((await evaluate(cdp, 'chrome.runtime.getManifest().name')) === 'Taber') return new URL(target.url).host;
    } finally {
      cdp.close();
    }
  }
  return undefined;
}

async function verifyExtensionManifest() {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`Cannot load Taber extension from ${extensionDir}: manifest.json is missing or unreadable. Run pnpm build:chrome first.`);
  }
  if (manifest.manifest_version !== 3) throw new Error(`${manifestPath} is not a MV3 extension manifest.`);
}

async function launchBrowser(cdpOrigin, browserApp) {
  if (!browserApp) throw new Error(runtimeUnavailableReason());
  const browserExecutable = await resolveBrowserExecutable(browserApp);
  const url = new URL(cdpOrigin);
  const port = url.port || '9258';
  const profileDir = `/tmp/taber-runtime-profile-${port}`;
  await rm(profileDir, { recursive: true, force: true });
  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--mute-audio',
  ];
  if (shouldRunHeadless()) launchArgs.push('--headless=new', '--hide-scrollbars');
  else launchArgs.push('--new-window');
  launchArgs.push('about:blank');

  const child = spawn(browserExecutable, launchArgs, { stdio: 'ignore' });
  child.unref();
  try {
    await waitFor(() => isCdpReachable(cdpOrigin), 10000, 'Timed out waiting for runtime browser CDP');
  } catch (error) {
    child.kill();
    await closeBrowserIfReachable(cdpOrigin).catch(() => killPort(port));
    throw error;
  }
}

async function resolveBrowserExecutable(browserApp) {
  if (!browserApp.endsWith('.app')) return browserApp;
  const executable = path.join(browserApp, 'Contents', 'MacOS', path.basename(browserApp, '.app'));
  if (await exists(executable)) return executable;
  throw new Error(`Browser executable does not exist: ${executable}`);
}

async function loadUnpackedTaberExtension(cdpOrigin) {
  const version = await fetchJson(`${cdpOrigin}/json/version`);
  const cdp = await connectCdp(version.webSocketDebuggerUrl);
  try {
    let result;
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        result = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
        break;
      } catch (error) {
        lastError = error;
        await delay(200 * attempt);
      }
    }
    if (!result) throw lastError ?? new Error('Extensions.loadUnpacked failed');
    if (typeof result.id !== 'string' || result.id.length === 0) throw new Error('Extensions.loadUnpacked did not return an extension id');
    await waitForExtensionPageReady(cdpOrigin, cdp, result.id);
    return result.id;
  } catch (error) {
    throw new Error(`Failed to load Taber extension via CDP Extensions.loadUnpacked: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    cdp.close();
  }
}

async function waitForExtensionPageReady(cdpOrigin, browserCdp, extensionId) {
  const target = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
  let pageCdp;
  try {
    const page = await waitForTarget(cdpOrigin, (nextTarget) => nextTarget.id === target.targetId && hasCdpEndpoint(nextTarget), 10000);
    pageCdp = await connectTarget(page);
    await pageCdp.send('Runtime.enable');
    await evaluate(pageCdp, `new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const timer = setInterval(() => {
        if (document.readyState !== 'loading' && chrome?.runtime?.id === ${JSON.stringify(extensionId)}) {
          clearInterval(timer);
          resolve(true);
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('extension page did not become ready'));
        }
      }, 50);
    })`);
  } finally {
    pageCdp?.close();
    await browserCdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => undefined);
  }
}

async function closeBrowserIfReachable(cdpOrigin) {
  const url = new URL(cdpOrigin);
  const port = url.port || '80';
  if (!await isCdpReachable(cdpOrigin)) return;
  const version = await fetchJson(`${cdpOrigin}/json/version`);
  const cdp = await connectCdp(version.webSocketDebuggerUrl);
  try {
    await cdp.send('Browser.close').catch(() => undefined);
  } finally {
    cdp.close();
  }
  await waitForCdpClosed(cdpOrigin, 10000).catch(async () => {
    await killPort(port);
    await waitForCdpClosed(cdpOrigin, 5000);
  });
}

function waitForCdpClosed(cdpOrigin, timeoutMs) {
  return waitFor(() => isCdpReachable(cdpOrigin).then((reachable) => !reachable), timeoutMs, `Timed out waiting for ${cdpOrigin} to close`);
}

function isCdpReachable(cdpOrigin) {
  return fetchJson(`${cdpOrigin}/json/version`).then(() => true, () => false);
}

function runtimeUnavailableReason() {
  return `runtime smoke skipped; install Google Chrome at ${defaultBrowserApp} or set TABER_CDP_ORIGIN/TABER_EXTENSION_ID. Use TABER_BROWSER_APP only for local browser debugging.`;
}

function shouldRunHeadless() {
  return process.env.TABER_HEADED !== '1' && process.env.TABER_HEADLESS !== '0';
}

function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

async function killPort(port) {
  await execFileAsync('bash', ['-lc', `lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill`]).catch(() => undefined);
}
