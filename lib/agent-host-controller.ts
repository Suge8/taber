import type { AgentLocale } from './agent-instructions.ts';

export const AGENT_HOST_IDLE_TIMEOUT_MS = 120_000;

type OffscreenLifecycle = {
  ensureDocument(): Promise<boolean>;
  hasDocument(): Promise<boolean>;
  closeDocument(): Promise<boolean>;
};

type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timeoutId: unknown): void;
};

type HostMessageSender = (message: unknown) => Promise<unknown>;

type StartTaskRequest = {
  prompt: string;
  foregroundMode: boolean;
  sessionId?: number;
  windowId?: number;
  targetTabId?: number;
  targetTab?: unknown;
  locale?: AgentLocale;
};

export function createAgentHostController(options: {
  lifecycle: OffscreenLifecycle;
  sendToHost: HostMessageSender;
  scheduler?: Scheduler;
  idleTimeoutMs?: number;
}) {
  const scheduler: Scheduler = options.scheduler ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId as ReturnType<typeof globalThis.setTimeout>),
  };
  const idleTimeoutMs = options.idleTimeoutMs ?? AGENT_HOST_IDLE_TIMEOUT_MS;
  let idleTimer: unknown;
  let taskActive = false;

  async function startTask(request: StartTaskRequest) {
    clearIdleTimer();
    if (!(await options.lifecycle.ensureDocument())) throw new Error('AgentHost offscreen document was not created');
    const response = await options.sendToHost({ type: 'taber.agent.startTask', ...request });
    taskActive = true;
    return response;
  }

  async function stopTask() {
    if (!(await options.lifecycle.hasDocument())) return { stopped: false };
    return options.sendToHost({ type: 'taber.agent.stopTask' });
  }

  function markActive() {
    taskActive = true;
    clearIdleTimer();
  }

  function markIdle() {
    taskActive = false;
    clearIdleTimer();
    idleTimer = scheduler.setTimeout(() => {
      idleTimer = undefined;
      if (!taskActive) void options.lifecycle.closeDocument();
    }, idleTimeoutMs);
  }

  function closeNow() {
    taskActive = false;
    clearIdleTimer();
    return options.lifecycle.closeDocument();
  }

  function clearIdleTimer() {
    if (idleTimer === undefined) return;
    scheduler.clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  return { closeNow, markActive, markIdle, startTask, stopTask };
}
