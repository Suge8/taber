import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { CODEX_MODELS_URL } from '../lib/codex-auth.ts';
import { connectOpenAICodex, readCodexTokens, readFreshCodexTokens, saveCodexModels } from '../lib/codex-provider.ts';
import { createProviderConnection, selectModel, signOutOpenAICodex } from '../lib/provider-config-flow.ts';
import { database, initializeDatabase } from '../lib/db.ts';

await initializeDatabase();
await reset();

await testConnectStoresCredentialAndModels();
await testMissingModelsAreMarkedUnavailable();
await testSignOutFallsBackToCredentialedModel();
await testSignOutClearsSelectedWithoutFallback();
await testInFlightTokenRefreshCannotRestoreSignedOutCredential();

database.close();
console.info('codex-provider tests passed');

async function reset() {
  database.close();
  await database.delete();
  await initializeDatabase();
}

async function testConnectStoresCredentialAndModels() {
  await reset();
  let capturedAuth = '';
  let capturedAccount = '';
  const { provider, models } = await connectOpenAICodex({
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 2_000_000,
    accountId: 'account-secret',
    email: 'user@example.com',
  }, {
    now: 1_000_000,
    fetch: async (input, init) => {
      assert.equal(String(input), CODEX_MODELS_URL);
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get('authorization') ?? '';
      capturedAccount = headers.get('chatgpt-account-id') ?? '';
      return jsonResponse({ models: [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          context_window: 272000,
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
          default_reasoning_level: 'high',
          priority: 1,
          visibility: 'list',
          supported_in_api: true,
        },
      ] });
    },
  });

  assert.equal(provider.kind, 'openaiCodex');
  assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  assert.equal(capturedAuth, 'Bearer access-secret');
  assert.equal(capturedAccount, 'account-secret');
  assert.equal(models.length, 1);
  assert.equal(models[0]!.name, 'gpt-5.5');
  assert.equal(models[0]!.displayName, 'GPT-5.5');
  assert.deepEqual(models[0]!.supportedReasoningEfforts, ['low', 'high']);
  assert.equal(models[0]!.defaultReasoningEffort, 'high');
  assert.equal(models[0]!.metadataFetchedAt, 1_000_000);
  assert.equal((await database.settings.get('selectedModelId'))?.value, models[0]!.id);

  const credential = await database.providerCredentials.get(provider.id);
  assert.equal(credential?.kind, 'openaiCodexOAuth');
  assert.equal((await readCodexTokens(provider.id))?.email, 'user@example.com');
  assert(!JSON.stringify(await database.providers.toArray()).includes('access-secret'));
  assert(!JSON.stringify(await database.models.toArray()).includes('access-secret'));
  assert(!JSON.stringify(await database.settings.toArray()).includes('access-secret'));
}

async function testMissingModelsAreMarkedUnavailable() {
  await reset();
  const providerId = await database.providers.add({
    kind: 'openaiCodex',
    name: 'ChatGPT subscription',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    createdAt: 1,
    updatedAt: 1,
  });
  await database.providerCredentials.put({ providerId: Number(providerId), kind: 'openaiCodexOAuth', value: codexCredentialValue(), updatedAt: 1 });
  await saveCodexModels(Number(providerId), [{ name: 'old-model', contextWindowTokens: 128000 }], 10);
  await saveCodexModels(Number(providerId), [{ name: 'new-model', contextWindowTokens: 272000 }], 20);
  const models = await database.models.where('providerId').equals(Number(providerId)).toArray();
  assert.equal(models.find((model) => model.name === 'old-model')?.unavailable, true);
  assert.equal(models.find((model) => model.name === 'new-model')?.unavailable, false);
}

async function testSignOutFallsBackToCredentialedModel() {
  await reset();
  const api = await createProviderConnection({
    name: 'API',
    baseURL: 'https://api.example.com',
    apiKey: 'sk-api',
    models: [{ name: 'api-model' }],
  });
  const codex = await connectOpenAICodex(codexTokens(), { fetch: codexModelsFetch(), now: 1_000_000 });
  await selectModel(codex.models[0]!.id);

  const result = await signOutOpenAICodex(codex.provider.id);

  assert.equal(await database.providerCredentials.get(codex.provider.id), undefined);
  assert.equal(result.nextSelectedModelId, api.models[0]!.id);
  assert.equal((await database.settings.get('selectedModelId'))?.value, api.models[0]!.id);
}

async function testSignOutClearsSelectedWithoutFallback() {
  await reset();
  const codex = await connectOpenAICodex(codexTokens(), { fetch: codexModelsFetch(), now: 1_000_000 });
  await selectModel(codex.models[0]!.id);

  const result = await signOutOpenAICodex(codex.provider.id);

  assert.equal(await database.providerCredentials.get(codex.provider.id), undefined);
  assert.equal(result.nextSelectedModelId, null);
  assert.equal(await database.settings.get('selectedModelId'), undefined);
}

async function testInFlightTokenRefreshCannotRestoreSignedOutCredential() {
  await reset();
  const codex = await connectOpenAICodex({ ...codexTokens(), expiresAt: 1_000 }, { fetch: codexModelsFetch(), now: 1_000_000 });
  const refresh = deferred<Response>();
  const refreshStarted = deferred<void>();
  const refreshPromise = readFreshCodexTokens(codex.provider.id, {
    now: 2_000_000,
    fetch: async () => {
      refreshStarted.resolve();
      return refresh.promise;
    },
  });
  await refreshStarted.promise;

  await signOutOpenAICodex(codex.provider.id);
  refresh.resolve(jsonResponse({
    access_token: 'new-access-secret',
    refresh_token: 'new-refresh-secret',
    id_token: jwt({ chatgpt_account_id: 'account-secret', exp: 4_000 }),
    expires_in: 3600,
  }));

  await assert.rejects(refreshPromise, /not signed in/i);
  assert.equal(await database.providerCredentials.get(codex.provider.id), undefined);
  assert.equal(await database.settings.get('selectedModelId'), undefined);
}

function codexModelsFetch() {
  return async () => jsonResponse({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, visibility: 'list' }] });
}

function codexTokens() {
  return {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 2_000_000,
    accountId: 'account-secret',
    email: 'user@example.com',
  };
}

function codexCredentialValue() {
  return {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 2_000_000,
    accountId: 'account-secret',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function jwt(payload: Record<string, unknown>) {
  return `${base64Url({ alg: 'none' })}.${base64Url(payload)}.`;
}

function base64Url(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
