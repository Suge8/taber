/**
 * Shared browser OAuth PKCE primitives for extension login.
 * No provider policy: callers supply URLs, matchers, and token parsing.
 */

export type BrowserOAuthTabs = {
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

export type BrowserOAuthWebNavigation = {
  onBeforeNavigate: {
    addListener(listener: (details: { tabId: number; frameId: number; url: string }) => void): void;
    removeListener(listener: (details: { tabId: number; frameId: number; url: string }) => void): void;
  };
};

export type BrowserOAuthLoginDeps = {
  tabs: BrowserOAuthTabs;
  webNavigation?: BrowserOAuthWebNavigation;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class BrowserOAuthError extends Error {
  readonly kind: 'auth' | 'token_exchange' | 'timeout' | 'aborted' | 'unexpected_response';

  constructor(kind: BrowserOAuthError['kind'], message: string) {
    super(message);
    this.name = 'BrowserOAuthError';
    this.kind = kind;
  }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function createPkce() {
  const verifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildOAuthAuthorizeUrl(input: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  state: string;
  extraParams?: Record<string, string>;
}) {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scope);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Open a tab, wait until navigation hits a matching redirect URL, close the tab. */
export async function waitForBrowserOAuthRedirect(
  authUrl: string,
  options: BrowserOAuthLoginDeps & { isRedirect: (url: URL) => boolean },
): Promise<URL> {
  const tab = await options.tabs.create({ url: options.tabs.update ? 'about:blank' : authUrl, active: true });
  if (!tab.id) throw new BrowserOAuthError('auth', 'Failed to create OAuth tab.');
  const tabId = tab.id;

  return new Promise<URL>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(undefined, new BrowserOAuthError('timeout', 'OAuth login timed out.')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const abort = () => finish(undefined, new BrowserOAuthError('aborted', 'OAuth login was cancelled.'));
    const maybeFinish = (value: string | undefined) => {
      const url = safeUrl(value);
      if (url && options.isRedirect(url)) finish(url);
    };
    const onBeforeNavigate = (details: { tabId: number; frameId: number; url: string }) => {
      if (details.tabId === tabId && details.frameId === 0) maybeFinish(details.url);
    };
    const onUpdated = (updatedTabId: number, changeInfo: { url?: string }) => {
      if (updatedTabId === tabId) maybeFinish(changeInfo.url);
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(undefined, new BrowserOAuthError('auth', 'OAuth tab was closed before completing login.'));
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
      else reject(error ?? new BrowserOAuthError('auth', 'OAuth login failed.'));
    };

    if (options.signal?.aborted) abort();
    else {
      options.signal?.addEventListener('abort', abort, { once: true });
      options.webNavigation?.onBeforeNavigate.addListener(onBeforeNavigate);
      options.tabs.onUpdated.addListener(onUpdated);
      options.tabs.onRemoved.addListener(onRemoved);
      if (options.tabs.update) {
        void options.tabs
          .update(tabId, { url: authUrl, active: true })
          .catch((error) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
      }
    }
  });
}

export function readOAuthAuthorizationCode(redirectUrl: URL, expectedState: string): string {
  const error = redirectUrl.searchParams.get('error');
  if (error) {
    throw new BrowserOAuthError('auth', redirectUrl.searchParams.get('error_description') ?? error);
  }
  if (redirectUrl.searchParams.get('state') !== expectedState) {
    throw new BrowserOAuthError('auth', 'OAuth state mismatch.');
  }
  const code = redirectUrl.searchParams.get('code');
  if (!code) throw new BrowserOAuthError('auth', 'OAuth redirect is missing authorization code.');
  return code;
}

/** Standard OAuth token endpoint (authorization_code + PKCE). Returns raw JSON object. */
export async function exchangeOAuthCode(input: {
  tokenUrl: string;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  extraBody?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetcher(input.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.authorizationCode,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        code_verifier: input.codeVerifier,
        ...input.extraBody,
      }),
      signal: input.signal,
    });
  } catch (error) {
    throw new BrowserOAuthError(isAbortError(error) ? 'aborted' : 'token_exchange', describe(error));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BrowserOAuthError(
      'token_exchange',
      `OAuth token request failed: HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
  }
  return readJsonObject(response);
}

export async function refreshOAuthToken(input: {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  extraBody?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetcher(input.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        ...input.extraBody,
      }),
      signal: input.signal,
    });
  } catch (error) {
    throw new BrowserOAuthError(isAbortError(error) ? 'aborted' : 'token_exchange', describe(error));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BrowserOAuthError(
      'token_exchange',
      `OAuth refresh failed: HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`,
    );
  }
  return readJsonObject(response);
}

export function readBearerTokens(body: Record<string, unknown>, now = Date.now()) {
  const accessToken = readString(body.access_token);
  const refreshToken = readString(body.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new BrowserOAuthError('unexpected_response', 'OAuth token response is missing access_token or refresh_token.');
  }
  const idToken = readString(body.id_token);
  const expiresIn = readPositiveNumber(body.expires_in);
  return {
    accessToken,
    refreshToken,
    ...(idToken ? { idToken } : {}),
    expiresAt: expiresIn ? now + expiresIn * 1000 : now + 3600 * 1000,
  };
}

export function randomBase64Url(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export function safeUrl(value: string | undefined) {
  try {
    return value ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch (error) {
    throw new BrowserOAuthError('token_exchange', `Invalid OAuth token JSON: ${describe(error)}`);
  }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown) {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
