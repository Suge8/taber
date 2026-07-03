import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { database, initializeDatabase } = await import('../lib/db.ts');
const {
  saveProvider,
  updateProvider,
  deleteProvider,
  getProviderApiKey,
  saveModel,
  updateModel,
  deleteModel,
  setSelectedModelId,
  getSelectedModelId,
  listProvidersWithModels,
  testConnection,
  maskApiKey,
  getReasoningEffort,
  normalizeReasoningEffort,
  reasoningProviderOptions,
  setReasoningEffort,
} = await import('../lib/provider-store.ts');
const {
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
  deleteProviderModel,
  saveOpenAICodexModels,
  selectModel,
} = await import('../lib/provider-config-flow.ts');

await initializeDatabase();

await testSaveProviderAndModel();
await testCreateProviderConnectionIsAtomic();
await testUpdateProviderConnectionIsAtomic();
await testDeleteProviderConnectionCascades();
await testDeleteProviderModelFallsBack();
await testCodexModelRefreshFallbackAndManualContext();
await testUpdateModelContextWindow();
await testDeleteProviderCascadesAndClearsSelected();
await testDeleteProviderFallsBackToNextModel();
await testDeleteSelectedModelFallsBack();
await testUpdateProviderValidates();
await testMaskApiKey();
await testReasoningEffortSettings();
await testConnectionUsesBearerAndModelsEndpoint();
await testConnectionFailsOnHttpError();

database.close();
console.info('provider-store tests passed');

async function reset() {
  await database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await database.providers.clear();
    await database.providerCredentials.clear();
    await database.models.clear();
    await database.settings.clear();
  });
}

async function testSaveProviderAndModel() {
  await reset();
  const provider = await saveProvider({ name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test1234' });
  assert.equal(provider.kind, 'openaiCompatible');
  assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  assert.equal(await getProviderApiKey(provider.id), 'sk-test1234');
  const model = await saveModel({ providerId: provider.id, name: 'gpt-4o-mini' });
  await setSelectedModelId(model.id);
  const view = await listProvidersWithModels();
  assert.equal(view.length, 1);
  assert.equal(view[0]!.hasCredential, true);
  assert.equal(Object.hasOwn(view[0]!, 'apiKey'), false);
  assert.equal(view[0]!.models.length, 1);
  assert.equal(view[0]!.models[0]!.name, 'gpt-4o-mini');
  assert.equal(view[0]!.models[0]!.contextWindowTokens, 128000);
  assert.equal(await getSelectedModelId(), model.id);
}

async function testCreateProviderConnectionIsAtomic() {
  await reset();
  const created = await createProviderConnection({
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    models: [
      { name: 'gpt-a', contextWindowTokens: 200000 },
      { name: 'gpt-b' },
    ],
  });
  assert.equal(created.provider.kind, 'openaiCompatible');
  assert.equal(created.models.length, 2);
  assert.equal(await getProviderApiKey(created.provider.id), 'sk-test');
  assert.equal(await getSelectedModelId(), created.models[0]!.id);

  await reset();
  await assert.rejects(
    () => createProviderConnection({ name: 'Broken', baseURL: 'https://broken.example', apiKey: 'k', models: [{ name: 'bad', contextWindowTokens: 0 }] }),
    /positive integer/,
  );
  assert.equal((await database.providers.toArray()).length, 0);
  assert.equal((await database.providerCredentials.toArray()).length, 0);
  assert.equal((await database.models.toArray()).length, 0);
  assert.equal(await getSelectedModelId(), null);
}

async function testUpdateProviderConnectionIsAtomic() {
  await reset();
  const created = await createProviderConnection({
    name: 'Original',
    baseURL: 'https://old.example',
    apiKey: 'old-key',
    models: [{ name: 'keep' }, { name: 'remove' }],
  });
  await selectModel(created.models[1]!.id);
  const updated = await updateProviderConnection(created.provider.id, {
    name: 'Renamed',
    baseURL: 'https://new.example',
    apiKey: 'new-key',
    models: [
      { id: created.models[0]!.id, name: 'kept', contextWindowTokens: 64000 },
      { name: 'new', contextWindowTokens: 32000 },
    ],
  });

  assert.equal(updated.provider.name, 'Renamed');
  assert.equal(updated.provider.baseURL, 'https://new.example');
  assert.equal(await getProviderApiKey(created.provider.id), 'new-key');
  assert.deepEqual(updated.models.map((model) => model.name), ['kept', 'new']);
  assert.equal(updated.models.find((model) => model.name === 'kept')?.contextWindowTokens, 64000);
  assert.equal(await database.models.get(created.models[1]!.id), undefined);
  assert.equal(await getSelectedModelId(), created.models[0]!.id);
}

async function testDeleteProviderConnectionCascades() {
  await reset();
  const first = await createProviderConnection({ name: 'A', baseURL: 'https://a.example', apiKey: 'a', models: [{ name: 'a-model' }] });
  const second = await createProviderConnection({ name: 'B', baseURL: 'https://b.example', apiKey: 'b', models: [{ name: 'b-model' }] });
  await selectModel(first.models[0]!.id);
  const result = await deleteProviderConnection(first.provider.id);
  assert.deepEqual(result.removedModelIds, [first.models[0]!.id]);
  assert.equal(await database.providers.get(first.provider.id), undefined);
  assert.equal(await database.providerCredentials.get(first.provider.id), undefined);
  assert.equal(await database.models.get(first.models[0]!.id), undefined);
  assert.equal(await getSelectedModelId(), second.models[0]!.id);
}

async function testDeleteProviderModelFallsBack() {
  await reset();
  const created = await createProviderConnection({ name: 'P', baseURL: 'https://example.com', apiKey: 'k', models: [{ name: 'm1' }, { name: 'm2' }] });
  await selectModel(created.models[0]!.id);
  const result = await deleteProviderModel(created.models[0]!.id);
  assert.equal(result.nextSelectedModelId, created.models[1]!.id);
  assert.equal(await getSelectedModelId(), created.models[1]!.id);
}

async function testCodexModelRefreshFallbackAndManualContext() {
  await reset();
  const providerId = Number(await database.providers.add({
    kind: 'openaiCodex',
    name: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    createdAt: 1,
    updatedAt: 1,
  }));
  await database.providerCredentials.put({
    providerId,
    kind: 'openaiCodexOAuth',
    value: { accessToken: 'access', refreshToken: 'refresh', expiresAt: 2, accountId: 'account' },
    updatedAt: 1,
  });
  const initial = await saveOpenAICodexModels(providerId, [{ name: 'gpt-5.5', contextWindowTokens: 128000 }], 10);
  await database.models.update(initial[0]!.id, { contextWindowTokens: 64000 });
  const refreshed = await saveOpenAICodexModels(providerId, [
    { name: 'gpt-5.5', contextWindowTokens: 272000 },
    { name: 'gpt-new', contextWindowTokens: 512000 },
  ], 20);
  assert.equal(refreshed.find((model) => model.name === 'gpt-5.5')?.contextWindowTokens, 64000);

  await selectModel(initial[0]!.id);
  const next = await saveOpenAICodexModels(providerId, [{ name: 'gpt-new', contextWindowTokens: 512000 }], 30);
  assert.equal((await database.models.get(initial[0]!.id))?.unavailable, true);
  assert.equal(await getSelectedModelId(), next[0]!.id);
}

async function testUpdateModelContextWindow() {
  await reset();
  const provider = await saveProvider({ name: 'P', baseURL: 'https://example.com', apiKey: 'k' });
  const model = await saveModel({ providerId: provider.id, name: 'm', contextWindowTokens: 200000 });
  assert.equal(model.contextWindowTokens, 200000);
  const updated = await updateModel(model.id, { contextWindowTokens: 64000 });
  assert.equal(updated.contextWindowTokens, 64000);
  await assert.rejects(() => updateModel(model.id, { contextWindowTokens: 0 }), /positive integer/);
}

async function testDeleteProviderCascadesAndClearsSelected() {
  await reset();
  const provider = await saveProvider({ name: 'P', baseURL: 'https://example.com', apiKey: 'k' });
  const model = await saveModel({ providerId: provider.id, name: 'm' });
  await setSelectedModelId(model.id);
  const result = await deleteProvider(provider.id);
  assert.deepEqual(result.removedModelIds, [model.id]);
  assert.equal(result.nextSelectedModelId, null);
  assert.equal(await getSelectedModelId(), null);
  assert.equal((await database.models.toArray()).length, 0);
  assert.equal(await database.providerCredentials.get(provider.id), undefined);
}

async function testDeleteProviderFallsBackToNextModel() {
  await reset();
  const a = await saveProvider({ name: 'A', baseURL: 'https://a.example', apiKey: 'k' });
  const b = await saveProvider({ name: 'B', baseURL: 'https://b.example', apiKey: 'k' });
  const ma = await saveModel({ providerId: a.id, name: 'm-a' });
  const mb = await saveModel({ providerId: b.id, name: 'm-b' });
  await setSelectedModelId(ma.id);
  const result = await deleteProvider(a.id);
  assert.equal(result.nextSelectedModelId, mb.id);
  assert.equal(await getSelectedModelId(), mb.id);
}

async function testDeleteSelectedModelFallsBack() {
  await reset();
  const provider = await saveProvider({ name: 'P', baseURL: 'https://example.com', apiKey: 'k' });
  const m1 = await saveModel({ providerId: provider.id, name: 'm1' });
  const m2 = await saveModel({ providerId: provider.id, name: 'm2' });
  await setSelectedModelId(m1.id);
  const result = await deleteModel(m1.id);
  assert.equal(result.nextSelectedModelId, m2.id);
}

async function testUpdateProviderValidates() {
  await reset();
  const provider = await saveProvider({ name: 'P', baseURL: 'https://example.com', apiKey: 'k' });
  await assert.rejects(() => updateProvider(provider.id, { baseURL: 'not a url' }), /valid URL/);
  await updateProvider(provider.id, { name: 'Renamed', apiKey: 'new-key' });
  const reread = await database.providers.get(provider.id);
  assert.equal(reread?.name, 'Renamed');
  assert.equal(Object.hasOwn(reread!, 'apiKey'), false);
  assert.equal(await getProviderApiKey(provider.id), 'new-key');
}

function testMaskApiKey() {
  assert.equal(maskApiKey('sk-abcd1234'), '••••1234');
  assert.equal(maskApiKey('xxx'), '••••');
}

async function testReasoningEffortSettings() {
  await reset();
  assert.equal(await getReasoningEffort(), 'default');
  assert.equal(normalizeReasoningEffort('none'), 'default');
  assert.equal(reasoningProviderOptions('default'), undefined);
  assert.deepEqual(reasoningProviderOptions('low'), { openaiCompatible: { reasoningEffort: 'low' } });
  assert.deepEqual(reasoningProviderOptions('medium'), { openaiCompatible: { reasoningEffort: 'medium' } });
  assert.deepEqual(reasoningProviderOptions('high'), { openaiCompatible: { reasoningEffort: 'high' } });
  await setReasoningEffort('high');
  assert.equal(await getReasoningEffort(), 'high');
}

async function testConnectionUsesBearerAndModelsEndpoint() {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedAuth = '';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    capturedAuth = headers?.Authorization ?? '';
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await testConnection('https://api.example.com/v1/', 'sk-test');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.modelIds, ['gpt-4o']);
    assert.equal(capturedUrl, 'https://api.example.com/v1/models');
    assert.equal(capturedAuth, 'Bearer sk-test');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testConnectionFailsOnHttpError() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('forbidden', { status: 403, statusText: 'Forbidden' })) as typeof fetch;
  try {
    const result = await testConnection('https://api.example.com', 'bad');
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.includes('403'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}
