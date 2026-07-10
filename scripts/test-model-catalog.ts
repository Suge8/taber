import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { database, initializeDatabase } from '../lib/db.ts';
import { builtinProviderPresets, mergeProviderCatalog, readCachedModelCatalog, refreshModelCatalog } from '../lib/model-catalog.ts';
import { createProviderConnection } from '../lib/provider-config-flow.ts';

await initializeDatabase();
await database.delete();
await initializeDatabase();

assert.equal(builtinProviderPresets.find((provider) => provider.id === 'openai')?.models[0]?.name, 'gpt-5.6-sol');
assert.equal(builtinProviderPresets.find((provider) => provider.id === 'openrouter')?.models[0]?.name, 'openai/gpt-5.6-sol');
assert.ok(builtinProviderPresets.some((provider) => provider.id === 'kimi-global'));
assert.ok(builtinProviderPresets.some((provider) => provider.id === 'kimi-cn'));
assert.ok(builtinProviderPresets.some((provider) => provider.id === 'minimax'));
assert.ok(builtinProviderPresets.some((provider) => provider.id === 'zai'));
assert.ok(builtinProviderPresets.some((provider) => provider.id === 'stepfun'));
assert.equal(builtinProviderPresets.find((provider) => provider.id === 'custom')?.models.length, 0);

const response = new Response(JSON.stringify({
  openai: {
    name: 'OpenAI',
    models: {
      'gpt-new': {
        name: 'GPT New',
        limit: { context: 256000, output: 8192 },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'xhigh', 'unknown'] }],
        default_reasoning_effort: 'low',
      },
    },
  },
}), { status: 200 });
const catalog = await refreshModelCatalog((async () => response) as typeof fetch);
assert.equal(catalog.providers[0].models[0].name, 'gpt-new');
assert.equal(catalog.providers[0].models[0].contextWindowTokens, 256000);
assert.equal(catalog.providers[0].models[0].displayName, 'GPT New');
assert.deepEqual(catalog.providers[0].models[0].supportedReasoningEfforts, ['none', 'low', 'xhigh']);
assert.equal(catalog.providers[0].models[0].defaultReasoningEffort, 'low');
assert.equal((await readCachedModelCatalog())?.providers[0].id, 'openai');
assert.ok(mergeProviderCatalog(catalog).some((provider) => provider.models.some((model) => model.name === 'gpt-new')));

const created = await createProviderConnection({ name: 'Compatible', baseURL: 'https://api.example.com/v1', apiKey: 'k', models: [{ name: 'gpt-new', contextWindowTokens: 64000 }] });
await refreshModelCatalog((async () => new Response(JSON.stringify({ openai: { models: { 'gpt-new': { limit: { context: 512000 } } } } }), { status: 200 })) as typeof fetch);
assert.equal((await database.models.get(created.models[0]!.id))?.contextWindowTokens, 64000);

database.close();
console.info('model catalog tests passed');
