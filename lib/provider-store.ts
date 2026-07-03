import { database, type Model, type Provider, type ProviderCredential, type ProviderKind } from './db.ts';
import {
  SELECTED_MODEL_KEY,
  assertProviderCredentialKind,
  deleteProviderConnection,
  deleteProviderModel,
  removeProviderCredential,
  saveProviderModel,
  selectModel,
  updateProviderModel,
} from './provider-config-flow.ts';

export type ProviderInput = { name: string; baseURL: string; apiKey: string; kind?: ProviderKind };
export type ModelInput = { providerId: number; name: string; contextWindowTokens?: number };
export type ModelPatch = { name?: string; contextWindowTokens?: number };

export type ProviderWithModels = Provider & { models: Model[]; hasCredential: boolean };

export type ConnectionTestResult =
  | { ok: true; modelIds?: string[] }
  | { ok: false; error: string };

export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high';

const REASONING_EFFORT_KEY = 'reasoningEffort';

export async function listProviders(): Promise<Provider[]> {
  return database.providers.orderBy('id').toArray();
}

export async function listModels(providerId?: number): Promise<Model[]> {
  if (providerId === undefined) return database.models.orderBy('id').toArray();
  return database.models.where('providerId').equals(providerId).sortBy('id');
}

export async function listProvidersWithModels(): Promise<ProviderWithModels[]> {
  const providers = await listProviders();
  if (providers.length === 0) return [];
  const [allModels, credentials] = await Promise.all([database.models.toArray(), database.providerCredentials.toArray()]);
  const credentialProviderIds = new Set(credentials.map((credential) => credential.providerId));
  return providers.map((provider) => ({
    ...provider,
    hasCredential: credentialProviderIds.has(provider.id),
    models: allModels.filter((model) => model.providerId === provider.id),
  }));
}

export async function saveProvider(input: ProviderInput): Promise<Provider> {
  validateProvider(input);
  const now = Date.now();
  const provider = await database.transaction('rw', database.providers, database.providerCredentials, async () => {
    const id = await database.providers.add({
      kind: input.kind ?? 'openaiCompatible',
      name: input.name.trim(),
      baseURL: input.baseURL.trim(),
      createdAt: now,
      updatedAt: now,
    } as Provider);
    await saveApiKeyCredential(Number(id), input.apiKey, now);
    const created = await database.providers.get(Number(id));
    if (!created) throw new Error('Failed to read newly created provider');
    return created;
  });
  return provider;
}

export async function updateProvider(id: number, patch: Partial<ProviderInput>): Promise<Provider> {
  const existing = await database.providers.get(id);
  if (!existing) throw new Error(`Provider not found: ${id}`);
  const next: Partial<Provider> = { updatedAt: Date.now() };
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.baseURL !== undefined) next.baseURL = patch.baseURL.trim();
  if (patch.kind !== undefined) next.kind = patch.kind;
  validateProvider({ ...existing, ...next, apiKey: '' });

  return database.transaction('rw', database.providers, database.providerCredentials, async () => {
    await database.providers.update(id, next);
    if (patch.apiKey !== undefined) await saveApiKeyCredential(id, patch.apiKey, next.updatedAt!);
    const updated = await database.providers.get(id);
    if (!updated) throw new Error(`Provider not found after update: ${id}`);
    return updated;
  });
}

export async function deleteProvider(id: number): Promise<{ removedModelIds: number[]; nextSelectedModelId: number | null }> {
  return deleteProviderConnection(id);
}

export async function readProviderCredential(providerId: number): Promise<ProviderCredential | undefined> {
  return database.providerCredentials.get(providerId);
}

export async function saveProviderCredential(credential: ProviderCredential): Promise<void> {
  assertProviderCredentialKind(credential);
  await database.providerCredentials.put(credential);
}

export async function deleteProviderCredential(providerId: number): Promise<void> {
  await removeProviderCredential(providerId);
}

export async function getProviderApiKey(providerId: number): Promise<string> {
  const credential = await readProviderCredential(providerId);
  return credential?.kind === 'apiKey' ? readApiKeyCredential(credential.value) : '';
}

export async function saveModel(input: ModelInput): Promise<Model> {
  return saveProviderModel(input);
}

export async function updateModel(id: number, patch: ModelPatch): Promise<Model> {
  return updateProviderModel(id, patch);
}

export async function deleteModel(id: number): Promise<{ nextSelectedModelId: number | null }> {
  return deleteProviderModel(id);
}

export async function getSelectedModelId(): Promise<number | null> {
  const setting = await database.settings.get(SELECTED_MODEL_KEY);
  const value = setting?.value;
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export async function setSelectedModelId(modelId: number): Promise<void> {
  await selectModel(modelId);
}

export async function clearSelectedModelId(): Promise<void> {
  await database.settings.delete(SELECTED_MODEL_KEY);
}

export async function getReasoningEffort(): Promise<ReasoningEffort> {
  const setting = await database.settings.get(REASONING_EFFORT_KEY);
  return normalizeReasoningEffort(setting?.value);
}

export async function setReasoningEffort(value: ReasoningEffort): Promise<void> {
  await database.settings.put({ key: REASONING_EFFORT_KEY, value: normalizeReasoningEffort(value) });
}

export function normalizeReasoningEffort(value: unknown): ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'default';
}

export function reasoningProviderOptions(value: ReasoningEffort) {
  return value === 'default' ? undefined : { openaiCompatible: { reasoningEffort: value } };
}

export async function testConnection(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ConnectionTestResult> {
  if (!baseURL.trim()) return { ok: false, error: 'baseURL is empty.' };
  let endpoint: URL;
  try {
    endpoint = new URL(joinUrl(baseURL, 'models'));
  } catch (error) {
    return { ok: false, error: `Invalid baseURL: ${describe(error)}` };
  }
  try {
    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal,
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
    const body = await response.json().catch(() => undefined);
    const ids = extractModelIds(body);
    return { ok: true, modelIds: ids };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

async function saveApiKeyCredential(providerId: number, apiKey: string, updatedAt: number) {
  await database.providerCredentials.put({ providerId, kind: 'apiKey', value: { apiKey }, updatedAt });
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

function readApiKeyCredential(value: unknown) {
  if (!value || typeof value !== 'object') return '';
  const apiKey = (value as { apiKey?: unknown }).apiKey;
  return typeof apiKey === 'string' ? apiKey : '';
}

function joinUrl(base: string, path: string) {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedPath}`;
}

function extractModelIds(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const ids = data
    .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string');
  return ids.length > 0 ? ids : undefined;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function maskApiKey(key: string) {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '••••';
  return `${'•'.repeat(4)}${trimmed.slice(-4)}`;
}
