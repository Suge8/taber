export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.124.0';

export type CodexAuthFailureKind = 'auth' | 'token_exchange' | 'model_endpoint' | 'network' | 'timeout' | 'aborted' | 'unexpected_response';

export class CodexAuthError extends Error {
  readonly kind: CodexAuthFailureKind;
  readonly status?: number;

  constructor(kind: CodexAuthFailureKind, message: string, status?: number) {
    super(redactCodexSecrets(message));
    this.name = 'CodexAuthError';
    this.kind = kind;
    this.status = status;
  }
}

export type CodexDeviceCode = {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
};

export type CodexAuthorizationCode = {
  authorizationCode: string;
  codeVerifier: string;
};

export type CodexAuthTokens = {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
  planType?: string;
};

export type CodexDiscoveredModel = {
  name: string;
  displayName?: string;
  contextWindowTokens?: number;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  priority?: number;
  visibility?: string;
  supportedInApi?: boolean;
};

type FetchLike = typeof fetch;
type Delay = (ms: number, signal?: AbortSignal) => Promise<void>;

type RequestOptions = {
  fetch?: FetchLike;
  signal?: AbortSignal;
};

type PollOptions = RequestOptions & {
  timeoutMs?: number;
  delay?: Delay;
};

type TokenOptions = RequestOptions & {
  now?: number;
};

const DEVICE_TIMEOUT_MS = 5 * 60 * 1000;
const DEVICE_USER_CODE_PATH = '/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_PATH = '/api/accounts/deviceauth/token';
const DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
const TOKEN_PATH = '/oauth/token';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';

export async function requestCodexDeviceCode(options: RequestOptions = {}): Promise<CodexDeviceCode> {
  const response = await postJson(joinUrl(CODEX_ISSUER, DEVICE_USER_CODE_PATH), { client_id: CODEX_CLIENT_ID }, options, 'auth');
  const body = await readJson(response, 'auth');
  const deviceAuthId = readString((body as { device_auth_id?: unknown }).device_auth_id);
  const userCode = readString((body as { user_code?: unknown; usercode?: unknown }).user_code) ?? readString((body as { usercode?: unknown }).usercode);
  if (!deviceAuthId || !userCode) throw new CodexAuthError('unexpected_response', 'Device auth response is missing device_auth_id or user_code.');
  return {
    verificationUrl: CODEX_DEVICE_VERIFY_URL,
    userCode,
    deviceAuthId,
    intervalSeconds: Math.max(1, readPositiveNumber((body as { interval?: unknown }).interval) ?? 1),
  };
}

export async function pollCodexAuthorizationCode(deviceCode: CodexDeviceCode, options: PollOptions = {}): Promise<CodexAuthorizationCode> {
  const fetcher = resolveFetch(options.fetch);
  const delay = options.delay ?? abortableDelay;
  const timeoutMs = options.timeoutMs ?? DEVICE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    throwIfAborted(options.signal);
    let response: Response;
    try {
      response = await fetcher(joinUrl(CODEX_ISSUER, DEVICE_TOKEN_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceCode.deviceAuthId, user_code: deviceCode.userCode }),
        signal: options.signal,
      });
    } catch (error) {
      throw classifyFetchError(error, 'auth');
    }

    if (response.ok) {
      const body = await readJson(response, 'auth');
      const authorizationCode = readString((body as { authorization_code?: unknown }).authorization_code);
      const codeVerifier = readString((body as { code_verifier?: unknown }).code_verifier);
      if (!authorizationCode || !codeVerifier) throw new CodexAuthError('unexpected_response', 'Device token response is missing authorization_code or code_verifier.');
      return { authorizationCode, codeVerifier };
    }

    if (response.status !== 403 && response.status !== 404) throw await httpError(response, 'auth', 'Device auth failed');
    await delay(Math.min(deviceCode.intervalSeconds * 1000, Math.max(0, deadline - Date.now())), options.signal);
  }

  throw new CodexAuthError('timeout', 'Device auth timed out.');
}

export async function exchangeCodexAuthorizationCode(code: CodexAuthorizationCode, options: TokenOptions = {}): Promise<CodexAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code.authorizationCode,
    redirect_uri: DEVICE_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: code.codeVerifier,
  });
  const response = await postForm(joinUrl(CODEX_ISSUER, TOKEN_PATH), body, options, 'token_exchange');
  return normalizeTokenResponse(await readJson(response, 'token_exchange'), options.now ?? Date.now());
}

export async function refreshCodexTokens(refreshToken: string, options: TokenOptions = {}): Promise<CodexAuthTokens> {
  const response = await postJson(joinUrl(CODEX_ISSUER, TOKEN_PATH), {
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  }, options, 'token_exchange');
  return normalizeTokenResponse(await readJson(response, 'token_exchange'), options.now ?? Date.now());
}

export async function completeCodexDeviceLogin(deviceCode: CodexDeviceCode, options: PollOptions & TokenOptions = {}): Promise<CodexAuthTokens> {
  const code = await pollCodexAuthorizationCode(deviceCode, options);
  return exchangeCodexAuthorizationCode(code, options);
}

export async function fetchCodexModels(auth: { accessToken: string; accountId: string }, options: RequestOptions = {}): Promise<unknown> {
  if (!auth.accessToken.trim()) throw new CodexAuthError('auth', 'Codex access token is required.');
  if (!auth.accountId.trim()) throw new CodexAuthError('auth', 'Codex account id is required.');
  const fetcher = resolveFetch(options.fetch);
  try {
    const response = await fetcher(CODEX_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'taber',
        Accept: 'application/json',
      },
      signal: options.signal,
    });
    if (!response.ok) throw await httpError(response, 'model_endpoint', 'Codex models request failed', [auth.accessToken, auth.accountId]);
    return readJson(response, 'model_endpoint');
  } catch (error) {
    if (error instanceof CodexAuthError) throw error;
    throw classifyFetchError(error, 'model_endpoint');
  }
}

export function parseCodexModels(body: unknown): CodexDiscoveredModel[] {
  const models = readCodexModelArray(body);
  return models
    .map((model) => {
      const name = readString(model.slug) ?? readString(model.id);
      if (!name) return undefined;
      const supportedReasoningEfforts = readReasoningEfforts(model.supported_reasoning_levels ?? model.supported_reasoning_efforts);
      return {
        name,
        ...(readString(model.display_name) ? { displayName: readString(model.display_name) } : {}),
        ...(readPositiveInteger(model.context_window ?? model.contextWindowTokens ?? model.context_length) ? { contextWindowTokens: readPositiveInteger(model.context_window ?? model.contextWindowTokens ?? model.context_length) } : {}),
        ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
        ...(readReasoningEffort(model.default_reasoning_level ?? model.default_reasoning_effort) ? { defaultReasoningEffort: readReasoningEffort(model.default_reasoning_level ?? model.default_reasoning_effort) } : {}),
        ...(readFiniteNumber(model.priority) !== undefined ? { priority: readFiniteNumber(model.priority) } : {}),
        ...(readString(model.visibility) ? { visibility: readString(model.visibility) } : {}),
        ...(typeof model.supported_in_api === 'boolean' ? { supportedInApi: model.supported_in_api } : {}),
      };
    })
    .filter((model): model is CodexDiscoveredModel => model !== undefined);
}

export function selectDefaultCodexModel(models: CodexDiscoveredModel[]) {
  const sorted = [...models].sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
  return sorted.find((model) => model.visibility === 'list') ?? sorted[0];
}

export function parseCodexTokenMetadata(tokens: { accessToken?: string; idToken?: string }, now = Date.now()) {
  const idClaims = tokens.idToken ? decodeJwtClaims(tokens.idToken) : undefined;
  const accessClaims = tokens.accessToken ? decodeJwtClaims(tokens.accessToken) : undefined;
  return {
    expiresAt: readJwtExpiresAt(accessClaims) ?? readJwtExpiresAt(idClaims) ?? now + 60 * 60 * 1000,
    accountId: readAccountId(idClaims) ?? readAccountId(accessClaims),
    email: readEmail(idClaims) ?? readEmail(accessClaims),
    planType: readPlanType(idClaims) ?? readPlanType(accessClaims),
  };
}

export function redactCodexSecrets(value: unknown) {
  return String(value)
    .replace(/(access_token|refresh_token|id_token|code_verifier|authorization_code)(["'=:\s]+)([^"'\s,&}]+)/giu, '$1$2<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/rt_[A-Za-z0-9_-]+/g, '<redacted-refresh-token>');
}

function redactKnownSecrets(value: unknown, secrets: string[]) {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('<redacted>') : text, redactCodexSecrets(value));
}

function normalizeTokenResponse(body: unknown, now: number): CodexAuthTokens {
  if (!body || typeof body !== 'object') throw new CodexAuthError('unexpected_response', 'Token response is not an object.');
  const record = body as Record<string, unknown>;
  const accessToken = readString(record.access_token);
  const refreshToken = readString(record.refresh_token);
  if (!accessToken || !refreshToken) throw new CodexAuthError('unexpected_response', 'Token response is missing access_token or refresh_token.');
  const idToken = readString(record.id_token);
  const expiresIn = readPositiveNumber(record.expires_in);
  const metadata = parseCodexTokenMetadata({ accessToken, idToken }, now);
  return {
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    expiresAt: expiresIn ? now + expiresIn * 1000 : metadata.expiresAt,
    ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
    ...(metadata.email ? { email: metadata.email } : {}),
    ...(metadata.planType ? { planType: metadata.planType } : {}),
  };
}

async function postJson(url: string, body: unknown, options: RequestOptions, errorKind: CodexAuthFailureKind) {
  const fetcher = resolveFetch(options.fetch);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) throw await httpError(response, errorKind, 'Codex auth request failed');
    return response;
  } catch (error) {
    if (error instanceof CodexAuthError) throw error;
    throw classifyFetchError(error, errorKind);
  }
}

async function postForm(url: string, body: URLSearchParams, options: RequestOptions, errorKind: CodexAuthFailureKind) {
  const fetcher = resolveFetch(options.fetch);
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: options.signal,
    });
    if (!response.ok) throw await httpError(response, errorKind, 'Codex token request failed');
    return response;
  } catch (error) {
    if (error instanceof CodexAuthError) throw error;
    throw classifyFetchError(error, errorKind);
  }
}

async function readJson(response: Response, errorKind: CodexAuthFailureKind) {
  try {
    return await response.json();
  } catch (error) {
    throw new CodexAuthError(errorKind, `Invalid JSON response: ${describe(error)}`, response.status);
  }
}

async function httpError(response: Response, kind: CodexAuthFailureKind, prefix: string, secrets: string[] = []) {
  const text = await response.text().catch(() => '');
  const suffix = text.trim() ? `: ${redactKnownSecrets(text, secrets).slice(0, 300)}` : '';
  return new CodexAuthError(kind, `${prefix}: HTTP ${response.status} ${response.statusText}${suffix}`, response.status);
}

function classifyFetchError(error: unknown, fallbackKind: CodexAuthFailureKind) {
  if (isAbortError(error)) return new CodexAuthError('aborted', 'Codex auth was cancelled.');
  if (fallbackKind === 'token_exchange') return new CodexAuthError('token_exchange', describe(error));
  return new CodexAuthError('network', describe(error));
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function readJwtExpiresAt(claims?: Record<string, unknown>) {
  const exp = claims && typeof claims.exp === 'number' ? claims.exp : undefined;
  return exp && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function readAccountId(claims?: Record<string, unknown>) {
  if (!claims) return undefined;
  const auth = readRecord(claims[OPENAI_AUTH_CLAIM]);
  const organizations = Array.isArray(claims.organizations) ? claims.organizations : undefined;
  const firstOrganization = readRecord(organizations?.[0]);
  return readString(auth?.chatgpt_account_id) ?? readString(claims.chatgpt_account_id) ?? readString(firstOrganization?.id);
}

function readEmail(claims?: Record<string, unknown>) {
  if (!claims) return undefined;
  const profile = readRecord(claims[OPENAI_PROFILE_CLAIM]);
  return readString(claims.email) ?? readString(profile?.email);
}

function readPlanType(claims?: Record<string, unknown>) {
  const auth = claims ? readRecord(claims[OPENAI_AUTH_CLAIM]) : undefined;
  return readString(auth?.chatgpt_plan_type);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

function readPositiveInteger(value: unknown) {
  const number = readPositiveNumber(value);
  return Number.isInteger(number) ? number : undefined;
}

function readFiniteNumber(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function readCodexModelArray(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const source = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : [];
  return source.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
}

function readReasoningEfforts(value: unknown) {
  if (!Array.isArray(value)) return [];
  const efforts = value
    .map((item) => readReasoningEffort(item) ?? readReasoningEffort(readRecord(item)?.effort))
    .filter((effort): effort is string => Boolean(effort));
  return [...new Set(efforts)];
}

function readReasoningEffort(value: unknown) {
  return readString(value)?.toLowerCase();
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function resolveFetch(fetcher?: FetchLike) {
  return fetcher ?? globalThis.fetch.bind(globalThis);
}

async function abortableDelay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new CodexAuthError('aborted', 'Codex auth was cancelled.');
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
