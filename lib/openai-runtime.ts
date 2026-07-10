import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { assertReasoningEffortSupported, normalizeSupportedReasoningEfforts, type ReasoningEffort } from './reasoning-effort.ts';

export type OpenAIApiRuntimeOptions = {
  modelId: string;
  providerName: string;
  baseURL: string;
  apiKey: string;
  fetch?: typeof fetch;
};

export function createOpenAIApiLanguageModel(options: OpenAIApiRuntimeOptions): LanguageModel {
  return createOpenAI({
    name: options.providerName,
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }).responses(options.modelId) as LanguageModel;
}

export function openAIProviderOptions(reasoningEffort: ReasoningEffort, supportedReasoningEfforts: unknown, modelId: string) {
  const supported = normalizeSupportedReasoningEfforts(supportedReasoningEfforts);
  assertReasoningEffortSupported(reasoningEffort, supported, modelId);
  const supportsReasoning = supported.length > 0;
  return {
    openai: {
      store: false,
      parallelToolCalls: true,
      ...(supportsReasoning ? { reasoningSummary: 'detailed' } : {}),
      ...(reasoningEffort === 'default' ? {} : { reasoningEffort }),
    },
  };
}
