import assert from 'node:assert/strict';
import { ToolLoopAgent, simulateReadableStream, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { collectAgentResponseText, emitAgentEventFailClosed, type AgentStreamPart } from '../lib/agent-stream.ts';
import { createAgentTools, createToolInputAuditGate } from '../lib/agent-tools.ts';
import { MAX_FS_WRITE_CHARS } from '../lib/fs-tool.ts';

await testTextDeltasAreEmitted();
await testReasoningAndToolProgressAreEmitted();
await testInvalidToolCallEmitsFailure();
await testToolInputPersistenceFailureStopsScheduledTool();
await testFallbackTextIsEmitted();
await testFinishReasonErrorRejects();
await testUnfinishedToolLoopRejects();
await testDegenerateReasoningRejects();
await testDegenerateTextRejects();
await testStepOutputBudgetRejectsRepetition();
await testToolInputRejectsContentAfterCompleteJson();
await testCapturedDegenerateToolInputRejects();
await testCompletedToolInputWhitespaceRejects();
await testMaxSizeFsInputIsAccepted();
await testOversizedToolInputRejects();
await testInternalTimeoutAbortIsHealthFailure();
await testStalledStreamRejects();

console.info('agent stream tests passed');

async function testTextDeltasAreEmitted() {
  const events: string[] = [];
  const text = await collectAgentResponseText({
    fullStream: streamParts([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'finish', finishReason: 'stop' },
    ]),
    text: Promise.resolve('ignored'),
  }, streamEvents(events));

  assert.equal(text, 'Hello');
  assert.deepEqual(events, ['create', 'append:Hel', 'append:lo']);
}

async function testReasoningAndToolProgressAreEmitted() {
  const events: string[] = [];
  const text = await collectAgentResponseText({
    fullStream: streamParts([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'Need page state' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'tool-input-start', id: 'call-1', toolName: 'browserRepl', title: 'Inspect page' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"code":' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'browserRepl', input: { code: 'return 1' } },
      { type: 'finish', finishReason: 'stop' },
    ]),
    text: Promise.resolve(''),
  }, streamEvents(events));

  assert.equal(text, '');
  assert.deepEqual(events, [
    'reasoning-start:r1',
    'reasoning-append:r1:Need page state',
    'reasoning-complete:r1',
    'tool-input-start:call-1:browserRepl:Inspect page',
    'tool-input-append:call-1:{"code":',
    'tool-input-complete:call-1:browserRepl:{"code":"return 1"}',
  ]);
}

async function testInvalidToolCallEmitsFailure() {
  const events: string[] = [];
  await collectAgentResponseText({
    fullStream: streamParts([
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'extractImage', input: { source: 'bogus' }, invalid: true, error: new Error('source must be viewport, imageElement, canvas, or backgroundImage') },
      { type: 'tool-call', toolCallId: 'call-3', toolName: 'navigate', input: { action: 'currentTab' } },
      { type: 'finish', finishReason: 'stop' },
    ]),
    text: Promise.resolve(''),
  }, streamEvents(events));

  assert.deepEqual(events, [
    'tool-input-complete:call-2:extractImage:{"source":"bogus"}',
    'tool-fail:call-2:extractImage:source must be viewport, imageElement, canvas, or backgroundImage',
    'tool-input-complete:call-3:navigate:{"action":"currentTab"}',
  ]);
}

async function testToolInputPersistenceFailureStopsScheduledTool() {
  const abortController = new AbortController();
  const inputAudit = createToolInputAuditGate();
  let pageActions = 0;
  const tools = createAgentTools({
    sessionId: 1,
    foregroundMode: false,
    targetTabId: 7,
    async sendMessage() {
      pageActions += 1;
      throw new Error('scheduled page action must not run');
    },
    async emitEvent() {},
    waitForInputPersistence: inputAudit.wait,
    browserJsEnabled: false,
  });
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV3({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call-audit', toolName: 'navigate' },
          { type: 'tool-input-delta', id: 'call-audit', delta: '{"action":"currentTab"}' },
          { type: 'tool-input-end', id: 'call-audit' },
          { type: 'tool-call', toolCallId: 'call-audit', toolName: 'navigate', input: '{"action":"currentTab"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
  const result = await new ToolLoopAgent({ model, tools, stopWhen: stepCountIs(2) }).stream({
    prompt: 'test audit failure',
    abortSignal: abortController.signal,
  });
  let fatalCallbacks = 0;

  await assert.rejects(
    () => collectAgentResponseText(result, {
      createMessage: async () => {},
      appendText: async () => {},
      startToolInput: async () => {},
      appendToolInput: async () => {},
      completeToolInput: () => emitAgentEventFailClosed(
        async () => { throw new Error('synthetic tool.input.completed persistence failure'); },
        async () => { fatalCallbacks += 1; abortController.abort(); },
      ),
    }, { abortSignal: abortController.signal }),
    /synthetic tool\.input\.completed persistence failure/,
  );
  await Promise.resolve(result.text).catch(() => undefined);

  assert.equal(fatalCallbacks, 1);
  assert.equal(abortController.signal.aborted, true);
  assert.equal(pageActions, 0, 'an input whose audit event failed must not reach the page');
  assert.equal(model.doStreamCalls.length, 1, 'audit failure must stop the model loop');
}

async function testFallbackTextIsEmitted() {
  const events: string[] = [];
  const text = await collectAgentResponseText({
    fullStream: streamParts([{ type: 'finish', finishReason: 'stop' }]),
    text: Promise.resolve('Done'),
  }, streamEvents(events));

  assert.equal(text, 'Done');
  assert.deepEqual(events, ['create', 'append:Done']);
}

async function testFinishReasonErrorRejects() {
  const events: string[] = [];
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([{ type: 'finish', finishReason: 'error' }]),
      text: Promise.resolve('should not complete'),
    }, streamEvents(events)),
    /Model response failed\./,
  );
  assert.deepEqual(events, []);
}

async function testUnfinishedToolLoopRejects() {
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([{ type: 'finish', finishReason: 'tool-calls' }]),
      text: Promise.resolve(''),
    }, streamEvents([])),
    /tool-loop limit/,
  );
}

async function testDegenerateReasoningRejects() {
  const healthFailures: string[] = [];
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'reasoning-start', id: 'r-loop' },
        ...Array.from({ length: 100 }, () => ({ type: 'reasoning-delta', id: 'r-loop', text: ' '.repeat(100) })),
      ]),
      text: Promise.resolve(''),
    }, streamEvents([]), { onHealthFailure: (error) => { healthFailures.push(error); } }),
    /reasoning output exceeded .* consecutive whitespace/,
  );
  assert.equal(healthFailures.length, 1);
}

async function testDegenerateTextRejects() {
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts(Array.from({ length: 5 }, () => ({ type: 'text-delta', id: 'text-loop', text: ' '.repeat(8) }))),
      text: Promise.resolve(''),
    }, streamEvents([]), { maxConsecutiveContentWhitespaceChars: 32 }),
    /text output exceeded 32 consecutive whitespace/,
  );
}

async function testStepOutputBudgetRejectsRepetition() {
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'start-step' },
        { type: 'reasoning-delta', id: 'r-repeat', text: 'abcabc' },
        { type: 'reasoning-delta', id: 'r-repeat', text: 'abcabc' },
      ]),
      text: Promise.resolve(''),
    }, streamEvents([]), { maxStepOutputChars: 10 }),
    /step output exceeded 10 characters/,
  );
}

async function testToolInputRejectsContentAfterCompleteJson() {
  const events: string[] = [];
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'tool-input-start', id: 'call-junk', toolName: 'getDocument' },
        { type: 'tool-input-delta', id: 'call-junk', delta: '{"source":"url"}]} garbage' },
      ]),
      text: Promise.resolve(''),
    }, streamEvents(events)),
    /continued after complete JSON/,
  );
  assert.match(events.at(-1) ?? '', /^tool-fail:call-junk:getDocument:/);
}

async function testCapturedDegenerateToolInputRejects() {
  const events: string[] = [];
  const capturedPrefix = '{"source":"url","url":"https://www.google.com/search?q=%22Fantasy%22%22}]} garbage. But maybe user asked "';
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'tool-input-start', id: 'call-captured', toolName: 'getDocument' },
        { type: 'tool-input-delta', id: 'call-captured', delta: capturedPrefix },
        ...Array.from({ length: 6 }, () => ({ type: 'tool-input-delta', id: 'call-captured', delta: ' '.repeat(100) })),
      ]),
      text: Promise.resolve(''),
    }, streamEvents(events)),
    /exceeded 512 consecutive structural whitespace/,
  );
  assert.match(events.at(-1) ?? '', /^tool-fail:call-captured:getDocument:/);
}

async function testCompletedToolInputWhitespaceRejects() {
  const events: string[] = [];
  const whitespaceDeltas = Array.from({ length: 5 }, () => ({ type: 'tool-input-delta', id: 'call-loop', delta: ' '.repeat(8) }));
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'tool-input-start', id: 'call-loop', toolName: 'getDocument' },
        { type: 'tool-input-delta', id: 'call-loop', delta: '{"source":"url"}' },
        ...whitespaceDeltas,
      ]),
      text: Promise.resolve(''),
    }, streamEvents(events), { maxToolInputStructuralWhitespaceChars: 32 }),
    /exceeded 32 consecutive structural whitespace/,
  );
  assert.match(events.at(-1) ?? '', /^tool-fail:call-loop:getDocument:/);
}

async function testMaxSizeFsInputIsAccepted() {
  const content = ' '.repeat(MAX_FS_WRITE_CHARS);
  const input = { action: 'write', path: '/workspace/max.txt', content };
  await collectAgentResponseText({
    fullStream: streamParts([
      { type: 'tool-input-start', id: 'call-max-fs', toolName: 'fs' },
      { type: 'tool-input-delta', id: 'call-max-fs', delta: JSON.stringify(input) },
      { type: 'tool-call', toolCallId: 'call-max-fs', toolName: 'fs', input },
      { type: 'finish', finishReason: 'stop' },
    ]),
    text: Promise.resolve(''),
  }, silentStreamEvents());

  const escapedContent = '\0'.repeat(MAX_FS_WRITE_CHARS);
  await collectAgentResponseText({
    fullStream: streamParts([
      { type: 'tool-input-start', id: 'call-max-escaped', toolName: 'fs' },
      { type: 'tool-input-delta', id: 'call-max-escaped', delta: JSON.stringify({ ...input, content: escapedContent }) },
      { type: 'tool-call', toolCallId: 'call-max-escaped', toolName: 'fs', input: { ...input, content: escapedContent } },
      { type: 'finish', finishReason: 'stop' },
    ]),
    text: Promise.resolve(''),
  }, silentStreamEvents());
}

async function testOversizedToolInputRejects() {
  const events: string[] = [];
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'tool-input-start', id: 'call-large', toolName: 'fs' },
        { type: 'tool-input-delta', id: 'call-large', delta: '{"content":"too long"}' },
      ]),
      text: Promise.resolve(''),
    }, streamEvents(events), { maxToolInputChars: 16 }),
    /exceeded 16 characters/,
  );
  assert.match(events.at(-1) ?? '', /^tool-fail:call-large:fs:/);
}

async function testInternalTimeoutAbortIsHealthFailure() {
  const events: string[] = [];
  const healthFailures: string[] = [];
  await assert.rejects(
    () => collectAgentResponseText({
      fullStream: streamParts([
        { type: 'tool-input-start', id: 'call-timeout', toolName: 'browser' },
        { type: 'abort', reason: 'This operation was aborted' },
      ]),
      text: Promise.resolve(''),
    }, streamEvents(events), {
      abortSignal: new AbortController().signal,
      onHealthFailure: (error) => { healthFailures.push(error); },
    }),
    /Agent execution timed out/,
  );
  assert.deepEqual(healthFailures, ['Agent execution timed out.']);
  assert.match(events.at(-1) ?? '', /^tool-fail:call-timeout:browser:/);
}

async function testStalledStreamRejects() {
  const events: string[] = [];
  const healthFailures: string[] = [];
  const stalled: AsyncIterable<AgentStreamPart> = {
    [Symbol.asyncIterator]() {
      let first = true;
      return {
        next() {
          if (first) {
            first = false;
            return Promise.resolve({ done: false, value: { type: 'text-delta', text: 'partial' } as AgentStreamPart });
          }
          return new Promise(() => undefined); // upstream hangs forever
        },
      };
    },
  };
  await assert.rejects(
    () => collectAgentResponseText({ fullStream: stalled, text: Promise.resolve('') }, streamEvents(events), {
      idleTimeoutMs: 50,
      onHealthFailure: (error) => { healthFailures.push(error); },
    }),
    /Model stream stalled/,
  );
  assert.deepEqual(events, ['create', 'append:partial']);
  assert.equal(healthFailures.length, 1);
}

async function* streamParts(parts: AgentStreamPart[]) {
  for (const part of parts) yield part;
}

function silentStreamEvents() {
  return {
    createMessage: async () => {},
    appendText: async () => {},
    startToolInput: async () => {},
    appendToolInput: async () => {},
    completeToolInput: async () => {},
    failToolCall: async () => {},
  };
}

function streamEvents(events: string[]) {
  return {
    createMessage: async () => { events.push('create'); },
    appendText: async (delta: string) => { events.push(`append:${delta}`); },
    startReasoning: async ({ reasoningId }: { reasoningId: string }) => { events.push(`reasoning-start:${reasoningId}`); },
    appendReasoning: async ({ reasoningId, delta }: { reasoningId: string; delta: string }) => { events.push(`reasoning-append:${reasoningId}:${delta}`); },
    completeReasoning: async ({ reasoningId }: { reasoningId: string }) => { events.push(`reasoning-complete:${reasoningId}`); },
    startToolInput: async ({ toolCallId, toolName, title }: { toolCallId: string; toolName: string; title?: string }) => { events.push(`tool-input-start:${toolCallId}:${toolName}:${title ?? ''}`); },
    appendToolInput: async ({ toolCallId, delta }: { toolCallId: string; delta: string }) => { events.push(`tool-input-append:${toolCallId}:${delta}`); },
    completeToolInput: async ({ toolCallId, toolName, input }: { toolCallId: string; toolName: string; input: unknown }) => { events.push(`tool-input-complete:${toolCallId}:${toolName}:${JSON.stringify(input)}`); },
    failToolCall: async ({ toolCallId, toolName, error }: { toolCallId: string; toolName: string; error: string }) => { events.push(`tool-fail:${toolCallId}:${toolName}:${error}`); },
  };
}
