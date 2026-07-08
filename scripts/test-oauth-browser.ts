import assert from 'node:assert/strict';
import {
  BrowserOAuthError,
  buildOAuthAuthorizeUrl,
  createPkce,
  exchangeOAuthCode,
  readBearerTokens,
  readOAuthAuthorizationCode,
  refreshOAuthToken,
  waitForBrowserOAuthRedirect,
} from '../lib/oauth-browser.ts';

function createFakeTabs(seedUrl?: string) {
  const updated = new Set<(tabId: number, changeInfo: { url?: string }) => void>();
  const removed = new Set<(tabId: number) => void>();
  const beforeNavigate = new Set<(details: { tabId: number; frameId: number; url: string }) => void>();
  let nextId = 1;
  const tabs = {
    async create() {
      return { id: nextId++ };
    },
    async update(tabId: number, options: { url: string }) {
      for (const listener of updated) listener(tabId, { url: options.url });
      for (const listener of beforeNavigate) listener({ tabId, frameId: 0, url: options.url });
    },
    async remove() {},
    onUpdated: {
      addListener(listener: (tabId: number, changeInfo: { url?: string }) => void) {
        updated.add(listener);
      },
      removeListener(listener: (tabId: number, changeInfo: { url?: string }) => void) {
        updated.delete(listener);
      },
    },
    onRemoved: {
      addListener(listener: (tabId: number) => void) {
        removed.add(listener);
      },
      removeListener(listener: (tabId: number) => void) {
        removed.delete(listener);
      },
    },
  };
  const webNavigation = {
    onBeforeNavigate: {
      addListener(listener: (details: { tabId: number; frameId: number; url: string }) => void) {
        beforeNavigate.add(listener);
        if (seedUrl) queueMicrotask(() => listener({ tabId: 1, frameId: 0, url: seedUrl }));
      },
      removeListener(listener: (details: { tabId: number; frameId: number; url: string }) => void) {
        beforeNavigate.delete(listener);
      },
    },
  };
  return { tabs, webNavigation, emitBeforeNavigate(tabId: number, url: string) {
    for (const listener of beforeNavigate) listener({ tabId, frameId: 0, url });
  } };
}

async function testPkceAndAuthorizeUrl() {
  const pkce = await createPkce();
  assert.equal(typeof pkce.verifier, 'string');
  assert.equal(typeof pkce.challenge, 'string');
  assert.notEqual(pkce.verifier, pkce.challenge);
  const url = buildOAuthAuthorizeUrl({
    authorizeUrl: 'https://auth.example.com/oauth2/authorize',
    clientId: 'client',
    redirectUri: 'http://127.0.0.1:56121/callback',
    scope: 'openid',
    codeChallenge: pkce.challenge,
    state: 'state-1',
    extraParams: { foo: 'bar' },
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('response_type'), 'code');
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(parsed.searchParams.get('foo'), 'bar');
}

async function testWaitForRedirect() {
  const fake = createFakeTabs();
  const pending = waitForBrowserOAuthRedirect('https://auth.example.com/start', {
    tabs: fake.tabs,
    webNavigation: fake.webNavigation,
    timeoutMs: 1000,
    isRedirect: (url) => url.hostname === '127.0.0.1' && url.port === '56121',
  });
  await Promise.resolve();
  fake.emitBeforeNavigate(1, 'http://127.0.0.1:56121/callback?code=abc&state=s');
  const redirect = await pending;
  assert.equal(redirect.searchParams.get('code'), 'abc');
}

async function testReadCodeAndExchange() {
  const redirect = new URL('http://127.0.0.1:56121/callback?code=the-code&state=good');
  assert.equal(readOAuthAuthorizationCode(redirect, 'good'), 'the-code');
  assert.throws(() => readOAuthAuthorizationCode(redirect, 'bad'), BrowserOAuthError);

  const body = await exchangeOAuthCode({
    tokenUrl: 'https://auth.example.com/token',
    authorizationCode: 'the-code',
    codeVerifier: 'v',
    redirectUri: 'http://127.0.0.1:56121/callback',
    clientId: 'client',
    fetch: async (_url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'the-code');
      return new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
      }), { status: 200 });
    },
  });
  const tokens = readBearerTokens(body, 1_000);
  assert.equal(tokens.accessToken, 'access');
  assert.equal(tokens.refreshToken, 'refresh');
  assert.equal(tokens.expiresAt, 1_000 + 3600 * 1000);

  const refreshed = await refreshOAuthToken({
    tokenUrl: 'https://auth.example.com/token',
    refreshToken: 'refresh',
    clientId: 'client',
    fetch: async () => new Response(JSON.stringify({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 10,
    }), { status: 200 }),
  });
  assert.equal(readBearerTokens(refreshed, 0).accessToken, 'access-2');
}

await testPkceAndAuthorizeUrl();
await testWaitForRedirect();
await testReadCodeAndExchange();
console.log('ok: oauth-browser');
