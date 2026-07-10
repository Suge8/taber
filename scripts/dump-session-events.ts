// Dump Taber session event logs from a CDP-reachable browser into .tmp/*.jsonl.
//
//   node --experimental-strip-types scripts/dump-session-events.ts            # list sessions
//   node --experimental-strip-types scripts/dump-session-events.ts <sessionId>
//
// The browser must run with a debugging port and have Taber loaded, e.g. the
// runtime smoke browser (TABER_CDP_ORIGIN=http://127.0.0.1:9258) or a
// browser-dev instance (http://127.0.0.1:9333). See docs/debugging.md.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connectTarget, evaluate, hasCdpEndpoint, readTargets, type CdpClient } from './cdp-client.mjs';
import type { AgentEvent } from '../lib/db.ts';
import { buildSessionExportJsonl, sessionExportFileName } from '../lib/session-export.ts';

const DEFAULT_ORIGINS = ['http://127.0.0.1:9258', 'http://127.0.0.1:9333'];

const sessionId = process.argv[2] ? Number.parseInt(process.argv[2], 10) : undefined;
if (process.argv[2] && (!Number.isInteger(sessionId) || Number(sessionId) <= 0)) {
  console.error(`Invalid session id: ${process.argv[2]}`);
  process.exit(1);
}

const cdp = await connectTaberTarget();
try {
  if (sessionId === undefined) await listSessions(cdp);
  else await dumpSession(cdp, sessionId);
} finally {
  cdp.close();
}

async function connectTaberTarget(): Promise<CdpClient> {
  const origins = process.env.TABER_CDP_ORIGIN ? [process.env.TABER_CDP_ORIGIN] : DEFAULT_ORIGINS;
  for (const origin of origins) {
    const targets = await readTargets(origin).catch(() => []);
    for (const target of targets) {
      if (!String(target.url).startsWith('chrome-extension://') || !hasCdpEndpoint(target)) continue;
      const candidate = await connectTarget(target).catch(() => undefined);
      if (!candidate) continue;
      await candidate.send('Runtime.enable').catch(() => undefined);
      const name = await evaluate(candidate, `chrome?.runtime?.getManifest?.().name`).catch(() => undefined);
      if (name === 'Taber') {
        console.info(`Attached to Taber at ${origin} (${target.type}: ${target.url})`);
        return candidate;
      }
      candidate.close();
    }
  }
  console.error(`No Taber extension target reachable via CDP (tried: ${origins.join(', ')}).`);
  console.error('Start one with: pnpm build:chrome && TABER_HEADED=1 pnpm run test:ci:runtime, or load .output/chrome-mv3 into a browser running with --remote-debugging-port.');
  process.exit(1);
}

async function listSessions(client: CdpClient) {
  const sessions = JSON.parse(await evaluate(client, dumpStoreExpression('sessions'))) as { id: number; title: string; updatedAt: number }[];
  if (sessions.length === 0) {
    console.info('No sessions found.');
    return;
  }
  for (const session of sessions.sort((left, right) => right.updatedAt - left.updatedAt)) {
    console.info(`${session.id}\t${new Date(session.updatedAt).toISOString()}\t${session.title}`);
  }
  console.info('\nDump one with: node --experimental-strip-types scripts/dump-session-events.ts <sessionId>');
}

async function dumpSession(client: CdpClient, id: number) {
  const events = JSON.parse(await evaluate(client, dumpStoreExpression('agentEvents', id))) as AgentEvent[];
  if (events.length === 0) {
    console.error(`Session ${id} has no events.`);
    process.exit(1);
  }
  const outPath = path.join('.tmp', sessionExportFileName(id));
  await mkdir('.tmp', { recursive: true });
  await writeFile(outPath, buildSessionExportJsonl(events.sort((left, right) => left.id - right.id)));
  console.info(`Wrote ${events.length} events to ${outPath}`);
}

function dumpStoreExpression(storeName: 'sessions' | 'agentEvents', bySessionId?: number) {
  const read = bySessionId === undefined ? 'store.getAll()' : `store.index('sessionId').getAll(${bySessionId})`;
  return `new Promise((resolve, reject) => {
    const open = indexedDB.open('taber');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      let request;
      try {
        const store = db.transaction('${storeName}').objectStore('${storeName}');
        request = ${read};
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      request.onerror = () => { db.close(); reject(request.error); };
      request.onsuccess = () => { db.close(); resolve(JSON.stringify(request.result)); };
    };
  })`;
}
