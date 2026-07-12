import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';
import { database, initializeDatabase } from '../lib/db.ts';
import {
  foregroundModeSettingKey,
  parseForegroundMode,
  readForegroundMode,
  setForegroundMode,
} from '../lib/foreground-mode.ts';

await initializeDatabase();
await database.settings.delete(foregroundModeSettingKey);

assert.equal(await readForegroundMode(), false, 'missing setting must default to background mode');
assert.equal(parseForegroundMode(true), true);
assert.equal(parseForegroundMode(false), false);
assert.throws(() => parseForegroundMode(undefined), /foregroundMode must be a boolean/);
assert.throws(() => parseForegroundMode('true'), /foregroundMode must be a boolean/);

await setForegroundMode(true);
assert.equal(await readForegroundMode(), true);
assert.deepEqual(await database.settings.get(foregroundModeSettingKey), { key: foregroundModeSettingKey, value: true });
await setForegroundMode(false);
assert.equal(await readForegroundMode(), false);

await database.settings.put({ key: foregroundModeSettingKey, value: 1 });
await assert.rejects(readForegroundMode(), /foregroundMode must be a boolean/);
assert.equal(database.verno, 4, 'foreground mode must not add a database version');

const backgroundSource = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
assert.doesNotMatch(backgroundSource, /focusTabWindow|focused:\s*true/, 'Agent tab activation must not focus a Chrome window');

database.close();
console.info('foreground mode tests passed');
