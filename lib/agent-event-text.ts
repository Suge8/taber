import type { AgentEvent } from './db.ts';

const TOOL_DIGEST_MAX_CHARS = 2000;
const LONG_TEXT_MAX_CHARS = 1200;
const OBSERVE_WARNING = 'Element indexes/stable IDs are historical; re-observe or query the current page before interacting.';
const reasoningLabelPattern = '(?:cot|thoughts?|chain[-_\\s]*of[-_\\s]*thought|raw[-_\\s]*reasoning|reasoning|thinking)';
const hiddenKeyPattern = new RegExp(`(?:^|[-_\\s])${reasoningLabelPattern}(?:$|[-_\\s])`, 'i');
const summaryKeyPattern = /summary/i;

export function projectToolEvidence(event: AgentEvent): string | undefined {
  const payload = readRecord(event.payload) ?? {};
  const toolName = readString(payload.toolName) ?? 'tool';
  if (event.type === 'tool.failed') return truncate(`${toolName} failed: ${hideReasoningText(readString(payload.error) ?? 'Tool failed.')}`, TOOL_DIGEST_MAX_CHARS);
  if (event.type !== 'tool.completed') return undefined;
  const input = readRecord(payload.input) ?? {};
  const outputRecord = readRecord(payload.output);
  const output = outputRecord ?? payload.output;
  if (outputRecord?.ok === false) return truncate(recoverableResultDigest(toolName, outputRecord), TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'navigate') return truncate(`navigate: ${fields({ action: input.action, url: readDeepString(output, ['url']) ?? input.url, title: readDeepString(output, ['title']), tabId: readDeepNumber(output, ['tabId', 'id']) })}`, TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'getDocument') return truncate(`getDocument: ${fields({ title: readDeepString(output, ['title']), url: readDeepString(output, ['url']), source: readDeepString(output, ['source']) ?? input.source, mode: readDeepString(output, ['mode']) ?? input.mode, contentChars: readDeepNumber(output, ['contentChars']), truncated: readDeepValue(output, ['truncated']) === true ? true : undefined, headings: summarizeArray(readDeepValue(output, ['headings'])), tables: summarizeTables(readDeepValue(output, ['tables'])), excerpt: excerpt(readDeepString(output, ['content'])) })}`, TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'extractImage') return truncate(`extractImage: ${fields({ source: readDeepString(output, ['source']) ?? input.source, selector: input.selector ?? readDeepString(output, ['selector']), url: readDeepString(output, ['url']), width: readDeepNumber(output, ['width']), height: readDeepNumber(output, ['height']), alt: readDeepString(output, ['alt']) })}`, TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'browserRepl') return truncate(`browserRepl.${readString(input.helper) ?? 'run'}: ${safeSnippet(output)}${isObserve(input) ? ` ${OBSERVE_WARNING}` : ''}`, TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'debugger') return truncate(`debugger: ${safeSnippet(output)}`, TOOL_DIGEST_MAX_CHARS);
  return truncate(`${toolName}: ${safeSnippet(output)}`, TOOL_DIGEST_MAX_CHARS);
}

export function formatPayload(value: unknown, maxLength = 900): string {
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? hideReasoningText(value) : JSON.stringify(sanitize(value), null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function formatRawEvidence(value: unknown): string {
  if (value === undefined) return '—';
  return typeof value === 'string' ? hideReasoningText(value) : JSON.stringify(sanitizeRaw(value), null, 2);
}

export function domainFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function hideReasoningText(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '[reasoning hidden]')
    .replace(/<think\b[^>]*>[\s\S]*$/gi, '[reasoning hidden]')
    .replace(new RegExp(`(?:\`\`\`|~~~)[ \\t]*${reasoningLabelPattern}\\b[^\\n\\r]*(?:\\r?\\n)?[\\s\\S]*?(?:\`\`\`|~~~)[ \\t]*(?=\\r?\\n|$)`, 'gi'), '[reasoning hidden]')
    .replace(new RegExp(`(?:\`\`\`|~~~)[ \\t]*${reasoningLabelPattern}\\b[^\\n\\r]*(?:\\r?\\n)?[\\s\\S]*$`, 'gi'), '[reasoning hidden]');
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return hideReasoningText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => sanitize(item, depth + 1, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 12)) output[key] = hiddenKeyPattern.test(key) && !summaryKeyPattern.test(key) ? '[hidden]' : sanitize(item, depth + 1, seen);
  return output;
}

function sanitizeRaw(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return hideReasoningText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeRaw(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = hiddenKeyPattern.test(key) && !summaryKeyPattern.test(key) ? '[hidden]' : sanitizeRaw(item, seen);
  return output;
}

function fields(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== '' && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ') || '(none)';
}

function recoverableResultDigest(toolName: string, output: Record<string, unknown>): string {
  return `${toolName}: ${fields({ ok: false, code: safeString(output.code), message: safeString(output.message), retryHint: safeString(output.retryHint) })}`;
}

function safeSnippet(value: unknown): string {
  return truncate(JSON.stringify(stripUnsafe(value)) ?? String(value), LONG_TEXT_MAX_CHARS);
}

function stripUnsafe(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return looksLikeBase64(value) ? '[base64 omitted]' : truncate(hideReasoningText(value), LONG_TEXT_MAX_CHARS);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 8).map((item) => stripUnsafe(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (/dataUrl|base64/i.test(key)) continue;
    output[key] = hiddenKeyPattern.test(key) && !summaryKeyPattern.test(key) ? '[hidden]' : stripUnsafe(item, depth + 1);
  }
  return output;
}

function excerpt(value: string | undefined): string | undefined {
  return value ? truncate(hideReasoningText(value.replace(/\s+/g, ' ').trim()), LONG_TEXT_MAX_CHARS) : undefined;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' ? hideReasoningText(value) : undefined;
}

function summarizeArray(value: unknown): string | undefined {
  return Array.isArray(value) ? value.slice(0, 6).map((item) => typeof item === 'string' ? hideReasoningText(item) : JSON.stringify(stripUnsafe(item))).join(' | ') : undefined;
}

function summarizeTables(value: unknown): string | undefined {
  return Array.isArray(value) ? `${value.length} table(s)` : undefined;
}

function isObserve(input: Record<string, unknown>): boolean {
  const helper = readString(input.helper);
  return helper === 'observe' || helper === 'query';
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function looksLikeBase64(value: string): boolean {
  return value.startsWith('data:') || (value.length > 256 && /^[A-Za-z0-9+/=\r\n]+$/.test(value));
}

function readDeepString(value: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = readDeepValue(value, [key]);
    if (typeof found === 'string') return hideReasoningText(found);
  }
  return undefined;
}

function readDeepNumber(value: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const found = readDeepValue(value, [key]);
    if (Number.isFinite(found)) return Number(found);
  }
  return undefined;
}

function readDeepValue(value: unknown, keys: string[]): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) return record[key];
  for (const item of Object.values(record)) {
    const found = readDeepValue(item, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
