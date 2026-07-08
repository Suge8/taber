import {
  XAI_OAUTH_AUTHORIZE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPES,
  XAI_OAUTH_TOKEN_URL,
  type XaiAuthTokens,
  XaiAuthError,
  mapXaiError,
  parseXaiTokenResponse,
} from './xai-auth.ts';
import {
  type BrowserOAuthLoginDeps,
  buildOAuthAuthorizeUrl,
  createPkce,
  exchangeOAuthCode,
  randomBase64Url,
  readOAuthAuthorizationCode,
  waitForBrowserOAuthRedirect,
} from './oauth-browser.ts';

export type XaiOAuthLoginOptions = BrowserOAuthLoginDeps & {
  now?: number;
  /**
   * Called while waiting for login. Resolve with the finish-login code or callback URL
   * when the user pastes it. Reject/abort if the user cancels.
   */
  waitForManualCode?: (ctx: { signal: AbortSignal }) => Promise<string>;
};

type LoginSource =
  | { type: 'redirect'; url: URL }
  | { type: 'manual'; code: string };

export async function loginXaiSub(options: XaiOAuthLoginOptions): Promise<XaiAuthTokens> {
  const pkce = await createPkce();
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const authUrl = buildOAuthAuthorizeUrl({
    authorizeUrl: XAI_OAUTH_AUTHORIZE_URL,
    clientId: XAI_OAUTH_CLIENT_ID,
    redirectUri: XAI_OAUTH_REDIRECT_URI,
    scope: XAI_OAUTH_SCOPES,
    codeChallenge: pkce.challenge,
    state,
    extraParams: { nonce },
  });

  try {
    const source = await collectLoginSource(authUrl, options);
    const authorizationCode =
      source.type === 'redirect' ? readOAuthAuthorizationCode(source.url, state) : source.code;

    const body = await exchangeOAuthCode({
      tokenUrl: XAI_OAUTH_TOKEN_URL,
      authorizationCode,
      codeVerifier: pkce.verifier,
      redirectUri: XAI_OAUTH_REDIRECT_URI,
      clientId: XAI_OAUTH_CLIENT_ID,
      fetch: options.fetch,
      signal: options.signal,
    });
    return parseXaiTokenResponse(body, options.now ?? Date.now());
  } catch (error) {
    throw mapXaiError(error);
  }
}

/** Parse pasted finish-login code, callback URL, or query string. */
export function parseXaiManualCode(input: string): string {
  const value = input.trim();
  if (!value) throw new XaiAuthError('auth', 'Paste the xAI login code first.');

  try {
    const url = value.startsWith('http')
      ? new URL(value)
      : value.includes('code=')
        ? new URL(`http://127.0.0.1:56121/callback?${value.replace(/^\?/, '')}`)
        : undefined;
    if (url) {
      const error = url.searchParams.get('error');
      if (error) throw new XaiAuthError('auth', url.searchParams.get('error_description') ?? error);
      const code = url.searchParams.get('code');
      if (code) return code;
    }
  } catch (error) {
    if (error instanceof XaiAuthError) throw error;
  }

  // Long OAuth authorization codes
  if (/^[A-Za-z0-9_-]{16,}$/.test(value)) return value;

  // Short finish-login codes shown by xAI, e.g. B4A6-4B08
  if (/^[A-Za-z0-9]{3,8}(?:-[A-Za-z0-9]{3,8})+$/.test(value)) return value;
  if (/^[A-Za-z0-9]{6,12}$/.test(value)) return value;

  throw new XaiAuthError('auth', 'That does not look like an xAI login code.');
}

async function collectLoginSource(authUrl: string, options: XaiOAuthLoginOptions): Promise<LoginSource> {
  const redirectAbort = new AbortController();
  const manualAbort = new AbortController();
  const linkParent = () => {
    redirectAbort.abort();
    manualAbort.abort();
  };
  options.signal?.addEventListener('abort', linkParent, { once: true });
  if (options.signal?.aborted) linkParent();

  const redirectPromise = waitForBrowserOAuthRedirect(authUrl, {
    tabs: options.tabs,
    webNavigation: options.webNavigation,
    timeoutMs: options.timeoutMs,
    signal: redirectAbort.signal,
    isRedirect: isXaiRedirect,
  }).then((url): LoginSource => ({ type: 'redirect', url }));

  if (!options.waitForManualCode) {
    try {
      return await redirectPromise;
    } finally {
      options.signal?.removeEventListener('abort', linkParent);
    }
  }

  const manualPromise = options
    .waitForManualCode({ signal: manualAbort.signal })
    .then((raw): LoginSource => ({ type: 'manual', code: parseXaiManualCode(raw) }));

  try {
    const source = await Promise.race([redirectPromise, manualPromise]);
    if (source.type === 'manual') redirectAbort.abort();
    else manualAbort.abort();
    return source;
  } catch (error) {
    // One path may reject with abort after the other wins; prefer any fulfilled source.
    const settled = await Promise.allSettled([redirectPromise, manualPromise]);
    const fulfilled = settled.find((item) => item.status === 'fulfilled');
    if (fulfilled && fulfilled.status === 'fulfilled') return fulfilled.value;
    throw error;
  } finally {
    redirectAbort.abort();
    manualAbort.abort();
    options.signal?.removeEventListener('abort', linkParent);
  }
}

function isXaiRedirect(url: URL) {
  return (
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
    url.port === '56121' &&
    (url.pathname === '/callback' || url.pathname.endsWith('/callback'))
  );
}
