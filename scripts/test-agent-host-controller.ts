import assert from 'node:assert/strict';
import { AGENT_HOST_IDLE_TIMEOUT_MS, createAgentHostController } from '../lib/agent-host-controller.ts';
import { instructionsByLocale, readAgentLocale } from '../lib/agent-instructions.ts';

await testStartCreatesHostAndSendsPrompt();
await testStartForwardsTargetTabAndMode();
await testStartForwardsLocale();
await testStartLocaleSelectsInstructions();
testAgentInstructionsLocale();
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

  assert.deepEqual(await controller.startTask({ prompt: 'Summarize', foregroundMode: false }), { taskId: 'task-1' });
  assert.equal(lifecycle.ensureCount, 1);
  assert.deepEqual(calls[0], { type: 'taber.agent.startTask', prompt: 'Summarize', foregroundMode: false });
}

async function testStartForwardsTargetTabAndMode() {
  const calls: unknown[] = [];
  const lifecycle = createLifecycle();
  const controller = createAgentHostController({
    lifecycle,
    sendToHost: async (message) => {
      calls.push(message);
      return { taskId: 'task-1' };
    },
  });

  await controller.startTask({ prompt: 'Fill form', foregroundMode: true, windowId: 3, targetTabId: 7, targetTab: { id: 7, windowId: 3, url: 'https://example.test' } });
  assert.deepEqual(calls[0], { type: 'taber.agent.startTask', prompt: 'Fill form', foregroundMode: true, windowId: 3, targetTabId: 7, targetTab: { id: 7, windowId: 3, url: 'https://example.test' } });
}

async function testStartForwardsLocale() {
  const calls: unknown[] = [];
  const lifecycle = createLifecycle();
  const controller = createAgentHostController({ lifecycle, sendToHost: async (message) => { calls.push(message); return { taskId: 'task-1' }; } });

  await controller.startTask({ prompt: '总结', foregroundMode: false, locale: 'zh' });
  await controller.startTask({ prompt: 'Summarize', foregroundMode: true, locale: 'en' });
  assert.deepEqual(calls[0], { type: 'taber.agent.startTask', prompt: '总结', foregroundMode: false, locale: 'zh' });
  assert.deepEqual(calls[1], { type: 'taber.agent.startTask', prompt: 'Summarize', foregroundMode: true, locale: 'en' });
}

async function testStartLocaleSelectsInstructions() {
  const lifecycle = createLifecycle();
  const controller = createAgentHostController({
    lifecycle,
    sendToHost: async (message) => {
      const locale = readAgentLocale((message as Record<string, unknown>).locale);
      return { instructions: instructionsByLocale[locale] };
    },
  });

  assert.match((await controller.startTask({ prompt: '总结', foregroundMode: false, locale: 'zh' }) as { instructions: string }).instructions, /你是 Taber/);
  assert.match((await controller.startTask({ prompt: 'Summarize', foregroundMode: true, locale: 'en' }) as { instructions: string }).instructions, /You are Taber/);
}

function testAgentInstructionsLocale() {
  assert.equal(readAgentLocale('zh'), 'zh');
  assert.equal(readAgentLocale('fr'), 'en');
  assert.match(instructionsByLocale.zh, /你是 Taber/);
  assert.match(instructionsByLocale.zh, /失败 3 次/);
  assert.match(instructionsByLocale.en, /You are Taber/);
  assert.match(instructionsByLocale.en, /After 3 failures/);
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
