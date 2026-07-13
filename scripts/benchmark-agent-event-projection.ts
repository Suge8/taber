import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { projectAgentEvents } from '../lib/agent-event-projection.ts';
import type { AgentEvent } from '../lib/db.ts';

const eventCounts = [2_500, 5_000, 10_000];
const medians = new Map<number, number>();

projectAgentEvents(createEvents(1_000));
for (const eventCount of eventCounts) {
  const events = createEvents(eventCount);
  projectAgentEvents(events);
  const durations = Array.from({ length: 5 }, () => measure(() => projectAgentEvents(events)));
  const median = durations.sort((left, right) => left - right)[Math.floor(durations.length / 2)]!;
  medians.set(eventCount, median);
  console.info(`${eventCount} events median: ${median.toFixed(2)}ms`);
}

const growthRatio = medians.get(10_000)! / medians.get(5_000)!;
console.info(`10k/5k growth ratio: ${growthRatio.toFixed(2)}`);
assert(growthRatio < 3, `Expected 10k/5k growth ratio below 3, received ${growthRatio.toFixed(2)}`);

function createEvents(eventCount: number): AgentEvent[] {
  assert.equal(eventCount % 10, 0);
  const events: AgentEvent[] = [];
  let eventId = 0;
  for (let taskIndex = 0; taskIndex < eventCount / 10; taskIndex += 1) {
    const taskId = `task-${taskIndex}`;
    events.push(event(++eventId, 'task.started', { taskId, prompt: `Synthetic task ${taskIndex}` }));
    for (let toolIndex = 0; toolIndex < 2; toolIndex += 1) {
      const toolCallId = `call-${taskIndex}-${toolIndex}`;
      const toolName = toolIndex === 0 ? 'getDocument' : 'navigate';
      events.push(event(++eventId, 'tool.input.started', { taskId, toolCallId, toolName }));
      events.push(event(++eventId, 'tool.input.completed', { taskId, toolCallId, toolName, input: { value: toolIndex } }));
      events.push(event(++eventId, 'tool.completed', { taskId, toolCallId, toolName, output: { ok: true, value: toolIndex } }));
    }
    const messageId = `message-${taskIndex}`;
    events.push(event(++eventId, 'message.created', { taskId, messageId, role: 'assistant', text: '' }));
    events.push(event(++eventId, 'message.appended', { taskId, messageId, delta: `Synthetic result ${taskIndex}` }));
    events.push(event(++eventId, 'task.completed', { taskId, text: `Synthetic result ${taskIndex}` }));
  }
  return events;
}

function measure(operation: () => unknown) {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

function event(id: number, type: string, payload: unknown): AgentEvent {
  return { id, sessionId: 1, type, payload, createdAt: id };
}
