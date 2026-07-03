import assert from 'node:assert/strict';
import { deriveTaskState } from '../lib/agent-events.ts';

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

console.info('agent event tests passed');
