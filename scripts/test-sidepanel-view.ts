import assert from 'node:assert/strict';
import { projectAgentEvents } from '../lib/agent-event-projection.ts';
import { createIntentPrompt, deriveConversation, deriveSidebarTaskView, deriveSources, deriveTimeline, deriveToolTimeline, formatPayload, formatRawEvidence, hideReasoningText, latestImagePreview, orderQuickActions } from '../lib/sidepanel-view.ts';
import { detectLocale, formatTime, messages as sidepanelMessages } from '../lib/sidepanel-i18n.ts';

const events = [
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'task-1', prompt: 'Summarize this page', context: { id: 12, windowId: 3, title: 'Article', url: 'https://example.com/a', favIconUrl: 'https://example.com/icon.png' } }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'tool.started', payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'getDocument', input: { source: 'currentPage', mode: 'article' } }, createdAt: 2 },
  { id: 3, sessionId: 1, type: 'tool.completed', payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'getDocument', output: { ok: true, source: 'currentPage', mode: 'article', url: 'https://example.com/a', content: '# Page', contentChars: 6, truncated: false } }, createdAt: 3 },
  { id: 4, sessionId: 1, type: 'tool.completed', payload: { taskId: 'task-1', toolCallId: 'call-2', toolName: 'extractImage', output: { ok: true, source: 'viewport', dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png', width: 10, height: 20 } }, createdAt: 4 },
  { id: 5, sessionId: 1, type: 'message.created', payload: { taskId: 'task-1', role: 'assistant', text: '<think>private</think>Summary' }, createdAt: 5 },
] as const;

const projection = projectAgentEvents([...events]);
assert.equal(projection.taskState, 'running');
assert.equal(projection.currentTask?.taskId, 'task-1');
assert.equal(projection.currentTask?.status, 'running');
assert.equal(projection.taskGroups.length, 1);
assert.equal(projection.taskGroups[0].prompt, 'Summarize this page');
assert.equal(projection.conversation[1].text, '[reasoning hidden]Summary');
assert.deepEqual(projection.timeline.map((entry) => entry.kind), ['message', 'assistantTurn']);
assert.equal(projection.tools[0].toolName, 'getDocument');
assert.equal(projection.sources[0].url, 'https://example.com/a');
assert.equal(projection.image?.src, 'data:image/png;base64,abc');
assert.equal(projection.image?.source, 'viewport');

const task = deriveSidebarTaskView([...events]);
assert.equal(task.status, 'running');
assert.equal(task.detailKey, 'running');
assert.equal(task.context?.title, 'Article');

const failed = deriveSidebarTaskView([
  ...events,
  { id: 6, sessionId: 1, type: 'task.failed', payload: { taskId: 'task-1', error: 'network failed' }, createdAt: 6 },
]);
assert.equal(failed.status, 'failed');
assert.equal(failed.detailKey, 'failed');
assert.equal(failed.detail, 'network failed');

const timeline = deriveToolTimeline([...events]);
assert.equal(timeline.length, 2);
assert.equal(timeline[0].status, 'completed');
assert.match(timeline[0].inputSummary, /currentPage/);
assert.match(timeline[0].outputSummary ?? '', /content/);

const hiddenPayload = formatPayload({
  chainOfThought: 'secret',
  reasoning: 'secret',
  reasoningSummary: 'safe <think>summary-secret</think>Visible',
  nested: { note: '<think attr="x">nested-secret</think>Visible' },
});
assert.doesNotMatch(hiddenPayload, /secret/);
assert.match(hiddenPayload, /safe/);
assert.match(hiddenPayload, /Visible/);

const rawEvidence = formatRawEvidence({
  input: { items: Array.from({ length: 20 }, (_, index) => ({ index, value: `value-${index}` })) },
  output: { nested: { level1: { level2: { level3: { level4: { level5: 'deep value' } } } } } },
  error: 'full technical error',
  reasoning: 'secret',
});
assert.match(rawEvidence, /value-19/);
assert.match(rawEvidence, /deep value/);
assert.match(rawEvidence, /full technical error/);
assert.doesNotMatch(rawEvidence, /secret/);
assert.doesNotMatch(rawEvidence, /truncated/);

const messages = deriveConversation([...events]);
assert.equal(messages.length, 2);
assert.equal(messages[0].role, 'user');
assert.equal(messages[1].role, 'assistant');
assert.doesNotMatch(messages[1].text, /private/);

const streamingMessages = deriveConversation([
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'task-stream', prompt: 'go' }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'message.created', payload: { taskId: 'task-stream', messageId: 'msg-1', role: 'assistant', text: '' }, createdAt: 2 },
  { id: 3, sessionId: 1, type: 'message.appended', payload: { taskId: 'task-stream', messageId: 'msg-1', delta: 'Hel' }, createdAt: 3 },
  { id: 4, sessionId: 1, type: 'message.appended', payload: { taskId: 'task-stream', messageId: 'msg-1', delta: 'lo' }, createdAt: 4 },
  { id: 5, sessionId: 1, type: 'task.completed', payload: { taskId: 'task-stream', text: 'Hello' }, createdAt: 5 },
]);
assert.equal(streamingMessages.length, 2);
assert.equal(streamingMessages[1].id, 'msg-1');
assert.equal(streamingMessages[1].text, 'Hello');

const cancelledStream = deriveConversation([
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'task-stop', prompt: 'go' }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'message.created', payload: { taskId: 'task-stop', messageId: 'msg-stop', role: 'assistant', text: '' }, createdAt: 2 },
  { id: 3, sessionId: 1, type: 'message.appended', payload: { taskId: 'task-stop', messageId: 'msg-stop', delta: 'partial' }, createdAt: 3 },
  { id: 4, sessionId: 1, type: 'task.cancelled', payload: { taskId: 'task-stop' }, createdAt: 4 },
]);
assert.equal(cancelledStream.length, 2);
assert.equal(cancelledStream[1].text, 'partial');

assert.equal(hideReasoningText('<think>secret Visible'), '[reasoning hidden]');
assert.equal(hideReasoningText('<think >secret</think>Visible'), '[reasoning hidden]Visible');
assert.equal(hideReasoningText('<think attr="x">secret</think>Visible'), '[reasoning hidden]Visible');
assert.equal(hideReasoningText('<think\n>secret</think>Visible'), '[reasoning hidden]Visible');
assert.equal(hideReasoningText('Answer\n```reasoning\nsecret'), 'Answer\n[reasoning hidden]');
assert.equal(hideReasoningText('Answer\n``` reasoning\nsecret\n```\nVisible'), 'Answer\n[reasoning hidden]\nVisible');
assert.equal(hideReasoningText('Answer\n```cot\nsecret\n```Visible'), 'Answer\n[reasoning hidden]');
assert.equal(hideReasoningText('Answer\n```thought\nsecret\n```\nVisible'), 'Answer\n[reasoning hidden]\nVisible');
assert.equal(hideReasoningText('Answer\n```thoughts\nsecret\n```\nVisible'), 'Answer\n[reasoning hidden]\nVisible');
assert.equal(hideReasoningText('Answer\n```raw-reasoning\nsecret\n```\nVisible'), 'Answer\n[reasoning hidden]\nVisible');
assert.equal(hideReasoningText('Answer\n```raw_reasoning\nsecret\n```\nVisible'), 'Answer\n[reasoning hidden]\nVisible');
assert.equal(hideReasoningText('Answer\n~~~ reasoning\nsecret\n~~~\nVisible'), 'Answer\n[reasoning hidden]\nVisible');
assert.equal(hideReasoningText('Answer\n~~~chain-of-thought\nsecret'), 'Answer\n[reasoning hidden]');

const sources = deriveSources(task.context, [
  ...events,
  { id: 7, sessionId: 1, type: 'tool.completed', payload: { toolName: 'navigate', output: { title: 'Second page', url: 'https://example.com/b', favIconUrl: 'https://example.com/b-icon.png' } }, createdAt: 7 },
]);
assert.deepEqual(sources.map((source) => source.url), ['https://example.com/a', 'https://example.com/b']);
assert.deepEqual(sources.map((source) => source.faviconUrl), ['https://example.com/icon.png', 'https://example.com/b-icon.png']);
assert.deepEqual(sources.map((source) => source.tabId), [12, undefined]);
assert.deepEqual(sources.map((source) => source.windowId), [3, undefined]);

const localizedSources = deriveSources({ url: 'https://example.com/c' }, [], sidepanelMessages.zh.sources);
assert.equal(localizedSources[0].label, '当前页');
assert.equal(localizedSources[0].domain, 'example.com');
assert.equal(localizedSources[0].faviconUrl, 'https://example.com/favicon.ico');

const image = latestImagePreview([...events]);
assert.equal(image?.label, 'viewport · 10×20');
assert.equal(latestImagePreview([{ id: 8, sessionId: 1, type: 'tool.completed', payload: { toolName: 'extractImage', output: { ok: true, source: 'viewport', dataUrl: 'data:image/png;base64,x', mediaType: 'image/png' } }, createdAt: 8 }], sidepanelMessages.zh.sources)?.label, 'viewport');

assert.equal(detectLocale({ stored: 'zh', manual: true, navigatorLanguage: 'en-US' }), 'zh');
assert.equal(detectLocale({ stored: 'en', manual: false, navigatorLanguage: 'zh-CN' }), 'zh');
assert.equal(detectLocale({ stored: null, navigatorLanguage: 'zh-CN' }), 'zh');
assert.equal(detectLocale({ stored: null, navigatorLanguages: ['fr-FR', 'zh-CN'] }), 'zh');
assert.equal(detectLocale({ stored: null, navigatorLanguage: 'fr-FR' }), 'en');
assert.equal(formatTime('en', 0), new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(0)));
assert.equal(formatTime('zh', 0), new Intl.DateTimeFormat('zh', { hour: '2-digit', minute: '2-digit' }).format(new Date(0)));

const timelineEntries = deriveTimeline([...events]);
assert.equal(timelineEntries.length, 2);
assert.deepEqual(
  timelineEntries.map((entry) => entry.kind),
  ['message', 'assistantTurn'],
);
assert.equal(timelineEntries[1].kind === 'assistantTurn' ? timelineEntries[1].turn.parts.length : 0, 3);
assert.equal(timelineEntries[1].kind === 'assistantTurn' ? timelineEntries[1].turn.status : '', 'running');
const completedTimelineEntries = deriveTimeline([...events, { id: 6, sessionId: 1, type: 'task.completed', payload: { taskId: 'task-1', text: 'Summary' }, createdAt: 6 }]);
assert.equal(completedTimelineEntries[1].kind === 'assistantTurn' ? completedTimelineEntries[1].turn.status : '', 'completed');
const interleavedTimelineEntries = deriveTimeline([
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'linear-task', prompt: 'go' }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'message.created', payload: { taskId: 'linear-task', messageId: 'linear-message', role: 'assistant', text: '' }, createdAt: 2 },
  { id: 3, sessionId: 1, type: 'message.appended', payload: { taskId: 'linear-task', messageId: 'linear-message', delta: 'Before tool.' }, createdAt: 3 },
  { id: 4, sessionId: 1, type: 'tool.started', payload: { taskId: 'linear-task', toolCallId: 'linear-call', toolName: 'navigate', input: { url: 'https://example.com' } }, createdAt: 4 },
  { id: 5, sessionId: 1, type: 'tool.completed', payload: { taskId: 'linear-task', toolCallId: 'linear-call', toolName: 'navigate', output: { url: 'https://example.com' } }, createdAt: 5 },
  { id: 6, sessionId: 1, type: 'message.appended', payload: { taskId: 'linear-task', messageId: 'linear-message', delta: ' After tool.' }, createdAt: 6 },
  { id: 7, sessionId: 1, type: 'task.completed', payload: { taskId: 'linear-task', text: 'Before tool. After tool.' }, createdAt: 7 },
]);
assert.deepEqual(interleavedTimelineEntries[1].kind === 'assistantTurn' ? interleavedTimelineEntries[1].turn.parts.map((part) => part.kind) : [], ['text', 'tool', 'text']);
assert.deepEqual(orderQuickActions({ title: 'Product detail', url: 'https://shop.example/item/1' }).slice(0, 2), ['compare', 'summarize']);
assert.deepEqual(orderQuickActions({ title: 'API docs', url: 'https://example.com/docs' }).slice(0, 2), ['summarize', 'translate']);
assert.equal(createIntentPrompt('research', '', [], sidepanelMessages.en.prompts), sidepanelMessages.en.prompts.researchPage);
assert.equal(createIntentPrompt('compare', 'camera', [], sidepanelMessages.en.prompts), sidepanelMessages.en.prompts.compareTopic('camera'));
assert.match(createIntentPrompt('research', 'agents', [{ title: 'A', url: 'https://a.example' }, { title: '', url: 'https://b.example/path' }], sidepanelMessages.en.prompts), /agents[\s\S]*https:\/\/a\.example[\s\S]*b\.example/);

for (let index = 1; index < timelineEntries.length; index++) {
  assert.ok(
    timelineEntries[index].createdAt >= timelineEntries[index - 1].createdAt,
    'timeline must be sorted by createdAt ascending',
  );
}

console.log('sidepanel view tests passed');
