import assert from 'node:assert/strict';
import { chromeApiRequestType, createChromeApiBroker, isChromeApiRequest, isTrustedChromeApiSender } from '../lib/chrome-api-broker.ts';

await testAllowsOnlyKnownActions();
await testTrustsOnlyExtensionPageSenders();
await testDispatchesAllowedAction();

console.info('chrome api broker tests passed');

async function testAllowsOnlyKnownActions() {
  assert.equal(isChromeApiRequest({ type: chromeApiRequestType, action: 'tabs.query', args: [{}] }), true);
  assert.equal(isChromeApiRequest({ type: chromeApiRequestType, action: 'runtime.sendMessage', args: [] }), false);
  assert.equal(isChromeApiRequest({ type: chromeApiRequestType, action: 'tabs.query', args: {} }), false);
}

async function testTrustsOnlyExtensionPageSenders() {
  assert.equal(isTrustedChromeApiSender({ id: 'abc', url: 'chrome-extension://abc/offscreen.html' }, 'abc'), true);
  assert.equal(isTrustedChromeApiSender({ id: 'abc', url: 'chrome-extension://abc/sidepanel.html' }, 'abc'), true);
  assert.equal(isTrustedChromeApiSender({ id: 'abc', url: 'https://example.test/page', tab: { id: 1 } }, 'abc'), false);
  assert.equal(isTrustedChromeApiSender({ id: 'abc', origin: 'https://example.test' }, 'abc'), false);
  assert.equal(isTrustedChromeApiSender({ id: 'other', url: 'chrome-extension://other/offscreen.html' }, 'abc'), false);
  assert.equal(isTrustedChromeApiSender(undefined, 'abc'), false);
}

async function testDispatchesAllowedAction() {
  const calls: unknown[] = [];
  const broker = createChromeApiBroker({
    tabs: createNamespace(['query', 'get', 'create', 'update', 'remove'], calls),
    scripting: createNamespace(['executeScript'], calls),
    userScripts: createNamespace(['execute'], calls),
    debugger: createNamespace(['attach', 'detach', 'sendCommand'], calls),
  });

  const result = await broker({ type: chromeApiRequestType, action: 'tabs.query', args: [{ active: true }] });

  assert.deepEqual(calls, [{ method: 'query', args: [{ active: true }] }]);
  assert.deepEqual(result, { method: 'query' });
}

function createNamespace(methods: string[], calls: unknown[]) {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args });
        return { method };
      },
    ]),
  ) as never;
}
