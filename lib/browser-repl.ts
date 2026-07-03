export const browserReplRequestType = 'taber.browserRepl.request';
export const DEFAULT_BROWSER_REPL_TIMEOUT_MS = 30_000;
export const MAX_BROWSER_REPL_TIMEOUT_MS = 120_000;

const SHORT_PAGE_TIMEOUT_MS = 5_000;
const WAIT_FOR_TIMEOUT_MS = 8_000;

export type BrowserReplInput = {
  code: string;
  tabId?: number;
  timeoutMs?: number;
};

export type BrowserReplResult = { value: unknown };

export type BrowserReplElementRef = {
  stableId: string;
  selector: string;
  tagName: string;
  name: string;
};

export type BrowserReplPageCommand = {
  helper: 'observe' | 'query' | 'click' | 'fill' | 'press' | 'scroll' | 'waitFor' | 'browserjs' | 'pickElement';
  args: unknown[];
  cancelKey?: string;
  timeoutMs?: number;
};

export type BrowserReplHelper = (...args: unknown[]) => Promise<unknown>;
export type BrowserReplFallback = 'browserjsCdp' | 'pressCdp' | 'scripting';

export type BrowserReplSandboxRun = {
  code: string;
  helpers: Record<string, BrowserReplHelper>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
};

type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timeoutId: unknown): void;
};

export const browserReplInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: {
    code: { type: 'string', description: 'JavaScript REPL code. Use return to send a serializable result.' },
    tabId: { type: 'integer', minimum: 1, description: 'Target tab id. Defaults to the active tab.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_BROWSER_REPL_TIMEOUT_MS },
  },
} as const;

export function createBrowserReplController(options: {
  getCurrentTabId(): Promise<number>;
  executePageCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal): Promise<unknown>;
  runSandbox(run: BrowserReplSandboxRun): Promise<unknown>;
  browserJsEnabled?: boolean;
  scheduler?: Scheduler;
}) {
  const scheduler = options.scheduler ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId as ReturnType<typeof globalThis.setTimeout>),
  };

  async function run(value: unknown, abortSignal?: AbortSignal): Promise<BrowserReplResult> {
    const input = parseBrowserReplInput(value);
    const tabId = input.tabId ?? (await options.getCurrentTabId());
    const refs = new Map<number, BrowserReplElementRef>();

    const callPage = (command: BrowserReplPageCommand, pageTimeoutMs: number) => {
      const pageCommand = { ...command, cancelKey: crypto.randomUUID(), timeoutMs: pageTimeoutMs };
      const pageAbortController = new AbortController();
      const relayAbort = () => pageAbortController.abort();
      if (abortSignal?.aborted) relayAbort();
      else abortSignal?.addEventListener('abort', relayAbort, { once: true });
      return withTimeout(
        () => options.executePageCommand(tabId, pageCommand, pageAbortController.signal),
        pageTimeoutMs,
        `${command.helper} timed out`,
        scheduler,
        pageAbortController,
      ).finally(() => abortSignal?.removeEventListener('abort', relayAbort));
    };

    const helpers: Record<string, BrowserReplHelper> = {
      observe: async (observeOptions) => remember(await callPage({ helper: 'observe', args: [observeOptions] }, helperTimeout(observeOptions, SHORT_PAGE_TIMEOUT_MS)), refs),
      query: async (selector, queryOptions) => remember(await callPage({ helper: 'query', args: [readString(selector, 'selector'), queryOptions] }, helperTimeout(queryOptions, SHORT_PAGE_TIMEOUT_MS)), refs),
      click: async (index) => callPage({ helper: 'click', args: [requireRef(refs, index)] }, SHORT_PAGE_TIMEOUT_MS),
      fill: async (index, text) => callPage({ helper: 'fill', args: [requireRef(refs, index), readString(text, 'text')] }, SHORT_PAGE_TIMEOUT_MS),
      press: async (targetOrKey, key) => callPage({ helper: 'press', args: readPressArgs(refs, targetOrKey, key) }, SHORT_PAGE_TIMEOUT_MS),
      scroll: async (scrollOptions) => callPage({ helper: 'scroll', args: [normalizeScrollOptions(scrollOptions)] }, SHORT_PAGE_TIMEOUT_MS),
      waitFor: async (waitOptions) => callPage({ helper: 'waitFor', args: [waitOptions] }, helperTimeout(waitOptions, WAIT_FOR_TIMEOUT_MS)),
      sandbox: async (code, args) => runInlineSandbox(readString(code, 'code'), args),
      pickElement: async (index) => callPage({ helper: 'pickElement', args: [requireRef(refs, index)] }, SHORT_PAGE_TIMEOUT_MS),
    };
    if (options.browserJsEnabled !== false) helpers.browserjs = async (code, args) => callPage({ helper: 'browserjs', args: [readString(code, 'code'), args] }, helperTimeout(args, DEFAULT_BROWSER_REPL_TIMEOUT_MS));

    const valueResult = await options.runSandbox({ code: input.code, helpers, timeoutMs: timeoutMs(input), abortSignal });
    return { value: valueResult };
  }

  return { run };
}

export function browserReplFallbackFor(command: BrowserReplPageCommand): BrowserReplFallback {
  if (command.helper === 'browserjs') return 'browserjsCdp';
  if (command.helper === 'press') return 'pressCdp';
  return 'scripting';
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

function remember(value: unknown, refs: Map<number, BrowserReplElementRef>) {
  if (!isRecord(value) || !Array.isArray(value.elements)) return value;
  refs.clear();
  return {
    ...value,
    elements: value.elements.map((element) => {
      if (!isRecord(element)) return element;
      const index = Number(element.index);
      if (Number.isInteger(index) && isElementRef(element.ref)) refs.set(index, element.ref);
      const { ref: _ref, ...visibleElement } = element;
      return visibleElement;
    }),
  };
}

function requireRef(refs: Map<number, BrowserReplElementRef>, value: unknown) {
  const index = readPositiveInteger(value, 'index');
  const ref = refs.get(index);
  if (!ref) throw new Error(`Unknown element index: ${index}. Call observe() or query() first.`);
  return ref;
}

function readPressArgs(refs: Map<number, BrowserReplElementRef>, targetOrKey: unknown, key: unknown) {
  if (key === undefined) return [undefined, readString(targetOrKey, 'key')];
  return [requireRef(refs, targetOrKey), readString(key, 'key')];
}

function normalizeScrollOptions(value: unknown) {
  if (value === undefined) return { y: 600 };
  if (typeof value === 'number') return { y: value };
  if (isRecord(value)) return value;
  throw new Error('scroll options must be a number or object');
}

async function runInlineSandbox(code: string, args: unknown) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', `"use strict";\n${code}`)(args);
}

function helperTimeout(value: unknown, fallback: number) {
  if (!isRecord(value) || !('timeoutMs' in value)) return fallback;
  const timeout = readPositiveInteger(value.timeoutMs, 'timeoutMs');
  if (timeout > MAX_BROWSER_REPL_TIMEOUT_MS) throw new Error(`timeoutMs must be <= ${MAX_BROWSER_REPL_TIMEOUT_MS}`);
  return timeout;
}

function timeoutMs(input: BrowserReplInput) {
  return input.timeoutMs ?? DEFAULT_BROWSER_REPL_TIMEOUT_MS;
}

function withTimeout<T>(run: () => Promise<T>, timeoutMs: number, message: string, scheduler: Scheduler, abortController: AbortController) {
  if (abortController.signal.aborted) return Promise.reject(new Error('Task aborted'));
  const promise = run();
  let timeoutId: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = scheduler.setTimeout(() => {
      abortController.abort();
      reject(new Error(`${message} after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => scheduler.clearTimeout(timeoutId));
}

function isElementRef(value: unknown): value is BrowserReplElementRef {
  return isRecord(value) && typeof value.stableId === 'string' && typeof value.selector === 'string' && typeof value.tagName === 'string' && typeof value.name === 'string';
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
