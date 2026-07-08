import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { assertReasoningEffortSupported, type ReasoningEffort } from './reasoning-effort.ts';
import { XAI_SUPPORTED_REASONING_EFFORTS } from './xai-auth.ts';

export type XaiRuntimeAuth = { accessToken: string };

export type XaiRuntimeOptions = {
  modelId: string;
  providerName: string;
  baseURL: string;
  auth: () => Promise<XaiRuntimeAuth>;
  reasoningEffort: ReasoningEffort;
  supportedReasoningEfforts?: string[];
  fetch?: typeof fetch;
};

export function createXaiLanguageModel(options: XaiRuntimeOptions): LanguageModel {
  const supported = options.supportedReasoningEfforts ?? [...XAI_SUPPORTED_REASONING_EFFORTS];
  assertReasoningEffortSupported(options.reasoningEffort, supported, options.modelId);
  return createOpenAI({
    name: options.providerName,
    baseURL: options.baseURL,
    apiKey: 'unused',
    fetch: createXaiFetch(options),
  }).responses(options.modelId) as LanguageModel;
}

export function xaiProviderOptions(reasoningEffort: ReasoningEffort) {
  return {
    openai: {
      store: false,
      parallelToolCalls: true,
      ...(reasoningEffort === 'default' ? {} : { reasoningEffort }),
    },
  };
}

function createXaiFetch(options: XaiRuntimeOptions): typeof fetch {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const auth = await options.auth();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${auth.accessToken}`);
    return fetcher(input, { ...init, headers });
  };
}
