import assert from 'node:assert/strict';
import { AGENT_HOST_IDLE_TIMEOUT_MS, createAgentHostController } from '../lib/agent-host-controller.ts';

await testStartCreatesHostAndSendsPrompt();
await testStopForwardsOnlyWhenHostExists();
await testIdleClosesAfterTwoMinutes();
await testNewActivityCancelsIdleClose();

console.info('agent host controller tests passed');

async function testStartCreatesHostAndSendsPrompt() {
  const calls: unknown[] = [];
  const lifecycle = createLifecycle();
  const controller = createAgentHostController({
    lifecycle,
    sendToHost: async (message) => {
      calls.push(message);
      return { taskId: 'task-1' };
    },
  });

  assert.deepEqual(await controller.startTask({ prompt: 'Summarize' }), { taskId: 'task-1' });
  assert.equal(lifecycle.ensureCount, 1);
  assert.deepEqual(calls[0], { type: 'taber.agent.startTask', prompt: 'Summarize' });
}

async function testStopForwardsOnlyWhenHostExists() {
  const calls: unknown[] = [];
  const lifecycle = createLifecycle(false);
  const controller = createAgentHostController({ lifecycle, sendToHost: async (message) => calls.push(message) });

  assert.deepEqual(await controller.stopTask(), { stopped: false });
  assert.equal(calls.length, 0);

  lifecycle.open = true;
  await controller.stopTask();
  assert.deepEqual(calls[0], { type: 'taber.agent.stopTask' });
}

async function testIdleClosesAfterTwoMinutes() {
  const lifecycle = createLifecycle(true);
  const scheduler = createScheduler();
  const controller = createAgentHostController({ lifecycle, scheduler, sendToHost: async () => undefined });

  controller.markIdle();
  assert.equal(scheduler.delayMs, AGENT_HOST_IDLE_TIMEOUT_MS);
  assert.equal(lifecycle.closeCount, 0);

  scheduler.fire();
  assert.equal(lifecycle.closeCount, 1);
}

async function testNewActivityCancelsIdleClose() {
  const lifecycle = createLifecycle(true);
  const scheduler = createScheduler();
  const controller = createAgentHostController({ lifecycle, scheduler, sendToHost: async () => undefined });

  controller.markIdle();
  controller.markActive();
  scheduler.fire();

  assert.equal(scheduler.clearCount, 1);
  assert.equal(lifecycle.closeCount, 0);
}

function createLifecycle(open = false) {
  return {
    open,
    ensureCount: 0,
    closeCount: 0,
    async ensureDocument() {
      this.ensureCount += 1;
      this.open = true;
      return true;
    },
    async hasDocument() {
      return this.open;
    },
    async closeDocument() {
      this.closeCount += 1;
      this.open = false;
      return false;
    },
  };
}

function createScheduler() {
  let callback: () => void = () => undefined;
  return {
    delayMs: 0,
    clearCount: 0,
    setTimeout(nextCallback: () => void, delayMs: number) {
      callback = nextCallback;
      this.delayMs = delayMs;
      return 1;
    },
    clearTimeout() {
      this.clearCount += 1;
      callback = () => undefined;
    },
    fire() {
      callback();
    },
  };
}
