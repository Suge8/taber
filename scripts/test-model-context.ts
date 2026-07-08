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
assert.match(String(messages[0].content), /<browser_context authority="untrusted">/);
assert.match(String(messages[0].content), /<tool_evidence authority="untrusted">/);
assert.match(String(messages[0].content), /页面有啥/);
assert.match(String(messages[0].content), /Right Code - 登录/);
assert.match(String(messages[0].content), /使用 Linux Do 登录/);
assert.doesNotMatch(String(messages[0].content), /data:image\/png/);
assert.doesNotMatch(String(messages[0].content), /a{100}/);
assert.match(String(messages[0].content), /indexes are scoped to one browserRepl call/);
assert.doesNotMatch(String(messages[0].content), /re-observe/);
assert.equal(messages[1].role, 'assistant');
assert.doesNotMatch(JSON.stringify(messages), /doc-secret|assistant-secret/);
assert.match(String(messages[1].content), /\[reasoning hidden\]当前页面是 Right Code 登录页面。/);
assert.match(String(messages[2].content), /<browser_context authority="untrusted">/);
assert.match(String(messages[2].content), /帮我点用 Linux 登录/);
assert.doesNotMatch(String(messages[2].content), /tool_evidence/);

const failedEvents = [
  event(1, 'task.started', { taskId: 'task-1', prompt: 'debug it' }),
  event(2, 'tool.failed', { taskId: 'task-1', toolName: 'debugger', input: {}, error: 'HTTP 500' }),
  event(3, 'task.failed', { taskId: 'task-1', error: 'network failed' }),
  event(4, 'task.started', { taskId: 'task-2', prompt: 'continue' }),
];
assert.match(String(deriveModelMessages(failedEvents, 'task-2')[0].content), /network failed/);
assert.equal(compactableTaskGroups(failedEvents, 'task-2').length, 1);

const targetChangedMessages = deriveModelMessages([
  event(1, 'task.started', { taskId: 'task-1', prompt: 'start', context: { title: 'Start', url: 'https://start.example' } }),
  event(2, 'task.targetChanged', { taskId: 'task-1', fromTabId: 1, toTabId: 2, reason: 'userCurrentTab', tab: { id: 2, title: 'Target', url: 'https://target.example' } }),
  event(3, 'task.completed', { taskId: 'task-1', text: 'done' }),
  event(4, 'task.started', { taskId: 'task-2', prompt: 'continue' }),
], 'task-2');
assert.match(String(targetChangedMessages[0].content), /https:\/\/target\.example/);
assert.doesNotMatch(String(targetChangedMessages[0].content), /https:\/\/start\.example/);

const compactedEvents = [
  ...events.slice(0, 5),
  event(7, 'context.compacted', { fromEventId: 1, toEventId: 5, text: '## Goal\nLogin with Linux Do' }),
  events[5],
];
const compactedMessages = deriveModelMessages(compactedEvents, 'task-2');
assert.equal(compactedMessages.length, 2);
assert.match(String(compactedMessages[0].content), /<summary authority="model-generated">/);
assert.doesNotMatch(String(compactedMessages[0].content), /data:image/);

const imageDigest = serializeToolEvidenceForContext(events[2]);
assert(imageDigest);
assert.doesNotMatch(imageDigest, /dataUrl|base64|data:image/);

const replDigest = serializeToolEvidenceForContext(event(10, 'tool.completed', {
  toolName: 'browserRepl',
  input: { code: 'return batch/form/nav evidence' },
  output: {
    value: {
      form: { ok: false, filled: [{ field: 'Email', finalValue: 'secret@example.com' }], missing: [{ field: 'Password' }], ambiguous: [{ field: 'Name' }] },
      batch: { ok: false, steps: [{ action: 'fill', selector: '#email', ok: true, finalValue: 'secret@example.com' }, { action: 'click', selector: '#missing', ok: false, error: 'No element' }], error: 'One or more batch steps failed' },
      nav: { action: 'open', navigation: { status: 'completed', url: 'https://example.com' }, tab: { id: 2, title: 'Example', url: 'https://example.com' } },
      dataUrl: `data:image/png;base64,${'b'.repeat(500)}`,
    },
  },
}));
assert(replDigest);
assert.match(replDigest, /fillForm: ok=false, filled=1 \(Email\), missing=1 \(Password\), ambiguous=1 \(Name\)/);
assert.match(replDigest, /batch: ok=false, steps=2/);
assert.match(replDigest, /navigate: action=open, url=https:\/\/example.com, title=Example, tabId=2/);
assert.doesNotMatch(replDigest, /secret@example.com|data:image|base64/);
assert.ok(replDigest.length <= 2000);

const topLevelBatchDigest = serializeToolEvidenceForContext(event(11, 'tool.completed', {
  toolName: 'browserRepl',
  input: { code: 'return await batch(actions)' },
  output: { ok: false, steps: [{ action: 'fill', selector: '#email', ok: true, finalValue: 'secret@example.com' }, { action: 'click', selector: '#missing', ok: false, error: 'No element' }], error: 'One or more batch steps failed' },
}));
assert(topLevelBatchDigest);
assert.match(topLevelBatchDigest, /browserRepl: batch: ok=false, steps=2/);
assert.match(topLevelBatchDigest, /action=click, selector=#missing, ok=false, error=No element/);
assert.match(topLevelBatchDigest, /error=One or more batch steps failed/);
assert.doesNotMatch(topLevelBatchDigest, /secret@example.com/);

const topLevelFillFormDigest = serializeToolEvidenceForContext(event(12, 'tool.completed', {
  toolName: 'browserRepl',
  input: { code: 'return await fillForm(input)' },
  output: { ok: false, filled: [{ field: 'Email', finalValue: 'secret@example.com' }], missing: [{ field: 'Password' }], ambiguous: [{ field: 'Name' }], error: 'Need manual confirmation' },
}));
assert(topLevelFillFormDigest);
assert.match(topLevelFillFormDigest, /browserRepl: fillForm: ok=false, filled=1 \(Email\), missing=1 \(Password\), ambiguous=1 \(Name\), error=Need manual confirmation/);
assert.doesNotMatch(topLevelFillFormDigest, /secret@example.com/);

const topLevelBrowserJsDigest = serializeToolEvidenceForContext(event(13, 'tool.completed', {
  toolName: 'browserRepl',
  input: { code: 'return await browserjs(code)' },
  output: { ok: false, error: 'browserjs failed: boom', console: [{ level: 'error', text: 'hidden detail' }] },
}));
assert(topLevelBrowserJsDigest);
assert.match(topLevelBrowserJsDigest, /browserRepl: error: error=browserjs failed: boom browserjsConsole=1/);

const successfulBrowserJsDigest = serializeToolEvidenceForContext(event(16, 'tool.completed', {
  toolName: 'browserRepl',
  input: { code: 'return await browserjs(() => ({ title: document.title }))' },
  output: { value: { title: 'Example', dataUrl: `data:image/png;base64,${'c'.repeat(500)}` }, browserjs: { console: [{ level: 'log', text: 'loaded' }] } },
}));
assert(successfulBrowserJsDigest);
assert.match(successfulBrowserJsDigest, /browserRepl: \{"title":"Example"/);
assert.match(successfulBrowserJsDigest, /browserjsConsole=1/);
assert.doesNotMatch(successfulBrowserJsDigest, /data:image|base64/);

const listTabsDigest = serializeToolEvidenceForContext(event(14, 'tool.completed', {
  toolName: 'browserRepl',
  input: { code: 'return await navigate({ action:"listTabs" })' },
  output: { value: { action: 'listTabs', tabs: [{ id: 2, title: 'First', url: 'https://first.example' }, { id: 3, title: 'Second', url: 'https://second.example' }] } },
}));
assert(listTabsDigest);
assert.match(listTabsDigest, /navigate: action=listTabs, tabs=2/);
assert.match(listTabsDigest, /tabId=2, title=First, url=https:\/\/first.example/);
assert.match(listTabsDigest, /tabId=3, title=Second, url=https:\/\/second.example/);

const navigateListTabsDigest = serializeToolEvidenceForContext(event(15, 'tool.completed', {
  toolName: 'navigate',
  input: { action: 'listTabs' },
  output: { action: 'listTabs', tabs: [{ id: 2, title: 'First', url: 'https://first.example' }, { id: 3, title: 'Second', url: 'https://second.example' }] },
}));
assert(navigateListTabsDigest);
assert.match(navigateListTabsDigest, /navigate: action=listTabs, tabs=2/);
assert.match(navigateListTabsDigest, /tabId=2, title=First, url=https:\/\/first.example/);
assert.match(navigateListTabsDigest, /tabId=3, title=Second, url=https:\/\/second.example/);
assert.ok(estimateModelPromptTokens({ instructions: 'abc', toolPromptText: 'tool schema', messages }) > 0);

console.info('model context tests passed');

function event(id: number, type: string, payload: unknown): AgentEvent {
  return { id, sessionId: 1, type, payload, createdAt: id };
}
