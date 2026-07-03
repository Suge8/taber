import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createCodexLanguageModel } from '../lib/codex-runtime.ts';
import { connectOpenAICodex } from '../lib/codex-provider.ts';
import { database, initializeDatabase } from '../lib/db.ts';
import { readSelectedConfiguredModel, signOutOpenAICodex } from '../lib/provider-config-flow.ts';

await testStreamSendsResponsesRequest();
await testDefaultReasoningIsOmitted();
await testUnsupportedReasoningThrows();
await testAuthRunsForEachRequest();
await testHttpErrorRedactsSecrets();
await testSignedOutCodexIsNotRuntimeDefault();

database.close();
console.info('codex-runtime tests passed');

async function testStreamSendsResponsesRequest() {
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};
  const model = createCodexLanguageModel({
    modelId: 'codex-mini',
    providerName: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex/',
    reasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'high'],
    auth: async () => ({ accessToken: 'access-secret', accountId: 'account-secret' }),
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse(
        { type: 'response.created', response: { id: 'response-1', model: 'codex-mini' } },
        { type: 'response.output_text.delta', delta: 'Done' },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-1', name: 'navigate', arguments: '{"action":"read"}' } },
        { type: 'response.completed', response: { id: 'response-1', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 15 } } },
      );
    },
  }) as any;

  const result = await model.doStream({
    prompt: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: [{ type: 'text', text: 'Open the current tab' }] },
    ],
    tools: [{ type: 'function', name: 'navigate', description: 'Navigate tabs', inputSchema: { type: 'object' } }],
  });
  const parts = await readStream(result.stream);

  assert.equal(capturedUrl, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(capturedHeaders.get('authorization'), 'Bearer access-secret');
  assert.equal(capturedHeaders.get('chatgpt-account-id'), 'account-secret');
  assert.equal(capturedHeaders.get('openai-beta'), 'responses=experimental');
  assert.equal(capturedHeaders.get('originator'), 'taber');
  assert.equal(capturedBody.model, 'codex-mini');
  assert.equal(capturedBody.instructions, 'System prompt');
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.stream, true);
  assert.deepEqual(capturedBody.reasoning, { effort: 'high' });
  assert.deepEqual(capturedBody.tools, [{ type: 'function', name: 'navigate', description: 'Navigate tabs', parameters: { type: 'object' } }]);
  assert.deepEqual(capturedBody.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Open the current tab' }] }]);
  assert(parts.some((part) => part.type === 'text-delta' && part.delta === 'Done'));
  assert(parts.some((part) => part.type === 'tool-call' && part.toolCallId === 'call-1' && part.toolName === 'navigate'));
  assert(!JSON.stringify(result.request.body).includes('access-secret'));
  assert(!JSON.stringify(parts).includes('access-secret'));
}

async function testDefaultReasoningIsOmitted() {
  let capturedBody: Record<string, unknown> = {};
  const model = createCodexLanguageModel({
    modelId: 'codex-mini',
    providerName: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    reasoningEffort: 'default',
    supportedReasoningEfforts: ['low'],
    auth: async () => ({ accessToken: 'access-secret', accountId: 'account-secret' }),
    fetch: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return sseResponse({ type: 'response.completed', response: { id: 'response-1' } });
    },
  }) as any;

  const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] });
  await readStream(result.stream);
  assert.equal(Object.hasOwn(capturedBody, 'reasoning'), false);
}

function testUnsupportedReasoningThrows() {
  assert.throws(() => createCodexLanguageModel({
    modelId: 'codex-mini',
    providerName: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    reasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'high'],
    auth: async () => ({ accessToken: 'access-secret', accountId: 'account-secret' }),
  }), /does not support reasoning effort "medium"/);
}

async function testAuthRunsForEachRequest() {
  const authorizationHeaders: string[] = [];
  let authCalls = 0;
  const model = createCodexLanguageModel({
    modelId: 'codex-mini',
    providerName: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    reasoningEffort: 'default',
    auth: async () => {
      authCalls += 1;
      return { accessToken: `access-${authCalls}`, accountId: 'account-secret' };
    },
    fetch: async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
      return jsonResponse({ id: 'response-1', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] });
    },
  }) as any;

  await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'One' }] }] });
  await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Two' }] }] });
  assert.deepEqual(authorizationHeaders, ['Bearer access-1', 'Bearer access-2']);
}

async function testHttpErrorRedactsSecrets() {
  const model = createCodexLanguageModel({
    modelId: 'codex-mini',
    providerName: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    reasoningEffort: 'default',
    auth: async () => ({ accessToken: 'access-secret', accountId: 'account-secret' }),
    fetch: async () => new Response('access-secret account-secret rt_refreshSECRET', { status: 401, statusText: 'Unauthorized' }),
  }) as any;

  await assert.rejects(
    () => model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert(!message.includes('access-secret'));
      assert(!message.includes('account-secret'));
      assert(!message.includes('rt_refreshSECRET'));
      assert(message.includes('<redacted>') || message.includes('<redacted-refresh-token>'));
      return true;
    },
  );
}

async function testSignedOutCodexIsNotRuntimeDefault() {
  await resetDatabase();
  const { provider } = await connectOpenAICodex({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 2_000_000,
    accountId: 'account-secret',
  }, { fetch: codexModelsFetch(), now: 1_000_000 });
  await signOutOpenAICodex(provider.id);

  assert.equal((await database.models.where('providerId').equals(provider.id).first())?.name, 'gpt-5.5');
  assert.equal((await database.settings.get('selectedModelId'))?.value, undefined);
  assert.equal(await readSelectedConfiguredModel(), undefined);
}

async function readStream(stream: ReadableStream) {
  const parts: any[] = [];
  for await (const part of stream as any) parts.push(part);
  return parts;
}

async function resetDatabase() {
  database.close();
  await database.delete();
  await initializeDatabase();
}

function codexModelsFetch() {
  return async () => jsonResponse({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, visibility: 'list' }] });
}

function sseResponse(...events: Record<string, unknown>[]) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
