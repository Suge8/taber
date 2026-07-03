import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_LIMIT,
  UNLIMITED_SESSION_RETENTION,
  selectPrunableSessionIds,
  type Session,
} from '../lib/db.ts';

await testDefaultLimitKeepsLatestThirty();
await testPinnedSessionsAreNeverPruned();
await testUnlimitedRetentionKeepsEverything();

console.info('database retention tests passed');

async function testDefaultLimitKeepsLatestThirty() {
  const sessions = createSessions(35);
  const prunedIds = selectPrunableSessionIds(sessions, DEFAULT_SESSION_LIMIT).sort((left, right) => left - right);
  assert.deepEqual(prunedIds, [1, 2, 3, 4, 5]);
}

async function testPinnedSessionsAreNeverPruned() {
  const sessions = createSessions(35);
  sessions[0].pinned = true;

  const prunedIds = selectPrunableSessionIds(sessions, DEFAULT_SESSION_LIMIT).sort((left, right) => left - right);
  assert.deepEqual(prunedIds, [2, 3, 4, 5]);
}

async function testUnlimitedRetentionKeepsEverything() {
  assert.deepEqual(selectPrunableSessionIds(createSessions(35), UNLIMITED_SESSION_RETENTION), []);
}

function createSessions(count: number): Session[] {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return {
      id,
      title: `Session ${id}`,
      pinned: false,
      createdAt: id,
      updatedAt: id,
    };
  });
}
