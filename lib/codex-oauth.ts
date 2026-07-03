import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  type CodexAuthTokens,
  CodexAuthError,
  parseCodexTokenMetadata,
  redactCodexSecrets,
} from './codex-auth.ts';

export const CODEX_OAUTH_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_OAUTH_IDENTITY_REDIRECT_PATH = 'auth/callback';
export const CODEX_OAUTH_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

export type CodexOAuthIdentity = {
  getRedirectURL(path?: string): string;
  launchWebAuthFlow(details: {
    url: string;
    interactive?: boolean;
    abortOnLoadForNonInteractive?: boolean;
    timeoutMsForNonInteractive?: number;
  }): Promise<string | undefined>;
};

export type CodexOAuthTabs = {
  create(options: { url: string; active?: boolean }): Promise<{ id?: number }>;
  update?(tabId: number, options: { url: string; active?: boolean }): Promise<unknown>;
  remove(tabId: number): Promise<unknown>;
  onUpdated: {
    addListener(listener: (tabId: number, changeInfo: { url?: string }) => void): void;
    removeListener(listener: (tabId: number, changeInfo: { url?: string }) => void): void;
  };
  onRemoved: {
    addListener(listener: (tabId: number) => void): void;
    removeListener(listener: (tabId: number) => void): void;
  };
};

export type CodexOAuthWebNavigation = {
  onBeforeNavigate: {
    addListener(listener: (details: { tabId: number; frameId: number; url: string }) => void): void;
    removeListener(listener: (details: { tabId: number; frameId: number; url: string }) => void): void;
  };
};

type LoginOptions = {
  tabs: CodexOAuthTabs;
  identity?: CodexOAuthIdentity;
  webNavigation?: CodexOAuthWebNavigation;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  originator?: string;
  now?: number;
};

type ExchangeOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  now?: number;
  redirectUri?: string;
};

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export async function loginOpenAICodex(options: LoginOptions): Promise<CodexAuthTokens> {
  const pkce = await createCodexPkce();
  const state = randomBase64Url(32);

  if (options.identity) {
    try {
      const redirectUri = options.identity.getRedirectURL(CODEX_OAUTH_IDENTITY_REDIRECT_PATH);
      const authUrl = buildCodexAuthorizeUrl({ codeChallenge: pkce.challenge, state, originator: options.originator, redirectUri });
      const redirectUrl = await waitForCodexIdentityRedirect(authUrl, {
        identity: options.identity,
        tabs: options.tabs,
        webNavigation: options.webNavigation,
        signal: options.signal,
        interactive: false,
      });
      return completeCodexOAuthRedirect(redirectUrl, { state, codeVerifier: pkce.verifier, redirectUri, ...options });
    } catch (error) {
      if (!shouldUseLocalhostFallback(error)) throw error;
    }
  }

  const authUrl = buildCodexAuthorizeUrl({ codeChallenge: pkce.challenge, state, originator: options.originator, redirectUri: CODEX_OAUTH_REDIRECT_URI });
  const redirectUrl = await waitForCodexOAuthRedirect(authUrl, options);
  return completeCodexOAuthRedirect(redirectUrl, { state, codeVerifier: pkce.verifier, redirectUri: CODEX_OAUTH_REDIRECT_URI, ...options });
}

export async function exchangeCodexOAuthCode(authorizationCode: string, codeVerifier: string, options: ExchangeOptions = {}): Promise<CodexAuthTokens> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetcher(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: options.redirectUri ?? CODEX_OAUTH_REDIRECT_URI,
        client_id: CODEX_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
      signal: options.signal,
    });
  } catch (error) {
    throw new CodexAuthError(isAbortError(error) ? 'aborted' : 'token_exchange', describe(error));
  }
  if (!response.ok) throw new CodexAuthError('token_exchange', await readError(response), response.status);
  const body = await readTokenJson(response);
  const accessToken = readString(body.access_token);
  const refreshToken = readString(body.refresh_token);
  if (!accessToken || !refreshToken) throw new CodexAuthError('unexpected_response', 'OAuth token response is missing access_token or refresh_token.');
  const idToken = readString(body.id_token);
  const expiresIn = readPositiveNumber(body.expires_in);
  const metadata = parseCodexTokenMetadata({ accessToken, idToken }, options.now ?? Date.now());
  return {
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    expiresAt: expiresIn ? (options.now ?? Date.now()) + expiresIn * 1000 : metadata.expiresAt,
    ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
    ...(metadata.email ? { email: metadata.email } : {}),
    ...(metadata.planType ? { planType: metadata.planType } : {}),
  };
}

export async function waitForCodexIdentityRedirect(
  authUrl: string,
  options: { identity: CodexOAuthIdentity; tabs?: CodexOAuthTabs; webNavigation?: CodexOAuthWebNavigation; signal?: AbortSignal; interactive?: boolean },
): Promise<URL> {
  throwIfAborted(options.signal);
  let removeAbort: () => void = () => undefined;
  const unsupportedPage = watchIdentityUnsupportedPage(options);
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new CodexAuthError('aborted', 'OAuth login was cancelled.'));
      removeAbort = () => options.signal?.removeEventListener('abort', abort);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
    const responseUrl = await Promise.race([
      options.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: options.interactive ?? true,
        ...(options.interactive === false ? { abortOnLoadForNonInteractive: true, timeoutMsForNonInteractive: 2000 } : {}),
      }),
      unsupportedPage.promise,
      aborted,
    ]);
    if (!responseUrl) throw new CodexAuthError('auth', 'OAuth login failed.');
    const url = safeUrl(responseUrl);
    if (!url) throw new CodexAuthError('auth', 'OAuth login returned an invalid redirect URL.');
    return url;
  } catch (error) {
    if (error instanceof CodexAuthError) throw error;
    throw new CodexAuthError(isAbortError(error) ? 'aborted' : 'auth', describe(error));
  } finally {
    unsupportedPage.cleanup();
    removeAbort();
  }
}

function watchIdentityUnsupportedPage(options: { tabs?: CodexOAuthTabs; webNavigation?: CodexOAuthWebNavigation }) {
  let removeListener: () => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    if (!options.tabs || !options.webNavigation) return;
    const onBeforeNavigate = (details: { tabId: number; frameId: number; url: string }) => {
      if (details.frameId !== 0 || !isOpenAIIdentityUnsupportedPage(safeUrl(details.url))) return;
      removeListener();
      if (details.tabId >= 0) void options.tabs?.remove(details.tabId).catch(() => undefined);
      reject(new CodexAuthError('auth', 'OpenAI does not accept the browser extension OAuth redirect.'));
    };
    removeListener = () => options.webNavigation?.onBeforeNavigate.removeListener(onBeforeNavigate);
    options.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
  });
  return { promise, cleanup: removeListener };
}

export async function waitForCodexOAuthRedirect(authUrl: string, options: Pick<LoginOptions, 'tabs' | 'webNavigation' | 'timeoutMs' | 'signal'>): Promise<URL> {
  const tab = await options.tabs.create({ url: options.tabs.update ? 'about:blank' : authUrl, active: true });
  if (!tab.id) throw new CodexAuthError('auth', 'Failed to create OAuth tab.');
  const tabId = tab.id;
  return new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(() => finish(undefined, new CodexAuthError('timeout', 'OAuth login timed out.')), options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    const abort = () => finish(undefined, new CodexAuthError('aborted', 'OAuth login was cancelled.'));
    const maybeFinish = (value: string | undefined) => {
      const url = safeUrl(value);
      if (isLocalhostRedirect(url)) finish(url);
    };
    const onBeforeNavigate = (details: { tabId: number; frameId: number; url: string }) => {
      if (details.tabId === tabId && details.frameId === 0) maybeFinish(details.url);
    };
    const onUpdated = (updatedTabId: number, changeInfo: { url?: string }) => {
      if (updatedTabId === tabId) maybeFinish(changeInfo.url);
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(undefined, new CodexAuthError('auth', 'OAuth tab was closed before completing login.'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      options.webNavigation?.onBeforeNavigate.removeListener(onBeforeNavigate);
      options.tabs.onUpdated.removeListener(onUpdated);
      options.tabs.onRemoved.removeListener(onRemoved);
    };
    const finish = (url?: URL, error?: Error) => {
      cleanup();
      void options.tabs.remove(tabId).catch(() => undefined);
      if (url) resolve(url);
      else reject(error ?? new CodexAuthError('auth', 'OAuth login failed.'));
    };
    if (options.signal?.aborted) abort();
    else {
      options.signal?.addEventListener('abort', abort, { once: true });
      options.webNavigation?.onBeforeNavigate.addListener(onBeforeNavigate);
      options.tabs.onUpdated.addListener(onUpdated);
      options.tabs.onRemoved.addListener(onRemoved);
      if (options.tabs.update) void options.tabs.update(tabId, { url: authUrl, active: true }).catch((error) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
    }
  });
}

export async function createCodexPkce() {
  const verifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildCodexAuthorizeUrl(input: { codeChallenge: string; state: string; originator?: string; redirectUri?: string }) {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', input.redirectUri ?? CODEX_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', CODEX_OAUTH_SCOPES);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', input.state);
  url.searchParams.set('originator', input.originator ?? 'taber');
  return url.toString();
}

async function completeCodexOAuthRedirect(redirectUrl: URL, input: { state: string; codeVerifier: string; redirectUri: string } & ExchangeOptions) {
  const error = redirectUrl.searchParams.get('error');
  if (error) throw new CodexAuthError('auth', redirectUrl.searchParams.get('error_description') ?? error);
  if (redirectUrl.searchParams.get('state') !== input.state) throw new CodexAuthError('auth', 'OAuth state mismatch.');
  const authorizationCode = redirectUrl.searchParams.get('code');
  if (!authorizationCode) throw new CodexAuthError('auth', 'OAuth redirect is missing authorization code.');
  return exchangeCodexOAuthCode(authorizationCode, input.codeVerifier, input);
}

async function readTokenJson(response: Response) {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch (error) {
    throw new CodexAuthError('token_exchange', `Invalid OAuth token JSON: ${describe(error)}`, response.status);
  }
}

async function readError(response: Response) {
  const text = await response.text().catch(() => '');
  return `OAuth token request failed: HTTP ${response.status} ${response.statusText}${text ? `: ${redactCodexSecrets(text).slice(0, 300)}` : ''}`;
}

function shouldUseLocalhostFallback(error: unknown) {
  const message = describe(error);
  if (/\baborted\b|cancel|closed|denied|approve|state mismatch|missing authorization code/i.test(message)) return false;
  return /redirect|could not be loaded|authorization page|oauth login failed|invalid_request|not supported|not allowed|interaction required|requires user interaction|failed/i.test(message);
}

function isOpenAIIdentityUnsupportedPage(url: URL | undefined) {
  if (url?.origin !== CODEX_ISSUER || url.pathname !== '/error') return false;
  return /invalid_request|redirect/i.test(decodeOAuthErrorPayload(url.searchParams.get('payload')));
}

function decodeOAuthErrorPayload(payload: string | null) {
  if (!payload) return '';
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return atob(padded);
  } catch {
    return '';
  }
}

function isLocalhostRedirect(url: URL | undefined) {
  return url?.hostname === 'localhost' && url.host === 'localhost:1455';
}

function safeUrl(value: string | undefined) {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

function randomBase64Url(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new CodexAuthError('aborted', 'OAuth login was cancelled.');
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
