import assert from 'node:assert/strict';
import { allSitesOrigins, isPageAccessError, originPatternForUrl, pageAccessErrorMessage, userScriptsErrorMessage } from '../lib/browser-access.ts';

assert.deepEqual([...allSitesOrigins], ['http://*/*', 'https://*/*']);
assert.equal(originPatternForUrl('https://example.com/path?q=1'), 'https://example.com/*');
assert.equal(originPatternForUrl('http://localhost:3000/path'), 'http://localhost:3000/*');
assert.equal(originPatternForUrl('chrome://extensions'), undefined);
assert.equal(originPatternForUrl('not a url'), undefined);

assert.equal(isPageAccessError(new Error('Cannot access contents of url "https://example.com". Extension manifest must request permission.')), true);
assert.equal(isPageAccessError(new Error('random failure')), false);
assert.match(pageAccessErrorMessage(), /Browser Control/);
assert.match(userScriptsErrorMessage(), /Allow User Scripts/);

console.info('browser access tests passed');
