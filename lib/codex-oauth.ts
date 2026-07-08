import {
  CODEX_CLIENT_ID,
  CODEX_ISSUER,
  type CodexAuthTokens,
  CodexAuthError,
  parseCodexTokenMetadata,
  redactCodexSecrets,
} from './codex-auth.ts';
import {
  type BrowserOAuthTabs,
  type BrowserOAuthWebNavigation,
  BrowserOAuthError,
  buildOAuthAuthorizeUrl,
  createPkce,
  exchangeOAuthCode,
  readBearerTokens,
  readOAuthAuthorizationCode,
  safeUrl,
  waitForBrowserOAuthRedirect,
} from './oauth-browser.ts';

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

export type CodexOAuthTabs = BrowserOAuthTabs;
export type CodexOAuthWebNavigation = BrowserOAuthWebNavigation;

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

export async function loginOpenAICodex(options: LoginOptions): Promise<CodexAuthTokens> {
  const pkce = await createCodexPkce();
  const state = cryptoRandomState();

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
      if (!shouldUseLocalhostFallback(error)) throw mapBrowserError(error);
    }
  }

  const authUrl = buildCodexAuthorizeUrl({ codeChallenge: pkce.challenge, state, originator: options.originator, redirectUri: CODEX_OAUTH_REDIRECT_URI });
  const redirectUrl = await waitForCodexOAuthRedirect(authUrl, options);
  return completeCodexOAuthRedirect(redirectUrl, { state, codeVerifier: pkce.verifier, redirectUri: CODEX_OAUTH_REDIRECT_URI, ...options });
}

export async function exchangeCodexOAuthCode(authorizationCode: string, codeVerifier: string, options: ExchangeOptions = {}): Promise<CodexAuthTokens> {
  try {
    const body = await exchangeOAuthCode({
      tokenUrl: CODEX_OAUTH_TOKEN_URL,
      authorizationCode,
      codeVerifier,
      redirectUri: options.redirectUri ?? CODEX_OAUTH_REDIRECT_URI,
      clientId: CODEX_CLIENT_ID,
      fetch: options.fetch,
      signal: options.signal,
    });
    return normalizeCodexOAuthTokens(body, options.now ?? Date.now());
  } catch (error) {
    throw mapBrowserError(error);
  }
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

export async function waitForCodexOAuthRedirect(authUrl: string, options: Pick<LoginOptions, 'tabs' | 'webNavigation' | 'timeoutMs' | 'signal'>): Promise<URL> {
  try {
    return await waitForBrowserOAuthRedirect(authUrl, {
      tabs: options.tabs,
      webNavigation: options.webNavigation,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      isRedirect: isLocalhostRedirect,
    });
  } catch (error) {
    throw mapBrowserError(error);
  }
}

export async function createCodexPkce() {
  return createPkce();
}

export function buildCodexAuthorizeUrl(input: { codeChallenge: string; state: string; originator?: string; redirectUri?: string }) {
  return buildOAuthAuthorizeUrl({
    authorizeUrl: CODEX_OAUTH_AUTHORIZE_URL,
    clientId: CODEX_CLIENT_ID,
    redirectUri: input.redirectUri ?? CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPES,
    codeChallenge: input.codeChallenge,
    state: input.state,
    extraParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: input.originator ?? 'taber',
    },
  });
}

async function completeCodexOAuthRedirect(redirectUrl: URL, input: { state: string; codeVerifier: string; redirectUri: string } & ExchangeOptions) {
  try {
    const authorizationCode = readOAuthAuthorizationCode(redirectUrl, input.state);
    return exchangeCodexOAuthCode(authorizationCode, input.codeVerifier, input);
  } catch (error) {
    throw mapBrowserError(error);
  }
}

function normalizeCodexOAuthTokens(body: Record<string, unknown>, now: number): CodexAuthTokens {
  const tokens = readBearerTokens(body, now);
  const metadata = parseCodexTokenMetadata({ accessToken: tokens.accessToken, idToken: tokens.idToken }, now);
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    expiresAt: tokens.expiresAt,
    ...(metadata.accountId ? { accountId: metadata.accountId } : {}),
    ...(metadata.email ? { email: metadata.email } : {}),
    ...(metadata.planType ? { planType: metadata.planType } : {}),
  };
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

function isLocalhostRedirect(url: URL) {
  return url.hostname === 'localhost' && url.host === 'localhost:1455';
}

function mapBrowserError(error: unknown): Error {
  if (error instanceof CodexAuthError) return error;
  if (error instanceof BrowserOAuthError) {
    return new CodexAuthError(error.kind === 'unexpected_response' ? 'unexpected_response' : error.kind, error.message);
  }
  return error instanceof Error ? error : new CodexAuthError('auth', String(error));
}

function cryptoRandomState() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
