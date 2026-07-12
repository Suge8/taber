import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const RUNTIME_SMOKE_PAGE = 'runtime-smoke.html';
const VERSION_PREFIX = 'runtime-smoke:';

export async function markRuntimeSmokeBuild(extensionDir, token) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const pagePath = path.join(extensionDir, RUNTIME_SMOKE_PAGE);
  const originalManifest = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(originalManifest);
  const versionName = `${VERSION_PREFIX}${token}`;
  manifest.version_name = versionName;
  try {
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(pagePath, '<!doctype html><meta charset="utf-8"><title>Taber runtime smoke</title>');
  } catch (error) {
    await writeFile(manifestPath, originalManifest);
    await rm(pagePath, { force: true });
    throw error;
  }

  return {
    versionName,
    async restore() {
      await writeFile(manifestPath, originalManifest);
      await rm(pagePath, { force: true });
    },
  };
}

export function assertRuntimeSmokeTarget(expectedVersionName, actualVersionName) {
  if (!expectedVersionName?.startsWith(VERSION_PREFIX)) {
    throw new Error('Destructive sidepanel smoke must run through scripts/run-runtime-smoke-if-configured.mjs.');
  }
  if (actualVersionName !== expectedVersionName) {
    throw new Error('Runtime smoke target is not the isolated build from this run. Refusing to modify extension data or permissions.');
  }
}
