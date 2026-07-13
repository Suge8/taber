import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { database, initializeDatabase } from '../lib/db.ts';
import { saveXaiCredential, signOutXaiSub } from '../lib/provider-config-flow.ts';
import {
  connectXaiSub,
  readFreshXaiTokens,
  readXaiTokens,
  XAI_API_BASE_URL,
  XAI_DEFAULT_MODEL_ID,
  XAI_SUB_PROVIDER_NAME,
} from '../lib/xai-provider.ts';
import { XAI_MODELS } from '../lib/xai-auth.ts';

await initializeDatabase();
await testConnectStoresCredentialAndModel();
await testFreshTokenSkipsRefresh();
await testExpiringTokenRefreshesAndPreservesIdentity();
await testInvalidCredentialsAreRejected();
await testInFlightRefreshCannotRestoreSignedOutCredential();
await testInFlightRefreshCannotOverwriteNewCredential();

database.close();
console.info('xai-provider tests passed');

async function reset() {
  database.close();
  await database.delete();
  await initializeDatabase();
}

async function testConnectStoresCredentialAndModel() {
  await reset();
  const tokens = xaiTokens();
  const { provider, models, selectedModelId } = await connectXaiSub(tokens, { now: 1_000_000 });
  const expectedModel = XAI_MODELS[0]!;

  assert.equal(provider.kind, 'xaiSub');
  assert.equal(provider.name, XAI_SUB_PROVIDER_NAME);
  assert.equal(provider.baseURL, XAI_API_BASE_URL);
  assert.equal(Object.hasOwn(provider, 'apiKey'), false);
  assert.equal(models.length, 1);
  assert.equal(models[0]!.name, XAI_DEFAULT_MODEL_ID);
  assert.equal(models[0]!.displayName, expectedModel.displayName);
  assert.equal(models[0]!.contextWindowTokens, expectedModel.contextWindowTokens);
  assert.deepEqual(models[0]!.supportedReasoningEfforts, expectedModel.supportedReasoningEfforts);
  assert.equal(models[0]!.defaultReasoningEffort, expectedModel.defaultReasoningEffort);
  assert.equal(selectedModelId, models[0]!.id);
  assert.equal((await database.settings.get('selectedModelId'))?.value, models[0]!.id);

  const credential = await database.providerCredentials.get(provider.id);
  assert.equal(credential?.kind, 'xaiSubOAuth');
  assert.deepEqual(await readXaiTokens(provider.id), tokens);
  for (const records of [
    await database.providers.toArray(),
    await database.models.toArray(),
    await database.settings.toArray(),
  ]) {
    const serialized = JSON.stringify(records);
    assert(!serialized.includes(tokens.accessToken));
    assert(!serialized.includes(tokens.refreshToken));
  }
}

async function testFreshTokenSkipsRefresh() {
  await reset();
  const tokens = xaiTokens({ expiresAt: 3_000_000 });
  const { provider } = await connectXaiSub(tokens, { now: 1_000_000 });
  let fetchCalls = 0;

  const result = await readFreshXaiTokens(provider.id, {
    now: 2_000_000,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('fresh token must not be refreshed');
    },
  });

  assert.deepEqual(result, tokens);
  assert.equal(fetchCalls, 0);
}

async function testExpiringTokenRefreshesAndPreservesIdentity() {
  await reset();
  const previous = xaiTokens({ expiresAt: 1_000, email: 'person@example.test', name: 'Synthetic Person' });
  const { provider } = await connectXaiSub(previous, { now: 1_000_000 });
  let refreshCalls = 0;

  const result = await readFreshXaiTokens(provider.id, {
    now: 2_000_000,
    fetch: async (_input, init) => {
      refreshCalls += 1;
      const body = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(body.get('refresh_token'), previous.refreshToken);
      return jsonResponse({ access_token: 'xai-access-refreshed-synthetic', expires_in: 3600 });
    },
  });

  assert.equal(refreshCalls, 1);
  assert.deepEqual(result, {
    accessToken: 'xai-access-refreshed-synthetic',
    refreshToken: previous.refreshToken,
    expiresAt: 5_600_000,
    email: previous.email,
    name: previous.name,
  });
  assert.deepEqual(await readXaiTokens(provider.id), result);
}

async function testInvalidCredentialsAreRejected() {
  await reset();
  const { provider } = await connectXaiSub(xaiTokens(), { now: 1_000_000 });

  await database.providerCredentials.delete(provider.id);
  await assert.rejects(() => readFreshXaiTokens(provider.id), /not signed in/i);

  await database.providerCredentials.put({ providerId: provider.id, kind: 'apiKey', value: { apiKey: 'synthetic' }, updatedAt: 1 });
  await assert.rejects(() => readFreshXaiTokens(provider.id), /not signed in/i);

  await database.providerCredentials.put({
    providerId: provider.id,
    kind: 'xaiSubOAuth',
    value: { accessToken: 'xai-access-invalid-synthetic', refreshToken: '', expiresAt: Number.NaN },
    updatedAt: 2,
  });
  await assert.rejects(() => readFreshXaiTokens(provider.id), /not signed in/i);
}

async function testInFlightRefreshCannotRestoreSignedOutCredential() {
  await reset();
  const { provider } = await connectXaiSub(xaiTokens({ expiresAt: 1_000 }), { now: 1_000_000 });
  const refresh = deferred<Response>();
  const refreshStarted = deferred<void>();
  const refreshPromise = readFreshXaiTokens(provider.id, {
    now: 2_000_000,
    fetch: async () => {
      refreshStarted.resolve();
      return refresh.promise;
    },
  });
  await refreshStarted.promise;

  await signOutXaiSub(provider.id);
  refresh.resolve(refreshResponse());

  await assert.rejects(refreshPromise, /not signed in/i);
  assert.equal(await database.providerCredentials.get(provider.id), undefined);
}

async function testInFlightRefreshCannotOverwriteNewCredential() {
  await reset();
  const { provider } = await connectXaiSub(xaiTokens({ expiresAt: 1_000 }), { now: 1_000_000 });
  const refresh = deferred<Response>();
  const refreshStarted = deferred<void>();
  const refreshPromise = readFreshXaiTokens(provider.id, {
    now: 2_000_000,
    fetch: async () => {
      refreshStarted.resolve();
      return refresh.promise;
    },
  });
  await refreshStarted.promise;

  const replacement = xaiTokens({
    accessToken: 'xai-access-replacement-synthetic',
    refreshToken: 'xai-refresh-replacement-synthetic',
    expiresAt: 7_000_000,
  });
  await saveXaiCredential(provider.id, replacement, 3_000_000);
  refresh.resolve(refreshResponse());

  await assert.rejects(refreshPromise, /not signed in/i);
  assert.deepEqual(await readXaiTokens(provider.id), replacement);
}

function xaiTokens(overrides: Partial<ReturnType<typeof baseXaiTokens>> = {}) {
  return { ...baseXaiTokens(), ...overrides };
}

function baseXaiTokens() {
  return {
    accessToken: 'xai-access-original-synthetic',
    refreshToken: 'xai-refresh-original-synthetic',
    expiresAt: 3_000_000,
    email: 'original@example.test',
    name: 'Original Synthetic User',
  };
}

function refreshResponse() {
  return jsonResponse({ access_token: 'xai-access-stale-refresh-synthetic', expires_in: 3600 });
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

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
