import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { AGENT_TOOL_PROMPT_ESTIMATE_TEXT, createAgentToolPromptEstimateText, createAgentTools } from '../lib/agent-tools.ts';
import { createSession, database, initializeDatabase } from '../lib/db.ts';

await initializeDatabase();
await createSession({ now: 1 });

const messages: unknown[] = [];
const tools = createAgentTools({
  sessionId: 1,
  windowId: 42,
  async sendMessage(message) {
    messages.push(message);
    if (isRecord(message) && message.type === 'taber.extractImage.captureVisibleTab') return 'data:image/png;base64,AAA=';
    if (isRecord(message) && message.type === 'taber.navigate.request') return { action: 'currentTab', tab: { id: 7 } };
    throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
  },
  async emitEvent() {},
  browserJsEnabled: false,
});

assert.equal('debugger' in tools, false);
assert.equal(JSON.parse(AGENT_TOOL_PROMPT_ESTIMATE_TEXT).debugger, undefined);
assert.match(JSON.parse(createAgentToolPromptEstimateText({ browserJsEnabled: false })).browserRepl.description, /waitFor, sandbox, pickElement/);
assert.doesNotMatch(JSON.parse(createAgentToolPromptEstimateText({ browserJsEnabled: false })).browserRepl.description, /browserjs/);

const image = await (tools.extractImage.execute as (input: unknown, options: unknown) => Promise<unknown>)({ source: 'viewport' }, { abortSignal: new AbortController().signal });
const file = await (tools.getDocument.execute as (input: unknown, options: unknown) => Promise<unknown>)({ source: 'file', fileText: 'skip current tab' }, { abortSignal: new AbortController().signal });
await (tools.navigate.execute as (input: unknown, options: unknown) => Promise<unknown>)({ action: 'currentTab' }, { abortSignal: new AbortController().signal });

assert.deepEqual(image, { ok: true, source: 'viewport', dataUrl: 'data:image/png;base64,AAA=', mediaType: 'image/png' });
assert.deepEqual(file, { ok: true, source: 'file', title: undefined, content: 'skip current tab', contentChars: 16, truncated: false });
assert.deepEqual(
  messages.filter((message) => isRecord(message)).map((message) => ({ type: message.type, windowId: message.windowId, input: message.input })),
  [
    { type: 'taber.extractImage.captureVisibleTab', windowId: 42, input: { source: 'viewport' } },
    { type: 'taber.navigate.request', windowId: 42, input: { action: 'currentTab' } },
  ],
);

database.close();
console.info('agent tools tests passed');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
