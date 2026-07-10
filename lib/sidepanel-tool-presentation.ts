import { domainFromUrl, formatRawEvidence } from './agent-event-text.ts';
import type { Locale, SidepanelMessages } from './sidepanel-i18n.ts';
import type { ToolTimelineItem } from './sidepanel-view.ts';

type RecoverableOutput = Record<string, unknown> & { ok: false };
type ToolPresentationItem = Pick<ToolTimelineItem, 'toolName' | 'status' | 'input' | 'output' | 'error' | 'durationMs'>;

export function toolHeaderSummary(tool: ToolPresentationItem, labels: SidepanelMessages, locale: Locale) {
  if (tool.status === 'failed') return labels.tool.summary.failed(toolErrorSummary(tool, labels));
  const input = readRecord(tool.input);
  const output = readRecord(tool.output);
  if (isRecoverableOutput(output)) return labels.tool.summary.failed(recoverableErrorSummary(tool, output, labels));
  if (tool.toolName === 'navigate') return navigateSummary(input, output, labels, locale);
  if (tool.toolName === 'getDocument') return labels.tool.summary.read(sourceTarget(input, output, 'currentPage', labels, locale), contentSize(output, labels));
  if (tool.toolName === 'extractImage') return imageSummary(input, output, labels, locale);
  if (tool.toolName === 'browser') return labels.tool.summary.generic(`${actionLabel(tool, labels)} ${browserTarget(input, output)}`.trim());
  if (tool.toolName === 'debugger') return debugSummary(output, labels);
  if (tool.toolName === 'browserRepl') return labels.tool.actions.browserRepl;
  if (tool.toolName === 'fs') return fsSummary(input, output, labels);
  return labels.tool.summary.generic(actionLabel(tool, labels));
}

export function rawToolDetails(tool: ToolPresentationItem) {
  const details: Record<string, unknown> = { input: tool.input };
  if (tool.output !== undefined) details.output = tool.output;
  if (tool.error) details.error = tool.error;
  if (tool.durationMs !== undefined) details.durationMs = tool.durationMs;
  return formatRawEvidence(details);
}

function actionKey(tool: ToolPresentationItem) {
  const input = readRecord(tool.input);
  const output = readRecord(tool.output);
  if (tool.toolName === 'navigate') return readString(input?.action) || readString(output?.action) || 'open';
  if (tool.toolName === 'getDocument') return readString(input?.source) || readString(output?.source) || 'currentPage';
  if (tool.toolName === 'extractImage') return readString(input?.source) || readString(output?.source) || 'viewport';
  if (tool.toolName === 'browser') return readString(input?.action) || readString(output?.action) || 'browser';
  if (tool.toolName === 'debugger') return 'debugger';
  if (tool.toolName === 'browserRepl') return 'browserRepl';
  if (tool.toolName === 'fs') return 'fs';
  return 'tool';
}

function actionLabel(tool: ToolPresentationItem, labels: SidepanelMessages) {
  const key = actionKey(tool);
  return labels.tool.actions[key as keyof typeof labels.tool.actions] ?? labels.tool.actions.tool;
}

function navigateSummary(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, labels: SidepanelMessages, locale: Locale) {
  const action = readString(output?.action) || readString(input?.action) || 'open';
  const target = navigateTarget(input, output, locale);
  if (action === 'back') return labels.tool.summary.back(target);
  if (action === 'forward') return labels.tool.summary.forward(target);
  if (action === 'reload') return labels.tool.summary.reload(target);
  if (action === 'listTabs') {
    const tabs = Array.isArray(output?.tabs) ? output.tabs : undefined;
    return tabs ? labels.tool.summary.listTabs(tabs.length) : labels.tool.actions.listTabs;
  }
  if (action === 'switchTab') return labels.tool.summary.switchTab(navigateTabTarget(input, output, labels, locale));
  if (action === 'closeTab') return labels.tool.summary.closeTab(navigateTabTarget(input, output, labels, locale));
  if (action === 'currentTab') return labels.tool.summary.currentTab(target);
  return labels.tool.summary.open(target);
}

function navigateTarget(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, locale: Locale) {
  return shortTarget(navigateUrl(input, output), locale);
}

function navigateTabTarget(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, labels: SidepanelMessages, locale: Locale) {
  const url = navigateUrl(input, output);
  if (url) return shortTarget(url, locale);
  const tab = readRecord(output?.tab);
  const tabId = readNumber(output?.tabId) ?? readNumber(tab?.id) ?? readNumber(input?.tabId);
  return tabId ? labels.sources.tabNumber(tabId) : shortTarget(undefined, locale);
}

function navigateUrl(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined) {
  const tab = readRecord(output?.tab);
  const navigation = readRecord(output?.navigation);
  return readString(tab?.url) || readString(navigation?.url) || readString(output?.url) || readString(input?.url);
}

function sourceTarget(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, fallbackSource: string, labels: SidepanelMessages, locale: Locale) {
  const url = readString(output?.url) || readString(input?.url);
  if (url) return shortTarget(url, locale);
  return sourceLabel(readString(output?.source) || readString(input?.source) || fallbackSource, labels);
}

function sourceLabel(source: string, labels: SidepanelMessages) {
  return labels.tool.actions[source as keyof typeof labels.tool.actions] ?? source;
}

function imageSummary(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, labels: SidepanelMessages, locale: Locale) {
  const source = readString(output?.source) || readString(input?.source) || 'viewport';
  const target = source === 'viewport' ? '' : sourceTarget(input, output, 'viewport', labels, locale);
  const size = imageSize(output);
  if (target) return labels.tool.summary.image(target, size);
  return [labels.tool.actions.viewport, size].filter(Boolean).join(' · ');
}

function fsSummary(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, labels: SidepanelMessages) {
  const path = readString(output?.path) || readString(input?.path);
  // Skill reads/writes are a distinct concept for users ("using site know-how"),
  // not generic file access; label them accordingly.
  const action = path?.startsWith('/skills/') ? labels.tool.actions.skill : labels.tool.actions.fs;
  const target = path ? truncate(path.replace(/^\/(workspace|skills)\//, '').replace(/\.md$/, ''), 28) : readString(input?.action) || '';
  return target ? `${action} · ${target}` : action;
}

function debugSummary(output: Record<string, unknown> | undefined, labels: SidepanelMessages) {
  const result = debugResult(output, labels);
  return result ? `${labels.tool.actions.debugger} · ${result}` : labels.tool.actions.debugger;
}

function browserTarget(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined) {
  const target = readRecord(input?.target);
  const evidence = readRecord(output?.evidence);
  const element = readRecord(evidence?.element);
  if (target?.text) return `“${truncate(String(target.text), 24)}”`;
  if (target?.label) return `“${truncate(String(target.label), 24)}”`;
  if (target?.role || target?.name) return [target.role, target.name].filter(Boolean).join(' ');
  if (target?.selector) return truncate(String(target.selector), 24);
  return readString(element?.name) || readString(element?.text) || '';
}

function contentSize(output: Record<string, unknown> | undefined, labels: SidepanelMessages) {
  const content = readString(output?.content) || readString(output?.text) || readString(output?.markdown) || readString(output?.article);
  if (!content) return '';
  return labels.tool.words(compactNumber(content.length));
}

function imageSize(output: Record<string, unknown> | undefined) {
  if (!output) return '';
  const width = typeof output.width === 'number' ? output.width : undefined;
  const height = typeof output.height === 'number' ? output.height : undefined;
  return width && height ? `${width}×${height}` : '';
}

function debugResult(output: Record<string, unknown> | undefined, labels: SidepanelMessages) {
  const logs = Array.isArray(output?.logs) ? output.logs.length : 0;
  const requests = Array.isArray(output?.requests) ? output.requests.length : 0;
  const count = logs || requests;
  return count ? labels.tool.errorCount(count) : '';
}

function toolErrorSummary(tool: ToolPresentationItem, labels: SidepanelMessages) {
  const recoverable = readRecord(tool.output);
  if (isRecoverableOutput(recoverable)) return recoverableErrorSummary(tool, recoverable, labels);

  const error = tool.error ?? '';
  if (/timeout|timed out/i.test(error)) return labels.tool.errors.timeout;
  if (/Element not found|Unknown element|selector/i.test(error)) return labels.tool.errors.elementNotFound;
  if (/Navigation failed/i.test(error)) return labels.tool.errors.navigationFailed;
  if (/no readable text|returned no text/i.test(error)) return labels.tool.errors.noReadableText;
  if (/permission|access|denied/i.test(error)) return labels.tool.errors.accessLimited;
  if (tool.toolName === 'getDocument') return labels.tool.errors.readFailed;
  if (tool.toolName === 'navigate') return labels.tool.errors.navigateFailed;
  if (tool.toolName === 'extractImage') return labels.tool.errors.imageFailed;
  if (tool.toolName === 'browserRepl') return labels.tool.errors.inspectFailed;
  if (tool.toolName === 'debugger') return labels.tool.errors.debugFailed;
  return labels.tool.errors.genericFailed;
}

function recoverableErrorSummary(tool: ToolPresentationItem, output: Record<string, unknown>, labels: SidepanelMessages) {
  const code = readString(output.code);
  return code ? recoverableErrorLabel(code, labels) || toolDefaultError(tool.toolName, labels) : toolDefaultError(tool.toolName, labels);
}

function recoverableErrorLabel(code: string, labels: SidepanelMessages) {
  if (code === 'NO_SELECTION') return labels.tool.errors.noSelection;
  if (code === 'NO_READABLE_CONTENT') return labels.tool.errors.noReadableText;
  if (code === 'REMOTE_FETCH_FAILED') return labels.tool.errors.remoteFetchFailed;
  if (code === 'ELEMENT_NOT_FOUND') return labels.tool.errors.elementNotFound;
  if (code === 'INVALID_SELECTOR') return labels.tool.errors.invalidSelector;
  if (code === 'SCREENSHOT_UNAVAILABLE') return labels.tool.errors.screenshotUnavailable;
  if (code === 'PAGE_ACCESS_REQUIRED') return labels.tool.errors.pageAccessRequired;
  if (code === 'NO_TARGET') return labels.tool.errors.targetNotFound;
  if (code === 'AMBIGUOUS_TARGET') return labels.tool.errors.ambiguousTarget;
  if (code === 'STALE_REF' || code === 'ELEMENT_CHANGED') return labels.tool.errors.pageChanged;
  if (code === 'FRAME_NOT_ACCESSIBLE') return labels.tool.errors.accessLimited;
  if (code === 'INVALID_TARGET') return labels.tool.errors.invalidTarget;
  if (code === 'DISABLED') return labels.tool.errors.targetDisabled;
  if (code === 'NOT_FILLABLE') return labels.tool.errors.targetNotFillable;
  if (code === 'ACTION_FAILED') return labels.tool.errors.actionFailed;
  return undefined;
}

function toolDefaultError(toolName: string, labels: SidepanelMessages) {
  if (toolName === 'getDocument') return labels.tool.errors.readFailed;
  if (toolName === 'navigate') return labels.tool.errors.navigateFailed;
  if (toolName === 'extractImage') return labels.tool.errors.imageFailed;
  if (toolName === 'browser' || toolName === 'browserRepl') return labels.tool.errors.inspectFailed;
  if (toolName === 'debugger') return labels.tool.errors.debugFailed;
  return labels.tool.errors.genericFailed;
}

function shortTarget(url: string | undefined, locale: Locale) {
  if (!url) return locale === 'zh' ? '当前页' : 'page';
  return domainFromUrl(url) || truncate(url, 24);
}

function compactNumber(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecoverableOutput(output: Record<string, unknown> | undefined): output is RecoverableOutput {
  return output?.ok === false;
}
