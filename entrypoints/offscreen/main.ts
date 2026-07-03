import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { isLoopFinished, ToolLoopAgent } from 'ai';
import { browser } from 'wxt/browser';
import { browserPageScriptConsentKey } from '../../lib/browser-access';
import { createAgentToolPromptEstimateText, createAgentTools } from '../../lib/agent-tools';
import { AGENT_HOST_IDLE_TIMEOUT_MS } from '../../lib/agent-host-controller';
import {
  appendAgentEvent,
  createSession,
  database,
  initializeDatabase,
  readSessionSnapshot,
  type AgentEvent,
} from '../../lib/db';
import { compactContext, contextLimit, needsCompaction } from '../../lib/context-compaction';
import { createCodexLanguageModel } from '../../lib/codex-runtime';
import { readFreshCodexTokens } from '../../lib/codex-provider';
import { deriveModelMessages, estimateModelPromptTokens } from '../../lib/model-context';
import { readSelectedConfiguredModel } from '../../lib/provider-config-flow';
import { getProviderApiKey, getReasoningEffort, reasoningProviderOptions } from '../../lib/provider-store';

const instructions = `You are Taber, a supervised browser agent. Use the available browser tools directly. Never expose raw chain-of-thought. Cite tool evidence when summarizing. Cookies are unavailable. Before interacting with a page based on prior context, re-observe or query the current page state.`;

let runningTask:
  | {
      abortController: AbortController;
      sessionId: number;
      taskId: string;
      windowId?: number;
    }
  | undefined;
let idleCloseTimer: ReturnType<typeof setTimeout> | undefined;

void initializeDatabase()
  .then(() => {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!isRecord(message)) return false;
      if (message.type === 'taber.agent.startTask') {
        void startTask(message).then(sendResponse, sendError(sendResponse));
        return true;
      }
      if (message.type === 'taber.agent.stopTask') {
        void stopTask().then(sendResponse, sendError(sendResponse));
        return true;
      }
      return false;
    });

    document.body.dataset.ready = 'true';
    console.info('Taber AgentHost ready');
  })
  .catch((error) => {
    document.body.dataset.ready = 'failed';
    console.error('Taber AgentHost failed to initialize', error);
  });

async function startTask(message: Record<string, unknown>) {
  if (runningTask) throw new Error('A Taber task is already running');
  if (typeof message.prompt !== 'string' || message.prompt.trim() === '') throw new Error('Task prompt is required');

  clearIdleCloseTimer();
  const prompt = message.prompt.trim();
  const sessionId = await resolveSessionId(message.sessionId, prompt);
  const taskId = crypto.randomUUID();
  const windowId = readWindowId(message.windowId);
  const abortController = new AbortController();
  runningTask = { abortController, sessionId, taskId, windowId };

  void notifyBackground('taber.background.agentActive');
  await emitAgentEvent(sessionId, 'task.started', { taskId, prompt, context: await readActiveTabContext(windowId) });
  void runAgentTask({ abortController, prompt, sessionId, taskId, windowId });

  return { sessionId, taskId };
}

async function stopTask() {
  if (!runningTask) return { stopped: false };
  runningTask.abortController.abort();
  await emitAgentEvent(runningTask.sessionId, 'task.stopRequested', { taskId: runningTask.taskId });
  return { stopped: true, taskId: runningTask.taskId };
}

async function runAgentTask(task: {
  abortController: AbortController;
  prompt: string;
  sessionId: number;
  taskId: string;
  windowId?: number;
}) {
  try {
    const runtime = await createConfiguredRuntime(task.sessionId, task.taskId, task.windowId);
    let events = (await readSessionSnapshot(task.sessionId)).agentEvents;
    const budget = { contextWindowTokens: runtime.modelRecord.contextWindowTokens, instructions, toolPromptText: runtime.toolPromptText };
    const compacted = await compactContext({
      events,
      currentTaskId: task.taskId,
      model: runtime.model,
      modelName: runtime.modelRecord.name,
      budget,
      appendCompaction: (payload) => emitAgentEvent(task.sessionId, 'context.compacted', payload),
    });
    if (compacted) events = (await readSessionSnapshot(task.sessionId)).agentEvents;
    const messages = deriveModelMessages(events, task.taskId);
    if (needsCompaction(events, task.taskId, budget) || estimateModelPromptTokens({ instructions, toolPromptText: runtime.toolPromptText, messages }) > contextLimit(runtime.modelRecord.contextWindowTokens)) throw new Error('Context is too large for the selected model. Choose a larger context model or start a new session.');
    const result = await runtime.agent.stream({ messages, abortSignal: task.abortController.signal });
    const messageId = crypto.randomUUID();
    let text = '';
    let messageCreated = false;
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'abort') throw new Error(part.reason ?? 'Task aborted');
      if (part.type !== 'text-delta') continue;
      if (!messageCreated) {
        await emitAgentEvent(task.sessionId, 'message.created', { taskId: task.taskId, messageId, role: 'assistant', text: '' });
        messageCreated = true;
      }
      text += part.text;
      await emitAgentEvent(task.sessionId, 'message.appended', { taskId: task.taskId, messageId, delta: part.text });
    }
    if (!messageCreated) {
      text = await result.text;
      if (text) {
        await emitAgentEvent(task.sessionId, 'message.created', { taskId: task.taskId, messageId, role: 'assistant', text: '' });
        await emitAgentEvent(task.sessionId, 'message.appended', { taskId: task.taskId, messageId, delta: text });
      }
    }
    if (task.abortController.signal.aborted) throw new Error('Task aborted');
    await emitAgentEvent(task.sessionId, 'task.completed', { taskId: task.taskId, text });
  } catch (error) {
    if (task.abortController.signal.aborted) {
      await emitAgentEvent(task.sessionId, 'task.cancelled', { taskId: task.taskId });
    } else {
      await emitAgentEvent(task.sessionId, 'task.failed', { taskId: task.taskId, error: stringifyError(error) });
    }
  } finally {
    if (runningTask?.taskId === task.taskId) runningTask = undefined;
    scheduleIdleClose();
    void notifyBackground('taber.background.agentIdle');
  }
}

function scheduleIdleClose() {
  clearIdleCloseTimer();
  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = undefined;
    if (!runningTask) void notifyBackground('taber.background.closeIdleHost');
  }, AGENT_HOST_IDLE_TIMEOUT_MS);
}

function clearIdleCloseTimer() {
  if (idleCloseTimer === undefined) return;
  clearTimeout(idleCloseTimer);
  idleCloseTimer = undefined;
}

async function createConfiguredRuntime(sessionId: number, taskId: string, windowId?: number) {
  const modelRecord = await readSelectedModel();
  const providerRecord = await database.providers.get(modelRecord.providerId);
  if (!providerRecord) throw new Error(`Model provider not found: ${modelRecord.providerId}`);

  const reasoningEffort = await getReasoningEffort();
  const model = providerRecord.kind === 'openaiCodex'
    ? createCodexLanguageModel({
        modelId: modelRecord.name,
        providerName: providerRecord.name,
        baseURL: providerRecord.baseURL,
        reasoningEffort,
        supportedReasoningEfforts: modelRecord.supportedReasoningEfforts,
        auth: () => readFreshCodexTokens(providerRecord.id),
      })
    : createOpenAICompatible({
        name: providerRecord.name,
        baseURL: providerRecord.baseURL,
        apiKey: await getProviderApiKey(providerRecord.id),
      })(modelRecord.name);
  const providerOptions = providerRecord.kind === 'openaiCodex' ? undefined : reasoningProviderOptions(reasoningEffort);
  const browserJsEnabled = await readBrowserJsEnabled();
  const toolPromptText = createAgentToolPromptEstimateText({ browserJsEnabled });
  return {
    modelRecord,
    model,
    toolPromptText,
    agent: new ToolLoopAgent({
      model,
      instructions,
      stopWhen: isLoopFinished(),
      ...(providerOptions ? { providerOptions } : {}),
      tools: createAgentTools({
        sessionId,
        taskId,
        windowId,
        sendMessage: (message) => browser.runtime.sendMessage(message),
        emitEvent: (type, payload) => emitAgentEvent(sessionId, type, payload),
        browserJsEnabled,
      }),
    }),
  };
}

async function readBrowserJsEnabled() {
  const setting = await database.settings.get(browserPageScriptConsentKey);
  return setting?.value === true;
}

async function readSelectedModel() {
  const model = await readSelectedConfiguredModel();
  if (!model) throw new Error('Model provider is not configured');
  return model;
}

async function resolveSessionId(value: unknown, prompt: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  const session = await createSession({ title: prompt.slice(0, 80) });
  return session.id;
}

async function readActiveTabContext(windowId?: number) {
  const tab = await browser.runtime.sendMessage({ type: 'taber.background.currentTab', windowId }).catch(() => undefined);
  if (!isRecord(tab)) return undefined;
  return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl };
}

async function emitAgentEvent(sessionId: number, type: string, payload: unknown) {
  const createdAt = Date.now();
  const id = await appendAgentEvent({ sessionId, type, payload, now: createdAt });
  const event: AgentEvent = { id, sessionId, type, payload, createdAt };
  void browser.runtime.sendMessage({ type: 'taber.agent.event', event }).catch(() => undefined);
}

function readWindowId(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function notifyBackground(type: string) {
  return browser.runtime.sendMessage({ type }).catch(() => undefined);
}

function sendError(sendResponse: (response?: unknown) => void) {
  return (error: unknown) => sendResponse({ error: stringifyError(error) });
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
