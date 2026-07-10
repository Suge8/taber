import type { AgentEvent } from './db.ts';

export const SESSION_EXPORT_MAX_STRING_CHARS = 2048;
const DATA_URL_PREVIEW_CHARS = 64;

/** One JSON line per agent event, with oversized strings truncated so the file stays reviewable. */
export function buildSessionExportJsonl(events: AgentEvent[]): string {
  return events.map((event) => JSON.stringify({ ...event, payload: truncateDeep(event.payload) })).join('\n');
}

export function sessionExportFileName(sessionId: number, now = new Date()): string {
  const date = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return `taber-session-${sessionId}-${date}.jsonl`;
}

function truncateDeep(value: unknown): unknown {
  if (typeof value === 'string') return truncateString(value);
  if (Array.isArray(value)) return value.map(truncateDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, truncateDeep(entry)]));
  }
  return value;
}

function truncateString(value: string): string {
  if (value.startsWith('data:') && value.length > DATA_URL_PREVIEW_CHARS) {
    return `${value.slice(0, DATA_URL_PREVIEW_CHARS)}…[truncated data url, ${value.length} chars total]`;
  }
  if (value.length <= SESSION_EXPORT_MAX_STRING_CHARS) return value;
  return `${value.slice(0, SESSION_EXPORT_MAX_STRING_CHARS)}…[truncated, ${value.length} chars total]`;
}
