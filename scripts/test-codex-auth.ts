import assert from 'node:assert/strict';
import {
  CODEX_CLIENT_ID,
  CODEX_CLIENT_VERSION,
  CODEX_DEVICE_VERIFY_URL,
  CODEX_MODELS_URL,
  CODEX_ORIGINATOR,
  CodexAuthError,
  exchangeCodexAuthorizationCode,
  fetchCodexModels,
  parseCodexModels,
  parseCodexTokenMetadata,
  pollCodexAuthorizationCode,
  redactCodexSecrets,
  refreshCodexTokens,
  requestCodexDeviceCode,
} from '../lib/codex-auth.ts';
import {
  CODEX_OAUTH_IDENTITY_REDIRECT_PATH,
  CODEX_OAUTH_REDIRECT_URI,
  buildCodexAuthorizeUrl,
  exchangeCodexOAuthCode,
  loginOpenAICodex,
  waitForCodexIdentityRedirect,
  waitForCodexOAuthRedirect,
  type CodexOAuthIdentity,
  type CodexOAuthTabs,
  type CodexOAuthWebNavigation,
} from '../lib/codex-oauth.ts';

assert.equal(CODEX_CLIENT_VERSION, '0.144.1');
assert.equal(new URL(CODEX_MODELS_URL).searchParams.get('client_version'), CODEX_CLIENT_VERSION);

await testRequestDeviceCode();
await testPollDeviceCode();
await testExchangeCodeForTokens();
await testExchangeOAuthCodeForTokens();
await testLoginUsesIdentityWebAuthFlow();
await testIdentityFailureFallsBackToLocalhostCapture();
await testIdentityInteractionRequiredFallsBackToLocalhostCapture();
await testIdentityUnsupportedPageFallsBackToLocalhostCapture();
await testIdentityCancelDoesNotFallback();
await testWaitForIdentityRedirect();
await testWaitForOAuthRedirect();
await testWaitForOAuthRedirectUsesWebNavigation();
await testRefreshTokens();
await testFetchCodexModels();
testParseCodexModels();
testParseJwtClaims();
await testErrorsAreRedacted();

console.info('codex-auth tests passed');

async function testRequestDeviceCode() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await requestCodexDeviceCode({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '2' });
    },
  });

  assert.equal(result.verificationUrl, CODEX_DEVICE_VERIFY_URL);
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.deviceAuthId, 'dev-1');
  assert.equal(result.intervalSeconds, 2);
  assert.equal(calls[0]!.url, 'https://auth.openai.com/api/accounts/deviceauth/usercode');
  assert.equal(JSON.parse(String(calls[0]!.init!.body)).client_id, CODEX_CLIENT_ID);
}

async function testPollDeviceCode() {
  const calls: string[] = [];
  const delays: number[] = [];
  const code = await pollCodexAuthorizationCode(
    { verificationUrl: CODEX_DEVICE_VERIFY_URL, userCode: 'ABCD', deviceAuthId: 'dev-1', intervalSeconds: 3 },
    {
      timeoutMs: 10000,
      delay: async (ms) => { delays.push(ms); },
      fetch: async (input, init) => {
        calls.push(String(input));
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.device_auth_id, 'dev-1');
        assert.equal(payload.user_code, 'ABCD');
        if (calls.length === 1) return new Response('', { status: 403, statusText: 'Forbidden' });
        return jsonResponse({ authorization_code: 'auth-code', code_verifier: 'verifier' });
      },
    },
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(delays, [3000]);
  assert.deepEqual(code, { authorizationCode: 'auth-code', codeVerifier: 'verifier' });
}

async function testExchangeCodeForTokens() {
  const now = 1_700_000_000_000;
  let body = '';
  const accessToken = jwt({ exp: now / 1000 + 3600 });
  const idToken = jwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-1',
      chatgpt_plan_type: 'plus',
    },
  });

  const tokens = await exchangeCodexAuthorizationCode({ authorizationCode: 'code', codeVerifier: 'verifier' }, {
    now,
    fetch: async (_input, init) => {
      body = String(init?.body);
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
      return jsonResponse({ access_token: accessToken, refresh_token: 'rt_123', id_token: idToken, expires_in: 1800 });
    },
  });

  const params = new URLSearchParams(body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('client_id'), CODEX_CLIENT_ID);
  assert.equal(params.get('code'), 'code');
  assert.equal(params.get('code_verifier'), 'verifier');
  assert.equal(params.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
  assert.equal(tokens.expiresAt, now + 1800_000);
  assert.equal(tokens.accountId, 'account-1');
  assert.equal(tokens.email, 'user@example.com');
  assert.equal(tokens.planType, 'plus');
}

async function testExchangeOAuthCodeForTokens() {
  const now = 1_700_000_000_000;
  let body = '';
  const idToken = jwt({
    email: 'oauth@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'oauth-account' },
  });

  const tokens = await exchangeCodexOAuthCode('oauth-code', 'oauth-verifier', {
    now,
    fetch: async (_input, init) => {
      body = String(init?.body);
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
      return jsonResponse({ access_token: jwt({ exp: now / 1000 + 600 }), refresh_token: 'rt_oauth', id_token: idToken, expires_in: 600 });
    },
  });

  const params = new URLSearchParams(body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('client_id'), CODEX_CLIENT_ID);
  assert.equal(params.get('code'), 'oauth-code');
  assert.equal(params.get('code_verifier'), 'oauth-verifier');
  assert.equal(params.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);
  assert.equal(tokens.accountId, 'oauth-account');
  assert.equal(tokens.email, 'oauth@example.com');
}

async function testLoginUsesIdentityWebAuthFlow() {
  const now = 1_700_000_000_000;
  let body = '';
  let launchedUrl = '';
  const identityRedirectUri = 'https://extension.chromiumapp.org/auth/callback';
  const identity: CodexOAuthIdentity = {
    getRedirectURL(path) {
      assert.equal(path, CODEX_OAUTH_IDENTITY_REDIRECT_PATH);
      return identityRedirectUri;
    },
    async launchWebAuthFlow(details) {
      launchedUrl = details.url;
      assert.equal(details.interactive, false);
      assert.equal(details.abortOnLoadForNonInteractive, true);
      assert.equal(details.timeoutMsForNonInteractive, 2000);
      const url = new URL(details.url);
      assert.equal(url.searchParams.get('redirect_uri'), identityRedirectUri);
      return `${identityRedirectUri}?code=identity-code&state=${url.searchParams.get('state')}`;
    },
  };
  const fakeTabs = createFakeTabs();

  const tokens = await loginOpenAICodex({
    identity,
    tabs: fakeTabs.tabs,
    now,
    fetch: async (_input, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: jwt({ exp: now / 1000 + 600 }), refresh_token: 'rt_identity' });
    },
  });

  assert.equal(new URL(launchedUrl).searchParams.get('redirect_uri'), identityRedirectUri);
  const params = new URLSearchParams(body);
  assert.equal(params.get('code'), 'identity-code');
  assert.equal(params.get('redirect_uri'), identityRedirectUri);
  assert.equal(tokens.refreshToken, 'rt_identity');
  assert.deepEqual(fakeTabs.createdUrls, []);
}

async function testIdentityFailureFallsBackToLocalhostCapture() {
  let body = '';
  const identity: CodexOAuthIdentity = {
    getRedirectURL: () => 'https://extension.chromiumapp.org/auth/callback',
    launchWebAuthFlow: async () => { throw new Error('Authorization page load timed out.'); },
  };
  const fakeTabs = createFakeTabs();
  const login = loginOpenAICodex({
    identity,
    tabs: fakeTabs.tabs,
    webNavigation: fakeTabs.webNavigation,
    fetch: async (_input, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: jwt({ exp: 2000 }), refresh_token: 'rt_fallback' });
    },
  });

  const authUrl = await fakeTabs.created;
  const state = new URL(authUrl).searchParams.get('state');
  fakeTabs.beforeNavigate?.({ tabId: 7, frameId: 0, url: `http://localhost:1455/auth/callback?code=local-code&state=${state}` });

  const tokens = await login;
  const params = new URLSearchParams(body);
  assert.equal(params.get('code'), 'local-code');
  assert.equal(params.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);
  assert.equal(tokens.refreshToken, 'rt_fallback');
  assert.deepEqual(fakeTabs.removedIds, [7]);
}

async function testIdentityInteractionRequiredFallsBackToLocalhostCapture() {
  let body = '';
  const identity: CodexOAuthIdentity = {
    getRedirectURL: () => 'https://extension.chromiumapp.org/auth/callback',
    launchWebAuthFlow: async () => { throw new Error('User interaction required. Try setting `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` if multiple navigations are required.'); },
  };
  const fakeTabs = createFakeTabs();
  const login = loginOpenAICodex({
    identity,
    tabs: fakeTabs.tabs,
    webNavigation: fakeTabs.webNavigation,
    fetch: async (_input, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: jwt({ exp: 2000 }), refresh_token: 'rt_interaction_fallback' });
    },
  });

  const authUrl = await fakeTabs.created;
  const state = new URL(authUrl).searchParams.get('state');
  fakeTabs.beforeNavigate?.({ tabId: 7, frameId: 0, url: `http://localhost:1455/auth/callback?code=local-code&state=${state}` });

  const tokens = await login;
  const params = new URLSearchParams(body);
  assert.equal(params.get('code'), 'local-code');
  assert.equal(params.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);
  assert.equal(tokens.refreshToken, 'rt_interaction_fallback');
  assert.deepEqual(fakeTabs.removedIds, [7]);
}

async function testIdentityUnsupportedPageFallsBackToLocalhostCapture() {
  let body = '';
  let resolveLaunched: () => void = () => undefined;
  const launched = new Promise<void>((resolve) => { resolveLaunched = resolve; });
  const identity: CodexOAuthIdentity = {
    getRedirectURL: () => 'https://extension.chromiumapp.org/auth/callback',
    launchWebAuthFlow: async () => {
      resolveLaunched();
      return new Promise<string>(() => undefined);
    },
  };
  const fakeTabs = createFakeTabs();
  const login = loginOpenAICodex({
    identity,
    tabs: fakeTabs.tabs,
    webNavigation: fakeTabs.webNavigation,
    fetch: async (_input, init) => {
      body = String(init?.body);
      return jsonResponse({ access_token: jwt({ exp: 2000 }), refresh_token: 'rt_identity_unsupported' });
    },
  });

  await launched;
  const payload = base64Url({ kind: 'AuthApiFailure', errorCode: 'authorize_hydra_invalid_request' });
  fakeTabs.beforeNavigate?.({ tabId: 23, frameId: 0, url: `https://auth.openai.com/error?payload=${payload}` });
  const authUrl = await fakeTabs.created;
  const state = new URL(authUrl).searchParams.get('state');
  fakeTabs.beforeNavigate?.({ tabId: 7, frameId: 0, url: `http://localhost:1455/auth/callback?code=local-code&state=${state}` });

  const tokens = await login;
  const params = new URLSearchParams(body);
  assert.equal(params.get('code'), 'local-code');
  assert.equal(params.get('redirect_uri'), CODEX_OAUTH_REDIRECT_URI);
  assert.equal(tokens.refreshToken, 'rt_identity_unsupported');
  assert.deepEqual(fakeTabs.removedIds, [23, 7]);
}

async function testIdentityCancelDoesNotFallback() {
  const identity: CodexOAuthIdentity = {
    getRedirectURL: () => 'https://extension.chromiumapp.org/auth/callback',
    launchWebAuthFlow: async () => { throw new CodexAuthError('aborted', 'OAuth login was cancelled.'); },
  };
  const fakeTabs = createFakeTabs();

  await assert.rejects(
    () => loginOpenAICodex({ identity, tabs: fakeTabs.tabs }),
    /OAuth login was cancelled/,
  );
  assert.deepEqual(fakeTabs.createdUrls, []);
}

async function testWaitForIdentityRedirect() {
  const identity: CodexOAuthIdentity = {
    getRedirectURL: () => 'https://extension.chromiumapp.org/auth/callback',
    launchWebAuthFlow: async (details) => `${details.url}&code=bad`,
  };
  const redirect = await waitForCodexIdentityRedirect('https://extension.chromiumapp.org/auth/callback?code=ok', { identity });
  assert.equal(redirect.searchParams.get('code'), 'ok');
}

async function testWaitForOAuthRedirect() {
  const url = buildCodexAuthorizeUrl({ codeChallenge: 'challenge', state: 'state-1' });
  assert.equal(new URL(url).searchParams.get('originator'), CODEX_ORIGINATOR);
  const fakeTabs = createFakeTabs();
  const redirect = waitForCodexOAuthRedirect(url, { tabs: fakeTabs.tabs, timeoutMs: 1000 });
  await fakeTabs.created;
  fakeTabs.updated?.(7, { url: 'https://auth.openai.com/noop' });
  fakeTabs.updated?.(7, { url: 'http://localhost:1455/auth/callback?code=oauth-code&state=state-1' });
  assert.equal((await redirect).searchParams.get('code'), 'oauth-code');
  assert.deepEqual(fakeTabs.removedIds, [7]);
}

async function testWaitForOAuthRedirectUsesWebNavigation() {
  const fakeTabs = createFakeTabs();
  const redirect = waitForCodexOAuthRedirect('https://auth.openai.com/oauth/authorize', { tabs: fakeTabs.tabs, webNavigation: fakeTabs.webNavigation, timeoutMs: 1000 });
  await fakeTabs.created;
  fakeTabs.beforeNavigate?.({ tabId: 7, frameId: 0, url: 'http://localhost:1455/auth/callback?code=before-navigate&state=state-1' });
  assert.equal((await redirect).searchParams.get('code'), 'before-navigate');
  assert.deepEqual(fakeTabs.removedIds, [7]);
}

async function testRefreshTokens() {
  let payload: Record<string, unknown> | undefined;
  const accessToken = jwt({ exp: 2000, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-refresh' } });
  const tokens = await refreshCodexTokens('rt_refresh_secret', {
    now: 1_000_000,
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return jsonResponse({ access_token: accessToken, refresh_token: 'rt_next' });
    },
  });

  assert.deepEqual(payload, { grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: 'rt_refresh_secret' });
  assert.equal(tokens.refreshToken, 'rt_next');
  assert.equal(tokens.accountId, 'account-refresh');
  assert.equal(tokens.expiresAt, 2_000_000);
}

async function testFetchCodexModels() {
  let capturedHeaders: Headers | undefined;
  const body = await fetchCodexModels({ accessToken: 'access-secret', accountId: 'account-1' }, {
    fetch: async (input, init) => {
      assert.equal(String(input), CODEX_MODELS_URL);
      assert.equal(init?.method, 'GET');
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse({ models: [{ slug: 'gpt-5.4', context_window: 1000000 }] });
    },
  });

  assert.deepEqual(body, { models: [{ slug: 'gpt-5.4', context_window: 1000000 }] });
  assert.equal(capturedHeaders!.get('authorization'), 'Bearer access-secret');
  assert.equal(capturedHeaders!.get('chatgpt-account-id'), 'account-1');
  assert.equal(capturedHeaders!.get('openai-beta'), 'responses=experimental');
  assert.equal(capturedHeaders!.get('originator'), CODEX_ORIGINATOR);
}

function testParseCodexModels() {
  assert.deepEqual(parseCodexModels({
    models: [
      {
        slug: 'gpt-5.4',
        display_name: 'GPT 5.4',
        context_window: 1000000,
        supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'high', description: 'Deep' }],
        default_reasoning_level: 'medium',
        priority: 2,
        visibility: 'list',
        supported_in_api: true,
      },
      { id: 'legacy', context_length: '128000', supported_reasoning_efforts: ['minimal', 'low', 'low'] },
      { display_name: 'missing slug' },
    ],
  }), [
    {
      name: 'gpt-5.4',
      displayName: 'GPT 5.4',
      contextWindowTokens: 1000000,
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'medium',
      priority: 2,
      visibility: 'list',
      supportedInApi: true,
    },
    {
      name: 'legacy',
      contextWindowTokens: 128000,
      supportedReasoningEfforts: ['minimal', 'low'],
    },
  ]);
}

function testParseJwtClaims() {
  const token = jwt({
    exp: 1234,
    'https://api.openai.com/profile': { email: 'profile@example.com' },
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc', chatgpt_plan_type: 'pro' },
  });
  assert.deepEqual(parseCodexTokenMetadata({ accessToken: token }, 0), {
    expiresAt: 1_234_000,
    accountId: 'acc',
    email: 'profile@example.com',
    planType: 'pro',
  });
}

async function testErrorsAreRedacted() {
  const leakedJwt = jwt({ secret: true });
  const message = redactCodexSecrets(`access_token=${leakedJwt}&refresh_token=rt_secret&code_verifier=plain`);
  assert(!message.includes(leakedJwt));
  assert(!message.includes('rt_secret'));
  assert(!message.includes('plain'));

  await assert.rejects(
    () => exchangeCodexAuthorizationCode({ authorizationCode: 'code', codeVerifier: 'verifier' }, {
      fetch: async () => new Response(`{"access_token":"${leakedJwt}","refresh_token":"rt_secret"}`, { status: 400, statusText: 'Bad Request' }),
    }),
    (error) => {
      assert(error instanceof CodexAuthError);
      assert.equal(error.kind, 'token_exchange');
      assert(!error.message.includes(leakedJwt));
      assert(!error.message.includes('rt_secret'));
      return true;
    },
  );

  await assert.rejects(
    () => fetchCodexModels({ accessToken: 'access-secret', accountId: 'account-secret' }, {
      fetch: async () => new Response('access-secret account-secret rt_model_secret', { status: 401, statusText: 'Unauthorized' }),
    }),
    (error) => {
      assert(error instanceof CodexAuthError);
      assert.equal(error.kind, 'model_endpoint');
      assert(!error.message.includes('access-secret'));
      assert(!error.message.includes('account-secret'));
      assert(!error.message.includes('rt_model_secret'));
      return true;
    },
  );
}

function createFakeTabs() {
  let updated: ((tabId: number, changeInfo: { url?: string }) => void) | undefined;
  let removed: ((tabId: number) => void) | undefined;
  let beforeNavigate: ((details: { tabId: number; frameId: number; url: string }) => void) | undefined;
  let resolveCreated: (url: string) => void = () => undefined;
  const created = new Promise<string>((resolve) => { resolveCreated = resolve; });
  const createdUrls: string[] = [];
  const removedIds: number[] = [];
  const tabs: CodexOAuthTabs = {
    create: async (options) => {
      if (options.url !== 'about:blank') {
        createdUrls.push(options.url);
        resolveCreated(options.url);
      }
      return { id: 7 };
    },
    update: async (_tabId, options) => {
      createdUrls.push(options.url);
      resolveCreated(options.url);
    },
    remove: async (tabId) => { removedIds.push(tabId); },
    onUpdated: {
      addListener(listener) { updated = listener; },
      removeListener() { updated = undefined; },
    },
    onRemoved: {
      addListener(listener) { removed = listener; },
      removeListener() { removed = undefined; },
    },
  };
  const webNavigation: CodexOAuthWebNavigation = {
    onBeforeNavigate: {
      addListener(listener) { beforeNavigate = listener; },
      removeListener() { beforeNavigate = undefined; },
    },
  };
  return { tabs, webNavigation, created, createdUrls, removedIds, get updated() { return updated; }, get removed() { return removed; }, get beforeNavigate() { return beforeNavigate; } };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function jwt(payload: Record<string, unknown>) {
  return [base64Url({ alg: 'none', typ: 'JWT' }), base64Url(payload), 'sig'].join('.');
}

function base64Url(value: unknown) {
  return btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
