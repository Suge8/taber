// Demo recording: real Google Chrome + Taber store build + real Codex subscription.
//   node design/promo/motion/record-demo.mjs prepare   # grants + seed (headless)
//   node design/promo/motion/record-demo.mjs record    # headed run: task + window recording
// Key facts (probed):
// - Branded Chrome dropped --load-extension; the extension is CDP-loaded each launch and
//   optional grants reset with it, so the grant sequence runs after every launch.
// - developerPrivate.addHostPermission pre-registers wildcard hosts, after which
//   permissions.request resolves silently (no native bubble) even when headed.
// - Codex credential shape matches ~/.codex/auth.json tokens; Taber refreshes when expired.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp, connectTarget, delay, evaluate, fetchJson, hasCdpEndpoint, waitFor, waitForTarget } from '../../../scripts/cdp-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const extensionDir = path.join(repoRoot, '.output/chrome-mv3');
const profileDir = '/tmp/taber-demo-profile';
const cdpOrigin = 'http://127.0.0.1:9666';
const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_ID = 'mbihjdkbfdfidffmphfglahfkdemlhoj'; // stable: derived from extension path
const START_URL = 'https://www.google.com/';
const PROMPT = 'Go to Hacker News and give me the top 3 stories with one-line summaries';
const RECORDING = path.join(here, 'raw-recording.mov');

const phase = process.argv[2] ?? 'record';

function codexCredential() {
  const auth = JSON.parse(readFileSync(path.join(os.homedir(), '.codex/auth.json'), 'utf8'));
  const tokens = auth.tokens;
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    accountId: tokens.account_id,
    expiresAt: (claims.exp ?? 0) * 1000,
  };
}

let chromePid;

async function launch({ headless, url }) {
  const args = [
    '--remote-debugging-port=9666', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--mute-audio', '--lang=en-US',
    '--window-size=1680,1000', '--window-position=60,60',
  ];
  if (headless) args.push('--headless=new');
  args.push(url ?? 'about:blank');
  const child = spawn(chromeBin, args, { stdio: 'ignore' });
  child.unref();
  chromePid = child.pid;
  await waitFor(() => fetchJson(`${cdpOrigin}/json/version`).then(() => true, () => false), 15_000, 'chrome did not expose CDP');
  const version = await fetchJson(`${cdpOrigin}/json/version`);
  const bCdp = await connectCdp(version.webSocketDebuggerUrl);
  // Branded Chrome dropped --load-extension; load via CDP each launch (same path => stable id).
  const loaded = await bCdp.send('Extensions.loadUnpacked', { path: extensionDir });
  if (loaded.id !== EXT_ID) throw new Error(`extension id changed: ${loaded.id}`);
  return bCdp;
}

async function shutdown(bCdp) {
  await bCdp.send('Browser.close').catch(() => undefined);
  bCdp.close();
  await waitFor(() => fetchJson(`${cdpOrigin}/json/version`).then(() => false, () => true), 10_000, 'chrome did not close');
  await delay(800);
}

async function attachPage(bCdp, url) {
  const created = await bCdp.send('Target.createTarget', { url });
  const target = await waitForTarget(cdpOrigin, (t) => t.id === created.targetId && hasCdpEndpoint(t), 15_000);
  const cdp = await connectTarget(target);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { cdp, targetId: created.targetId };
}

async function clickAt(cdp, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

// Grants reset on every Extensions.loadUnpacked, so run this after each launch.
async function grantAll(bCdp) {
  const extensions = await attachPage(bCdp, `chrome://extensions/?id=${EXT_ID}`);
  await delay(1200);
  const usResult = await evaluate(extensions.cdp, `new Promise((resolve) => {
    chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(EXT_ID)}, userScriptsAccess: true }, () => resolve(chrome.runtime.lastError?.message ?? 'ok'));
  })`);
  console.log('userScriptsAccess:', usResult);
  // Pre-register wildcard hosts as runtime-granted; permissions.request then resolves silently.
  for (const host of ['http://*/*', 'https://*/*']) {
    const result = await evaluate(extensions.cdp, `new Promise((resolve) => {
      chrome.developerPrivate.addHostPermission(${JSON.stringify(EXT_ID)}, ${JSON.stringify(host)}, () => resolve(chrome.runtime.lastError?.message ?? 'ok'));
    })`);
    console.log('addHostPermission', host, result);
  }
  await bCdp.send('Target.closeTarget', { targetId: extensions.targetId }).catch(() => undefined);
  extensions.cdp.close();

  const panel = await attachPage(bCdp, `chrome-extension://${EXT_ID}/sidepanel.html`);
  await delay(2500); // app boot creates Dexie schema
  let granted = false;
  for (let attempt = 0; attempt < 5 && !granted; attempt += 1) {
    const box = await evaluate(panel.cdp, `(() => {
      document.getElementById('__grant')?.remove();
      window.__granted = undefined;
      const b = document.createElement('button');
      b.id = '__grant';
      b.style.cssText = 'position:fixed;top:0;left:0;width:200px;height:60px;z-index:2147483647;';
      b.onclick = () => { window.__granted = 'pending'; chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).then((g) => window.__granted = g).catch((e) => window.__granted = 'err:' + e.message); };
      document.body.appendChild(b);
      const r = b.getBoundingClientRect();
      return { x: r.x + 100, y: r.y + 30 };
    })()`);
    await clickAt(panel.cdp, box.x, box.y);
    await delay(3000);
    const flag = await evaluate(panel.cdp, `String(window.__granted)`);
    granted = await evaluate(panel.cdp, `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`);
    if (!granted) console.log(`grant attempt ${attempt + 1}: flag=${flag}, contains=false`);
  }
  if (!granted) throw new Error('all-sites grant failed after retries');
  console.log('allSites: granted');
  return panel;
}

// ---------------- prepare ----------------
async function prepare() {
  rmSync(profileDir, { recursive: true, force: true });
  const bCdp = await launch({ headless: true });
  await delay(2000);
  const panel = await grantAll(bCdp);

  // seed locale + codex provider + model + foreground mode
  await evaluate(panel.cdp, `(() => { localStorage.setItem('taber.locale', 'en'); localStorage.setItem('taber.locale.manual', 'true'); return true; })()`);
  const credential = codexCredential();
  const now = Date.now();
  await evaluate(panel.cdp, `
(async () => {
  const open = indexedDB.open('taber');
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const stores = ['providers', 'providerCredentials', 'models', 'settings'];
  const tx = db.transaction(stores, 'readwrite');
  const put = (store, value) => tx.objectStore(store).put(value);
  put('providers', { id: 1, kind: 'openaiCodex', name: 'ChatGPT subscription', baseURL: 'https://chatgpt.com/backend-api/codex', createdAt: ${now}, updatedAt: ${now} });
  put('providerCredentials', { providerId: 1, kind: 'openaiCodexOAuth', value: ${JSON.stringify(credential)}, updatedAt: ${now} });
  put('models', { id: 1, providerId: 1, name: 'gpt-5.6-luna', contextWindowTokens: 400000, supportedReasoningEfforts: ['low', 'medium', 'high'] });
  put('settings', { key: 'selectedModelId', value: 1 });
  put('settings', { key: 'reasoningEffort', value: 'high' });
  put('settings', { key: 'foregroundMode', value: true });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
  return true;
})()`);
  console.log('seeded provider + model + foreground mode');
  await bCdp.send('Target.closeTarget', { targetId: panel.targetId }).catch(() => undefined);
  panel.cdp.close();
  await shutdown(bCdp);
  console.log('prepare done');
}

// ---------------- record ----------------
function chromeWindowId() {
  const script = `
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let opts = CGWindowListOption([.optionOnScreenOnly, .excludeDesktopElements])
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
var best: (Int, Double) = (0, 0)
for w in list {
  guard (w["kCGWindowOwnerPID"] as? Int) == pid,
        (w["kCGWindowLayer"] as? Int) == 0,
        let bounds = w["kCGWindowBounds"] as? [String: Double],
        let num = w["kCGWindowNumber"] as? Int else { continue }
  let area = (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
  if area > best.1 { best = (num, area) }
}
print(best.0)`;
  const scriptPath = '/tmp/taber-winid.swift';
  execFileSync('bash', ['-c', `cat > ${scriptPath} <<'SWIFT_EOF'\n${script}\nSWIFT_EOF`]);
  const out = execFileSync('swift', [scriptPath, String(chromePid)]).toString().trim();
  if (!out || out === '0') throw new Error('Chrome window not found for recording');
  return out;
}

async function typePrompt(cdp, text) {
  await evaluate(cdp, `(() => {
    const textarea = document.querySelector('textarea[name="message"]');
    if (!textarea) throw new Error('composer not found');
    textarea.focus();
    return true;
  })()`);
  for (const char of text) {
    await cdp.send('Input.insertText', { text: char });
    await delay(18 + Math.random() * 30);
  }
}

async function record() {
  const bCdp = await launch({ headless: false });
  await delay(2000);
  const grantPanel = await grantAll(bCdp);
  await bCdp.send('Target.closeTarget', { targetId: grantPanel.targetId }).catch(() => undefined);
  grantPanel.cdp.close();
  const startTab = await bCdp.send('Target.createTarget', { url: START_URL });
  // close the initial about:blank tab so only the demo tab remains
  for (const t of await fetchJson(`${cdpOrigin}/json/list`)) {
    if (t.type === 'page' && t.url === 'about:blank' && t.id !== startTab.targetId) {
      await bCdp.send('Target.closeTarget', { targetId: t.id }).catch(() => undefined);
    }
  }
  await delay(4000);

  // open the real side panel: needs a user gesture, so send the _execute_action shortcut (⇧⌘Y)
  execFileSync('osascript', ['-e', `
    tell application "System Events"
      tell process "Google Chrome" to set frontmost to true
      delay 0.5
      keystroke "y" using {command down, shift down}
    end tell`]);
  console.log('sent side panel shortcut');

  // attach the side panel document
  const panelTarget = await waitForTarget(cdpOrigin, (t) => t.url.includes(`${EXT_ID}/sidepanel.html`) && hasCdpEndpoint(t), 15_000);
  const panel = await connectTarget(panelTarget);
  await panel.send('Runtime.enable');
  await evaluate(panel, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (document.querySelector('textarea[name="message"]')) { clearInterval(timer); resolve(true); }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('composer did not appear: ' + document.body.innerText.slice(0, 200))); }
    }, 200);
  })`);
  console.log('side panel ready');
  await delay(1500);

  // start recording the window (works while occluded; do not steal focus)
  rmSync(RECORDING, { force: true });
  const windowId = chromeWindowId();
  const recorder = spawn('screencapture', ['-v', '-l', windowId, RECORDING], { stdio: ['pipe', 'ignore', 'ignore'] });
  console.log('recording window', windowId);
  await delay(2000);

  try {
    await typePrompt(panel, PROMPT);
    await delay(600);
    // submit with a real click
    const submit = await evaluate(panel, `(() => {
      const textarea = document.querySelector('textarea[name="message"]');
      const form = textarea?.closest('form');
      const button = form?.querySelector('[data-prompt-input-submit], button[aria-label="Submit"]') ?? [...(form?.querySelectorAll('button[type="submit"]') ?? [])].at(-1);
      if (!button || button.disabled) return null;
      const r = button.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!submit) throw new Error('submit button not ready');
    await clickAt(panel, submit.x, submit.y);
    console.log('task submitted');

    // wait for completion (poll UI text; CDP has no event channel for this)
    const outcome = await evaluate(panel, `new Promise((resolve) => {
      const deadline = Date.now() + 300000;
      const timer = setInterval(() => {
        const text = document.body.innerText;
        if (/Completed \\d+ steps?/.test(text)) { clearInterval(timer); resolve('completed'); return; }
        if (/Failed|Stopped/i.test(text)) { clearInterval(timer); resolve('failed'); return; }
        if (Date.now() > deadline) { clearInterval(timer); resolve('timeout'); }
      }, 500);
    })`).catch(() => 'poll-error');
    console.log('outcome:', outcome);
    await delay(4000); // linger on the final answer
  } finally {
    recorder.kill('SIGINT');
    await new Promise((resolve) => recorder.on('exit', resolve));
    console.log('recording saved:', RECORDING);
    panel.close();
    await shutdown(bCdp);
  }
}

if (phase === 'prepare') await prepare();
else if (phase === 'record') await record();
else throw new Error(`unknown phase: ${phase}`);
