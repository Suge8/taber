import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { database, initializeDatabase } from '../lib/db.ts';
import {
  apiKeyProviderKind,
  createOpenAIApiModelCatalogSnapshot,
  currentOpenAIApiModelCatalog,
  discoverOpenAIApiModels,
  fetchOpenAIApiModelIds,
  listOpenAIApiModelCatalog,
} from '../lib/openai-api-provider.ts';
import { createOpenAIApiLanguageModel, openAIProviderOptions } from '../lib/openai-runtime.ts';
import { showManualContextWindowInput } from '../lib/provider-settings-policy.ts';

await initializeDatabase();
await reset();
await testProviderKind();
await testFetchOpenAIModelIds();
await testListOpenAIModelCatalogUsesAccountModelsAsPrimary();
await testAccountModelCatalogSnapshotFollowsCurrentCredentials();
await testDiscoverOpenAIModelsUsesAccountAndCatalogMetadata();
await testDiscoverOpenAIModelsRejectsUnavailableSelection();
testProviderSettingsHidesOfficialOpenAIContextOverride();
await testOpenAIApiRuntimeUsesResponsesAndReasoningMetadata();

database.close();
console.info('openai api provider tests passed');

async function reset() {
  await database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await database.providers.clear();
    await database.providerCredentials.clear();
    await database.models.clear();
    await database.settings.clear();
  });
}

function testProviderKind() {
  assert.equal(apiKeyProviderKind('https://api.openai.com/v1/'), 'openaiApiKey');
  assert.equal(apiKeyProviderKind('https://proxy.example/v1'), 'openaiCompatible');
}

async function testFetchOpenAIModelIds() {
  let capturedUrl = '';
  let capturedAuth = '';
  const ids = await fetchOpenAIApiModelIds('https://api.openai.com/v1/', 'sk-test', (async (input, init) => {
    capturedUrl = String(input);
    capturedAuth = new Headers(init?.headers).get('authorization') ?? '';
    return jsonResponse({ data: [{ id: 'gpt-5.4' }, { id: 'text-embedding-3-small' }] });
  }) as typeof fetch);
  assert.equal(capturedUrl, 'https://api.openai.com/v1/models');
  assert.equal(capturedAuth, 'Bearer sk-test');
  assert.deepEqual(ids, ['gpt-5.4', 'text-embedding-3-small']);
}

async function testListOpenAIModelCatalogUsesAccountModelsAsPrimary() {
  await reset();
  const catalog = await listOpenAIApiModelCatalog({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    fetch: openAIFetch,
  });
  assert.deepEqual(catalog.models.map((model) => model.name), ['gpt-unknown', 'gpt-5.4']);
  assert.equal(catalog.models[0]!.contextWindowTokens, 128000);
  assert.deepEqual(catalog.models[0]!.supportedReasoningEfforts, []);
  assert.equal(catalog.models[1]!.contextWindowTokens, 1050000);
  assert.deepEqual(catalog.models[1]!.supportedReasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(catalog.models.some((model) => model.name === 'gpt-missing'), false);
}

async function testAccountModelCatalogSnapshotFollowsCurrentCredentials() {
  await reset();
  const catalog = await listOpenAIApiModelCatalog({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test', fetch: openAIFetch });
  const snapshot = createOpenAIApiModelCatalogSnapshot({ baseURL: 'https://api.openai.com/v1/', apiKey: ' sk-test ' }, catalog);
  assert.equal(currentOpenAIApiModelCatalog(snapshot, { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test' }), catalog);
  assert.equal(currentOpenAIApiModelCatalog(snapshot, { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-other' }), null);
  assert.equal(currentOpenAIApiModelCatalog(snapshot, { baseURL: 'https://proxy.example/v1', apiKey: 'sk-test' }), null);
}

async function testDiscoverOpenAIModelsUsesAccountAndCatalogMetadata() {
  await reset();
  const models = await discoverOpenAIApiModels({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    selectedModelNames: ['gpt-unknown', 'gpt-5.4'],
    fetch: openAIFetch,
  });
  assert.deepEqual(models, [
    {
      name: 'gpt-unknown',
      contextWindowTokens: 128000,
      supportedReasoningEfforts: [],
    },
    {
      name: 'gpt-5.4',
      contextWindowTokens: 1050000,
      displayName: 'GPT-5.4',
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
  ]);
}

async function testDiscoverOpenAIModelsRejectsUnavailableSelection() {
  await reset();
  await assert.rejects(() => discoverOpenAIApiModels({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    selectedModelNames: ['gpt-missing'],
    fetch: openAIFetch,
  }), /cannot access selected model/);
}

function testProviderSettingsHidesOfficialOpenAIContextOverride() {
  assert.equal(showManualContextWindowInput('openaiApiKey'), false);
  assert.equal(showManualContextWindowInput('openaiCodex'), false);
  assert.equal(showManualContextWindowInput('openaiCompatible'), true);
}

async function testOpenAIApiRuntimeUsesResponsesAndReasoningMetadata() {
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  let capturedBody: Record<string, unknown> = {};
  const model = createOpenAIApiLanguageModel({
    modelId: 'gpt-5.4',
    providerName: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body));
      return jsonResponse({ id: 'response-1', model: 'gpt-5.4', output: [{ type: 'message', role: 'assistant', id: 'msg-1', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }] });
    },
  }) as any;

  await model.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    providerOptions: openAIProviderOptions('xhigh', ['none', 'xhigh'], 'gpt-5.4'),
  });
  assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
  assert.equal(capturedHeaders.get('authorization'), 'Bearer sk-test');
  assert.equal(capturedBody.model, 'gpt-5.4');
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.parallel_tool_calls, true);
  assert.deepEqual(capturedBody.reasoning, { effort: 'xhigh', summary: 'detailed' });
}

async function openAIFetch(input: RequestInfo | URL) {
  const url = String(input);
  if (url === 'https://api.openai.com/v1/models') return jsonResponse({ data: [{ id: 'gpt-unknown' }, { id: 'gpt-5.4' }] });
  if (url === 'https://models.dev/api.json') return jsonResponse({
    openai: {
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      models: {
        'gpt-5.4': {
          name: 'GPT-5.4',
          limit: { context: 1050000 },
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }],
        },
      },
    },
  });
  return jsonResponse({}, 404, 'Not Found');
}

function jsonResponse(body: unknown, status = 200, statusText = 'OK') {
  return new Response(JSON.stringify(body), { status, statusText, headers: { 'Content-Type': 'application/json' } });
}
