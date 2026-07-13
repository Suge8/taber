import assert from 'node:assert/strict';
import { createXaiLanguageModel, xaiProviderOptions } from '../lib/xai-runtime.ts';

assert.deepEqual(xaiProviderOptions('default'), {
  openai: { store: false, parallelToolCalls: true, forceReasoning: true },
});
assert.deepEqual(xaiProviderOptions('high'), {
  openai: { store: false, parallelToolCalls: true, forceReasoning: true, reasoningEffort: 'high' },
});

testUnsupportedReasoningThrows();
await testGenerateSendsResponsesRequest();
await testAuthRunsForEachRequest();
await testErrorsDoNotExposeAuthorization();

console.info('xai-runtime tests passed');

function testUnsupportedReasoningThrows() {
  assert.throws(() => createXaiLanguageModel({
    modelId: 'grok-4.5',
    providerName: 'xAI subscription',
    baseURL: 'https://xai.invalid/v1',
    reasoningEffort: 'medium',
    supportedReasoningEfforts: ['low', 'high'],
    auth: async () => ({ accessToken: 'xai-access-unsupported-synthetic' }),
  }), /does not support reasoning effort "medium"/);
}

async function testGenerateSendsResponsesRequest() {
  const accessToken = 'xai-access-generate-synthetic';
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};
  const model = createXaiLanguageModel({
    modelId: 'grok-4.5',
    providerName: 'xAI subscription',
    baseURL: 'https://xai.invalid/v1/',
    reasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    auth: async () => ({ accessToken }),
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body));
      return responsesJson('grok-4.5');
    },
  }) as any;

  const result = await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic prompt' }] }],
    providerOptions: xaiProviderOptions('high'),
  });

  assert.equal(capturedUrl, 'https://xai.invalid/v1/responses');
  assert.equal(capturedHeaders.get('authorization'), `Bearer ${accessToken}`);
  assert.notEqual(capturedHeaders.get('authorization'), 'Bearer unused');
  assert.equal(capturedBody.model, 'grok-4.5');
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.parallel_tool_calls, true);
  assert.deepEqual(capturedBody.reasoning, { effort: 'high' });
  assert(!JSON.stringify(capturedBody).includes(accessToken));
  assert(!JSON.stringify(result.request.body).includes(accessToken));
  assert(!JSON.stringify(result).includes(accessToken));
}

async function testAuthRunsForEachRequest() {
  const authorizationHeaders: string[] = [];
  let authCalls = 0;
  const model = createXaiLanguageModel({
    modelId: 'grok-4.5',
    providerName: 'xAI subscription',
    baseURL: 'https://xai.invalid/v1',
    reasoningEffort: 'default',
    auth: async () => {
      authCalls += 1;
      return { accessToken: `xai-access-fresh-${authCalls}-synthetic` };
    },
    fetch: async (_input, init) => {
      authorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
      return responsesJson('grok-4.5');
    },
  }) as any;

  await model.doGenerate(generateOptions('One'));
  await model.doGenerate(generateOptions('Two'));

  assert.equal(authCalls, 2);
  assert.deepEqual(authorizationHeaders, [
    'Bearer xai-access-fresh-1-synthetic',
    'Bearer xai-access-fresh-2-synthetic',
  ]);
}

async function testErrorsDoNotExposeAuthorization() {
  const accessToken = 'xai-access-error-synthetic';
  const model = createXaiLanguageModel({
    modelId: 'grok-4.5',
    providerName: 'xAI subscription',
    baseURL: 'https://xai.invalid/v1',
    reasoningEffort: 'default',
    auth: async () => ({ accessToken }),
    fetch: async () => new Response(JSON.stringify({ error: { message: 'Synthetic endpoint unavailable' } }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    }),
  }) as any;

  await assert.rejects(
    () => model.doGenerate(generateOptions('Fail safely')),
    (error: unknown) => {
      const serialized = serializeError(error);
      assert(!serialized.includes(accessToken));
      assert(!serialized.includes('unused'));
      return true;
    },
  );
}

function generateOptions(text: string) {
  return {
    prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
    providerOptions: xaiProviderOptions('default'),
  };
}

function responsesJson(model: string) {
  return new Response(JSON.stringify({
    id: 'response-synthetic',
    created_at: 0,
    model,
    output: [{
      type: 'message',
      role: 'assistant',
      id: 'message-synthetic',
      content: [{ type: 'output_text', text: 'Synthetic result', annotations: [] }],
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function serializeError(error: unknown) {
  if (typeof error !== 'object' || error === null) return String(error);
  const details = error as { message?: unknown; responseBody?: unknown; stack?: unknown };
  return [details.message, details.responseBody, details.stack].map(String).join('\n');
}
