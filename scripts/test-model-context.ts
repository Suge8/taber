import assert from 'node:assert/strict';
import { compactableTaskGroups, deriveModelMessages, estimateModelPromptTokens, serializeToolEvidenceForContext } from '../lib/model-context.ts';
import type { AgentEvent } from '../lib/db.ts';

const events: AgentEvent[] = [
  event(1, 'task.started', { taskId: 'task-1', prompt: '页面有啥', context: { title: 'Right Code - 登录', url: 'https://www.right.codes/login' } }),
  event(2, 'tool.completed', { taskId: 'task-1', toolName: 'getDocument', input: { source: 'currentPage', mode: 'article' }, output: { ok: true, source: 'currentPage', mode: 'article', title: 'Right Code', url: 'https://www.right.codes/login', content: '<think>doc-secret</think># Login\n使用 Linux Do 登录'.repeat(200), contentChars: 9400, truncated: false } }),
  event(3, 'tool.completed', { taskId: 'task-1', toolName: 'extractImage', input: { source: 'viewport' }, output: { ok: true, source: 'viewport', width: 10, height: 20, mediaType: 'image/png', dataUrl: `data:image/png;base64,${'a'.repeat(500)}` } }),
  event(4, 'tool.completed', { taskId: 'task-1', toolName: 'browserRepl', input: { helper: 'observe' }, output: { elements: [{ index: 1, role: 'button', text: '使用 Linux Do 登录', stableId: 'abc' }] } }),
  event(5, 'task.completed', { taskId: 'task-1', text: '<think>assistant-secret</think>当前页面是 Right Code 登录页面。' }),
  event(6, 'task.started', { taskId: 'task-2', prompt: '帮我点用 Linux 登录', context: { title: 'Right Code - 登录', url: 'https://www.right.codes/login' } }),
];

const messages = deriveModelMessages(events, 'task-2');
assert.equal(messages.length, 3);
assert.equal(messages[0].role, 'user');
assert.match(String(messages[0].content), /页面有啥/);
assert.match(String(messages[0].content), /Right Code - 登录/);
assert.match(String(messages[0].content), /使用 Linux Do 登录/);
assert.doesNotMatch(String(messages[0].content), /data:image\/png/);
assert.doesNotMatch(String(messages[0].content), /a{100}/);
assert.match(String(messages[0].content), /re-observe/);
assert.equal(messages[1].role, 'assistant');
assert.doesNotMatch(JSON.stringify(messages), /doc-secret|assistant-secret/);
assert.match(String(messages[1].content), /\[reasoning hidden\]当前页面是 Right Code 登录页面。/);
assert.match(String(messages[2].content), /帮我点用 Linux 登录/);
assert.doesNotMatch(String(messages[2].content), /Tool evidence/);

const failedEvents = [
  event(1, 'task.started', { taskId: 'task-1', prompt: 'debug it' }),
  event(2, 'tool.failed', { taskId: 'task-1', toolName: 'debugger', input: {}, error: 'HTTP 500' }),
  event(3, 'task.failed', { taskId: 'task-1', error: 'network failed' }),
  event(4, 'task.started', { taskId: 'task-2', prompt: 'continue' }),
];
assert.match(String(deriveModelMessages(failedEvents, 'task-2')[0].content), /network failed/);
assert.equal(compactableTaskGroups(failedEvents, 'task-2').length, 1);

const compactedEvents = [
  ...events.slice(0, 5),
  event(7, 'context.compacted', { fromEventId: 1, toEventId: 5, text: '## Goal\nLogin with Linux Do' }),
  events[5],
];
const compactedMessages = deriveModelMessages(compactedEvents, 'task-2');
assert.equal(compactedMessages.length, 2);
assert.match(String(compactedMessages[0].content), /<summary>/);
assert.doesNotMatch(String(compactedMessages[0].content), /data:image/);

const imageDigest = serializeToolEvidenceForContext(events[2]);
assert(imageDigest);
assert.doesNotMatch(imageDigest, /dataUrl|base64|data:image/);
assert.ok(estimateModelPromptTokens({ instructions: 'abc', toolPromptText: 'tool schema', messages }) > 0);

console.info('model context tests passed');

function event(id: number, type: string, payload: unknown): AgentEvent {
  return { id, sessionId: 1, type, payload, createdAt: id };
}
