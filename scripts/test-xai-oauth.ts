import assert from 'node:assert/strict';
import { loginXaiSub, parseXaiManualCode } from '../lib/xai-oauth.ts';
import { parseXaiTokenResponse, refreshXaiTokens, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_REDIRECT_URI } from '../lib/xai-auth.ts';

function createFakeTabs() {
  const updated = new Set<(tabId: number, changeInfo: { url?: string }) => void>();
  const removed = new Set<(tabId: number) => void>();
  const beforeNavigate = new Set<(details: { tabId: number; frameId: number; url: string }) => void>();
  let createdId = 0;
  return {
    tabs: {
      async create() {
        createdId += 1;
        return { id: createdId };
      },
      async update(tabId: number, options: { url: string }) {
        queueMicrotask(() => {
          for (const listener of beforeNavigate) {
            listener({
              tabId,
              frameId: 0,
              url: `${XAI_OAUTH_REDIRECT_URI}?code=xai-code&state=${new URL(options.url).searchParams.get('state')}`,
            });
          }
        });
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
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener(listener: (details: { tabId: number; frameId: number; url: string }) => void) {
          beforeNavigate.add(listener);
        },
        removeListener(listener: (details: { tabId: number; frameId: number; url: string }) => void) {
          beforeNavigate.delete(listener);
        },
      },
    },
  };
}

async function testLoginXaiSub() {
  const fake = createFakeTabs();
  const tokens = await loginXaiSub({
    tabs: fake.tabs,
    webNavigation: fake.webNavigation,
    now: 5_000,
    fetch: async (url, init) => {
      assert.match(String(url), /oauth2\/token$/);
      const params = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(params.get('client_id'), XAI_OAUTH_CLIENT_ID);
      assert.equal(params.get('code'), 'xai-code');
      assert.equal(params.get('redirect_uri'), XAI_OAUTH_REDIRECT_URI);
      assert.ok(params.get('code_verifier'));
      return new Response(JSON.stringify({
        access_token: 'xai-access',
        refresh_token: 'xai-refresh',
        expires_in: 120,
        token_type: 'Bearer',
      }), { status: 200 });
    },
  });
  assert.equal(tokens.accessToken, 'xai-access');
  assert.equal(tokens.refreshToken, 'xai-refresh');
  assert.equal(tokens.expiresAt, 5_000 + 120_000);
}

async function testRefreshAndParse() {
  const parsed = parseXaiTokenResponse({
    access_token: 'a',
    refresh_token: 'r',
    expires_in: 30,
  }, 1000);
  assert.equal(parsed.expiresAt, 1000 + 30_000);

  const refreshed = await refreshXaiTokens('old-refresh', {
    now: 2000,
    fetch: async (_url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(params.get('grant_type'), 'refresh_token');
      assert.equal(params.get('refresh_token'), 'old-refresh');
      return new Response(JSON.stringify({
        access_token: 'new-access',
        expires_in: 10,
      }), { status: 200 });
    },
  });
  assert.equal(refreshed.accessToken, 'new-access');
  assert.equal(refreshed.refreshToken, 'old-refresh');
}

function testParseManualCode() {
  assert.equal(parseXaiManualCode('B4A6-4B08'), 'B4A6-4B08');
  assert.equal(parseXaiManualCode('  abcdEFGHijklMNOP  '), 'abcdEFGHijklMNOP');
  assert.equal(
    parseXaiManualCode('http://127.0.0.1:56121/callback?code=long-oauth-code&state=x'),
    'long-oauth-code',
  );
}

async function testManualCodeLogin() {
  const fake = createFakeTabs();
  // Never emits redirect; only manual code path should complete.
  fake.tabs.update = async () => {};
  const tokens = await loginXaiSub({
    tabs: fake.tabs,
    webNavigation: fake.webNavigation,
    now: 9_000,
    waitForManualCode: async () => 'B4A6-4B08',
    fetch: async (_url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      assert.equal(params.get('code'), 'B4A6-4B08');
      assert.equal(params.get('redirect_uri'), XAI_OAUTH_REDIRECT_URI);
      return new Response(JSON.stringify({
        access_token: 'manual-access',
        refresh_token: 'manual-refresh',
        expires_in: 60,
      }), { status: 200 });
    },
  });
  assert.equal(tokens.accessToken, 'manual-access');
}

await testLoginXaiSub();
await testRefreshAndParse();
testParseManualCode();
await testManualCodeLogin();
console.log('ok: xai-oauth');
