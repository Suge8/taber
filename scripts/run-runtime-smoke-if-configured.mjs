import { link, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { findRuntimeBrowserApp, prepareRuntimeBrowser } from './runtime-browser.mjs';

const smokeCommands = {
  extension: [process.execPath, ['scripts/smoke-extension.mjs', '--require-runtime-extension-loaded']],
  'browser-repl': [process.execPath, ['--experimental-strip-types', 'scripts/smoke-browser-repl-runtime.ts']],
  sidepanel: [process.execPath, ['scripts/smoke-sidepanel-ui.mjs']],
};
const runtimeOutDirTemplate = 'chrome-mv{{manifestVersion}}-runtime';
const runtimeExtensionDir = '.output/chrome-mv3-runtime';
const lockPath = '/tmp/taber-runtime-smoke.lock';
const legacyOwnerFile = path.join(lockPath, 'owner.json');
const childTimeoutMs = 180000;

const required = process.argv.includes('--required');
let smokeNames;
try {
  smokeNames = readSmokeNames();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const configured = process.env.TABER_CDP_ORIGIN || process.env.TABER_EXTENSION_ID;
let browserApp;
try {
  browserApp = await findRuntimeBrowserApp();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!configured && !browserApp) {
  const reason = 'runtime smoke skipped; install Google Chrome at /Applications/Google Chrome.app or set TABER_CDP_ORIGIN/TABER_EXTENSION_ID. Use TABER_BROWSER_APP only for local browser debugging.';
  if (required) {
    console.error(reason);
    process.exit(1);
  }
  console.info(reason);
  process.exit(0);
}

const releaseLock = await acquireRuntimeLock();
if (!process.env.TABER_EXTENSION_DIR) process.env.TABER_EXTENSION_DIR = runtimeExtensionDir;
let runtime;
try {
  await run('pnpm', ['build:chrome'], {
    TABER_ENABLE_DEBUGGER: '',
    TABER_DEBUG_ARTIFACT: '',
    TABER_OUT_DIR_TEMPLATE: runtimeOutDirTemplate,
  });
  await assertProductionBuildOutput(process.env.TABER_EXTENSION_DIR);
  runtime = await prepareRuntimeBrowser({ required, allowLaunch: true });
  if (runtime.skipped) {
    console.info(runtime.reason);
    process.exitCode = 0;
  } else {
    const env = {
      TABER_CDP_ORIGIN: runtime.cdpOrigin,
      TABER_EXTENSION_ID: runtime.extensionId,
      TABER_EXTENSION_DIR: process.env.TABER_EXTENSION_DIR,
    };
    for (const smokeName of smokeNames) await runSmoke(smokeName, env);
  }
} finally {
  try {
    await runtime?.close();
  } finally {
    await releaseLock();
  }
}

function readSmokeNames() {
  const only = readOption('--only');
  if (only === undefined) return ['extension', 'browser-repl'];
  const names = only.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('--only requires at least one smoke name');
  for (const name of names) {
    if (!smokeCommands[name]) throw new Error(`Unknown runtime smoke: ${name}`);
  }
  return names;
}

function readOption(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1] ?? '';
}

async function acquireRuntimeLock() {
  const owner = { token: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const tempLockPath = `${lockPath}.${owner.token}.tmp`;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      await rm(tempLockPath, { force: true });
      await writeFile(tempLockPath, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
      await link(tempLockPath, lockPath);
      await rm(tempLockPath, { force: true });
      return () => releaseRuntimeLock(owner.token);
    } catch (error) {
      await rm(tempLockPath, { force: true });
      if (error?.code !== 'EEXIST') throw error;
      const currentOwner = await readLockOwner();
      if (await isStaleLock(currentOwner)) {
        await removeStaleLock(currentOwner);
        continue;
      }
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for runtime smoke lock: ${lockPath}`);
}

async function releaseRuntimeLock(token) {
  const owner = await readLockOwner();
  if (owner?.token !== token) return;
  await rm(lockPath, { recursive: true, force: true });
}

async function assertProductionBuildOutput(extensionDir) {
  const manifestPath = path.resolve(extensionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Runtime smoke production build is missing at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.permissions?.includes('debugger')) throw new Error('Runtime smoke production build unexpectedly contains debugger permission');
}

async function removeStaleLock(owner) {
  const currentOwner = await readLockOwner();
  if (!sameOwner(owner, currentOwner)) return;
  await rm(lockPath, { recursive: true, force: true });
}

async function readLockOwner() {
  const text = await readFile(lockPath, 'utf8').catch(async (error) => {
    if (error?.code === 'EISDIR' || error?.code === 'EPERM') return readFile(legacyOwnerFile, 'utf8').catch(() => undefined);
    if (error?.code === 'ENOENT') return undefined;
    return undefined;
  });
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    const [pidText, startedText] = text.trim().split('\n');
    const pid = Number(pidText);
    const startedAt = Number(startedText);
    if (!Number.isInteger(pid) || !Number.isFinite(startedAt)) return undefined;
    return { token: 'legacy', pid, startedAt };
  }
}

async function isStaleLock(owner) {
  if (!owner) return lockAgeMs().then((age) => age > 5000);
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return lockAgeMs().then((age) => age > 5000);
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function lockAgeMs() {
  const stats = await stat(lockPath).catch(() => undefined);
  return stats ? Date.now() - stats.mtimeMs : Infinity;
}

function sameOwner(left, right) {
  if (!left && !right) return true;
  return Boolean(left && right && left.token === right.token && left.pid === right.pid && left.startedAt === right.startedAt);
}

function runSmoke(name, env) {
  const [command, args] = smokeCommands[name];
  return run(command, args, env);
}

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  let killTimer;
  let settled = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGTERM');
    killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 5000);
    killTimer.unref?.();
  }, childTimeoutMs);
  timeout.unref?.();

  return new Promise((resolve, reject) => {
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(' ')} timed out after ${childTimeoutMs}ms`));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal ?? 1}`));
    });
  });
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
