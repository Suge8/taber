export const browserReplRequestType = 'taber.browserRepl.request';
export const DEFAULT_BROWSER_REPL_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_REPL_TIMEOUT_MS = 120_000;

export type BrowserReplInput = {
  code: string;
  tabId?: number;
  timeoutMs?: number;
};

export type BrowserJsConsoleEntry = { level: 'log' | 'info' | 'warn' | 'error'; text: string };
export type BrowserReplResult = { value: unknown; browserjs?: { console: BrowserJsConsoleEntry[] } };

export type BrowserReplElementRef = {
  stableId: string;
  selector: string;
  tagName: string;
  name: string;
  shadowPath?: string[];
  fingerprint?: string;
  fingerprintCount?: number;
  marker?: string;
};

export const browserReplPageHelperNames = [
  'readVisibleText',
  'readLinksAndButtons',
  'listInteractiveElements',
  'queryText',
  'observe',
  'query',
  'click',
  'fill',
  'press',
  'scroll',
  'waitFor',
  'batch',
  'fillForm',
  'pickElement',
  'pickUserElement',
  'controlOverlay',
] as const;

type BrowserReplAdvancedPageHelperName = 'browserjs';
export type BrowserReplPageHelperName = typeof browserReplPageHelperNames[number] | BrowserReplAdvancedPageHelperName;

type BrowserStructuredPageHelperName = 'browser';

export type BrowserReplPageCommand = {
  helper: BrowserReplPageHelperName | BrowserStructuredPageHelperName;
  args: unknown[];
  cancelKey?: string;
  timeoutMs?: number;
  frameId?: number;
};

export type BrowserReplHelper = (...args: unknown[]) => Promise<unknown>;
export type BrowserReplFallback = 'browserjsCdp' | 'pressCdp' | 'scripting';

export type BrowserReplSandboxRun = {
  code: string;
  helpers: Record<string, BrowserReplHelper>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
};

export const browserReplInputJsonSchema = createBrowserReplInputJsonSchema({ browserJsEnabled: true });

export function browserReplToolHelperNames(_browserJsEnabled: boolean) {
  const fixedHelpers = ['readVisibleText', 'readLinksAndButtons', 'listInteractiveElements', 'queryText', 'observe', 'query', 'click', 'fill', 'press', 'scroll', 'waitFor', 'batch', 'fillForm', 'navigate'];
  return [...fixedHelpers, 'sandbox', 'pickElement', 'pickUserElement'];
}

export function createBrowserReplInputJsonSchema(_options: { browserJsEnabled?: boolean } = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: {
      code: { type: 'string', description: 'JavaScript REPL code for the controlled target tab. Use the structured browser tool first for text/role/label/ref click, fill, press, and snapshot; use browserRepl only as an advanced fallback. Page-reading fallback helpers: readVisibleText(), readLinksAndButtons(), listInteractiveElements(), or queryText("text") report open shadow roots and frames[]; same-origin frames are readable summaries, cross-origin frames are metadata only. Prefer one observe()/query(native CSS) snapshot only when action indexes are needed, one batch/fillForm action, and one verification. waitFor("text") is shorthand for waitFor({ text: "text" }); obvious CSS like "body", "#id", or ".class" is shorthand for { selector }. observe("text") is invalid and does not search text. Native CSS does not support Playwright selectors like :has-text(); use browser text/role locators first, queryText("text"), waitFor({ text }) for waits, or observe/query then a same-call index for actions. click/fill/press indexes are valid only after observe/query in the same browserRepl call; prefer selectors for durable actions. For forms, use fillForm dryRun/execution, inspect missing/ambiguous, then pickElement/pickUserElement if needed. Use navigate(input) instead of direct location/history/window.open navigation. Return concise serializable evidence only; no DOM/functions/Window/Event/cycles/dataUrl.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_BROWSER_REPL_TIMEOUT_MS },
    },
  } as const;
}

export function parseBrowserReplInput(value: unknown): BrowserReplInput {
  if (!isRecord(value)) throw new Error('browserRepl input must be an object');
  const code = readString(value.code, 'code');
  if (code.trim() === '') throw new Error('browserRepl.code is required');

  const input: BrowserReplInput = { code };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  if ('timeoutMs' in value) input.timeoutMs = readPositiveInteger(value.timeoutMs, 'timeoutMs');
  if (input.timeoutMs && input.timeoutMs > MAX_BROWSER_REPL_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be <= ${MAX_BROWSER_REPL_TIMEOUT_MS}`);
  }
  return input;
}

export function browserReplFallbackFor(command: BrowserReplPageCommand): BrowserReplFallback {
  if (command.helper === 'browserjs') return 'browserjsCdp';
  if (command.helper === 'press') return 'pressCdp';
  return 'scripting';
}

export function rememberBrowserReplElementRefs(value: unknown, refs: Map<number, BrowserReplElementRef>, allocateIndex: () => number) {
  if (!isRecord(value) || !Array.isArray(value.elements)) return value;
  return {
    ...value,
    elements: value.elements.map((element) => {
      if (!isRecord(element)) return element;
      const { ref: _ref, ...visibleElement } = element;
      if (!isBrowserReplElementRef(element.ref)) return visibleElement;
      const index = allocateIndex();
      refs.set(index, element.ref);
      return { ...visibleElement, index };
    }),
  };
}

export function normalizeBrowserReplObserveOptions(value: unknown) {
  if (value === undefined) return undefined;
  if (isOptionsObject(value)) return value;
  throw new Error('observe() does not search text. Use queryText("..."), waitFor({ text: "..." }) to wait for text, or observe()/query(selector) for native CSS snapshots.');
}

export function normalizeBrowserReplWaitOptions(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const target = value.trim();
    if (!target) throw new Error('waitFor string must not be empty; use waitFor({ selector }) or waitFor({ text }).');
    return browserReplLooksLikeCssSelector(target) ? { selector: target } : { text: target };
  }
  if (isOptionsObject(value)) return value;
  throw new Error('waitFor requires { selector } or { text }, or a string shorthand.');
}

export function readBrowserReplActionTarget(refs: Map<number, BrowserReplElementRef>, value: unknown, name: string) {
  if (typeof value === 'string') return value;
  if (isBrowserReplElementRef(value)) return value;
  if (Number.isInteger(value)) return requireRef(refs, value);
  throw new Error(`${name} must be a selector string or same-call element index`);
}

export function readBrowserReplPressArgs(refs: Map<number, BrowserReplElementRef>, targetOrKey: unknown, key: unknown) {
  if (key === undefined) return [undefined, readString(targetOrKey, 'key')];
  return [readBrowserReplActionTarget(refs, targetOrKey, 'target'), readString(key, 'key')];
}

export function normalizeBrowserReplBatchActions(value: unknown, refs: Map<number, BrowserReplElementRef>) {
  if (!Array.isArray(value)) throw new Error('batch actions must be an array');
  return value.map((action, index) => normalizeBatchAction(action, refs, index));
}

export function normalizeBrowserReplScrollOptions(value: unknown) {
  if (value === undefined) return { y: 600 };
  if (typeof value === 'number') return { y: value };
  if (isRecord(value)) return value;
  throw new Error('scroll options must be a number or object');
}

export function browserReplPickUserElementOptions(value: unknown) {
  if (value === undefined) return {};
  if (typeof value === 'string') return { message: value };
  if (isRecord(value)) return value;
  throw new Error('pickUserElement message must be a string or options object');
}

export function browserReplHelperTimeout(value: unknown, fallback: number) {
  if (!isRecord(value) || !('timeoutMs' in value)) return fallback;
  const timeout = readPositiveInteger(value.timeoutMs, 'timeoutMs');
  if (timeout > MAX_BROWSER_REPL_TIMEOUT_MS) throw new Error(`timeoutMs must be <= ${MAX_BROWSER_REPL_TIMEOUT_MS}`);
  return timeout;
}

export function readBrowserReplString(value: unknown, name: string) {
  return readString(value, name);
}

export function isBrowserReplElementRef(value: unknown): value is BrowserReplElementRef {
  return isRecord(value) && typeof value.stableId === 'string' && typeof value.selector === 'string' && typeof value.tagName === 'string' && typeof value.name === 'string';
}

function requireRef(refs: Map<number, BrowserReplElementRef>, value: unknown) {
  const index = readPositiveInteger(value, 'index');
  const ref = refs.get(index);
  if (!ref) throw new Error(`Unknown element index: ${index}. Indexes are scoped to one browserRepl call; call observe() or query() in the same call before using an index.`);
  return ref;
}

function normalizeBatchAction(value: unknown, refs: Map<number, BrowserReplElementRef>, index: number) {
  if (!isRecord(value)) throw new Error(`batch action ${index + 1} must be an object`);
  const action = typeof value.action === 'string' ? value.action : typeof value.type === 'string' ? value.type : '';
  const next: Record<string, unknown> = { ...value, ...(action ? { action } : {}) };
  if (action === 'click' || action === 'fill' || action === 'press') {
    const target = value.target ?? value.selector ?? value.index;
    if (target !== undefined) next.target = readBrowserReplActionTarget(refs, target, `batch action ${index + 1} target`);
  }
  return next;
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function browserReplLooksLikeCssSelector(value: string) {
  if (/^(?:body|html)$/i.test(value)) return true;
  if (/^[#.[:*]/.test(value)) return true;
  if (/[>+~,\[\]]/.test(value)) return true;
  if (/^[a-zA-Z][\w-]*(?:[#.][\w-]+)+/.test(value)) return true;
  if (/^[a-zA-Z*][\w*-]*(?:[#.][\w-]+)*:[\w-]+(?:\(|$)/.test(value)) return true;
  const tokens = value.split(/\s+/);
  return tokens.length > 1 && tokens.every((token) => /^(?:body|html|main|section|article|nav|header|footer|form|label|input|button|select|textarea|a|div|span|p|ul|ol|li|table|thead|tbody|tr|td|th|iframe|frame|img|svg|canvas)$|^[#.[:*]/i.test(token));
}

function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
