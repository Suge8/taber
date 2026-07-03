import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { createSession, database, initializeDatabase, listSessions } = await import('../lib/db.ts');

await initializeDatabase();
await database.transaction('rw', database.sessions, async () => database.sessions.clear());

await createSession({ title: 'Older', pinned: false, now: 1000 });
await createSession({ title: 'Pinned', pinned: true, now: 2000 });
await createSession({ title: 'Newest', pinned: false, now: 3000 });

const sessions = await listSessions();
assert.deepEqual(sessions.map((session) => session.title), ['Newest', 'Pinned', 'Older']);
assert.deepEqual(Object.keys(sessions[0]!).sort(), ['createdAt', 'id', 'pinned', 'title', 'updatedAt']);
assert.equal(sessions[1]!.pinned, true);
assert.equal(sessions[2]!.updatedAt, 1000);

database.close();
console.info('session list tests passed');
