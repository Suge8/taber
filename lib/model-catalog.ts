import { database } from './db.ts';
import { normalizeSupportedReasoningEfforts, readReasoningEffortLevel, type ReasoningEffortLevel } from './reasoning-effort.ts';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128000;
export const modelCatalogSettingKey = 'modelCatalog';

export type ModelPreset = {
  name: string;
  contextWindowTokens: number;
  displayName?: string;
  supportedReasoningEfforts?: ReasoningEffortLevel[];
  defaultReasoningEffort?: ReasoningEffortLevel;
};

export type ProviderPreset = {
  id: string;
  name: string;
  baseURL: string;
  models: ModelPreset[];
};

export type CachedModelCatalog = {
  fetchedAt: number;
  providers: ProviderPreset[];
};

export const builtinProviderPresets: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    models: [
      // GPT-5.6 family (GA 2026-07-09): context/output verified via provider
      // metadata (1,050,000 in / 128,000 out); Sol = flagship, Terra = balanced, Luna = fast.
      { name: 'gpt-5.6-sol', contextWindowTokens: 1050000 },
      { name: 'gpt-5.6-terra', contextWindowTokens: 1050000 },
      { name: 'gpt-5.6-luna', contextWindowTokens: 1050000 },
      { name: 'gpt-5.5', contextWindowTokens: 1000000 },
      { name: 'gpt-5.4-mini', contextWindowTokens: 1000000 },
      { name: 'gpt-5.4-nano', contextWindowTokens: 1000000 },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    models: [
      { name: 'openai/gpt-5.6-sol', contextWindowTokens: 1050000 },
      { name: 'openai/gpt-5.5', contextWindowTokens: 1000000 },
      { name: 'anthropic/claude-sonnet-4.6', contextWindowTokens: 200000 },
      { name: 'google/gemini-3.1-pro-preview', contextWindowTokens: 1000000 },
      { name: 'deepseek/deepseek-v4-pro', contextWindowTokens: 1000000 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    models: [
      { name: 'deepseek-v4-pro', contextWindowTokens: 1000000 },
      { name: 'deepseek-v4-flash', contextWindowTokens: 1000000 },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen / DashScope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { name: 'qwen3.7-max', contextWindowTokens: 1000000 },
      { name: 'qwen3.7-plus', contextWindowTokens: 1000000 },
      { name: 'qwen3.5-flash', contextWindowTokens: 1000000 },
    ],
  },
  {
    id: 'kimi-global',
    name: 'Kimi Global',
    baseURL: 'https://api.moonshot.ai/v1',
    models: [
      { name: 'kimi-k2.6', contextWindowTokens: 256000 },
      { name: 'moonshot-v1-auto', contextWindowTokens: 128000 },
      { name: 'moonshot-v1-128k', contextWindowTokens: 128000 },
    ],
  },
  {
    id: 'kimi-cn',
    name: 'Kimi 中国区',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [
      { name: 'kimi-k2.6', contextWindowTokens: 256000 },
      { name: 'moonshot-v1-auto', contextWindowTokens: 128000 },
      { name: 'moonshot-v1-128k', contextWindowTokens: 128000 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimax.io/v1',
    models: [
      { name: 'MiniMax-M3', contextWindowTokens: 1000000 },
      { name: 'MiniMax-M2.7', contextWindowTokens: 204800 },
      { name: 'MiniMax-M2.7-highspeed', contextWindowTokens: 204800 },
    ],
  },
  {
    id: 'zai',
    name: 'Z.AI',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    models: [
      { name: 'glm-5.2', contextWindowTokens: 1000000 },
      { name: 'glm-5.1', contextWindowTokens: 1000000 },
      { name: 'glm-4.7', contextWindowTokens: 1000000 },
    ],
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    baseURL: 'https://api.stepfun.ai/v1',
    models: [
      { name: 'step-3.7-flash', contextWindowTokens: 1000000 },
      { name: 'step-3.5-flash', contextWindowTokens: 1000000 },
    ],
  },
  {
    id: 'custom',
    name: '自定义',
    baseURL: '',
    models: [],
  },
];

/** models.dev is the live source for API-side model specs; refresh weekly so
 * new models and context windows arrive without a manual catalog refresh. */
export const MODEL_CATALOG_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function isModelCatalogStale(catalog: CachedModelCatalog | null | undefined, now = Date.now()) {
  return !catalog || now - catalog.fetchedAt > MODEL_CATALOG_STALE_MS;
}

export async function readCachedModelCatalog() {
  const setting = await database.settings.get(modelCatalogSettingKey);
  return parseCachedCatalog(setting?.value);
}

export async function refreshModelCatalog(fetchCatalog = fetch): Promise<CachedModelCatalog> {
  const response = await fetchCatalog('https://models.dev/api.json');
  if (!response.ok) throw new Error(`models.dev: HTTP ${response.status} ${response.statusText}`);
  const catalog = normalizeModelsDevCatalog(await response.json());
  await database.settings.put({ key: modelCatalogSettingKey, value: catalog });
  return catalog;
}

export function mergeProviderCatalog(catalog?: CachedModelCatalog | null): ProviderPreset[] {
  if (!catalog) return builtinProviderPresets;
  const providers = new Map<string, ProviderPreset>();
  for (const provider of builtinProviderPresets) providers.set(provider.id, cloneProvider(provider));
  for (const provider of catalog.providers) {
    const existing = providers.get(provider.id);
    if (!existing) {
      providers.set(provider.id, cloneProvider(provider));
      continue;
    }
    const models = new Map(existing.models.map((model) => [model.name, model]));
    for (const model of provider.models) models.set(model.name, model);
    providers.set(provider.id, { ...existing, models: [...models.values()] });
  }
  return [...providers.values()];
}

export function findPresetModel(providers: ProviderPreset[], providerId: string, modelName: string) {
  return providers.find((provider) => provider.id === providerId)?.models.find((model) => model.name === modelName);
}

export function normalizeContextWindowTokens(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function normalizeModelsDevCatalog(value: unknown): CachedModelCatalog {
  const providers: ProviderPreset[] = [];
  if (!value || typeof value !== 'object') return { fetchedAt: Date.now(), providers };
  for (const [providerId, rawProvider] of Object.entries(value)) {
    if (!rawProvider || typeof rawProvider !== 'object') continue;
    const provider = rawProvider as Record<string, unknown>;
    const models = readModels(provider.models ?? provider);
    if (models.length === 0) continue;
    providers.push({
      id: providerId,
      name: readString(provider.name) ?? providerId,
      baseURL: readString(provider.baseURL) ?? readString(provider.base_url) ?? '',
      models,
    });
  }
  return { fetchedAt: Date.now(), providers };
}

function readModels(value: unknown) {
  const entries = Array.isArray(value)
    ? value.map((model) => [readString((model as Record<string, unknown>)?.id) ?? readString((model as Record<string, unknown>)?.name), model] as const)
    : value && typeof value === 'object'
      ? Object.entries(value)
      : [];
  const models: ModelPreset[] = [];
  for (const [name, rawModel] of entries) {
    if (!name || !rawModel || typeof rawModel !== 'object') continue;
    const model = rawModel as Record<string, unknown>;
    const limit = model.limit && typeof model.limit === 'object' ? model.limit as Record<string, unknown> : undefined;
    const contextWindowTokens = normalizeContextWindowTokens(limit?.context ?? model.contextWindowTokens ?? model.context_window);
    const supportedReasoningEfforts = readReasoningOptions(model.reasoning_options);
    const defaultReasoningEffort = readReasoningEffortLevel(model.default_reasoning_effort ?? model.default_reasoning_level);
    models.push({
      name,
      contextWindowTokens,
      ...(readString(model.name) && readString(model.name) !== name ? { displayName: readString(model.name) } : {}),
      ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }
  return models;
}

function readReasoningOptions(value: unknown) {
  if (!Array.isArray(value)) return [];
  const efforts = value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    const option = item as Record<string, unknown>;
    if (readString(option.type) !== 'effort') return [];
    return Array.isArray(option.values) ? option.values : [];
  });
  return normalizeSupportedReasoningEfforts(efforts);
}

function parseCachedCatalog(value: unknown): CachedModelCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const catalog = value as CachedModelCatalog;
  if (!Number.isFinite(catalog.fetchedAt) || !Array.isArray(catalog.providers)) return null;
  return catalog;
}

function cloneProvider(provider: ProviderPreset): ProviderPreset {
  return { ...provider, models: provider.models.map((model) => ({ ...model })) };
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
