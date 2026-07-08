import assert from 'node:assert/strict';
import { effectiveTabUrl, isOperableTab, readRequiredWindowId, selectOperableActiveTab } from '../lib/active-tab.ts';

assert.equal(isOperableTab({ id: 1, url: 'https://example.com' }), true);
assert.equal(isOperableTab({ id: 1, url: 'http://example.com' }), true);
assert.equal(isOperableTab({ url: 'https://example.com' }), false);
assert.equal(isOperableTab({ id: 1, url: 'chrome://extensions/shortcuts' }), false);
assert.equal(isOperableTab({ id: 1, url: 'chrome-extension://abc/sidepanel.html' }), false);
assert.equal(isOperableTab({ id: 1, pendingUrl: 'edge://settings' }), false);
assert.equal(isOperableTab({ id: 1, url: 'https://example.com/old', pendingUrl: 'chrome://settings' }), false);
assert.equal(isOperableTab({ id: 1, url: 'chrome://settings', pendingUrl: 'https://example.com/new' }), true);
assert.equal(effectiveTabUrl({ id: 1, url: 'https://example.com/old', pendingUrl: 'chrome://settings' }), 'chrome://settings');
assert.equal(isOperableTab({ id: 1, url: 'about:blank' }), false);
assert.equal(isOperableTab({ id: 1, url: 'file:///tmp/example.html' }), false);

assert.deepEqual(
  selectOperableActiveTab([
    { id: 1, url: 'chrome://extensions/shortcuts' },
    { id: 2, url: 'https://example.com' },
  ]),
  { id: 2, url: 'https://example.com' },
);
assert.equal(selectOperableActiveTab([{ id: 1, url: 'chrome://extensions/shortcuts' }]), undefined);
assert.equal(selectOperableActiveTab([{ id: 1, url: 'https://example.com/old', pendingUrl: 'chrome://settings' }]), undefined);
assert.equal(readRequiredWindowId(42), 42);
assert.throws(() => readRequiredWindowId(undefined), /Task windowId is required/);
assert.throws(() => readRequiredWindowId(0), /Task windowId is required/);

console.info('active tab tests passed');
