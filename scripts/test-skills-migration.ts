// Upgrade regression: a v3 database may contain skills whose names collide on
// the /skills/<slug>.md path (written before slug uniqueness was enforced).
// Opening the v4 database must repair them: unique paths, no data loss.
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

// Build a legacy v3 database with colliding slugs, exactly as old code could write them.
const legacy = new Dexie('taber');
legacy.version(3).stores({
  providers: '++id, kind, name',
  providerCredentials: '&providerId, kind',
  models: '++id, providerId, name',
  sessions: '++id, updatedAt, pinned',
  toolRuns: '++id, sessionId, createdAt, toolName',
  agentEvents: '++id, sessionId, createdAt, type',
  settings: '&key',
  skills: '++id, updatedAt, *hosts',
  files: '++id, sessionId, &[sessionId+name]',
});
await legacy.open();
await legacy.table('skills').bulkAdd([
  { name: 'A B', hosts: ['example.com'], description: 'older', content: 'older body', source: 'user', enabled: true, createdAt: 1, updatedAt: 1 },
  { name: 'A-B', hosts: ['example.com'], description: 'newer', content: 'newer body', source: 'agent', enabled: true, createdAt: 2, updatedAt: 2 },
]);
legacy.close();

// Opening the current database triggers the v4 repair migration.
const { initializeDatabase } = await import('../lib/db.ts');
const { listSkills, skillFileName } = await import('../lib/skills.ts');
const { createFsController } = await import('../lib/fs-tool.ts');
await initializeDatabase();

const skills = await listSkills();
assert.equal(skills.length, 2, 'no skill may be dropped by the repair');
const paths = skills.map((skill) => `/skills/${skillFileName(skill)}`);
assert.equal(new Set(paths).size, paths.length, `paths must be unique, got: ${paths.join(', ')}`);

// Newest keeps its name; the older one is renamed with a suffix.
const newer = skills.find((skill) => skill.description === 'newer')!;
const older = skills.find((skill) => skill.description === 'older')!;
assert.equal(newer.name, 'A-B');
assert.equal(older.name, 'A B 2');

// Both are stably addressable through fs.
const fs = createFsController({ sessionId: 1 });
const listing = await fs.run({ action: 'ls' });
assert.deepEqual(
  listing.action === 'ls' ? listing.skills.map((entry) => entry.path).sort() : [],
  ['/skills/a-b-2.md', '/skills/a-b.md'],
);
const readNewer = await fs.run({ action: 'read', path: '/skills/a-b.md' });
assert.match(readNewer.action === 'read' && 'content' in readNewer ? readNewer.content : '', /newer body/);
const readOlder = await fs.run({ action: 'read', path: '/skills/a-b-2.md' });
assert.match(readOlder.action === 'read' && 'content' in readOlder ? readOlder.content : '', /older body/);

console.log('test-skills-migration passed');
