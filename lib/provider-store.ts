import { database, type Model, type Provider, type ProviderCredential } from './db.ts';
import {
  SELECTED_MODEL_KEY,
  assertProviderCredentialKind,
  removeProviderCredential,
  selectModel,
} from './provider-config-flow.ts';
import {
  assertReasoningEffortSupported,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
  reasoningEffortOptionsForModel,
  type ReasoningEffort,
} from './reasoning-effort.ts';

export type ProviderWithModels = Provider & { models: Model[]; hasCredential: boolean };

export type ConnectionTestResult =
  | { ok: true; modelIds?: string[] }
  | { ok: false; error: string };

export { normalizeReasoningEffort, normalizeReasoningEffortForModel, reasoningEffortOptionsForModel, type ReasoningEffort };

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
    models: sortModelsForDisplay(allModels.filter((model) => model.providerId === provider.id)),
  }));
}

/** Newest generation first: compare the first version number in the name
 * (gpt-5.6-sol → 5.6) descending, then vendor priority, then stored order.
 * Vendor priority alone is unreliable — OpenAI still ranks gpt-5.5 above 5.6. */
export function sortModelsForDisplay<T extends { name: string; priority?: number }>(models: T[]): T[] {
  return [...models].sort((left, right) =>
    compareVersionDesc(modelNameVersion(left.name), modelNameVersion(right.name)) ||
    (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER),
  );
}

function modelNameVersion(name: string): number[] {
  const match = /\d+(?:\.\d+)*/.exec(name);
  return match ? match[0].split('.').map(Number) : [];
}

function compareVersionDesc(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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

export function reasoningProviderOptions(value: ReasoningEffort) {
  return value === 'default' ? undefined : { openaiCompatible: { reasoningEffort: value } };
}

export function reasoningProviderOptionsForModel(value: ReasoningEffort, supported: unknown, modelId = 'selected model') {
  assertReasoningEffortSupported(value, supported, modelId);
  return reasoningProviderOptions(value);
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
