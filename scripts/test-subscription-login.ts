import assert from 'node:assert/strict';
import { SUBSCRIPTION_MODEL_PREVIEW, visibleSubscriptionModels } from '../lib/subscription-login.ts';
import type { ProviderWithModels } from '../lib/provider-store.ts';

testSortsByNameVersionDescThenPriority();
testFiltersHiddenAndUnavailableModels();

console.info('subscription login tests passed');

function testSortsByNameVersionDescThenPriority() {
  // Vendor priority ranks gpt-5.5 first (as observed live); version-in-name must win.
  const provider = providerWith([
    model(1, 'gpt-5.5', 1),
    model(2, 'gpt-5.4', 2),
    model(3, 'gpt-5.4-mini', 3),
    model(4, 'gpt-5.3-codex-spark', 4),
    model(5, 'gpt-5.6-sol', 5),
    model(6, 'gpt-5.6-terra', 6),
    model(7, 'gpt-5.6-luna', 7),
    model(8, 'legacy-no-version', undefined),
  ]);

  const { all, preview } = visibleSubscriptionModels(provider);
  assert.deepEqual(all.map((entry) => entry.name), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
    'legacy-no-version',
  ]);
  assert.equal(preview.length, SUBSCRIPTION_MODEL_PREVIEW);
  assert.equal(preview[0].name, 'gpt-5.6-sol');
}

function testFiltersHiddenAndUnavailableModels() {
  const provider = providerWith([
    { ...model(1, 'visible', 1) },
    { ...model(2, 'hidden', 2), visibility: 'hide' },
    { ...model(3, 'gone', 3), unavailable: true },
  ]);
  assert.deepEqual(visibleSubscriptionModels(provider).all.map((entry) => entry.name), ['visible']);
  assert.deepEqual(visibleSubscriptionModels(undefined).all, []);
}

function model(id: number, name: string, priority: number | undefined) {
  return { id, providerId: 1, name, contextWindowTokens: 128000, ...(priority === undefined ? {} : { priority }) };
}

function providerWith(models: unknown[]): ProviderWithModels {
  return { id: 1, kind: 'openaiCodex', name: 'OpenAI', baseURL: 'https://chatgpt.com/backend-api/codex', createdAt: 0, updatedAt: 0, models: models as ProviderWithModels['models'], hasCredential: true } as ProviderWithModels;
}
