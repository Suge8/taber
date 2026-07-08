import { normalizeBrowserJsCode } from './browser-repl-code.ts';
import {
  DEFAULT_BROWSER_REPL_TIMEOUT_MS,
  MAX_BROWSER_REPL_TIMEOUT_MS,
  browserReplHelperTimeout,
  browserReplPickUserElementOptions,
  normalizeBrowserReplBatchActions,
  normalizeBrowserReplObserveOptions,
  normalizeBrowserReplScrollOptions,
  normalizeBrowserReplWaitOptions,
  parseBrowserReplInput,
  readBrowserReplActionTarget,
  readBrowserReplPressArgs,
  readBrowserReplString,
  rememberBrowserReplElementRefs,
  type BrowserJsConsoleEntry,
  type BrowserReplElementRef,
  type BrowserReplHelper,
  type BrowserReplInput,
  type BrowserReplPageCommand,
  type BrowserReplResult,
  type BrowserReplSandboxRun,
} from './browser-repl-command.ts';

export {
  DEFAULT_BROWSER_REPL_TIMEOUT_MS,
  MAX_BROWSER_REPL_TIMEOUT_MS,
  browserReplFallbackFor,
  browserReplInputJsonSchema,
  browserReplPageHelperNames,
  browserReplRequestType,
  browserReplToolHelperNames,
  createBrowserReplInputJsonSchema,
  parseBrowserReplInput,
  type BrowserJsConsoleEntry,
  type BrowserReplElementRef,
  type BrowserReplFallback,
  type BrowserReplHelper,
  type BrowserReplInput,
  type BrowserReplPageCommand,
  type BrowserReplPageHelperName,
  type BrowserReplResult,
  type BrowserReplSandboxRun,
} from './browser-repl-command.ts';

const SHORT_PAGE_TIMEOUT_MS = 5_000;
const WAIT_FOR_TIMEOUT_MS = 8_000;

const browserJsPageResultType = 'taber.browserjs.result';
const MAX_BROWSERJS_CONSOLE_ENTRIES = 20;

type BrowserJsPageResult = { type: typeof browserJsPageResultType; value: unknown; console: BrowserJsConsoleEntry[] };

type Scheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timeoutId: unknown): void;
};

export function createBrowserReplController(options: {
  getCurrentTabId(): Promise<number>;
  executePageCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal): Promise<unknown>;
  runSandbox(run: BrowserReplSandboxRun): Promise<unknown>;
  navigate?(input: unknown, abortSignal?: AbortSignal): Promise<unknown>;
  browserJsEnabled?: boolean;
  scheduler?: Scheduler;
}) {
  const scheduler = options.scheduler ?? {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId as ReturnType<typeof globalThis.setTimeout>),
  };

  async function run(value: unknown, abortSignal?: AbortSignal): Promise<BrowserReplResult> {
    const input = parseBrowserReplInput(value);
    let pageTabId = input.tabId ?? (await options.getCurrentTabId());
    const refs = new Map<number, BrowserReplElementRef>();
    let nextRefIndex = 1;
    const browserJsConsole: BrowserJsConsoleEntry[] = [];

    const callPage = (command: BrowserReplPageCommand, pageTimeoutMs: number) => {
      const pageCommand = { ...command, cancelKey: crypto.randomUUID(), timeoutMs: pageTimeoutMs };
      const pageAbortController = new AbortController();
      const relayAbort = () => pageAbortController.abort();
      if (abortSignal?.aborted) relayAbort();
      else abortSignal?.addEventListener('abort', relayAbort, { once: true });
      return withTimeout(
        () => options.executePageCommand(pageTabId, pageCommand, pageAbortController.signal),
        pageTimeoutMs,
        `${command.helper} timed out`,
        scheduler,
        pageAbortController,
      ).finally(() => abortSignal?.removeEventListener('abort', relayAbort));
    };

    const helpers: Record<string, BrowserReplHelper> = {
      readVisibleText: async (readOptions) => callPage({ helper: 'readVisibleText', args: [readOptions] }, browserReplHelperTimeout(readOptions, SHORT_PAGE_TIMEOUT_MS)),
      readLinksAndButtons: async (readOptions) => callPage({ helper: 'readLinksAndButtons', args: [readOptions] }, browserReplHelperTimeout(readOptions, SHORT_PAGE_TIMEOUT_MS)),
      listInteractiveElements: async (listOptions) => callPage({ helper: 'listInteractiveElements', args: [listOptions] }, browserReplHelperTimeout(listOptions, SHORT_PAGE_TIMEOUT_MS)),
      queryText: async (text, queryOptions) => callPage({ helper: 'queryText', args: [readBrowserReplString(text, 'text'), queryOptions] }, browserReplHelperTimeout(queryOptions, SHORT_PAGE_TIMEOUT_MS)),
      observe: async (observeOptions) => {
        const options = normalizeBrowserReplObserveOptions(observeOptions);
        return rememberBrowserReplElementRefs(await callPage({ helper: 'observe', args: [options] }, browserReplHelperTimeout(options, SHORT_PAGE_TIMEOUT_MS)), refs, () => nextRefIndex++);
      },
      query: async (selector, queryOptions) => rememberBrowserReplElementRefs(await callPage({ helper: 'query', args: [readBrowserReplString(selector, 'selector'), queryOptions] }, browserReplHelperTimeout(queryOptions, SHORT_PAGE_TIMEOUT_MS)), refs, () => nextRefIndex++),
      click: async (target) => callPage({ helper: 'click', args: [readBrowserReplActionTarget(refs, target, 'target')] }, SHORT_PAGE_TIMEOUT_MS),
      fill: async (target, text) => callPage({ helper: 'fill', args: [readBrowserReplActionTarget(refs, target, 'target'), readBrowserReplString(text, 'text')] }, SHORT_PAGE_TIMEOUT_MS),
      press: async (targetOrKey, key) => callPage({ helper: 'press', args: readBrowserReplPressArgs(refs, targetOrKey, key) }, SHORT_PAGE_TIMEOUT_MS),
      scroll: async (scrollOptions) => callPage({ helper: 'scroll', args: [normalizeBrowserReplScrollOptions(scrollOptions)] }, SHORT_PAGE_TIMEOUT_MS),
      waitFor: async (waitOptions) => {
        const options = normalizeBrowserReplWaitOptions(waitOptions);
        return callPage({ helper: 'waitFor', args: [options] }, browserReplHelperTimeout(options, WAIT_FOR_TIMEOUT_MS));
      },
      batch: async (actions, batchOptions) => callPage({ helper: 'batch', args: [normalizeBrowserReplBatchActions(actions, refs), batchOptions] }, browserReplHelperTimeout(batchOptions, DEFAULT_BROWSER_REPL_TIMEOUT_MS)),
      fillForm: async (formOptions) => callPage({ helper: 'fillForm', args: [formOptions] }, browserReplHelperTimeout(formOptions, DEFAULT_BROWSER_REPL_TIMEOUT_MS)),
      sandbox: async (code, args) => runInlineSandbox(readBrowserReplString(code, 'code'), args),
      pickElement: async (target) => callPage({ helper: 'pickElement', args: [readBrowserReplActionTarget(refs, target, 'target')] }, SHORT_PAGE_TIMEOUT_MS),
      pickUserElement: async (messageOrOptions) => {
        const pickerOptions = browserReplPickUserElementOptions(messageOrOptions);
        return callPage({ helper: 'pickUserElement', args: [pickerOptions] }, browserReplHelperTimeout(pickerOptions, DEFAULT_BROWSER_REPL_TIMEOUT_MS));
      },
    };
    if (options.navigate) {
      const navigate = options.navigate;
      helpers.navigate = async (navigateInput) => {
        const result = await navigate(navigateInput, abortSignal);
        pageTabId = navigateResultTabId(result) ?? pageTabId;
        return result;
      };
    }
    if (options.browserJsEnabled !== false) helpers.browserjs = async (code, args) => {
      const result = await callPage({ helper: 'browserjs', args: [normalizeBrowserJsCode(code), args] }, browserReplHelperTimeout(args, DEFAULT_BROWSER_REPL_TIMEOUT_MS));
      if (!isBrowserJsPageResult(result)) return result;
      appendBrowserJsConsole(browserJsConsole, result.console);
      return result.value;
    };

    const valueResult = await options.runSandbox({ code: input.code, helpers, timeoutMs: timeoutMs(input), abortSignal });
    return browserJsConsole.length ? { value: valueResult, browserjs: { console: browserJsConsole } } : { value: valueResult };
  }

  return { run };
}

export function browserJsPageResult(value: unknown, consoleEntries: unknown): BrowserJsPageResult {
  return { type: browserJsPageResultType, value, console: normalizeBrowserJsConsole(consoleEntries) };
}

function isBrowserJsPageResult(value: unknown): value is BrowserJsPageResult {
  return isRecord(value) && value.type === browserJsPageResultType && Array.isArray(value.console);
}

function appendBrowserJsConsole(target: BrowserJsConsoleEntry[], entries: BrowserJsConsoleEntry[]) {
  for (const entry of entries) {
    target.push(entry);
    if (target.length > MAX_BROWSERJS_CONSOLE_ENTRIES) target.shift();
  }
}

function normalizeBrowserJsConsole(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(readBrowserJsConsoleEntry).filter((entry) => entry !== undefined).slice(-MAX_BROWSERJS_CONSOLE_ENTRIES);
}

function readBrowserJsConsoleEntry(value: unknown): BrowserJsConsoleEntry | undefined {
  if (!isRecord(value) || !isBrowserJsConsoleLevel(value.level) || typeof value.text !== 'string') return undefined;
  return { level: value.level, text: value.text.slice(0, 500) };
}

function isBrowserJsConsoleLevel(value: unknown): value is BrowserJsConsoleEntry['level'] {
  return value === 'log' || value === 'info' || value === 'warn' || value === 'error';
}

async function runInlineSandbox(code: string, args: unknown) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', `"use strict";\n${code}`)(args);
}

function timeoutMs(input: BrowserReplInput) {
  return input.timeoutMs ?? DEFAULT_BROWSER_REPL_TIMEOUT_MS;
}

function navigateResultTabId(value: unknown) {
  if (!isRecord(value) || !isRecord(value.tab)) return undefined;
  return Number.isInteger(value.tab.id) && Number(value.tab.id) > 0 ? Number(value.tab.id) : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
