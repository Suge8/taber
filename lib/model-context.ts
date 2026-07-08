import type { ModelMessage } from 'ai';
import { hideReasoningText, projectTaskGroups, projectToolEvidence, type ProjectedTaskGroup } from './agent-event-projection.ts';
import type { AgentEvent } from './db.ts';

export type TaskEventGroup = ProjectedTaskGroup;

export type CompactionSummary = {
  event: AgentEvent;
  fromEventId: number;
  toEventId: number;
  text: string;
};

export function deriveModelMessages(events: AgentEvent[], currentTaskId: string): ModelMessage[] {
  const summary = latestCompactionSummary(events);
  const messages: ModelMessage[] = [];
  if (summary) messages.push({ role: 'user', content: summaryMessage(summary.text) });

  const groups = taskGroupsAfter(events, summary?.toEventId ?? 0);
  for (const group of groups) {
    messages.push({ role: 'user', content: taskUserMessage(group, group.taskId === currentTaskId) });
    if (group.taskId === currentTaskId) continue;
    const assistant = taskAssistantMessage(group);
    if (assistant) messages.push({ role: 'assistant', content: assistant });
  }
  return messages;
}

export function estimateModelPromptTokens(input: { instructions: string; toolPromptText: string; messages: ModelMessage[] }): number {
  return estimateTokens(input.instructions) + estimateTokens(input.toolPromptText) + estimateTokens(JSON.stringify(input.messages));
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) char.charCodeAt(0) <= 0x7f ? ascii += 1 : nonAscii += 1;
  return Math.ceil(ascii / 4 + nonAscii);
}

export function compactableTaskGroups(events: AgentEvent[], currentTaskId: string): TaskEventGroup[] {
  const summary = latestCompactionSummary(events);
  return taskGroupsAfter(events, summary?.toEventId ?? 0).filter((group) => group.taskId !== currentTaskId && group.status !== 'running');
}

export function latestCompactionSummary(events: AgentEvent[]): CompactionSummary | undefined {
  for (const event of [...events].sort((left, right) => right.createdAt - left.createdAt || right.id - left.id)) {
    if (event.type !== 'context.compacted') continue;
    const payload = readRecord(event.payload);
    const text = readString(payload?.text);
    const fromEventId = readNumber(payload?.fromEventId);
    const toEventId = readNumber(payload?.toEventId);
    if (text && fromEventId !== undefined && toEventId !== undefined) return { event, fromEventId, toEventId, text: hideReasoningText(text) };
  }
  return undefined;
}

export function serializeTaskGroupsForCompaction(groups: TaskEventGroup[]): string {
  return groups.map((group) => {
    const lines = [`Task ${group.taskId}`, taskUserMessage(group, false)];
    const assistant = taskAssistantMessage(group);
    if (assistant) lines.push(`[Assistant]\n${assistant}`);
    return lines.join('\n\n');
  }).join('\n\n---\n\n');
}

export function taskGroupsAfter(events: AgentEvent[], afterEventId: number): TaskEventGroup[] {
  return projectTaskGroups(events, afterEventId);
}

export function serializeToolEvidenceForContext(event: AgentEvent): string | undefined {
  return projectToolEvidence(event);
}

function summaryMessage(text: string): string {
  return `The conversation history before this point was compacted into the following summary:\n<summary authority="model-generated">\n${hideReasoningText(text)}\n</summary>`;
}

function taskUserMessage(group: TaskEventGroup, currentTask: boolean): string {
  const lines: string[] = [];
  const contextText = formatBrowserContext(group.context);
  if (contextText) lines.push(`<browser_context authority="untrusted">\n${contextText}\n</browser_context>`);
  lines.push(`[User request]\n${group.prompt}`);
  if (!currentTask && group.toolEvidence.length > 0) lines.push(`<tool_evidence authority="untrusted">\n${group.toolEvidence.map((line) => `- ${line}`).join('\n')}\n</tool_evidence>`);
  if (!currentTask && group.status === 'failed') lines.push(`[Task failed]\n${group.error || 'Task failed.'}`);
  if (!currentTask && group.status === 'cancelled') lines.push('[Task cancelled by user]');
  return lines.filter(Boolean).join('\n\n');
}

function taskAssistantMessage(group: TaskEventGroup): string | undefined {
  return group.status === 'completed' ? group.completedText : undefined;
}

function formatBrowserContext(context: Record<string, unknown> | undefined): string {
  const title = hideReasoningText(readString(context?.title) ?? '');
  const url = readString(context?.url);
  if (!title && !url) return '';
  return `[Browser context]\n${[title ? `title: ${title}` : '', url ? `url: ${url}` : ''].filter(Boolean).join('\n')}`;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return Number.isFinite(value) ? Number(value) : undefined;
}
