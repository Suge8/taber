import assert from 'node:assert/strict';
import { createOffscreenLifecycle, type OffscreenApi } from '../lib/offscreen-lifecycle.ts';

class FakeOffscreen implements OffscreenApi {
  createCount = 0;
  closeCount = 0;
  private documentOpen: boolean;
  private resolveCreateStarted?: () => void;
  private resolveCreateRelease?: () => void;
  private resolveCloseStarted?: () => void;
  private resolveCloseRelease?: () => void;

  createStarted = new Promise<void>((resolve) => {
    this.resolveCreateStarted = resolve;
  });
  closeStarted = new Promise<void>((resolve) => {
    this.resolveCloseStarted = resolve;
  });
  private createRelease = new Promise<void>((resolve) => {
    this.resolveCreateRelease = resolve;
  });
  private closeRelease = new Promise<void>((resolve) => {
    this.resolveCloseRelease = resolve;
  });

  constructor(open = false) {
    this.documentOpen = open;
  }

  async hasDocument() {
    return this.documentOpen;
  }

  async createDocument() {
    this.createCount += 1;
    this.resolveCreateStarted?.();
    await this.createRelease;
    this.documentOpen = true;
  }

  async closeDocument() {
    this.closeCount += 1;
    this.resolveCloseStarted?.();
    await this.closeRelease;
    this.documentOpen = false;
  }

  finishCreate() {
    this.resolveCreateRelease?.();
  }

  finishClose() {
    this.resolveCloseRelease?.();
  }
}

await testConcurrentEnsureIsSingleCreate();
await testCloseWaitsForInFlightCreate();
await testEnsureWaitsForInFlightClose();
await testCloseWithoutDocumentReturnsFalse();

console.info('offscreen lifecycle tests passed');

async function testConcurrentEnsureIsSingleCreate() {
  const offscreen = new FakeOffscreen();
  const lifecycle = createOffscreenLifecycle(offscreen);

  const firstEnsure = lifecycle.ensureDocument();
  const secondEnsure = lifecycle.ensureDocument();
  await offscreen.createStarted;
  offscreen.finishCreate();

  assert.equal(await firstEnsure, true);
  assert.equal(await secondEnsure, true);
  assert.equal(offscreen.createCount, 1);
  assert.equal(await lifecycle.hasDocument(), true);
}

async function testCloseWaitsForInFlightCreate() {
  const offscreen = new FakeOffscreen();
  const lifecycle = createOffscreenLifecycle(offscreen);

  const ensure = lifecycle.ensureDocument();
  await offscreen.createStarted;
  const close = lifecycle.closeDocument();
  offscreen.finishCreate();
  await offscreen.closeStarted;
  offscreen.finishClose();

  await ensure;
  assert.equal(await close, false);
  assert.equal(await lifecycle.hasDocument(), false);
}

async function testEnsureWaitsForInFlightClose() {
  const offscreen = new FakeOffscreen(true);
  const lifecycle = createOffscreenLifecycle(offscreen);

  const close = lifecycle.closeDocument();
  await offscreen.closeStarted;
  const ensure = lifecycle.ensureDocument();
  offscreen.finishClose();
  await offscreen.createStarted;
  offscreen.finishCreate();

  assert.equal(await close, false);
  assert.equal(await ensure, true);
  assert.equal(offscreen.closeCount, 1);
  assert.equal(offscreen.createCount, 1);
  assert.equal(await lifecycle.hasDocument(), true);
}

async function testCloseWithoutDocumentReturnsFalse() {
  const lifecycle = createOffscreenLifecycle(new FakeOffscreen());
  assert.equal(await lifecycle.closeDocument(), false);
}
