import assert from 'node:assert/strict';
import { createXaiLanguageModel, xaiProviderOptions } from '../lib/xai-runtime.ts';

let requestBody: Record<string, unknown> = {};
const model = createXaiLanguageModel({
  modelId: 'grok-4.5',
  providerName: 'xAI subscription',
  baseURL: 'https://xai.invalid/v1',
  reasoningEffort: 'high',
  auth: async () => ({ accessToken: 'xai-access-regression-synthetic' }),
  fetch: async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'response-synthetic',
      created_at: 0,
      model: 'grok-4.5',
      output: [{
        type: 'message',
        role: 'assistant',
        id: 'message-synthetic',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
}) as any;

await model.doGenerate({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  providerOptions: xaiProviderOptions('high'),
});

assert.deepEqual(requestBody.reasoning, { effort: 'high' });
console.info('xai reasoning regression passed');
