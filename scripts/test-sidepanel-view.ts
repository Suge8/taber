import assert from 'node:assert/strict';
import { projectAgentEvents } from '../lib/agent-event-projection.ts';
import { rawToolDetails, toolHeaderSummary } from '../lib/sidepanel-tool-presentation.ts';
import { activePart, activityEndedAt, activityGroupStatus, activityStartedAt, controlledTargetFromContext, createIntentPrompt, deriveConversation, deriveSidebarTaskView, deriveSources, deriveTimeline, deriveToolTimeline, formatPayload, formatRawEvidence, groupTurnParts, hideReasoningText, latestImagePreview, mergeLiveAgentEvent, quickActionOrder, settingsTabStartsBrowserControlGuide, shouldAdvanceToProviderSetup } from '../lib/sidepanel-view.ts';
import type { AgentEvent } from '../lib/db.ts';
import { detectLocale, formatTime, messages as sidepanelMessages } from '../lib/sidepanel-i18n.ts';
import { normalizeAssistantMarkdown } from '../lib/components/ai-elements/response/markdown.ts';

const events = [
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'task-1', prompt: 'Summarize this page', context: { id: 12, windowId: 3, title: 'Article', url: 'https://example.com/a', favIconUrl: 'https://example.com/icon.png' } }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'tool.started', payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'getDocument', input: { source: 'currentPage', mode: 'article' } }, createdAt: 2 },
  { id: 3, sessionId: 1, type: 'tool.completed', payload: { taskId: 'task-1', toolCallId: 'call-1', toolName: 'getDocument', output: { ok: true, source: 'currentPage', mode: 'article', url: 'https://example.com/a', content: '# Page', contentChars: 6, truncated: false }, durationMs: 123 }, createdAt: 3 },
  { id: 4, sessionId: 1, type: 'tool.completed', payload: { taskId: 'task-1', toolCallId: 'call-2', toolName: 'extractImage', output: { ok: true, source: 'viewport', dataUrl: 'data:image/png;base64,abc', mediaType: 'image/png', width: 10, height: 20 } }, createdAt: 4 },
  { id: 5, sessionId: 1, type: 'message.created', payload: { taskId: 'task-1', role: 'assistant', text: '<think>private</think>Summary' }, createdAt: 5 },
] as const;

const outOfOrderEvents: AgentEvent[] = [
  { id: 1, sessionId: 1, type: 'task.started', payload: {}, createdAt: 1 },
  { id: 3, sessionId: 1, type: 'message.appended', payload: {}, createdAt: 3 },
];
const reorderedEvents = mergeLiveAgentEvent(outOfOrderEvents, { id: 2, sessionId: 1, type: 'message.created', payload: {}, createdAt: 2 });
assert.deepEqual(reorderedEvents.map((event) => event.id), [1, 2, 3]);
assert.strictEqual(mergeLiveAgentEvent(reorderedEvents, reorderedEvents[1]), reorderedEvents);

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
assert.equal(timeline[0].durationMs, 123);
assert.match(rawToolDetails(timeline[0]), /durationMs/);

const failedWithoutAssistantOutput = deriveTimeline([
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'fail-fast', prompt: 'go' }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'task.failed', payload: { taskId: 'fail-fast', error: 'HTTP 400 unsupported parameter: reasoning_effort' }, createdAt: 2 },
]);
assert.equal(failedWithoutAssistantOutput[1].kind === 'assistantTurn' ? failedWithoutAssistantOutput[1].turn.status : '', 'failed');
assert.match(failedWithoutAssistantOutput[1].kind === 'assistantTurn' && failedWithoutAssistantOutput[1].turn.parts[0].kind === 'text' ? failedWithoutAssistantOutput[1].turn.parts[0].message.text : '', /reasoning_effort/);

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

const progressTimeline = deriveTimeline([
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'progress-task', prompt: 'go' }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'reasoning.started', payload: { taskId: 'progress-task', reasoningId: 'r1' }, createdAt: 2 },
  { id: 3, sessionId: 1, type: 'reasoning.appended', payload: { taskId: 'progress-task', reasoningId: 'r1', delta: 'Need inspect' }, createdAt: 3 },
  { id: 4, sessionId: 1, type: 'tool.input.started', payload: { taskId: 'progress-task', toolCallId: 'call-1', toolName: 'browserRepl' }, createdAt: 4 },
  { id: 5, sessionId: 1, type: 'tool.input.appended', payload: { taskId: 'progress-task', toolCallId: 'call-1', delta: '{"code":' }, createdAt: 5 },
  { id: 6, sessionId: 1, type: 'tool.input.completed', payload: { taskId: 'progress-task', toolCallId: 'call-1', toolName: 'browserRepl', input: { code: 'return 1' } }, createdAt: 6 },
]);
assert.deepEqual(progressTimeline[1].kind === 'assistantTurn' ? progressTimeline[1].turn.parts.map((part) => part.kind) : [], ['reasoning', 'tool']);
assert.equal(progressTimeline[1].kind === 'assistantTurn' && progressTimeline[1].turn.parts[0].kind === 'reasoning' ? progressTimeline[1].turn.parts[0].reasoning.text : '', 'Need inspect');
assert.equal(progressTimeline[1].kind === 'assistantTurn' && progressTimeline[1].turn.parts[1].kind === 'tool' ? progressTimeline[1].turn.parts[1].tool.status : '', 'pending');
assert.match(progressTimeline[1].kind === 'assistantTurn' && progressTimeline[1].turn.parts[1].kind === 'tool' ? progressTimeline[1].turn.parts[1].tool.inputSummary : '', /return 1/);

{
  const groupedTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'group-task', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'reasoning.started', payload: { taskId: 'group-task', reasoningId: 'r1' }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'reasoning.completed', payload: { taskId: 'group-task', reasoningId: 'r1', text: 'plan' }, createdAt: 3 },
    { id: 4, sessionId: 1, type: 'tool.started', payload: { taskId: 'group-task', toolCallId: 'c1', toolName: 'getDocument', input: {} }, createdAt: 4 },
    { id: 5, sessionId: 1, type: 'tool.completed', payload: { taskId: 'group-task', toolCallId: 'c1', toolName: 'getDocument', output: { ok: true } }, createdAt: 9 },
    { id: 6, sessionId: 1, type: 'message.created', payload: { taskId: 'group-task', role: 'assistant', text: 'interim' }, createdAt: 10 },
    { id: 7, sessionId: 1, type: 'tool.started', payload: { taskId: 'group-task', toolCallId: 'c2', toolName: 'navigate', input: { url: 'https://example.com' } }, createdAt: 11 },
  ]);
  const turn = groupedTimeline[1];
  assert.ok(turn.kind === 'assistantTurn');
  const blocks = groupTurnParts(turn.turn.parts);
  assert.deepEqual(blocks.map((block) => block.kind), ['activity', 'text', 'activity']);
  const first = blocks[0];
  assert.ok(first.kind === 'activity');
  assert.equal(first.parts.length, 2);
  assert.equal(first.id, `activity:${first.parts[0].id}`);
  assert.equal(activityStartedAt(first.parts), 2);
  assert.equal(activityEndedAt(first.parts), 9);
  assert.equal(activityGroupStatus(first.parts, turn.turn.status, false), 'completed');
  // No running part left in the first block: active falls back to the latest part.
  assert.equal(activePart(first.parts).kind, 'tool');
  const second = blocks[2];
  assert.ok(second.kind === 'activity');
  const runningTool = activePart(second.parts);
  assert.ok(runningTool.kind === 'tool' && runningTool.tool.status === 'running');
  assert.equal(activityGroupStatus(second.parts, turn.turn.status, true), 'running');
  assert.deepEqual(groupTurnParts([]), []);
}

{
  const streamingTextTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'streaming-text', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'tool.completed', payload: { taskId: 'streaming-text', toolCallId: 'done-call', toolName: 'getDocument', output: { ok: true } }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'message.appended', payload: { taskId: 'streaming-text', messageId: 'answer', role: 'assistant', delta: 'Writing answer…' }, createdAt: 3 },
  ]);
  const streamingTurn = streamingTextTimeline[1];
  assert.ok(streamingTurn.kind === 'assistantTurn');
  const streamingBlocks = groupTurnParts(streamingTurn.turn.parts);
  assert.deepEqual(streamingBlocks.map((block) => block.kind), ['activity', 'text']);
  assert.equal(streamingTurn.turn.status, 'running');
  const completedBeforeText = streamingBlocks[0];
  assert.ok(completedBeforeText.kind === 'activity');
  assert.equal(activityGroupStatus(completedBeforeText.parts, streamingTurn.turn.status, false), 'completed');

  const failedAfterTextTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'failed-after-text', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'tool.completed', payload: { taskId: 'failed-after-text', toolCallId: 'done-call', toolName: 'getDocument', output: { ok: true } }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'message.created', payload: { taskId: 'failed-after-text', role: 'assistant', text: 'Partial answer' }, createdAt: 3 },
    { id: 4, sessionId: 1, type: 'task.failed', payload: { taskId: 'failed-after-text', error: 'later failure' }, createdAt: 4 },
  ]);
  const failedAfterTextTurn = failedAfterTextTimeline[1];
  assert.ok(failedAfterTextTurn.kind === 'assistantTurn');
  const failedAfterTextBlocks = groupTurnParts(failedAfterTextTurn.turn.parts);
  assert.deepEqual(failedAfterTextBlocks.map((block) => block.kind), ['activity', 'text']);
  assert.equal(failedAfterTextTurn.turn.status, 'failed');
  const successfulBeforeFailure = failedAfterTextBlocks[0];
  assert.ok(successfulBeforeFailure.kind === 'activity');
  assert.equal(activityGroupStatus(successfulBeforeFailure.parts, failedAfterTextTurn.turn.status, false), 'completed');
}

{
  const recoveredTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'recovered-group', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'tool.failed', payload: { taskId: 'recovered-group', toolCallId: 'failed-call', toolName: 'navigate', error: 'wrong tab' }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'tool.completed', payload: { taskId: 'recovered-group', toolCallId: 'done-call', toolName: 'navigate', output: { action: 'open' } }, createdAt: 3 },
    { id: 4, sessionId: 1, type: 'reasoning.completed', payload: { taskId: 'recovered-group', reasoningId: 'final-check', text: 'verified' }, createdAt: 4 },
    { id: 5, sessionId: 1, type: 'message.created', payload: { taskId: 'recovered-group', messageId: 'answer', role: 'assistant', text: '' }, createdAt: 5 },
    { id: 6, sessionId: 1, type: 'message.appended', payload: { taskId: 'recovered-group', messageId: 'answer', delta: 'Done' }, createdAt: 6 },
    { id: 7, sessionId: 1, type: 'task.completed', payload: { taskId: 'recovered-group', text: 'Done' }, createdAt: 7 },
  ]);
  const recoveredTurn = recoveredTimeline[1];
  assert.ok(recoveredTurn.kind === 'assistantTurn');
  assert.equal(recoveredTurn.turn.status, 'completed');
  const recoveredBlock = groupTurnParts(recoveredTurn.turn.parts)[0];
  assert.ok(recoveredBlock.kind === 'activity');
  assert.equal(recoveredBlock.parts.some((part) => part.kind === 'tool' && part.tool.status === 'failed'), true);
  assert.equal(activityGroupStatus(recoveredBlock.parts, recoveredTurn.turn.status, false), 'completed');
}

{
  const failedTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'failed-group', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'tool.started', payload: { taskId: 'failed-group', toolCallId: 'failed-call', toolName: 'navigate', input: {} }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'tool.failed', payload: { taskId: 'failed-group', toolCallId: 'failed-call', toolName: 'navigate', error: 'boom' }, createdAt: 3 },
    { id: 4, sessionId: 1, type: 'task.failed', payload: { taskId: 'failed-group', error: 'boom' }, createdAt: 4 },
  ]);
  const failedTurn = failedTimeline[1];
  assert.ok(failedTurn.kind === 'assistantTurn');
  const failedBlock = groupTurnParts(failedTurn.turn.parts)[0];
  assert.ok(failedBlock.kind === 'activity');
  assert.equal(failedTurn.turn.status, 'failed');
  assert.equal(activityGroupStatus(failedBlock.parts, failedTurn.turn.status, true), 'failed');

  const stoppedTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'stopped-group', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'tool.started', payload: { taskId: 'stopped-group', toolCallId: 'stopped-call', toolName: 'browserRepl', input: {} }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'task.cancelled', payload: { taskId: 'stopped-group' }, createdAt: 3 },
  ]);
  const stoppedTurn = stoppedTimeline[1];
  assert.ok(stoppedTurn.kind === 'assistantTurn');
  const stoppedBlock = groupTurnParts(stoppedTurn.turn.parts)[0];
  assert.ok(stoppedBlock.kind === 'activity');
  assert.equal(stoppedTurn.turn.status, 'cancelled');
  assert.equal(activityGroupStatus(stoppedBlock.parts, stoppedTurn.turn.status, true), 'stopped');

  const warningTimeline = deriveTimeline([
    { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'warning-group', prompt: 'go' }, createdAt: 1 },
    { id: 2, sessionId: 1, type: 'tool.completed', payload: { taskId: 'warning-group', toolCallId: 'warning-call', toolName: 'getDocument', output: { ok: false, code: 'NO_SELECTION' } }, createdAt: 2 },
    { id: 3, sessionId: 1, type: 'task.completed', payload: { taskId: 'warning-group', text: '' }, createdAt: 3 },
  ]);
  const warningTurn = warningTimeline[1];
  assert.ok(warningTurn.kind === 'assistantTurn');
  const warningBlock = groupTurnParts(warningTurn.turn.parts)[0];
  assert.ok(warningBlock.kind === 'activity');
  assert.equal(activityGroupStatus(warningBlock.parts, warningTurn.turn.status, true), 'warning');
}

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

const targetChangedEvents = [
  { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'target-task', prompt: 'go', context: { id: 21, windowId: 4, title: 'Start', url: 'https://start.example/page', favIconUrl: 'https://start.example/icon.png' } }, createdAt: 1 },
  { id: 2, sessionId: 1, type: 'task.targetChanged', payload: { taskId: 'target-task', fromTabId: 21, toTabId: 22, reason: 'userCurrentTab', tab: { id: 22, windowId: 4, title: 'Target', url: 'https://target.example/page', favIconUrl: 'https://target.example/icon.png' } }, createdAt: 2 },
] as const;
const targetTask = deriveSidebarTaskView([...targetChangedEvents]);
assert.equal(targetTask.context?.url, 'https://target.example/page');
const controlledTarget = controlledTargetFromContext(targetTask.context, sidepanelMessages.en.sources);
assert.deepEqual(controlledTarget, { label: 'Target', url: 'https://target.example/page', domain: 'target.example', faviconUrl: 'https://target.example/icon.png', tabId: 22, windowId: 4 });
const targetSources = deriveSources(targetTask.context, [...targetChangedEvents], sidepanelMessages.en.sources);
assert.equal(targetSources[0].url, 'https://target.example/page');
assert.equal(targetSources[0].tabId, 22);
const targetTimeline = deriveTimeline([...targetChangedEvents]);
assert.equal(targetTimeline.length, 1);
assert.equal(targetTimeline[0].kind, 'message');
assert.equal(sidepanelMessages.en.sources.lastPage, 'Last page');
assert.equal(sidepanelMessages.zh.sources.lastPage, '上次页面');
assert.equal(sidepanelMessages.en.sources.switchToCurrentTab, 'Use current tab');
assert.match(sidepanelMessages.en.sources.noOperableActiveTab, /http\/https/);
assert.match(sidepanelMessages.zh.sources.noOperableActiveTab, /http\/https/);
assert.doesNotMatch(sidepanelMessages.en.sources.noOperableActiveTab, /No operable/i);
assert.match(sidepanelMessages.zh.sources.noOperableActiveTab, /请先选中/);
assert.equal(controlledTargetFromContext({ url: 'https://example.com/untitled' }, { ...sidepanelMessages.en.sources, controlledPage: sidepanelMessages.en.sources.lastPage })?.label, 'Last page');
assert.equal('technicalDetails' in sidepanelMessages.en.tool, false);
assert.equal(sidepanelMessages.en.reasoning.thinking, 'Thinking…');
assert.equal(sidepanelMessages.zh.reasoning.thinking, '正在思考…');
assert.equal(sidepanelMessages.zh.reasoning.summary, '思考');
assert.equal(sidepanelMessages.zh.tool.actions.listTabs, '标签页');
assert.equal(sidepanelMessages.zh.tool.summary.listTabs(3), '标签页 · 3 个');
assert.equal(sidepanelMessages.zh.tool.summary.switchTab('anpin.ai'), '切换 anpin.ai');

const recoverableSelectionTool = {
  id: 'tool-no-selection',
  toolName: 'getDocument',
  status: 'completed',
  createdAt: 1,
  updatedAt: 1,
  eventId: 1,
  input: { source: 'selection' },
  output: { ok: false, code: 'NO_SELECTION', message: 'No selected text.', retryHint: 'Select text first.' },
} as const;
assert.equal(toolHeaderSummary(recoverableSelectionTool, sidepanelMessages.zh, 'zh'), '未选中文本');
assert.doesNotMatch(toolHeaderSummary(recoverableSelectionTool, sidepanelMessages.zh, 'zh'), /NO_SELECTION/);
assert.match(rawToolDetails(recoverableSelectionTool), /NO_SELECTION/);
assert.match(rawToolDetails(recoverableSelectionTool), /Select text first/);
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browser', input: { action: 'press' }, output: { ok: false, code: 'NO_TARGET', message: 'No focused element for press()' } }, sidepanelMessages.zh, 'zh'), '未找到目标元素');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browserRepl', input: { code: 'return await press("Enter")' }, output: { ok: false, code: 'NO_TARGET', message: 'No focused element for press()' } }, sidepanelMessages.zh, 'zh'), '未找到目标元素');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browser', input: { action: 'click' }, output: { ok: false, code: 'AMBIGUOUS_TARGET', message: 'Multiple visible targets match: 保存' } }, sidepanelMessages.zh, 'zh'), '目标不够明确');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browserRepl', input: { code: 'return await click(1)' }, output: { ok: false, code: 'STALE_REF', message: 'Ref is stale. Use browser.snapshot again.' } }, sidepanelMessages.zh, 'zh'), '页面已变化，请重试');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browser', input: { action: 'click' }, output: { ok: false, code: 'UNMAPPED_BROWSER_CODE', message: 'No focused element for press()' } }, sidepanelMessages.zh, 'zh'), sidepanelMessages.zh.tool.errors.inspectFailed);
assert.doesNotMatch(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browser', input: { action: 'click' }, output: { ok: false, code: 'UNMAPPED_BROWSER_CODE', message: 'No focused element for press()' } }, sidepanelMessages.zh, 'zh'), /No focused/);
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'extractImage', input: { source: 'selector' }, output: { ok: false, code: 'ELEMENT_NOT_FOUND', message: 'Element not found.' } }, sidepanelMessages.zh, 'zh'), '未找到元素');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'extractImage', input: { source: 'viewport' }, output: { ok: true, source: 'viewport', width: 10, height: 20 } }, sidepanelMessages.zh, 'zh'), '截图 · 10×20');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'debugger', input: { action: 'console' }, output: { logs: [{}, {}, {}] } }, sidepanelMessages.zh, 'zh'), '调试 · 3错');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browserRepl', input: { code: 'return await observe()' }, output: { value: 1 } }, sidepanelMessages.zh, 'zh'), '检查');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'browserRepl', input: { code: 'const value = 1' }, output: { ok: false, code: 'NO_EVIDENCE', message: 'No evidence' } }, sidepanelMessages.zh, 'zh'), '未返回可用结果');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'navigate', input: { action: 'open' }, output: { ok: false, code: 'TARGET_TAB_MISMATCH', message: 'Wrong tab' } }, sidepanelMessages.zh, 'zh'), '目标标签页不匹配');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'navigate', input: { action: 'open' }, output: { ok: false, code: 'TARGET_NOT_OPERABLE', message: 'Restricted tab' } }, sidepanelMessages.zh, 'zh'), '目标标签页不可操作');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'navigate', input: { action: 'open' }, output: { ok: false, code: 'NAVIGATION_FAILED', message: 'Network failed' } }, sidepanelMessages.zh, 'zh'), '页面跳转失败');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'navigate', status: 'failed', input: { action: 'open' }, output: undefined, error: 'navigate.open is locked to target tab 7; received tabId 1.' }, sidepanelMessages.zh, 'zh'), '目标标签页不匹配');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'navigate', input: { action: 'listTabs' }, output: { action: 'listTabs', tabs: [{ id: 1 }, { id: 2 }] } }, sidepanelMessages.zh, 'zh'), '标签页 · 2 个');
assert.equal(toolHeaderSummary({ ...recoverableSelectionTool, toolName: 'navigate', input: { action: 'switchTab', tabId: 7 }, output: { action: 'switchTab', tab: { id: 7, url: 'https://anpin.ai/dashboard' } } }, sidepanelMessages.zh, 'zh'), '切换 anpin.ai');

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
assert.deepEqual(quickActionOrder, ['summarize', 'skills', 'research', 'compare']);
const manualBrowserControlGuide = settingsTabStartsBrowserControlGuide('preferences', true);
assert.equal(manualBrowserControlGuide, true);
assert.equal(settingsTabStartsBrowserControlGuide('providers', true), false);
assert.equal(shouldAdvanceToProviderSetup({ settingsOpen: true, promptedForBrowserControl: manualBrowserControlGuide, missingBrowserControl: false, hasAnyModel: false, promptedForMissingModel: false }), true);
assert.equal(shouldAdvanceToProviderSetup({ settingsOpen: true, promptedForBrowserControl: manualBrowserControlGuide, missingBrowserControl: false, hasAnyModel: true, promptedForMissingModel: false }), false);

const pseudoList = '概览：-**账户概览**-当前余额：**$17.23**-API密钥：**2个，均已启用**-当前主要使用平台为**Claude**-Claude今日消费：**$12.7661**-OpenAI、Gemini当前显示为**$0.0000**-**模型分布**-`claude-opus-4-8`：73次请求，实际消费**$8.3179**-使用兑换码充值整体来看，这是账户仪表盘。';
const normalizedPseudoList = normalizeAssistantMarkdown(pseudoList);
assert.match(normalizedPseudoList, /概览：\n\n\*\*账户概览\*\*/);
assert.match(normalizedPseudoList, /\n- 当前余额：\*\*\$17\.23\*\*/);
assert.match(normalizedPseudoList, /\n- API密钥：/);
assert.match(normalizedPseudoList, /\n- Claude今日消费：/);
assert.match(normalizedPseudoList, /当前显示为 \*\*\$0\.0000\*\*/);
assert.match(normalizedPseudoList, /\n\n\*\*模型分布\*\*/);
assert.match(normalizedPseudoList, /\n- `claude-opus-4-8`：73次请求，实际消费 \*\*\$8\.3179\*\*/);
assert.match(normalizedPseudoList, /\n- 使用兑换码充值整体来看，这是账户仪表盘。/);
const dashboardRaw = '当前页面是**AnPinAI的仪表盘**，核心内容是账户余额、API使用情况、消费统计和近期调用记录概览。主要信息如下：-**账户概览**-当前余额：**$17.23**-API密钥：**2个，均已启用**-用户身份：user-**今日使用情况**-今日请求数：**92次**-今日消费：**$12.7661/$9.8201**-今日Token：**3.3M**-输入：**27.5K**-输出：**26.1K**-平均响应时间：**7.56秒**-**平台消费拆分**-当前主要使用平台为**Claude**-Claude今日消费：**$12.7661**-请求数：**92**-Token：**3.3M**-OpenAI、Gemini、Antigravity当前显示为**$0.0000**-**模型分布**-`claude-opus-4-8`：73次请求，2.7MToken，实际消费**$8.3179**-`claude-fable-5`：18次请求，630.1KToken，实际消费**$4.4363**-`claude-sonnet-4-6`：1次请求，27.2KToken，实际消费**$0.0119**-**最近使用记录**-近期调用集中在`claude-opus-4-8`-最近记录时间为**2026/07/0805:52左右**-单次消费从约**$0.045到$0.3056**不等-**页面提供的快捷操作**-创建API密钥-查看使用记录-使用兑换码充值整体来看，这是一个用于查看**API余额、调用量、Token消耗、模型成本分布和近期请求记录**的账户仪表盘页面。';
const normalizedDashboard = normalizeAssistantMarkdown(dashboardRaw);
assert.match(normalizedDashboard, /主要信息如下：\n\n\*\*账户概览\*\*/);
assert.match(normalizedDashboard, /\n- 当前余额：\*\*\$17\.23\*\*/);
assert.match(normalizedDashboard, /\n\n\*\*今日使用情况\*\*/);
assert.match(normalizedDashboard, /\n- `claude-fable-5`：18次请求，630\.1KToken，实际消费 \*\*\$4\.4363\*\*/);
assert.match(normalizedDashboard, /\n- 最近记录时间为\*\*2026\/07\/0805:52左右\*\*/);
assert.equal(normalizeAssistantMarkdown('OpenAI-compatible provider keeps hyphen.'), 'OpenAI-compatible provider keeps hyphen.');
assert.equal(normalizeAssistantMarkdown('`claude-opus-4-8` should stay intact.'), '`claude-opus-4-8` should stay intact.');
assert.equal(normalizeAssistantMarkdown('A-B测试不应该变列表'), 'A-B测试不应该变列表');
assert.equal(normalizeAssistantMarkdown('日期 2026-07-08 不变，金额 -$0.5 不变。'), '日期 2026-07-08 不变，金额 -$0.5 不变。');
assert.equal(normalizeAssistantMarkdown('URL https://example.com/a-b?x=-1 不变'), 'URL https://example.com/a-b?x=-1 不变');
assert.equal(normalizeAssistantMarkdown('中文-英文混排不应该变列表'), '中文-英文混排不应该变列表');
assert.equal(normalizeAssistantMarkdown('深度研究-OpenAI模型选择保持。'), '深度研究-OpenAI模型选择保持。');
assert.equal(normalizeAssistantMarkdown('指标说明：A-B测试、C-D方案不变。'), '指标说明：A-B测试、C-D方案不变。');
assert.equal(normalizeAssistantMarkdown('参数 page-size 和 max-retries 不变。'), '参数 page-size 和 max-retries 不变。');
assert.equal(normalizeAssistantMarkdown('中文 - 英文也不应变列表。'), '中文 - 英文也不应变列表。');
assert.equal(normalizeAssistantMarkdown('- 已经是列表\n- 第二项'), '- 已经是列表\n- 第二项');
assert.equal(normalizeAssistantMarkdown('```txt\n说明：-不要改代码块\n```'), '```txt\n说明：-不要改代码块\n```');
assert.equal(normalizeAssistantMarkdown('```txt\n说明：-未闭合代码块也不要改'), '```txt\n说明：-未闭合代码块也不要改');

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
