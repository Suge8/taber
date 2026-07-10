import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { stepCountIs, ToolLoopAgent } from 'ai';
import { browser } from 'wxt/browser';
import { isOperableTab } from '../../lib/active-tab';
import { browserPageScriptConsentKey } from '../../lib/browser-access';
import { createAgentToolPromptEstimateText, createAgentTools } from '../../lib/agent-tools';
import { AGENT_HOST_IDLE_TIMEOUT_MS } from '../../lib/agent-host-controller';
import { collectAgentResponseText } from '../../lib/agent-stream';
import {
  appendAgentEvent,
  createSession,
  database,
  initializeDatabase,
  readSessionSnapshot,
  type AgentEvent,
  type Model,
  type Provider,
} from '../../lib/db';
import { compactContext, contextLimit, needsCompaction } from '../../lib/context-compaction';
import { createDeltaCoalescer } from '../../lib/event-coalescer';
import { codexProviderOptions, createCodexLanguageModel } from '../../lib/codex-runtime';
import { readFreshCodexTokens } from '../../lib/codex-provider';
import { deriveModelMessages, estimateModelPromptTokens } from '../../lib/model-context';
import { createOpenAIApiLanguageModel, openAIProviderOptions } from '../../lib/openai-runtime';
import { readFreshXaiTokens } from '../../lib/xai-provider';
import { createXaiLanguageModel, xaiProviderOptions } from '../../lib/xai-runtime';
import { readSelectedConfiguredModel } from '../../lib/provider-config-flow';
import { getProviderApiKey, getReasoningEffort, reasoningProviderOptionsForModel } from '../../lib/provider-store';
import { skillsDigestForTask } from '../../lib/skills';
import { seedBuiltinSkills } from '../../lib/skills-seeds';
import { AGENT_INSTRUCTIONS_VERSION, instructionsByLocale, readAgentLocale, type AgentLocale } from '../../lib/agent-instructions';

type TargetTabContext = { id: number; windowId?: number; title?: string; url?: string; favIconUrl?: string };

let runningTask:
  | {
      abortController: AbortController;
      sessionId: number;
      taskId: string;
      targetTabId: number;
      targetTab: TargetTabContext;
      windowId?: number;
      fatalError?: string;
    }
  | undefined;
let idleCloseTimer: ReturnType<typeof setTimeout> | undefined;

const MAX_AGENT_STEPS = 20;
const AGENT_STEP_TIMEOUT_MS = 5 * 60_000;
const AGENT_TOTAL_TIMEOUT_MS = 30 * 60_000;

void initializeDatabase()
  .then(async () => {
    await seedBuiltinSkills().catch((error) => console.warn('Taber builtin skills seeding failed', error));
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
      if (message.type === 'taber.agent.switchTarget') {
        void switchTarget(message).then(sendResponse, sendError(sendResponse));
        return true;
      }
      if (message.type === 'taber.background.tabRemoved') {
        handleTargetTabRemoved(message);
        return false;
      }
      if (message.type === 'taber.background.tabUpdated') {
        handleTargetTabUpdated(message);
        return false;
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
  const locale = readAgentLocale(message.locale);
  const targetTab = readTargetTab(message.targetTab, message.targetTabId, windowId);
  const abortController = new AbortController();
  runningTask = { abortController, sessionId, taskId, targetTabId: targetTab.id, targetTab, windowId };

  showTargetOverlay(targetTab.id);
  void notifyBackground('taber.background.agentActive');
  await emitAgentEvent(sessionId, 'task.started', { taskId, prompt, context: targetTab, instructionsVersion: AGENT_INSTRUCTIONS_VERSION });
  void runAgentTask({ abortController, prompt, sessionId, taskId, targetTabId: targetTab.id, targetTabUrl: targetTab.url, windowId, locale });

  return { sessionId, taskId };
}

async function stopTask() {
  if (!runningTask) return { stopped: false };
  runningTask.abortController.abort();
  hideTargetOverlay(runningTask.targetTabId);
  await emitAgentEvent(runningTask.sessionId, 'task.stopRequested', { taskId: runningTask.taskId });
  return { stopped: true, taskId: runningTask.taskId };
}

async function switchTarget(message: Record<string, unknown>) {
  if (!runningTask) throw new Error('No running Taber task');
  const targetTab = readTargetTab(message.targetTab, message.targetTabId, readWindowId(message.windowId) ?? runningTask.windowId);
  if (targetTab.id === runningTask.targetTabId) return { changed: false, taskId: runningTask.taskId, targetTab };
  await updateRunningTarget(runningTask.sessionId, runningTask.taskId, { toTabId: targetTab.id, reason: readString(message.reason) || 'userCurrentTab', tab: targetTab });
  return { changed: true, taskId: runningTask.taskId, targetTab };
}

function handleTargetTabRemoved(message: Record<string, unknown>) {
  const tabId = readPositiveInteger(message.tabId);
  if (!runningTask || tabId !== runningTask.targetTabId) return;
  void failRunningTask(runningTask.taskId, `Target tab is no longer available: ${tabId}`);
}

function handleTargetTabUpdated(message: Record<string, unknown>) {
  if (!runningTask) return;
  const tab = readTargetTab(message.tab, undefined, runningTask.windowId);
  if (tab.id !== runningTask.targetTabId) return;
  runningTask.targetTab = tab;
  // Non-operable pages no longer fail the task: page tools report recoverable
  // errors and navigate.open can steer the tab back to a real site.
  if (!isOperableTab(tab)) {
    hideTargetOverlay(tab.id);
    return;
  }
  showTargetOverlay(tab.id);
}

async function runAgentTask(task: {
  abortController: AbortController;
  prompt: string;
  sessionId: number;
  taskId: string;
  targetTabId: number;
  targetTabUrl?: string;
  windowId?: number;
  locale: AgentLocale;
}) {
  try {
    const skillsDigest = await skillsDigestForTask(task.targetTabUrl, task.prompt);
    const instructions = skillsDigest ? `${instructionsByLocale[task.locale]}

${skillsDigest}` : instructionsByLocale[task.locale];
    const runtime = await createConfiguredRuntime(task, instructions);
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
    const result = await runtime.agent.stream({
      messages,
      abortSignal: task.abortController.signal,
      timeout: { stepMs: AGENT_STEP_TIMEOUT_MS, totalMs: AGENT_TOTAL_TIMEOUT_MS },
    });
    const messageId = crypto.randomUUID();
    const deltas = createDeltaCoalescer((type, payload) => emitAgentEvent(task.sessionId, type, payload));
    const emitFlushed = async (type: string, payload: unknown) => {
      await deltas.flush();
      await emitAgentEvent(task.sessionId, type, payload);
    };
    const text = await collectAgentResponseText(result, {
      createMessage: () => emitFlushed('message.created', { taskId: task.taskId, messageId, role: 'assistant', text: '' }),
      appendText: (delta) => deltas.append('message.appended', messageId, { taskId: task.taskId, messageId }, delta),
      startReasoning: ({ reasoningId }) => emitFlushed('reasoning.started', { taskId: task.taskId, reasoningId }),
      appendReasoning: ({ reasoningId, delta }) => deltas.append('reasoning.appended', reasoningId, { taskId: task.taskId, reasoningId }, delta),
      completeReasoning: ({ reasoningId }) => emitFlushed('reasoning.completed', { taskId: task.taskId, reasoningId }),
      startToolInput: ({ toolCallId, toolName, title }) => emitFlushed('tool.input.started', { taskId: task.taskId, toolCallId, toolName, title }),
      appendToolInput: ({ toolCallId, delta }) => deltas.append('tool.input.appended', toolCallId, { taskId: task.taskId, toolCallId }, delta),
      completeToolInput: ({ toolCallId, toolName, input, title }) => emitFlushed('tool.input.completed', { taskId: task.taskId, toolCallId, toolName, input, title }),
      failToolCall: ({ toolCallId, toolName, error }) => emitFlushed('tool.failed', { taskId: task.taskId, toolCallId, toolName, error }),
    }, {
      abortSignal: task.abortController.signal,
      onHealthFailure: (error) => { void failRunningTask(task.taskId, error); },
    }).finally(() => deltas.flush());
    if (task.abortController.signal.aborted) throw new Error('Task aborted');
    await emitAgentEvent(task.sessionId, 'task.completed', { taskId: task.taskId, text });
  } catch (error) {
    const fatalError = runningTask?.taskId === task.taskId ? runningTask.fatalError : undefined;
    if (fatalError) {
      await emitAgentEvent(task.sessionId, 'task.failed', { taskId: task.taskId, error: fatalError });
    } else if (task.abortController.signal.aborted) {
      await emitAgentEvent(task.sessionId, 'task.cancelled', { taskId: task.taskId });
    } else {
      await emitAgentEvent(task.sessionId, 'task.failed', { taskId: task.taskId, error: stringifyError(error) });
    }
  } finally {
    if (runningTask?.taskId === task.taskId) {
      hideTargetOverlay(runningTask.targetTabId);
      runningTask = undefined;
    }
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

async function createConfiguredRuntime(
  task: { sessionId: number; taskId: string; windowId?: number; targetTabId: number; targetTabUrl?: string },
  instructions: string,
) {
  const { sessionId, taskId, windowId, targetTabId, targetTabUrl } = task;
  const modelRecord = await readSelectedModel();
  const providerRecord = await database.providers.get(modelRecord.providerId);
  if (!providerRecord) throw new Error(`Model provider not found: ${modelRecord.providerId}`);

  const reasoningEffort = await getReasoningEffort();
  const model = await createLanguageModel(providerRecord, modelRecord, reasoningEffort);
  const providerOptions = languageModelProviderOptions(providerRecord.kind, modelRecord, reasoningEffort);
  const browserJsEnabled = await readBrowserJsEnabled();
  const toolPromptText = createAgentToolPromptEstimateText({ browserJsEnabled });
  return {
    modelRecord,
    model,
    toolPromptText,
    agent: new ToolLoopAgent({
      model,
      instructions,
      stopWhen: stepCountIs(MAX_AGENT_STEPS),
      ...(providerOptions ? { providerOptions } : {}),
      tools: createAgentTools({
        sessionId,
        taskId,
        windowId,
        targetTabId,
        targetTabUrl,
        getTargetTabId: () => runningTask?.taskId === taskId ? runningTask.targetTabId : targetTabId,
        sendMessage: (message) => browser.runtime.sendMessage(message),
        emitEvent: (type, payload) => emitAgentEvent(sessionId, type, payload),
        onTargetChanged: (change) => updateRunningTarget(sessionId, taskId, change),
        onTargetUnavailable: (error) => failRunningTask(taskId, error),
        browserJsEnabled,
      }),
    }),
  };
}

type ReasoningEffortSetting = Awaited<ReturnType<typeof getReasoningEffort>>;

async function createLanguageModel(providerRecord: Provider, modelRecord: Model, reasoningEffort: ReasoningEffortSetting) {
  const shared = { modelId: modelRecord.name, providerName: providerRecord.name, baseURL: providerRecord.baseURL };
  if (providerRecord.kind === 'openaiCodex') {
    return createCodexLanguageModel({ ...shared, reasoningEffort, supportedReasoningEfforts: modelRecord.supportedReasoningEfforts, auth: () => readFreshCodexTokens(providerRecord.id) });
  }
  if (providerRecord.kind === 'xaiSub') {
    return createXaiLanguageModel({
      ...shared,
      reasoningEffort,
      supportedReasoningEfforts: modelRecord.supportedReasoningEfforts,
      auth: async () => ({ accessToken: (await readFreshXaiTokens(providerRecord.id)).accessToken }),
    });
  }
  const apiKey = await getProviderApiKey(providerRecord.id);
  if (providerRecord.kind === 'openaiApiKey') return createOpenAIApiLanguageModel({ ...shared, apiKey });
  return createOpenAICompatible({ name: providerRecord.name, baseURL: providerRecord.baseURL, apiKey })(modelRecord.name);
}

function languageModelProviderOptions(kind: Provider['kind'], modelRecord: Model, reasoningEffort: ReasoningEffortSetting) {
  if (kind === 'openaiCodex') return codexProviderOptions(reasoningEffort, modelRecord.supportedReasoningEfforts);
  if (kind === 'xaiSub') return xaiProviderOptions(reasoningEffort);
  if (kind === 'openaiApiKey') return openAIProviderOptions(reasoningEffort, modelRecord.supportedReasoningEfforts, modelRecord.name);
  return reasoningProviderOptionsForModel(reasoningEffort, modelRecord.supportedReasoningEfforts, modelRecord.name);
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

async function updateRunningTarget(sessionId: number, taskId: string, change: { fromTabId?: number; toTabId: number; reason: string; tab?: unknown }) {
  if (!runningTask || runningTask.taskId !== taskId) return;
  const targetTab = readTargetTab(change.tab, change.toTabId, runningTask.windowId);
  const fromTabId = change.fromTabId ?? runningTask.targetTabId;
  if (fromTabId !== targetTab.id) hideTargetOverlay(fromTabId);
  runningTask.targetTabId = targetTab.id;
  runningTask.targetTab = targetTab;
  if (fromTabId !== targetTab.id) showTargetOverlay(targetTab.id);
  await emitAgentEvent(sessionId, 'task.targetChanged', { taskId, fromTabId, toTabId: targetTab.id, reason: change.reason, tab: targetTab });
}

async function failRunningTask(taskId: string, error: string) {
  if (!runningTask || runningTask.taskId !== taskId || runningTask.fatalError) return;
  runningTask.fatalError = error;
  runningTask.abortController.abort();
}

function readTargetTab(value: unknown, fallbackTabId: unknown, fallbackWindowId?: number): TargetTabContext {
  const record = isRecord(value) ? value : {};
  const id = readPositiveInteger(record.id) ?? readPositiveInteger(fallbackTabId);
  if (!id) throw new Error('Task target tab is required');
  return {
    id,
    windowId: readPositiveInteger(record.windowId) ?? fallbackWindowId,
    title: readString(record.title),
    url: readString(record.url),
    favIconUrl: readString(record.favIconUrl),
  };
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

function readPositiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function showTargetOverlay(tabId: number) {
  sendTargetOverlayCommand(tabId, { action: 'show', message: 'Taber 正在控制此页', iconUrl: browser.runtime.getURL('/icons/icon-24.png') });
}

function hideTargetOverlay(tabId: number) {
  sendTargetOverlayCommand(tabId, { action: 'hide' });
}

function sendTargetOverlayCommand(tabId: number, command: unknown) {
  void browser.runtime.sendMessage({ type: 'taber.browserRepl.scriptingCommand', tabId, command: { helper: 'controlOverlay', args: [command], timeoutMs: 3_000 } }).then((response) => {
    if (isRecord(response) && typeof response.error === 'string') console.warn(`Taber overlay skipped for tab ${tabId}: ${response.error}`);
  }, (error) => console.warn(`Taber overlay skipped for tab ${tabId}: ${stringifyError(error)}`));
}

function notifyBackground(type: string) {
  return browser.runtime.sendMessage({ type }).catch(() => undefined);
}

function sendError(sendResponse: (response?: unknown) => void) {
  return (error: unknown) => sendResponse({ error: stringifyError(error) });
}

function stringifyError(error: unknown) {
  if (error instanceof Error) return error.message;
  const message = isRecord(error) ? readString(error.message) : undefined;
  return message ?? String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
