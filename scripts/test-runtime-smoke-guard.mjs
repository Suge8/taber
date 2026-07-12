import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertRuntimeSmokeTarget, markRuntimeSmokeBuild, RUNTIME_SMOKE_PAGE } from './runtime-smoke-guard.mjs';

await testRejectsUnverifiedTargets();
await testMarksAndRestoresRuntimeBuild();

console.info('runtime smoke guard tests passed');

function testRejectsUnverifiedTargets() {
  assert.throws(() => assertRuntimeSmokeTarget(undefined, undefined), /must run through/);
  assert.throws(() => assertRuntimeSmokeTarget('runtime-smoke:expected', 'runtime-smoke:other'), /Refusing/);
  assert.doesNotThrow(() => assertRuntimeSmokeTarget('runtime-smoke:expected', 'runtime-smoke:expected'));
}

async function testMarksAndRestoresRuntimeBuild() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taber-runtime-smoke-'));
  const manifestPath = path.join(directory, 'manifest.json');
  const originalManifest = '{"manifest_version":3,"name":"Taber","version":"1.0.0"}\n';
  await writeFile(manifestPath, originalManifest);

  try {
    const marker = await markRuntimeSmokeBuild(directory, 'test-token');
    const markedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(marker.versionName, 'runtime-smoke:test-token');
    assert.equal(markedManifest.version_name, marker.versionName);
    assert.match(await readFile(path.join(directory, RUNTIME_SMOKE_PAGE), 'utf8'), /Taber runtime smoke/);

    await marker.restore();
    assert.equal(await readFile(manifestPath, 'utf8'), originalManifest);
    await assert.rejects(() => readFile(path.join(directory, RUNTIME_SMOKE_PAGE)), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
