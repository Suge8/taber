import type { AgentEvent } from './db.ts';

const TOOL_DIGEST_MAX_CHARS = 2000;
const LONG_TEXT_MAX_CHARS = 1200;
const OBSERVE_WARNING = 'Element indexes are scoped to one browserRepl call; do not reuse them later.';
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
  if (toolName === 'browser') return truncate(browserDigest(input, output), TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'browserRepl') return truncate(browserReplDigest(input, output), TOOL_DIGEST_MAX_CHARS);
  if (outputRecord?.ok === false) return truncate(recoverableResultDigest(toolName, outputRecord), TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'navigate') return truncate(navigateDigest(input, output), TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'getDocument') return truncate(`getDocument: ${fields({ title: readDeepString(output, ['title']), url: readDeepString(output, ['url']), source: readDeepString(output, ['source']) ?? input.source, mode: readDeepString(output, ['mode']) ?? input.mode, contentChars: readDeepNumber(output, ['contentChars']), truncated: readDeepValue(output, ['truncated']) === true ? true : undefined, headings: summarizeArray(readDeepValue(output, ['headings'])), tables: summarizeTables(readDeepValue(output, ['tables'])), excerpt: excerpt(readDeepString(output, ['content'])) })}`, TOOL_DIGEST_MAX_CHARS);
  if (toolName === 'extractImage') return truncate(`extractImage: ${fields({ source: readDeepString(output, ['source']) ?? input.source, selector: input.selector ?? readDeepString(output, ['selector']), url: readDeepString(output, ['url']), width: readDeepNumber(output, ['width']), height: readDeepNumber(output, ['height']), alt: readDeepString(output, ['alt']) })}`, TOOL_DIGEST_MAX_CHARS);
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

function browserDigest(input: Record<string, unknown>, output: unknown): string {
  const record = readRecord(output) ?? {};
  const state = readRecord(record.state);
  const evidence = readRecord(record.evidence);
  const element = readRecord(evidence?.element);
  return `browser: ${fields({ action: safeString(input.action) ?? safeString(record.action), ok: record.ok, code: safeString(record.code), message: safeString(record.message), target: summarizeBrowserTarget(input.target), element: safeString(element?.name) ?? safeString(element?.text) ?? safeString(element?.selector), url: safeString(state?.url) })}`;
}

function summarizeBrowserTarget(value: unknown): string | undefined {
  const target = readRecord(value);
  if (!target) return undefined;
  if (target.text) return `text=${safeString(target.text)}`;
  if (target.label) return `label=${safeString(target.label)}`;
  if (target.selector) return `selector=${safeString(target.selector)}`;
  if (target.role || target.name) return `role=${safeString(target.role)}, name=${safeString(target.name)}`;
  if (target.ref) return 'ref';
  return undefined;
}

function navigateDigest(input: Record<string, unknown>, output: unknown): string {
  const outputRecord = readRecord(output);
  if (outputRecord?.action === 'listTabs') return summarizeNavigateResult(outputRecord) ?? 'navigate: action=listTabs, tabs=0';
  return `navigate: ${fields({ action: safeString(input.action) ?? readDeepString(output, ['action']), url: readDeepString(output, ['url']) ?? input.url, title: readDeepString(output, ['title']), tabId: readDeepNumber(output, ['tabId', 'id']) })}`;
}

function browserReplDigest(input: Record<string, unknown>, output: unknown): string {
  const outputRecord = readRecord(output);
  const value = outputRecord && 'value' in outputRecord ? outputRecord.value : output;
  const consoleEntries = readDeepValue(output, ['console']);
  const consoleCount = Array.isArray(consoleEntries) && consoleEntries.length ? ` browserjsConsole=${consoleEntries.length}` : '';
  const warning = isObserve(input) || hasElementIndexes(value) ? ` ${OBSERVE_WARNING}` : '';
  return `browserRepl: ${summarizeBrowserReplValue(value) ?? safeSnippet(value)}${consoleCount}${warning}`;
}

function summarizeBrowserReplValue(value: unknown, depth = 0): string | undefined {
  return summarizeNavigateResult(value) ?? summarizeBatchResult(value) ?? summarizeFillFormResult(value) ?? summarizeObservedElements(value) ?? summarizeErrorResult(value) ?? summarizeNestedBrowserReplValue(value, depth);
}

function summarizeNestedBrowserReplValue(value: unknown, depth: number): string | undefined {
  if (depth > 2 || !value || typeof value !== 'object') return undefined;
  const entries = Array.isArray(value)
    ? value.slice(0, 5).map((item, index) => [`${index}`, item] as const)
    : Object.entries(value).slice(0, 8);
  const parts = entries.map(([key, item]) => {
    const summary = summarizeBrowserReplValue(item, depth + 1);
    return summary ? `${key}=${summary}` : undefined;
  }).filter((item) => item !== undefined);
  return parts.length ? parts.join('; ') : undefined;
}

function summarizeNavigateResult(value: unknown): string | undefined {
  const record = readRecord(value);
  if (!record || typeof record.action !== 'string' || !['open', 'back', 'forward', 'reload', 'listTabs', 'switchTab', 'closeTab', 'currentTab'].includes(record.action)) return undefined;
  if (record.action === 'listTabs') {
    const tabs = Array.isArray(record.tabs) ? record.tabs : [];
    return `navigate: ${fields({ action: record.action, tabs: tabs.length, items: summarizeNavigateTabs(tabs) })}`;
  }
  return `navigate: ${fields({ action: record.action, url: readDeepString(record, ['url']), title: readDeepString(record, ['title']), tabId: readDeepNumber(record, ['tabId', 'id']) })}`;
}

function summarizeNavigateTabs(tabs: unknown[]): string | undefined {
  if (!tabs.length) return undefined;
  return tabs.slice(0, 5).map((tab) => {
    const record = readRecord(tab) ?? {};
    return fields({ tabId: readDeepNumber(record, ['tabId', 'id']), title: safeString(record.title), url: safeString(record.url) });
  }).join(' | ');
}

function summarizeBatchResult(value: unknown): string | undefined {
  const record = readRecord(value);
  if (!record || !Array.isArray(record.steps)) return undefined;
  return `batch: ${fields({ ok: record.ok, steps: record.steps.length, detail: summarizeBatchSteps(record.steps), code: safeString(record.code), message: safeString(record.message), error: safeString(record.error) })}`;
}

function summarizeBatchSteps(steps: unknown[]): string {
  return steps.slice(0, 6).map((step, index) => {
    const record = readRecord(step) ?? {};
    return fields({ n: index + 1, action: record.action ?? record.type, selector: record.selector ?? readDeepString(record.target, ['selector']), ok: record.ok, matched: record.matched === true ? true : undefined, code: safeString(record.code), message: safeString(record.message), error: safeString(record.error) });
  }).join(' | ');
}

function summarizeFillFormResult(value: unknown): string | undefined {
  const record = readRecord(value);
  if (!record || (!Array.isArray(record.filled) && !Array.isArray(record.missing) && !Array.isArray(record.ambiguous))) return undefined;
  return `fillForm: ${fields({ ok: record.ok, filled: summarizeFields(record.filled), missing: summarizeFields(record.missing), ambiguous: summarizeFields(record.ambiguous), code: safeString(record.code), message: safeString(record.message), error: safeString(record.error) })}`;
}

function summarizeFields(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.slice(0, 6).map((item) => {
    const record = readRecord(item);
    return safeString(record?.field) ?? safeString(record?.label) ?? safeString(item);
  }).filter((name) => name !== undefined);
  return `${value.length}${names.length ? ` (${names.join(' | ')})` : ''}`;
}

function summarizeObservedElements(value: unknown): string | undefined {
  const record = readRecord(value);
  if (!record || !Array.isArray(record.elements)) return undefined;
  const names = record.elements.slice(0, 6).map((item) => {
    const element = readRecord(item);
    return safeString(element?.name) ?? safeString(element?.text) ?? safeString(element?.role);
  }).filter((name) => name !== undefined);
  return `elements: ${fields({ count: record.elements.length, names: names.length ? names.join(' | ') : undefined })}`;
}

function summarizeErrorResult(value: unknown): string | undefined {
  const record = readRecord(value);
  if (!record || (record.code === undefined && record.message === undefined && record.error === undefined)) return undefined;
  return `error: ${fields({ code: safeString(record.code), message: safeString(record.message), error: safeString(record.error) })}`;
}

function hasElementIndexes(value: unknown, depth = 0): boolean {
  if (depth > 3 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasElementIndexes(item, depth + 1));
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.elements) && record.elements.some((item) => Number.isInteger(readRecord(item)?.index))) return true;
  return Object.values(record).some((item) => hasElementIndexes(item, depth + 1));
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
