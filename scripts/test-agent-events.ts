import assert from 'node:assert/strict';
import { deriveTaskState } from '../lib/agent-events.ts';
import { projectAgentEvents } from '../lib/agent-event-projection.ts';

assert.equal(deriveTaskState([]), 'idle');
assert.equal(deriveTaskState([{ type: 'task.started', payload: { taskId: '1' } }]), 'running');
assert.equal(
  deriveTaskState([
    { type: 'task.started', payload: { taskId: '1' } },
    { type: 'task.stopRequested', payload: { taskId: '1' } },
  ]),
  'running',
);
assert.equal(
  deriveTaskState([
    { type: 'task.started', payload: { taskId: '1' } },
    { type: 'task.completed', payload: { taskId: '1' } },
  ]),
  'idle',
);
assert.equal(
  deriveTaskState([
    { type: 'task.started', payload: { taskId: '1' } },
    { type: 'task.failed', payload: { taskId: 'other' } },
  ]),
  'running',
);
assert.equal(
  deriveTaskState([
    { type: 'task.started', payload: { taskId: '1' } },
    { type: 'task.completed', payload: { taskId: '1' } },
    { type: 'task.started', payload: { taskId: '2' } },
  ]),
  'running',
);

const projection = projectAgentEvents([
  event(1, 'task.started', { taskId: '1', context: { id: 1, url: 'https://start.example', title: 'Start' } }),
  event(2, 'task.targetChanged', { taskId: '1', fromTabId: 1, toTabId: 2, reason: 'switchTab', tab: { id: 2, url: 'https://target.example', title: 'Target' } }),
]);
const startedPayload = projection.currentTask?.started.payload as { context?: { url?: string } } | undefined;
assert.equal(projection.currentTask?.context?.url, 'https://target.example');
assert.equal(startedPayload?.context?.url, 'https://start.example');
assert.equal(projection.timeline.length, 0);

const clockRollback = projectAgentEvents([
  { ...event(4, 'task.completed', { taskId: 'rollback', text: 'done' }), createdAt: 902 },
  { ...event(2, 'tool.started', { taskId: 'rollback', toolCallId: 'call-1', toolName: 'navigate', input: { action: 'currentTab' } }), createdAt: 900 },
  { ...event(1, 'task.started', { taskId: 'rollback', prompt: 'go' }), createdAt: 1000 },
  { ...event(3, 'tool.completed', { taskId: 'rollback', toolCallId: 'call-1', toolName: 'navigate', output: { action: 'currentTab' } }), createdAt: 901 },
]);
assert.equal(clockRollback.taskState, 'idle');
assert.equal(clockRollback.taskGroups[0]?.status, 'completed');
assert.equal(clockRollback.taskGroups[0]?.terminal?.id, 4);
assert.equal(clockRollback.tools[0]?.status, 'completed');
assert.deepEqual(clockRollback.timeline.map((entry) => entry.kind), ['message', 'assistantTurn']);

const groupedTools = projectAgentEvents([
  event(1, 'task.started', { taskId: 'first', prompt: 'first task' }),
  event(2, 'tool.completed', { taskId: 'first', toolCallId: 'first-call', toolName: 'navigate', output: { page: 'first' } }),
  event(3, 'task.completed', { taskId: 'first', text: 'first done' }),
  event(4, 'task.started', { taskId: 'second', prompt: 'second task' }),
  event(5, 'tool.completed', { toolName: 'getDocument', output: { page: 'second' } }),
  event(6, 'task.completed', { taskId: 'second', text: 'second done' }),
  event(7, 'tool.completed', { toolName: 'extractImage', output: { ok: false } }),
]);
assert.deepEqual(groupedTools.tools.map((tool) => [tool.id, tool.taskId, tool.status]), [
  ['tool-first-call', 'first', 'completed'],
  ['event-5', undefined, 'completed'],
  ['event-7', undefined, 'completed'],
]);
assert.deepEqual(groupedTools.timeline.map((entry) => [entry.kind, entry.id]), [
  ['message', 'm:event-1'],
  ['assistantTurn', 'a:first'],
  ['message', 'm:event-4'],
  ['assistantTurn', 'a:second'],
  ['assistantTurn', 'a:event-7'],
]);
assert.deepEqual(groupedTools.timeline.flatMap((entry) => entry.kind === 'assistantTurn'
  ? entry.turn.parts.filter((part) => part.kind === 'tool').map((part) => part.tool.id)
  : []), ['tool-first-call', 'event-5', 'event-7']);

console.info('agent event tests passed');

function event(id: number, type: string, payload: unknown) {
  return { id, sessionId: 1, type, payload, createdAt: id };
}
