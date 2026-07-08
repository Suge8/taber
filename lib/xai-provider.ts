import { database, type ProviderCredential } from './db.ts';
import {
  saveRefreshedXaiCredential,
  saveXaiSubConnection,
  type XaiCredentialValue,
} from './provider-config-flow.ts';
import { XaiAuthError, refreshXaiTokens, type XaiAuthTokens } from './xai-auth.ts';

export type { XaiCredentialValue };
export { XAI_API_BASE_URL, XAI_DEFAULT_MODEL_ID } from './xai-auth.ts';
export { XAI_SUB_PROVIDER_BASE_URL, XAI_SUB_PROVIDER_NAME } from './provider-config-flow.ts';

type SyncOptions = {
  fetch?: typeof fetch;
  now?: number;
};

const TOKEN_REFRESH_SKEW_MS = 60_000;

export async function connectXaiSub(tokens: XaiAuthTokens, options: SyncOptions = {}) {
  return saveXaiSubConnection({ tokens, now: options.now });
}

export async function readXaiTokens(providerId: number): Promise<XaiCredentialValue | undefined> {
  const credential = await database.providerCredentials.get(providerId);
  if (credential?.kind !== 'xaiSubOAuth') return undefined;
  return normalizeXaiCredential(credential);
}

export async function readFreshXaiTokens(providerId: number, options: SyncOptions = {}) {
  const credential = await database.providerCredentials.get(providerId);
  if (credential?.kind !== 'xaiSubOAuth') throw new XaiAuthError('auth', 'xAI subscription is not signed in.');
  const tokens = normalizeXaiCredential(credential);
  if (!tokens) throw new XaiAuthError('auth', 'xAI subscription is not signed in.');
  if (tokens.expiresAt > (options.now ?? Date.now()) + TOKEN_REFRESH_SKEW_MS) return tokens;
  const refreshed = await refreshXaiTokens(tokens.refreshToken, { fetch: options.fetch, now: options.now });
  const next = {
    ...refreshed,
    email: refreshed.email ?? tokens.email,
    name: refreshed.name ?? tokens.name,
  };
  await saveRefreshedXaiCredential(providerId, credential, next, options.now ?? Date.now());
  return next;
}

function normalizeXaiCredential(credential: ProviderCredential): XaiCredentialValue | undefined {
  if (!credential.value || typeof credential.value !== 'object') return undefined;
  const value = credential.value as Partial<XaiCredentialValue>;
  if (!value.accessToken || !value.refreshToken || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) {
    return undefined;
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    ...(value.idToken ? { idToken: value.idToken } : {}),
    expiresAt: value.expiresAt,
    ...(value.email ? { email: value.email } : {}),
    ...(value.name ? { name: value.name } : {}),
  };
}
