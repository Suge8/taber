import assert from 'node:assert/strict';
import type { AgentEvent } from '../lib/db.ts';
import { buildSessionExportJsonl, SESSION_EXPORT_MAX_STRING_CHARS, sessionExportFileName } from '../lib/session-export.ts';

testEachEventBecomesOneJsonLine();
testOversizedStringsAreTruncated();
testDataUrlsAreTruncatedToPreview();
testFileName();

console.info('session export tests passed');

function testEachEventBecomesOneJsonLine() {
  const jsonl = buildSessionExportJsonl([
    event(1, 'task.started', { taskId: 't1', prompt: 'hello' }),
    event(2, 'tool.failed', { toolCallId: 'call-1', toolName: 'extractImage', error: 'source must be viewport' }),
  ]);
  const lines = jsonl.split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).payload, { taskId: 't1', prompt: 'hello' });
  assert.equal(JSON.parse(lines[1]).payload.error, 'source must be viewport');
}

function testOversizedStringsAreTruncated() {
  const long = 'x'.repeat(SESSION_EXPORT_MAX_STRING_CHARS + 100);
  const jsonl = buildSessionExportJsonl([event(1, 'tool.completed', { output: { nested: [long] } })]);
  const exported = JSON.parse(jsonl).payload.output.nested[0] as string;
  assert.ok(exported.startsWith('x'.repeat(100)));
  assert.ok(exported.endsWith(`[truncated, ${long.length} chars total]`));
  assert.ok(exported.length < long.length);
}

function testDataUrlsAreTruncatedToPreview() {
  const dataUrl = `data:image/png;base64,${'A'.repeat(10_000)}`;
  const jsonl = buildSessionExportJsonl([event(1, 'tool.completed', { output: { dataUrl } })]);
  const exported = JSON.parse(jsonl).payload.output.dataUrl as string;
  assert.ok(exported.startsWith('data:image/png;base64,'));
  assert.ok(exported.includes(`[truncated data url, ${dataUrl.length} chars total]`));
  assert.ok(exported.length < 200);
}

function testFileName() {
  assert.match(sessionExportFileName(7, new Date('2026-07-09T10:20:30Z')), /^taber-session-7-2026-07-09T10-20-30\.jsonl$/);
}

function event(id: number, type: string, payload: unknown): AgentEvent {
  return { id, sessionId: 1, type, payload, createdAt: id };
}
