import { database, type Model, type ProviderCredential } from './db.ts';
import {
  type CodexAuthTokens,
  type CodexDiscoveredModel,
  CodexAuthError,
  fetchCodexModels,
  parseCodexModels,
  refreshCodexTokens,
} from './codex-auth.ts';
import {
  type CodexCredentialValue,
  saveOpenAICodexConnection,
  saveOpenAICodexModels,
  saveRefreshedCodexCredential,
} from './provider-config-flow.ts';

export { OPENAI_CODEX_PROVIDER_BASE_URL, OPENAI_CODEX_PROVIDER_NAME, type CodexCredentialValue } from './provider-config-flow.ts';

type SyncOptions = {
  fetch?: typeof fetch;
  now?: number;
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

export async function connectOpenAICodex(tokens: CodexAuthTokens, options: SyncOptions = {}) {
  const accountId = requireAccountId(tokens);
  const body = await fetchCodexModels({ accessToken: tokens.accessToken, accountId }, { fetch: options.fetch });
  const result = await saveOpenAICodexConnection({
    tokens: { ...tokens, accountId },
    discoveredModels: parseCodexModels(body),
    now: options.now ?? Date.now(),
  });
  return { provider: result.provider, models: result.models };
}

export async function saveCodexTokens(providerId: number, tokens: CodexAuthTokens, updatedAt = Date.now()) {
  const credential = await database.providerCredentials.get(providerId);
  if (credential?.kind !== 'openaiCodexOAuth') throw new CodexAuthError('auth', 'ChatGPT subscription is not signed in.');
  await saveRefreshedCodexCredential(providerId, credential, { ...tokens, accountId: requireAccountId(tokens) }, updatedAt);
}

export async function readCodexTokens(providerId: number): Promise<CodexCredentialValue | undefined> {
  const credential = await database.providerCredentials.get(providerId);
  if (credential?.kind !== 'openaiCodexOAuth') return undefined;
  return normalizeCodexCredential(credential);
}

export async function readFreshCodexTokens(providerId: number, options: SyncOptions = {}) {
  const credential = await database.providerCredentials.get(providerId);
  if (credential?.kind !== 'openaiCodexOAuth') throw new CodexAuthError('auth', 'ChatGPT subscription is not signed in.');
  const tokens = normalizeCodexCredential(credential);
  if (!tokens) throw new CodexAuthError('auth', 'ChatGPT subscription is not signed in.');
  if (tokens.expiresAt > (options.now ?? Date.now()) + TOKEN_REFRESH_SKEW_MS) return tokens;
  const refreshed = await refreshCodexTokens(tokens.refreshToken, { fetch: options.fetch, now: options.now });
  const accountId = requireAccountId(refreshed);
  await saveRefreshedCodexCredential(providerId, credential, { ...refreshed, accountId }, options.now ?? Date.now());
  return { ...refreshed, accountId };
}

export async function refreshCodexModels(providerId: number, tokens: Pick<CodexCredentialValue, 'accessToken' | 'accountId'>, options: SyncOptions = {}): Promise<Model[]> {
  const body = await fetchCodexModels({ accessToken: tokens.accessToken, accountId: tokens.accountId }, { fetch: options.fetch });
  return saveOpenAICodexModels(providerId, parseCodexModels(body), options.now ?? Date.now());
}

export async function saveCodexModels(providerId: number, discovered: CodexDiscoveredModel[], fetchedAt = Date.now()): Promise<Model[]> {
  return saveOpenAICodexModels(providerId, discovered, fetchedAt);
}

function normalizeCodexCredential(credential: ProviderCredential): CodexCredentialValue | undefined {
  if (!credential.value || typeof credential.value !== 'object') return undefined;
  const value = credential.value as Partial<CodexCredentialValue>;
  const expiresAt = value.expiresAt;
  if (!value.accessToken || !value.refreshToken || !value.accountId || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    ...(value.idToken ? { idToken: value.idToken } : {}),
    expiresAt,
    accountId: value.accountId,
    ...(value.email ? { email: value.email } : {}),
    ...(value.planType ? { planType: value.planType } : {}),
  };
}

function requireAccountId(tokens: CodexAuthTokens) {
  if (!tokens.accountId) throw new CodexAuthError('unexpected_response', 'Codex token is missing account id.');
  return tokens.accountId;
}
