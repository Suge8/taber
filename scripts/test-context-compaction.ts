import assert from 'node:assert/strict';
import type { LanguageModel } from 'ai';
import {
  compactContext,
  contextLimit,
  needsCompaction,
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  type ContextBudget,
} from '../lib/context-compaction.ts';
import type { AgentEvent } from '../lib/db.ts';
import { createOpenAIApiLanguageModel } from '../lib/openai-runtime.ts';
import { compactableTaskGroups, deriveModelMessages, estimateModelPromptTokens } from '../lib/model-context.ts';

await testBelowThresholdDoesNothing();
await testThresholdBoundary();
await testOversizedCurrentTaskIsRejected();
await testTerminalTaskEligibility();
await testFirstCompaction();
await testIncrementalCompaction();
await testEmptySummaryIsRejected();
await testModelFailurePropagates();
await testAppendFailurePropagates();
await testCompactedContextCanRemainOversized();

console.info('context compaction tests passed');

async function testBelowThresholdDoesNothing() {
  const summaryModel = fakeSummaryModel('unused');
  let appendCalls = 0;
  const result = await compactContext({
    events: [event(1, 'task.started', { taskId: 'current', prompt: 'Short prompt' })],
    currentTaskId: 'current',
    model: summaryModel.model,
    modelName: 'summary-model',
    budget: budget(10_000),
    appendCompaction: async () => { appendCalls += 1; },
  });

  assert.equal(result, false);
  assert.equal(summaryModel.requests.length, 0);
  assert.equal(appendCalls, 0);
}

async function testThresholdBoundary() {
  const events = [event(1, 'task.started', { taskId: 'current', prompt: 'Boundary prompt' })];
  const promptTokens = estimateModelPromptTokens({
    instructions: '',
    toolPromptText: '',
    messages: deriveModelMessages(events, 'current'),
  });
  let exactWindow = 1;
  while (contextLimit(exactWindow) < promptTokens) exactWindow += 1;
  let belowWindow = exactWindow - 1;
  while (contextLimit(belowWindow) === promptTokens) belowWindow -= 1;

  assert.equal(contextLimit(exactWindow), promptTokens);
  assert.equal(contextLimit(belowWindow), promptTokens - 1);
  assert.equal(needsCompaction(events, 'current', budget(exactWindow)), false);
  assert.equal(needsCompaction(events, 'current', budget(belowWindow)), true);
}

async function testOversizedCurrentTaskIsRejected() {
  const summaryModel = fakeSummaryModel('unused');
  let appendCalls = 0;

  await assert.rejects(
    () => compactContext({
      events: [event(1, 'task.started', { taskId: 'current', prompt: 'Oversized current prompt '.repeat(20) })],
      currentTaskId: 'current',
      model: summaryModel.model,
      modelName: 'summary-model',
      budget: budget(20),
      appendCompaction: async () => { appendCalls += 1; },
    }),
    /Context is too large for the selected model\. Choose a larger context model or start a new session\./,
  );
  assert.equal(summaryModel.requests.length, 0);
  assert.equal(appendCalls, 0);
}

async function testTerminalTaskEligibility() {
  const events = [
    event(1, 'task.started', { taskId: 'failed', prompt: 'Investigate failure' }),
    event(2, 'task.failed', { taskId: 'failed', error: 'Synthetic network failure' }),
    event(3, 'task.started', { taskId: 'cancelled', prompt: 'Cancel this task' }),
    event(4, 'task.cancelled', { taskId: 'cancelled' }),
    event(5, 'task.started', { taskId: 'still-running', prompt: 'Not terminal' }),
    event(6, 'task.started', { taskId: 'current', prompt: 'Continue '.repeat(20) }),
  ];
  const groups = compactableTaskGroups(events, 'current');
  assert.deepEqual(groups.map((group) => [group.taskId, group.status]), [
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ]);

  const summaryModel = fakeSummaryModel('## Goal\nContinue after terminal tasks');
  const appended: CompactionPayload[] = [];
  assert.equal(await compactContext({
    events,
    currentTaskId: 'current',
    model: summaryModel.model,
    modelName: 'summary-model',
    budget: budget(20),
    appendCompaction: async (payload) => { appended.push(payload); },
  }), true);
  const request = JSON.stringify(summaryModel.requests[0]);
  assert.match(request, /Investigate failure/);
  assert.match(request, /Cancel this task/);
  assert.doesNotMatch(request, /Not terminal/);
  assert.equal(appended[0]?.toEventId, 4);
}

async function testFirstCompaction() {
  const events = firstCompactionEvents();
  const summaryModel = fakeSummaryModel('  ## Goal\nPreserve synthetic history  ');
  const appended: CompactionPayload[] = [];

  const result = await compactContext({
    events,
    currentTaskId: 'current',
    model: summaryModel.model,
    modelName: 'summary-model',
    budget: budget(30),
    appendCompaction: async (payload) => { appended.push(payload); },
  });

  assert.equal(result, true);
  assert.equal(summaryModel.requests.length, 1);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], {
    fromEventId: 10,
    toEventId: 12,
    text: '## Goal\nPreserve synthetic history',
    model: 'summary-model',
  });
  const request = JSON.stringify(summaryModel.requests[0]);
  assert.match(request, new RegExp(escapeRegExp(SUMMARIZATION_PROMPT.slice(0, 80))));
  assert.doesNotMatch(request, /<previous-summary>/);
  assert.match(request, /Inspect the synthetic page/);
  assert.match(request, /Synthetic Document/);
  assert.match(request, /Historical task complete/);
  assert.doesNotMatch(request, /Do not summarize this current request/);
  assert.doesNotMatch(request, /data:image\/png|base64/);
}

async function testIncrementalCompaction() {
  const events = [
    event(1, 'task.started', { taskId: 'old', prompt: 'Already summarized task' }),
    event(2, 'task.completed', { taskId: 'old', text: 'Already summarized result' }),
    event(3, 'context.compacted', { fromEventId: 1, toEventId: 2, text: '## Goal\nPrevious synthetic summary' }),
    event(6, 'task.started', { taskId: 'new', prompt: 'New completed task' }),
    event(7, 'task.completed', { taskId: 'new', text: 'New result' }),
    event(8, 'task.started', { taskId: 'current', prompt: 'Current request '.repeat(20) }),
  ];
  const summaryModel = fakeSummaryModel('## Goal\nUpdated synthetic summary');
  const appended: CompactionPayload[] = [];

  assert.equal(await compactContext({
    events,
    currentTaskId: 'current',
    model: summaryModel.model,
    modelName: 'summary-model-v2',
    budget: budget(30),
    appendCompaction: async (payload) => { appended.push(payload); },
  }), true);

  assert.deepEqual(appended[0], {
    fromEventId: 1,
    toEventId: 7,
    text: '## Goal\nUpdated synthetic summary',
    model: 'summary-model-v2',
  });
  const request = JSON.stringify(summaryModel.requests[0]);
  assert.match(request, new RegExp(escapeRegExp(UPDATE_SUMMARIZATION_PROMPT.slice(0, 80))));
  assert.match(request, /<previous-summary>.*Previous synthetic summary.*<\/previous-summary>/);
  assert.match(request, /New completed task/);
  assert.match(request, /New result/);
  assert.doesNotMatch(request, /Already summarized task|Already summarized result|Current request/);
}

async function testEmptySummaryIsRejected() {
  const summaryModel = fakeSummaryModel('   \n  ');
  let appendCalls = 0;

  await assert.rejects(
    () => compactContext({
      events: firstCompactionEvents(),
      currentTaskId: 'current',
      model: summaryModel.model,
      modelName: 'summary-model',
      budget: budget(30),
      appendCompaction: async () => { appendCalls += 1; },
    }),
    /Compaction returned an empty summary/,
  );
  assert.equal(appendCalls, 0);
}

async function testModelFailurePropagates() {
  const summaryModel = fakeSummaryModel(new Error('Synthetic summary model failure'));
  let appendCalls = 0;

  await assert.rejects(
    () => compactContext({
      events: firstCompactionEvents(),
      currentTaskId: 'current',
      model: summaryModel.model,
      modelName: 'summary-model',
      budget: budget(30),
      appendCompaction: async () => { appendCalls += 1; },
    }),
    /Synthetic summary model failure/,
  );
  assert.equal(appendCalls, 0);
}

async function testAppendFailurePropagates() {
  const summaryModel = fakeSummaryModel('## Goal\nSynthetic append failure');

  await assert.rejects(
    () => compactContext({
      events: firstCompactionEvents(),
      currentTaskId: 'current',
      model: summaryModel.model,
      modelName: 'summary-model',
      budget: budget(30),
      appendCompaction: async () => { throw new Error('Synthetic append failure'); },
    }),
    /Synthetic append failure/,
  );
  assert.equal(summaryModel.requests.length, 1);
}

async function testCompactedContextCanRemainOversized() {
  const events = firstCompactionEvents();
  const summaryModel = fakeSummaryModel(`## Goal\n${'Large synthetic summary '.repeat(20)}`);
  let appended: CompactionPayload | undefined;

  assert.equal(await compactContext({
    events,
    currentTaskId: 'current',
    model: summaryModel.model,
    modelName: 'summary-model',
    budget: budget(30),
    appendCompaction: async (payload) => { appended = payload; },
  }), true);
  assert(appended);
  assert.equal(needsCompaction([...events, event(21, 'context.compacted', appended)], 'current', budget(30)), true);
}

function firstCompactionEvents() {
  return [
    event(20, 'task.started', { taskId: 'current', prompt: 'Do not summarize this current request '.repeat(10) }, 200),
    event(12, 'task.completed', { taskId: 'history', text: 'Historical task complete' }, 300),
    event(10, 'task.started', { taskId: 'history', prompt: 'Inspect the synthetic page' }, 500),
    event(11, 'tool.completed', {
      taskId: 'history',
      toolName: 'getDocument',
      input: { source: 'currentPage', mode: 'article' },
      output: {
        ok: true,
        source: 'currentPage',
        mode: 'article',
        title: 'Synthetic Document',
        url: 'https://example.test/document',
        content: 'Safe synthetic evidence',
        dataUrl: `data:image/png;base64,${'a'.repeat(100)}`,
      },
    }, 400),
  ];
}

type CompactionPayload = {
  fromEventId: number;
  toEventId: number;
  text: string;
  model: string;
};

function fakeSummaryModel(result: string | Error): { model: LanguageModel; requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  const model = createOpenAIApiLanguageModel({
    modelId: 'gpt-5.4',
    providerName: 'OpenAI',
    baseURL: 'https://summary.invalid/v1',
    apiKey: 'synthetic-summary-key',
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://summary.invalid/v1/responses');
      requests.push(JSON.parse(String(init?.body)));
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify({
        id: 'response-synthetic',
        created_at: 0,
        model: 'gpt-5.4',
        output: [{
          type: 'message',
          role: 'assistant',
          id: 'message-synthetic',
          content: [{ type: 'output_text', text: result, annotations: [] }],
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  return { model, requests };
}

function budget(contextWindowTokens: number): ContextBudget {
  return { contextWindowTokens, instructions: '', toolPromptText: '' };
}

function event(id: number, type: string, payload: unknown, createdAt = id): AgentEvent {
  return { id, sessionId: 1, type, payload, createdAt };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
