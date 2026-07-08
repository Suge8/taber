import type { AgentEvent } from './db.ts';
import { domainFromUrl, hideReasoningText, projectToolEvidence } from './agent-event-text.ts';
import { projectToolTimeline, toolForEvent, type ProjectedToolRun } from './agent-tool-projection.ts';
export { domainFromUrl, formatPayload, formatRawEvidence, hideReasoningText, projectToolEvidence } from './agent-event-text.ts';
export type { ProjectedToolRun } from './agent-tool-projection.ts';

const terminalTaskEvents = new Set(['task.completed', 'task.cancelled', 'task.failed']);
const urlKeyPattern = /(?:^|url$|Url$|URL$|href$|source$|sourceUrl$)/;
const faviconKeyPattern = /favIconUrl|faviconUrl/i;

export type AgentTaskState = 'idle' | 'running';
export type ProjectedTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ProjectedSourceFallback = 'currentTab' | 'tool';

export type ProjectedTaskGroup = {
  taskId: string;
  started: AgentEvent;
  events: AgentEvent[];
  status: ProjectedTaskStatus;
  prompt: string;
  toolEvidence: string[];
  terminal?: AgentEvent;
  context?: Record<string, unknown>;
  completedText?: string;
  error?: string;
};

export type ProjectedConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  taskId?: string;
};

export type ProjectedReasoningRun = {
  id: string;
  reasoningId: string;
  status: 'running' | 'completed';
  createdAt: number;
  updatedAt: number;
  eventId: number;
  text: string;
  taskId?: string;
};

export type ProjectedAssistantTimelinePart =
  | { kind: 'tool'; id: string; createdAt: number; tool: ProjectedToolRun }
  | { kind: 'reasoning'; id: string; createdAt: number; reasoning: ProjectedReasoningRun }
  | { kind: 'text'; id: string; createdAt: number; message: ProjectedConversationMessage };

export type ProjectedAssistantTimelineTurn = {
  id: string;
  taskId?: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  parts: ProjectedAssistantTimelinePart[];
};

export type ProjectedTimelineEntry =
  | { kind: 'message'; id: string; createdAt: number; message: ProjectedConversationMessage }
  | { kind: 'assistantTurn'; id: string; createdAt: number; turn: ProjectedAssistantTimelineTurn };

export type ProjectedSource = {
  url: string;
  domain: string;
  fallbackLabel: ProjectedSourceFallback;
  label?: string;
  fallbackText?: string;
  faviconUrl?: string;
  tabId?: number;
  windowId?: number;
};

export type ProjectedImage = {
  src: string;
  source?: string;
  width?: number;
  height?: number;
  alt?: string;
};

export type AgentEventProjection = {
  taskState: AgentTaskState;
  taskGroups: ProjectedTaskGroup[];
  conversation: ProjectedConversationMessage[];
  tools: ProjectedToolRun[];
  timeline: ProjectedTimelineEntry[];
  sources: ProjectedSource[];
  currentTask?: ProjectedTaskGroup;
  image?: ProjectedImage;
};

export function projectAgentEvents(events: AgentEvent[]): AgentEventProjection {
  const orderedEvents = sortEvents(events);
  const taskGroups = projectTaskGroups(orderedEvents);
  const currentTask = currentTaskGroup(orderedEvents, taskGroups);
  const conversation = projectConversation(orderedEvents);
  const tools = projectToolTimeline(orderedEvents);
  return {
    taskState: currentTask?.status === 'running' ? 'running' : 'idle',
    taskGroups,
    currentTask,
    conversation,
    tools,
    timeline: projectTimeline(taskGroups, conversation, tools),
    sources: projectSources(orderedEvents, currentTask),
    image: projectLatestImage(orderedEvents),
  };
}

export function projectTaskGroups(events: AgentEvent[], afterEventId = 0): ProjectedTaskGroup[] {
  const groups: ProjectedTaskGroup[] = [];
  let current: ProjectedTaskGroup | undefined;
  for (const event of sortEvents(events)) {
    if (event.id <= afterEventId || event.type === 'context.compacted') continue;
    const payload = readRecord(event.payload);
    if (event.type === 'task.started') {
      const taskId = readString(payload?.taskId);
      if (!taskId) {
        current = undefined;
        continue;
      }
      current = {
        taskId,
        started: event,
        events: [event],
        status: 'running',
        prompt: hideReasoningText(readString(payload?.prompt) ?? ''),
        context: readRecord(payload?.context),
        toolEvidence: [],
      };
      groups.push(current);
      continue;
    }
    if (!current || eventBelongsToOtherTask(event, current.taskId)) continue;
    current.events.push(event);
    if (event.type === 'task.targetChanged') current.context = readRecord(payload?.tab) ?? current.context;
    const evidence = projectToolEvidence(event);
    if (evidence) current.toolEvidence.push(evidence);
    if (isTerminalEvent(event)) {
      applyTerminal(current, event);
      current = undefined;
    }
  }
  return groups;
}

export function sourceFromBrowserContext(context: Record<string, unknown> | undefined): ProjectedSource | undefined {
  return createSource(readString(context?.url), readString(context?.title), 'currentTab', undefined, sourceMetadata(context));
}

function currentTaskGroup(events: AgentEvent[], taskGroups: ProjectedTaskGroup[]): ProjectedTaskGroup | undefined {
  const latestStart = events.findLast((event) => event.type === 'task.started');
  const taskId = readString(readRecord(latestStart?.payload)?.taskId);
  return taskId ? taskGroups.findLast((group) => group.started.id === latestStart?.id) : undefined;
}

function projectConversation(events: AgentEvent[]): ProjectedConversationMessage[] {
  const messages: ProjectedConversationMessage[] = [];
  const streamingMessages = new Map<string, ProjectedConversationMessage>();
  const streamedTaskIds = new Set<string>();

  for (const event of events) {
    const payload = readRecord(event.payload);
    if (event.type === 'task.started') {
      pushMessage(messages, event, 'user', readString(payload?.prompt), readString(payload?.taskId));
      continue;
    }
    if (event.type === 'task.completed') {
      const taskId = readString(payload?.taskId);
      if (!taskId || !streamedTaskIds.has(taskId)) pushMessage(messages, event, 'assistant', readString(payload?.text), taskId);
      continue;
    }
    if (event.type === 'message.created') {
      const role = payload?.role === 'user' || payload?.role === 'assistant' ? payload.role : undefined;
      upsertStreamingMessage(messages, streamingMessages, streamedTaskIds, event, role, readString(payload?.text) ?? '');
      continue;
    }
    if (event.type === 'message.appended') {
      const role = payload?.role === 'user' || payload?.role === 'assistant' ? payload.role : 'assistant';
      upsertStreamingMessage(messages, streamingMessages, streamedTaskIds, event, role, readString(payload?.delta) ?? readString(payload?.text) ?? '');
    }
  }

  for (const message of messages) message.text = hideReasoningText(message.text);
  return messages.filter((message) => message.text.trim());
}

function projectTimeline(taskGroups: ProjectedTaskGroup[], messages: ProjectedConversationMessage[], tools: ProjectedToolRun[]): ProjectedTimelineEntry[] {
  const entries: ProjectedTimelineEntry[] = [];
  const usedMessages = new Set<string>();
  const usedTools = new Set<string>();

  for (const group of taskGroups) {
    if (group.prompt) {
      const message = { id: `event-${group.started.id}`, role: 'user' as const, text: group.prompt, createdAt: group.started.createdAt, taskId: group.taskId };
      entries.push({ kind: 'message', id: `m:${message.id}`, createdAt: message.createdAt, message });
      usedMessages.add(message.id);
    }

    const taskEventIds = new Set(group.events.map((event) => event.id));
    const taskTools = tools.filter((tool) => tool.taskId === group.taskId || taskEventIds.has(tool.eventId));
    const turn = createTaskAssistantTurn(group, taskTools, usedMessages);
    if (turn) {
      entries.push({ kind: 'assistantTurn', id: `a:${turn.id}`, createdAt: turn.createdAt, turn });
      for (const part of turn.parts) if (part.kind === 'tool') usedTools.add(part.tool.id);
    }
  }

  const fallbackEntries = [
    ...messages.filter((message) => !usedMessages.has(message.id)).map((message) => ({ kind: 'message' as const, id: `m:${message.id}`, createdAt: message.createdAt, message })),
    ...tools.filter((tool) => !usedTools.has(tool.id)).map((tool) => createFallbackToolTurn(tool)),
  ];

  return [...entries, ...fallbackEntries].sort((left, right) => left.createdAt - right.createdAt);
}

function projectSources(events: AgentEvent[], currentTask: ProjectedTaskGroup | undefined): ProjectedSource[] {
  const sources = new Map<string, ProjectedSource>();
  const contextSource = sourceFromBrowserContext(currentTask?.context);
  if (contextSource) sources.set(contextSource.url, contextSource);
  for (const event of events) {
    if (event.type !== 'tool.completed') continue;
    const payload = readRecord(event.payload);
    const output = readRecord(payload?.output);
    if (output?.ok === false) continue;
    collectUrls(sources, output ?? payload?.output, readString(payload?.toolName));
  }
  return [...sources.values()].slice(0, 5);
}

function projectLatestImage(events: AgentEvent[]): ProjectedImage | undefined {
  for (const event of [...events].reverse()) {
    const payload = readRecord(event.payload);
    if (event.type !== 'tool.completed' || readString(payload?.toolName) !== 'extractImage') continue;
    const output = readRecord(payload?.output);
    if (output?.ok !== true) continue;
    const src = readString(output.dataUrl);
    if (!src) continue;
    return {
      src,
      source: readString(output?.source),
      width: Number.isFinite(output?.width) ? Number(output?.width) : undefined,
      height: Number.isFinite(output?.height) ? Number(output?.height) : undefined,
      alt: readString(output?.alt),
    };
  }
  return undefined;
}

function applyTerminal(group: ProjectedTaskGroup, terminal: AgentEvent): void {
  const payload = readRecord(terminal.payload);
  group.terminal = terminal;
  if (terminal.type === 'task.completed') {
    group.status = 'completed';
    group.completedText = hideReasoningText(readString(payload?.text) ?? '');
  } else if (terminal.type === 'task.failed') {
    group.status = 'failed';
    group.error = hideReasoningText(readString(payload?.error) || 'Task failed.');
  } else {
    group.status = 'cancelled';
  }
}

function createTaskAssistantTurn(group: ProjectedTaskGroup, tools: ProjectedToolRun[], usedMessages: Set<string>): ProjectedAssistantTimelineTurn | undefined {
  const parts: ProjectedAssistantTimelinePart[] = [];
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const reasoningById = new Map<string, ProjectedReasoningRun>();
  const usedTools = new Set<string>();
  const usedReasoning = new Set<string>();
  let textSegment: { id: string; createdAt: number; text: string } | undefined;
  let segmentIndex = 0;
  let sawAssistantText = false;

  const flushText = () => {
    if (!textSegment) return;
    const text = hideReasoningText(textSegment.text);
    if (text.trim()) parts.push({ kind: 'text', id: `text:${textSegment.id}`, createdAt: textSegment.createdAt, message: { id: textSegment.id, role: 'assistant', text, createdAt: textSegment.createdAt, taskId: group.taskId } });
    textSegment = undefined;
  };

  const appendText = (event: AgentEvent, text: string) => {
    if (!text) return;
    textSegment ??= { id: `segment-${group.taskId}-${++segmentIndex}`, createdAt: event.createdAt, text: '' };
    textSegment.text += text;
    sawAssistantText = true;
  };

  for (const event of group.events) {
    if (event.id === group.started.id) continue;
    const payload = readRecord(event.payload);
    if (event.type === 'message.created' || event.type === 'message.appended') {
      const role = payload?.role === 'user' || payload?.role === 'assistant' ? payload.role : 'assistant';
      if (role !== 'assistant') continue;
      appendText(event, readString(payload?.delta) ?? readString(payload?.text) ?? '');
      usedMessages.add(readString(payload?.messageId) ?? `event-${event.id}`);
      continue;
    }
    if (event.type.startsWith('reasoning.')) {
      const reasoning = reasoningForEvent(event, reasoningById);
      if (reasoning && !usedReasoning.has(reasoning.id)) {
        flushText();
        parts.push({ kind: 'reasoning', id: `reasoning:${reasoning.id}`, createdAt: reasoning.createdAt, reasoning });
        usedReasoning.add(reasoning.id);
      }
      continue;
    }
    if (event.type.startsWith('tool.')) {
      const tool = toolForEvent(event, toolById);
      if (tool && !usedTools.has(tool.id)) {
        flushText();
        parts.push({ kind: 'tool', id: `tool:${tool.id}`, createdAt: tool.createdAt, tool });
        usedTools.add(tool.id);
      }
      continue;
    }
    if (event.type === 'task.targetChanged') continue;
    if (event.type === 'task.completed' && !sawAssistantText) {
      appendText(event, group.completedText ?? '');
      usedMessages.add(`event-${event.id}`);
    }
  }
  flushText();

  if (parts.length === 0 && group.status === 'failed') {
    const createdAt = group.terminal?.createdAt ?? group.started.createdAt;
    const text = group.error || 'Task failed.';
    parts.push({ kind: 'text', id: `error:${group.taskId}`, createdAt, message: { id: `error:${group.taskId}`, role: 'assistant', text, createdAt, taskId: group.taskId } });
  }

  if (parts.length === 0) return undefined;
  const updatedAt = Math.max(...parts.map((part) => partUpdatedAt(part)));
  return { id: group.taskId, taskId: group.taskId, status: taskTurnStatus(group, tools), createdAt: parts[0]?.createdAt ?? 0, updatedAt, parts };
}

function taskTurnStatus(group: ProjectedTaskGroup, tools: ProjectedToolRun[]): ProjectedAssistantTimelineTurn['status'] {
  if (group.status === 'running') return 'running';
  if (group.status === 'failed' || tools.some((tool) => tool.status === 'failed')) return 'failed';
  return 'completed';
}

function createFallbackToolTurn(tool: ProjectedToolRun): ProjectedTimelineEntry {
  const turn: ProjectedAssistantTimelineTurn = { id: tool.taskId ?? tool.id, taskId: tool.taskId, status: tool.status === 'failed' ? 'failed' : tool.status === 'pending' || tool.status === 'running' ? 'running' : 'completed', createdAt: tool.createdAt, updatedAt: tool.updatedAt, parts: [{ kind: 'tool', id: `tool:${tool.id}`, createdAt: tool.createdAt, tool }] };
  return { kind: 'assistantTurn', id: `a:${turn.id}`, createdAt: turn.createdAt, turn };
}

function pushMessage(messages: ProjectedConversationMessage[], event: AgentEvent, role: ProjectedConversationMessage['role'] | undefined, text: string | undefined, taskId?: string): void {
  if (!role || !text) return;
  messages.push({ id: `event-${event.id}`, role, text, createdAt: event.createdAt, taskId });
}

function upsertStreamingMessage(
  messages: ProjectedConversationMessage[],
  streamingMessages: Map<string, ProjectedConversationMessage>,
  streamedTaskIds: Set<string>,
  event: AgentEvent,
  role: ProjectedConversationMessage['role'] | undefined,
  text: string,
): void {
  if (!role) return;
  const payload = readRecord(event.payload);
  const messageId = readString(payload?.messageId) ?? `event-${event.id}`;
  const taskId = readString(payload?.taskId);
  let message = streamingMessages.get(messageId);
  if (!message) {
    message = { id: messageId, role, text: '', createdAt: event.createdAt, taskId };
    streamingMessages.set(messageId, message);
    messages.push(message);
  }
  if (taskId) message.taskId = taskId;
  message.text += text;
  if (taskId && text) streamedTaskIds.add(taskId);
}

function partUpdatedAt(part: ProjectedAssistantTimelinePart) {
  if (part.kind === 'tool') return part.tool.updatedAt;
  if (part.kind === 'reasoning') return part.reasoning.updatedAt;
  return part.createdAt;
}

function reasoningForEvent(event: AgentEvent, items: Map<string, ProjectedReasoningRun>): ProjectedReasoningRun | undefined {
  const payload = readRecord(event.payload) ?? {};
  const reasoningId = readString(payload.reasoningId);
  if (!reasoningId) return undefined;
  const id = `reasoning-${reasoningId}`;
  let item = items.get(id);
  if (!item) {
    item = { id, reasoningId, status: 'running', createdAt: event.createdAt, updatedAt: event.createdAt, eventId: event.id, text: '', taskId: readString(payload.taskId) };
    items.set(id, item);
  }
  item.updatedAt = event.createdAt;
  if (event.type === 'reasoning.appended') item.text += hideReasoningText(readString(payload.delta) ?? '');
  if (event.type === 'reasoning.completed') item.status = 'completed';
  return item;
}

function collectUrls(sources: Map<string, ProjectedSource>, value: unknown, fallbackText: string | undefined): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(sources, item, fallbackText);
    return;
  }
  const record = value as Record<string, unknown>;
  const label = readString(record.title) || readString(record.label);
  const metadata = sourceMetadata(record);
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && urlKeyPattern.test(key) && !faviconKeyPattern.test(key)) {
      const source = createSource(item, label, 'tool', fallbackText, metadata);
      if (source && !sources.has(source.url)) sources.set(source.url, source);
    } else {
      collectUrls(sources, item, fallbackText);
    }
  }
}

function createSource(url: string | undefined, label: string | undefined, fallbackLabel: ProjectedSourceFallback, fallbackText: string | undefined, metadata: { faviconUrl?: string; tabId?: number; windowId?: number } = {}): ProjectedSource | undefined {
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  return { url, label, fallbackLabel, fallbackText, domain: domainFromUrl(url), faviconUrl: metadata.faviconUrl || faviconFromUrl(url), ...(metadata.tabId ? { tabId: metadata.tabId } : {}), ...(metadata.windowId ? { windowId: metadata.windowId } : {}) };
}

function sourceMetadata(record: Record<string, unknown> | undefined): { faviconUrl?: string; tabId?: number; windowId?: number } {
  return {
    faviconUrl: readString(record?.favIconUrl) || readString(record?.faviconUrl),
    tabId: readPositiveInteger(record?.id) || readPositiveInteger(record?.tabId),
    windowId: readPositiveInteger(record?.windowId),
  };
}

function faviconFromUrl(url: string): string | undefined {
  try {
    return new URL('/favicon.ico', url).href;
  } catch {
    return undefined;
  }
}

function eventBelongsToOtherTask(event: AgentEvent, taskId: string): boolean {
  const eventTaskId = readString(readRecord(event.payload)?.taskId);
  return Boolean(eventTaskId && eventTaskId !== taskId);
}

function isTerminalEvent(event: AgentEvent): boolean {
  return terminalTaskEvents.has(event.type);
}

function sortEvents(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort(compareEventOrder);
}

function compareEventOrder(left: AgentEvent, right: AgentEvent): number {
  return left.createdAt - right.createdAt || left.id - right.id;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
