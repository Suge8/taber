import assert from 'node:assert/strict';
import { isOperableTab, selectOperableActiveTab } from '../lib/active-tab.ts';

assert.equal(isOperableTab({ url: 'https://example.com' }), true);
assert.equal(isOperableTab({ url: 'chrome://extensions/shortcuts' }), false);
assert.equal(isOperableTab({ url: 'chrome-extension://abc/sidepanel.html' }), false);
assert.equal(isOperableTab({ pendingUrl: 'edge://settings' }), false);
assert.equal(isOperableTab({ url: 'about:blank' }), false);

assert.deepEqual(
  selectOperableActiveTab([
    { id: 1, url: 'chrome://extensions/shortcuts' },
    { id: 2, url: 'https://example.com' },
  ]),
  { id: 2, url: 'https://example.com' },
);
assert.equal(selectOperableActiveTab([{ id: 1, url: 'chrome://extensions/shortcuts' }]), undefined);

console.info('active tab tests passed');
