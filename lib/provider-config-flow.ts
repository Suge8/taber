import { database, type Model, type Provider, type ProviderCredential, type ProviderCredentialKind, type ProviderKind } from './db.ts';
import { CodexAuthError, type CodexAuthTokens, type CodexDiscoveredModel, selectDefaultCodexModel } from './codex-auth.ts';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, normalizeContextWindowTokens } from './model-catalog.ts';

export const SELECTED_MODEL_KEY = 'selectedModelId';
export const OPENAI_CODEX_PROVIDER_NAME = 'ChatGPT subscription';
export const OPENAI_CODEX_PROVIDER_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export type CodexCredentialValue = {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  accountId: string;
  email?: string;
  planType?: string;
};

export type ProviderConnectionModelInput = {
  id?: number | null;
  name: string;
  contextWindowTokens?: number;
};

export type CreateProviderConnectionInput = {
  name: string;
  baseURL: string;
  apiKey: string;
  kind?: ProviderKind;
  models: ProviderConnectionModelInput[];
};

export type UpdateProviderConnectionInput = {
  name?: string;
  baseURL?: string;
  apiKey?: string;
  kind?: ProviderKind;
  models: ProviderConnectionModelInput[];
};

export async function createProviderConnection(input: CreateProviderConnectionInput) {
  validateProvider(input);
  validateModelList(input.models);
  const now = Date.now();
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    const providerId = Number(await database.providers.add({
      kind: input.kind ?? 'openaiCompatible',
      name: input.name.trim(),
      baseURL: input.baseURL.trim(),
      createdAt: now,
      updatedAt: now,
    } as Provider));
    await saveApiKeyCredential(providerId, input.apiKey, now);
    const models = await addProviderModels(providerId, input.models);
    await writeSelectedModel(models[0]?.id ?? null);
    const provider = await requireProvider(providerId);
    return { provider, models, selectedModelId: models[0]?.id ?? null };
  });
}

export async function updateProviderConnection(providerId: number, input: UpdateProviderConnectionInput) {
  const existing = await requireProvider(providerId);
  const providerPatch = providerUpdatePatch(input);
  validateProvider({ ...existing, ...providerPatch, apiKey: input.apiKey ?? '' });
  validateModelList(input.models);

  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await database.providers.update(providerId, providerPatch);
    if (input.apiKey !== undefined) await saveApiKeyCredential(providerId, input.apiKey, providerPatch.updatedAt!);
    const { models, removedModelIds } = await replaceProviderModels(providerId, input.models);
    const selectedModelId = await reconcileSelectedModel({ removedModelIds });
    return { provider: await requireProvider(providerId), models, removedModelIds, selectedModelId };
  });
}

export async function deleteProviderConnection(providerId: number): Promise<{ removedModelIds: number[]; nextSelectedModelId: number | null }> {
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await requireProvider(providerId);
    const removedModelIds = (await database.models.where('providerId').equals(providerId).toArray()).map((model) => model.id);
    await database.models.where('providerId').equals(providerId).delete();
    await database.providerCredentials.delete(providerId);
    await database.providers.delete(providerId);
    const nextSelectedModelId = await reconcileSelectedModel({ removedModelIds });
    return { removedModelIds, nextSelectedModelId };
  });
}

export async function saveProviderModel(input: { providerId: number; name: string; contextWindowTokens?: number }): Promise<Model> {
  validateModel(input);
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await requireProvider(input.providerId);
    const model = await addProviderModel(input.providerId, input);
    await reconcileSelectedModel({ preferredModelIds: [model.id] });
    return model;
  });
}

export async function updateProviderModel(modelId: number, patch: { name?: string; contextWindowTokens?: number }): Promise<Model> {
  const existing = await requireModel(modelId);
  const next = modelUpdatePatch(patch);
  validateModel({
    providerId: existing.providerId,
    name: next.name ?? existing.name,
    contextWindowTokens: next.contextWindowTokens ?? existing.contextWindowTokens,
  });
  await database.models.update(modelId, next);
  return requireModel(modelId);
}

export async function deleteProviderModel(modelId: number): Promise<{ nextSelectedModelId: number | null }> {
  return database.transaction('rw', database.providerCredentials, database.models, database.settings, async () => {
    await requireModel(modelId);
    await database.models.delete(modelId);
    return { nextSelectedModelId: await reconcileSelectedModel({ removedModelIds: [modelId] }) };
  });
}

export async function selectModel(modelId: number): Promise<void> {
  const model = await requireModel(modelId);
  const credentialedProviderIds = await readCredentialedProviderIds();
  if (!isSelectableModel(model, credentialedProviderIds)) throw new Error(`Model is not selectable: ${modelId}`);
  await database.settings.put({ key: SELECTED_MODEL_KEY, value: modelId });
}

export async function readSelectedConfiguredModel(): Promise<Model | undefined> {
  const current = await readSelectedModelId();
  const credentialedProviderIds = await readCredentialedProviderIds();
  if (current !== null) {
    const selected = await database.models.get(current);
    if (selected && isSelectableModel(selected, credentialedProviderIds)) return selected;
  }
  return findFallbackModel([], credentialedProviderIds, new Set());
}

export async function saveOpenAICodexConnection(input: { tokens: CodexAuthTokens; discoveredModels: CodexDiscoveredModel[]; now?: number }) {
  const now = input.now ?? Date.now();
  const accountId = requireAccountId(input.tokens);
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    const provider = await upsertCodexProvider(now);
    await saveCodexCredential(provider.id, { ...input.tokens, accountId }, now);
    const models = await saveCodexModelRecords(provider.id, input.discoveredModels, now);
    return { provider: await requireProvider(provider.id), models, selectedModelId: await selectCodexDefaultIfNeeded(models, input.discoveredModels) };
  });
}

export async function saveOpenAICodexModels(providerId: number, discovered: CodexDiscoveredModel[], fetchedAt = Date.now()): Promise<Model[]> {
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await requireProvider(providerId);
    const models = await saveCodexModelRecords(providerId, discovered, fetchedAt);
    await selectCodexDefaultIfNeeded(models, discovered);
    return models;
  });
}

export async function removeProviderCredential(providerId: number): Promise<{ nextSelectedModelId: number | null }> {
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    await requireProvider(providerId);
    await database.providerCredentials.delete(providerId);
    return { nextSelectedModelId: await reconcileSelectedModel() };
  });
}

export async function signOutOpenAICodex(providerId: number): Promise<{ nextSelectedModelId: number | null }> {
  return database.transaction('rw', database.providers, database.providerCredentials, database.models, database.settings, async () => {
    const provider = await requireProvider(providerId);
    if (provider.kind !== 'openaiCodex') throw new Error(`Provider is not OpenAI Codex: ${providerId}`);
    await database.providerCredentials.delete(providerId);
    return { nextSelectedModelId: await reconcileSelectedModel() };
  });
}

export async function saveCodexCredential(providerId: number, tokens: CodexAuthTokens & { accountId: string }, updatedAt = Date.now()) {
  const value: CodexCredentialValue = codexCredentialValue(tokens);
  await database.providerCredentials.put({ providerId, kind: 'openaiCodexOAuth', value, updatedAt });
}

export async function saveRefreshedCodexCredential(
  providerId: number,
  previous: ProviderCredential,
  tokens: CodexAuthTokens & { accountId: string },
  updatedAt = Date.now(),
) {
  return database.transaction('rw', database.providers, database.providerCredentials, async () => {
    const provider = await requireProvider(providerId);
    if (provider.kind !== 'openaiCodex') throw new Error(`Provider is not OpenAI Codex: ${providerId}`);
    const current = await database.providerCredentials.get(providerId);
    if (!isSameCodexCredential(current, previous)) throw new CodexAuthError('auth', 'ChatGPT subscription is not signed in.');
    await database.providerCredentials.put({ providerId, kind: 'openaiCodexOAuth', value: codexCredentialValue(tokens), updatedAt });
  });
}

export async function reconcileSelectedModel(options: { removedModelIds?: number[]; preferredModelIds?: number[] } = {}) {
  const current = await readSelectedModelId();
  const removed = new Set(options.removedModelIds ?? []);
  const credentialedProviderIds = await readCredentialedProviderIds();
  if (current !== null && !removed.has(current)) {
    const selected = await database.models.get(current);
    if (selected && isSelectableModel(selected, credentialedProviderIds)) return current;
  }

  const fallback = await findFallbackModel(options.preferredModelIds ?? [], credentialedProviderIds, removed);
  await writeSelectedModel(fallback?.id ?? null);
  return fallback?.id ?? null;
}

async function upsertCodexProvider(now: number): Promise<Provider> {
  const existing = await database.providers.where('kind').equals('openaiCodex').first();
  if (existing) {
    await database.providers.update(existing.id, {
      name: OPENAI_CODEX_PROVIDER_NAME,
      baseURL: OPENAI_CODEX_PROVIDER_BASE_URL,
      updatedAt: now,
    });
    return requireProvider(existing.id);
  }
  const providerId = Number(await database.providers.add({
    kind: 'openaiCodex',
    name: OPENAI_CODEX_PROVIDER_NAME,
    baseURL: OPENAI_CODEX_PROVIDER_BASE_URL,
    createdAt: now,
    updatedAt: now,
  } as Provider));
  return requireProvider(providerId);
}

async function replaceProviderModels(providerId: number, inputs: ProviderConnectionModelInput[]) {
  const existing = await database.models.where('providerId').equals(providerId).toArray();
  const existingById = new Map(existing.map((model) => [model.id, model]));
  const keptIds = new Set(inputs.flatMap((input) => input.id === null || input.id === undefined ? [] : [input.id]));
  const removedModelIds = existing.filter((model) => !keptIds.has(model.id)).map((model) => model.id);
  if (removedModelIds.length > 0) await database.models.bulkDelete(removedModelIds);

  const models: Model[] = [];
  for (const input of inputs) {
    if (input.id === null || input.id === undefined) {
      models.push(await addProviderModel(providerId, input));
      continue;
    }
    const model = existingById.get(input.id);
    if (!model || model.providerId !== providerId) throw new Error(`Model not found: ${input.id}`);
    await database.models.update(input.id, modelUpdatePatch(input));
    models.push(await requireModel(input.id));
  }
  return { models, removedModelIds };
}

async function addProviderModels(providerId: number, inputs: ProviderConnectionModelInput[]) {
  const models: Model[] = [];
  for (const input of inputs) models.push(await addProviderModel(providerId, input));
  return models;
}

async function addProviderModel(providerId: number, input: { name: string; contextWindowTokens?: number }) {
  const id = Number(await database.models.add({
    providerId,
    name: input.name.trim(),
    contextWindowTokens: normalizeContextWindowTokens(input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
  } as Model));
  return requireModel(id);
}

async function saveCodexModelRecords(providerId: number, discovered: CodexDiscoveredModel[], fetchedAt: number) {
  const models = discovered.filter((model) => model.name.trim());
  const existing = await database.models.where('providerId').equals(providerId).toArray();
  const existingByName = new Map(existing.map((model) => [model.name, model]));
  const seen = new Set<string>();
  const saved: Model[] = [];

  for (const model of models) {
    seen.add(model.name);
    const current = existingByName.get(model.name);
    const patch = codexModelPatch(providerId, model, fetchedAt, current);
    if (current) {
      await database.models.update(current.id, patch);
      saved.push(await requireModel(current.id));
    } else {
      const id = Number(await database.models.add(patch as Model));
      saved.push(await requireModel(id));
    }
  }

  const missingIds = existing.filter((model) => !seen.has(model.name) && !model.unavailable).map((model) => model.id);
  if (missingIds.length > 0) {
    await database.models.bulkUpdate(missingIds.map((key) => ({ key, changes: { unavailable: true, metadataFetchedAt: fetchedAt } })));
  }
  return saved;
}

async function selectCodexDefaultIfNeeded(saved: Model[], discovered: CodexDiscoveredModel[]) {
  const current = await readSelectedModelId();
  const credentialedProviderIds = await readCredentialedProviderIds();
  if (current !== null) {
    const selected = await database.models.get(current);
    if (selected && isSelectableModel(selected, credentialedProviderIds)) return current;
  }
  const preferred = selectDefaultCodexModel(discovered);
  const fallback = saved.find((model) => model.name === preferred?.name && isSelectableModel(model, credentialedProviderIds))
    ?? saved.find((model) => isSelectableModel(model, credentialedProviderIds));
  if (!fallback) return reconcileSelectedModel();
  await writeSelectedModel(fallback.id);
  return fallback.id;
}

function codexModelPatch(providerId: number, model: CodexDiscoveredModel, metadataFetchedAt: number, current?: Model): Partial<Model> {
  return {
    providerId,
    name: model.name.trim(),
    contextWindowTokens: current?.contextWindowTokens ?? normalizeContextWindowTokens(model.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
    ...(model.displayName ? { displayName: model.displayName } : {}),
    ...(model.supportedReasoningEfforts ? { supportedReasoningEfforts: model.supportedReasoningEfforts } : {}),
    ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
    ...(model.priority !== undefined ? { priority: model.priority } : {}),
    ...(model.visibility ? { visibility: model.visibility } : {}),
    ...(model.supportedInApi !== undefined ? { supportedInApi: model.supportedInApi } : {}),
    metadataFetchedAt,
    unavailable: false,
  };
}

function codexCredentialValue(tokens: CodexAuthTokens & { accountId: string }): CodexCredentialValue {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    expiresAt: tokens.expiresAt,
    accountId: tokens.accountId,
    ...(tokens.email ? { email: tokens.email } : {}),
    ...(tokens.planType ? { planType: tokens.planType } : {}),
  };
}

function isSameCodexCredential(current: ProviderCredential | undefined, previous: ProviderCredential) {
  if (current?.kind !== 'openaiCodexOAuth' || previous.kind !== 'openaiCodexOAuth') return false;
  if (current.updatedAt !== previous.updatedAt) return false;
  const currentValue = readCodexCredentialIdentity(current.value);
  const previousValue = readCodexCredentialIdentity(previous.value);
  return Boolean(currentValue && previousValue
    && currentValue.accessToken === previousValue.accessToken
    && currentValue.refreshToken === previousValue.refreshToken
    && currentValue.accountId === previousValue.accountId);
}

function readCodexCredentialIdentity(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const credential = value as Partial<CodexCredentialValue>;
  if (!credential.accessToken || !credential.refreshToken || !credential.accountId) return undefined;
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    accountId: credential.accountId,
  };
}

async function saveApiKeyCredential(providerId: number, apiKey: string, updatedAt: number) {
  await database.providerCredentials.put({ providerId, kind: 'apiKey', value: { apiKey }, updatedAt });
}

async function findFallbackModel(preferredModelIds: number[], credentialedProviderIds: Set<number>, removed: Set<number>) {
  for (const modelId of preferredModelIds) {
    if (removed.has(modelId)) continue;
    const model = await database.models.get(modelId);
    if (model && isSelectableModel(model, credentialedProviderIds)) return model;
  }
  const models = await database.models.orderBy('id').toArray();
  return models.find((model) => !removed.has(model.id) && isSelectableModel(model, credentialedProviderIds));
}

async function readCredentialedProviderIds() {
  return new Set((await database.providerCredentials.toArray()).map((credential) => credential.providerId));
}

async function readSelectedModelId() {
  const value = (await database.settings.get(SELECTED_MODEL_KEY))?.value;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

async function writeSelectedModel(modelId: number | null) {
  if (modelId === null) {
    await database.settings.delete(SELECTED_MODEL_KEY);
    return;
  }
  await database.settings.put({ key: SELECTED_MODEL_KEY, value: modelId });
}

async function requireProvider(providerId: number) {
  const provider = await database.providers.get(providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  return provider;
}

async function requireModel(modelId: number) {
  const model = await database.models.get(modelId);
  if (!model) throw new Error(`Model not found: ${modelId}`);
  return model;
}

function providerUpdatePatch(input: UpdateProviderConnectionInput): Partial<Provider> {
  return {
    updatedAt: Date.now(),
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.baseURL !== undefined ? { baseURL: input.baseURL.trim() } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
  };
}

function modelUpdatePatch(patch: { name?: string; contextWindowTokens?: number }) {
  return {
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.contextWindowTokens !== undefined ? { contextWindowTokens: normalizeContextWindowTokensStrict(patch.contextWindowTokens) } : {}),
  };
}

function validateProvider(input: { name: string; baseURL: string; apiKey: string; kind?: ProviderKind }) {
  if (input.kind !== undefined && input.kind !== 'openaiCompatible' && input.kind !== 'openaiCodex') throw new Error('Provider kind is invalid.');
  if (!input.name.trim()) throw new Error('Provider name is required.');
  if (!input.baseURL.trim()) throw new Error('Provider baseURL is required.');
  try {
    // eslint-disable-next-line no-new
    new URL(input.baseURL);
  } catch {
    throw new Error('Provider baseURL must be a valid URL.');
  }
}

function validateModelList(models: ProviderConnectionModelInput[]) {
  if (models.length === 0) throw new Error('At least one model is required.');
  for (const model of models) validateModel({ providerId: 1, name: model.name, contextWindowTokens: model.contextWindowTokens });
}

function validateModel(input: { providerId: number; name: string; contextWindowTokens?: number }) {
  if (!Number.isInteger(input.providerId)) throw new Error('Model providerId is required.');
  if (!input.name.trim()) throw new Error('Model name is required.');
  if (input.contextWindowTokens !== undefined) normalizeContextWindowTokensStrict(input.contextWindowTokens);
}

function validateCredentialKind(kind: ProviderCredentialKind) {
  if (kind !== 'apiKey' && kind !== 'openaiCodexOAuth') throw new Error('Provider credential kind is invalid.');
}

export function assertProviderCredentialKind(credential: ProviderCredential) {
  validateCredentialKind(credential.kind);
}

function normalizeContextWindowTokensStrict(value: number) {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error('Model contextWindowTokens must be a positive integer.');
  return value;
}

function isSelectableModel(model: Model, credentialedProviderIds: Set<number>) {
  return !model.unavailable && model.visibility !== 'hide' && credentialedProviderIds.has(model.providerId);
}

function requireAccountId(tokens: CodexAuthTokens) {
  if (!tokens.accountId) throw new CodexAuthError('unexpected_response', 'Codex token is missing account id.');
  return tokens.accountId;
}
