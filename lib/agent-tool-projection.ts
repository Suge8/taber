import type { AgentEvent } from './db.ts';
import { hideReasoningText, projectToolEvidence } from './agent-event-text.ts';

export type ProjectedToolRun = {
  id: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  updatedAt: number;
  eventId: number;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
  taskId?: string;
  toolCallId?: string;
  title?: string;
  evidence?: string;
};

export function projectToolTimeline(events: AgentEvent[]): ProjectedToolRun[] {
  const items: ProjectedToolRun[] = [];
  const byCallId = new Map<string, ProjectedToolRun>();
  const pendingByName = new Map<string, ProjectedToolRun>();
  for (const event of events) {
    if (!event.type.startsWith('tool.')) continue;
    applyToolEvent(items, byCallId, pendingByName, event);
  }
  return items;
}

export function toolForEvent(event: AgentEvent, tools: Map<string, ProjectedToolRun>): ProjectedToolRun | undefined {
  const toolCallId = readString(readRecord(event.payload)?.toolCallId);
  return tools.get(toolCallId ? `tool-${toolCallId}` : `event-${event.id}`);
}

function applyToolEvent(
  items: ProjectedToolRun[],
  byCallId: Map<string, ProjectedToolRun>,
  pendingByName: Map<string, ProjectedToolRun>,
  event: AgentEvent,
) {
  const payload = readRecord(event.payload) ?? {};
  const toolName = readString(payload.toolName) || 'tool';
  const toolCallId = readString(payload.toolCallId);
  const taskId = readString(payload.taskId);
  const findOrCreate = (input: unknown, status: ProjectedToolRun['status']) => {
    const existing = toolCallId ? byCallId.get(toolCallId) : pendingByName.get(toolName);
    if (existing) return existing;
    const item: ProjectedToolRun = { id: toolCallId ? `tool-${toolCallId}` : `event-${event.id}`, toolName, status, createdAt: event.createdAt, updatedAt: event.createdAt, eventId: event.id, input, taskId, toolCallId };
    items.push(item);
    if (toolCallId) byCallId.set(toolCallId, item);
    else pendingByName.set(toolName, item);
    return item;
  };

  if (event.type === 'tool.input.started') {
    const item = findOrCreate('', 'pending');
    item.status = item.status === 'completed' || item.status === 'failed' ? item.status : 'pending';
    item.title = readString(payload.title) ?? item.title;
    item.updatedAt = event.createdAt;
    return;
  }

  if (event.type === 'tool.input.appended') {
    const item = findOrCreate('', 'pending');
    item.input = appendToolInput(item.input, readString(payload.delta) ?? '');
    item.updatedAt = event.createdAt;
    return;
  }

  if (event.type === 'tool.input.completed') {
    const item = findOrCreate(payload.input, 'pending');
    item.input = payload.input;
    item.title = readString(payload.title) ?? item.title;
    item.updatedAt = event.createdAt;
    return;
  }

  if (event.type === 'tool.started') {
    const item = findOrCreate(payload.input, 'running');
    item.status = 'running';
    item.input = payload.input;
    item.updatedAt = event.createdAt;
    return;
  }

  if (event.type !== 'tool.completed' && event.type !== 'tool.failed') return;
  const item = findOrCreate(payload.input, 'running');
  item.status = event.type === 'tool.failed' ? 'failed' : 'completed';
  item.updatedAt = event.createdAt;
  item.output = event.type === 'tool.completed' ? payload.output : undefined;
  item.error = event.type === 'tool.failed' ? hideReasoningText(readString(payload.error) || 'Tool failed.') : undefined;
  item.durationMs = readFiniteNumber(payload.durationMs) ?? item.durationMs;
  item.evidence = projectToolEvidence(event);
  item.taskId ??= taskId;
  item.toolCallId ??= toolCallId;
  if (!toolCallId && pendingByName.get(toolName) === item) pendingByName.delete(toolName);
}

function appendToolInput(input: unknown, delta: string) {
  return typeof input === 'string' ? input + delta : delta;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
