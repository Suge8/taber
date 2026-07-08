import { jsonSchema, tool } from 'ai';
import { appendToolRun } from './db.ts';
import { DEFAULT_BROWSER_TOOL_TIMEOUT_MS, browserDescription, browserInputJsonSchema, parseBrowserInput, type BrowserInput, type BrowserResult } from './browser-tool.ts';
import { isPageAccessError, pageAccessErrorMessage } from './browser-access.ts';
import { browserReplToolHelperNames, createBrowserReplController, createBrowserReplInputJsonSchema, parseBrowserReplInput, type BrowserReplInput, type BrowserReplResult } from './browser-repl.ts';
import { runBrowserReplInSandbox } from './browser-repl-sandbox.ts';
import { createBrowserReplPageExecutor } from './browser-repl-executor.ts';
import { extractImageToModelOutput } from './agent-tool-image-output.ts';
import { debuggerInputJsonSchema, debuggerRequestType, parseDebuggerInput, type DebuggerInput, type DebuggerResult } from './debugger-tool.ts';
import { createExtractImageController, extractImageInputJsonSchema, parseExtractImageInput, type ExtractImageInput, type ExtractImageResult } from './extract-image.ts';
import { createGetDocumentController, getDocumentInputJsonSchema, parseGetDocumentInput, type GetDocumentInput, type GetDocumentResult, type PageDocument } from './get-document.ts';
import { navigateInputJsonSchema, navigateRequestType, parseNavigateInput, type NavigateInput, type NavigateResult } from './navigate.ts';
import { DEBUGGER_ENABLED } from './runtime-flags.ts';

type SendMessage = (message: unknown) => Promise<unknown>;
type EmitEvent = (type: string, payload: unknown) => Promise<void>;
type RunSandbox = typeof runBrowserReplInSandbox;
type TargetChangeReason = 'openNew' | 'switchTab';
type TargetChanged = { fromTabId?: number; toTabId: number; reason: TargetChangeReason; tab?: unknown };

type AgentToolOptions = {
  sessionId: number;
  taskId?: string;
  windowId?: number;
  targetTabId?: number;
  getTargetTabId?: () => number | undefined;
  sendMessage: SendMessage;
  emitEvent: EmitEvent;
  onTargetChanged?: (change: TargetChanged) => Promise<void>;
  onTargetUnavailable?: (error: string) => Promise<void>;
  runSandbox?: RunSandbox;
  browserJsEnabled?: boolean;
};

const getDocumentDescription = 'Read webpage, PDF, or file as structured content. Use when you need article text, page content, selection, or tables. For currentPage: mode:"article" extracts main content, mode:"page" gets full text, mode:"selection" reads user selection. Results include open shadow root text and same-origin iframe content; cross-origin iframes show metadata with access hints.';
const extractImageDescription = 'Capture screenshots or extract images. Use source:"viewport" for visible area, source:"imageElement" for <img> URLs, source:"canvas" for canvas pixels, source:"backgroundImage" for CSS backgrounds. Viewport requires visible target tab; to capture another tab, call navigate.switchTab first.';
const navigateDescription = 'Navigate tabs: open URLs, back/forward, reload, list/switch/close tabs, or read current tab. Use for all navigation. Changes target only on action:"switchTab" or open target:"new". Never use page location/history directly.';
const debuggerDescription = 'Debug-build only: read console, network, failed requests, accessibility snapshots, main-world JS state, or raw CDP. Use for diagnosing console errors, network failures, and accessibility issues. Cookies are blocked.';

export function createAgentToolPromptEstimateText(options: { browserJsEnabled?: boolean } = {}) {
  return JSON.stringify({
    getDocument: { description: getDocumentDescription, inputSchema: getDocumentInputJsonSchema },
    extractImage: { description: extractImageDescription, inputSchema: extractImageInputJsonSchema },
    navigate: { description: navigateDescription, inputSchema: navigateInputJsonSchema },
    browser: { description: browserDescription, inputSchema: browserInputJsonSchema },
    browserRepl: { description: browserReplDescription(options.browserJsEnabled !== false), inputSchema: createBrowserReplInputJsonSchema({ browserJsEnabled: options.browserJsEnabled !== false }) },
    ...(DEBUGGER_ENABLED ? { debugger: { description: debuggerDescription, inputSchema: debuggerInputJsonSchema } } : {}),
  });
}

export const AGENT_TOOL_PROMPT_ESTIMATE_TEXT = createAgentToolPromptEstimateText({ browserJsEnabled: true });

function browserReplDescription(browserJsEnabled: boolean) {
  const helpers = browserReplToolHelperNames(browserJsEnabled).join(', ');
  const browserJsNote = browserJsEnabled
    ? ' browserjs(codeOrFn, args) is available after user consent for advanced page script evidence; not for reading or regular operations.'
    : '';
  return (
    'Advanced REPL for operations browser cannot express. ' +
    'Use only for batch actions, complex forms, debugging, or when browser fails. ' +
    `Helpers: ${helpers}.${browserJsNote} ` +
    'Page reading: readVisibleText(), readLinksAndButtons(), listInteractiveElements(), queryText("text") cover main document, open shadow roots, and same-origin iframes; cross-origin frames show metadata. ' +
    'Element indexes from observe/query are scoped to one call; never reuse across calls. ' +
    'navigate(input) delegates to navigate; switchTab or open target:"new" updates task target for subsequent helpers in the same call. ' +
    'batch(actions) runs fill/click/press/scroll/waitFor with per-step evidence. ' +
    'fillForm({ fields, confidence?, dryRun? }) matches by label/placeholder/aria-label/name/id; fills high-confidence unique fields only; ambiguous fields are reported. ' +
    'sandbox() is for data processing with fetch. ' +
    'Return concise serializable evidence; no DOM/function/Window/Event/cycles or large dataUrl/logs.'
  );
}

export function createAgentTools(options: AgentToolOptions) {
  const browserJsEnabled = options.browserJsEnabled !== false;
  const runtime = new AgentToolRuntime({
    sendMessage: options.sendMessage,
    windowId: options.windowId,
    targetTabId: options.targetTabId,
    getTargetTabId: options.getTargetTabId,
    onTargetChanged: options.onTargetChanged,
    onTargetUnavailable: options.onTargetUnavailable,
    runSandbox: options.runSandbox ?? runBrowserReplInSandbox,
    browserJsEnabled,
  });
  const withRunLog = createRunLogger(options.sessionId, options.emitEvent, options.taskId);
  const tools = {
    getDocument: tool<GetDocumentInput, GetDocumentResult>({
      description: getDocumentDescription,
      inputSchema: jsonSchema<GetDocumentInput>(getDocumentInputJsonSchema, validator(parseGetDocumentInput)),
      execute: withRunLog('getDocument', (input, abortSignal) => runtime.getDocument(input, abortSignal)),
    }),
    extractImage: tool<ExtractImageInput, ExtractImageResult>({
      description: extractImageDescription,
      inputSchema: jsonSchema<ExtractImageInput>(extractImageInputJsonSchema, validator(parseExtractImageInput)),
      execute: withRunLog('extractImage', (input, abortSignal) => runtime.extractImage(input, abortSignal)),
      toModelOutput: extractImageToModelOutput,
    }),
    navigate: tool<NavigateInput, NavigateResult>({
      description: navigateDescription,
      inputSchema: jsonSchema<NavigateInput>(navigateInputJsonSchema, validator(parseNavigateInput)),
      execute: withRunLog('navigate', (input, abortSignal) => runtime.navigate(input, abortSignal)),
    }),
    browser: tool<BrowserInput, BrowserResult>({
      description: browserDescription,
      inputSchema: jsonSchema<BrowserInput>(browserInputJsonSchema, validator(parseBrowserInput)),
      execute: withRunLog('browser', (input, abortSignal) => runtime.browser(input, abortSignal)),
    }),
    browserRepl: tool<BrowserReplInput, BrowserReplResult>({
      description: browserReplDescription(browserJsEnabled),
      inputSchema: jsonSchema<BrowserReplInput>(createBrowserReplInputJsonSchema({ browserJsEnabled }), validator(parseBrowserReplInput)),
      execute: withRunLog('browserRepl', (input, abortSignal) => runtime.browserRepl(input, abortSignal)),
    }),
  };

  if (!DEBUGGER_ENABLED) return tools;
  return {
    ...tools,
    debugger: tool<DebuggerInput, DebuggerResult>({
      description: debuggerDescription,
      inputSchema: jsonSchema<DebuggerInput>(debuggerInputJsonSchema, validator(parseDebuggerInput)),
      execute: withRunLog('debugger', (input, abortSignal) => runtime.debugger(input, abortSignal)),
    }),
  };
}

class AgentToolRuntime {
  private readonly sendMessage: SendMessage;
  private readonly windowId?: number;
  private readonly runSandbox: RunSandbox;
  private readonly browserJsEnabled: boolean;
  private readonly pageExecutor: ReturnType<typeof createBrowserReplPageExecutor>;
  private readonly getTargetTabId?: () => number | undefined;
  private readonly onTargetChanged?: (change: TargetChanged) => Promise<void>;
  private readonly onTargetUnavailable?: (error: string) => Promise<void>;
  private targetTabId?: number;

  constructor(options: {
    sendMessage: SendMessage;
    windowId?: number;
    targetTabId?: number;
    getTargetTabId?: () => number | undefined;
    onTargetChanged?: (change: TargetChanged) => Promise<void>;
    onTargetUnavailable?: (error: string) => Promise<void>;
    runSandbox: RunSandbox;
    browserJsEnabled: boolean;
  }) {
    this.sendMessage = options.sendMessage;
    this.windowId = options.windowId;
    this.targetTabId = options.targetTabId;
    this.getTargetTabId = options.getTargetTabId;
    this.onTargetChanged = options.onTargetChanged;
    this.onTargetUnavailable = options.onTargetUnavailable;
    this.runSandbox = options.runSandbox;
    this.browserJsEnabled = options.browserJsEnabled;
    this.pageExecutor = createBrowserReplPageExecutor({
      sendMessage: this.sendMessage,
      readTargetTabId: () => this.currentTargetTabId(),
      errorFromResponse: (message) => this.errorFromResponse(message),
    });
  }

  getDocument(input: GetDocumentInput, abortSignal?: AbortSignal) {
    if (input.source === 'currentPage' && input.tabId !== undefined) this.assertInputTabId('getDocument', input.tabId);
    return createGetDocumentController({
      getCurrentTabId: () => this.getCurrentTabId(),
      executeInTab: (tabId, nextInput) => this.extractPageDocument(tabId, nextInput, abortSignal),
      fetchArrayBuffer: (url) => abortable(() => fetch(url).then(requireOk).then((response) => response.arrayBuffer()), abortSignal),
    }).run(input);
  }

  extractImage(input: ExtractImageInput, abortSignal?: AbortSignal) {
    if (input.source !== 'viewport' && input.tabId !== undefined) this.assertInputTabId('extractImage', input.tabId);
    return createExtractImageController({
      getCurrentTabId: () => this.getCurrentTabId(),
      captureVisibleTab: (nextInput) => this.captureVisibleTab(nextInput, abortSignal),
      executeInTab: (tabId, nextInput) => this.extractPageImage(tabId, nextInput, abortSignal),
    }).run(input);
  }

  async navigate(input: NavigateInput, abortSignal?: AbortSignal) {
    this.assertNavigateTabId(input);
    const response = await abortable(() => this.sendMessage({ type: navigateRequestType, input, windowId: this.windowId, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw await this.navigateError(input, response.error);
    const result = response as NavigateResult;
    await this.applyNavigateTargetChange(input, result);
    return result;
  }

  async browser(input: BrowserInput, abortSignal?: AbortSignal) {
    if (input.tabId !== undefined) this.assertInputTabId('browser', input.tabId);
    const tabId = input.tabId ?? (await this.getCurrentTabId());
    return this.pageExecutor.executePageCommand(tabId, { helper: 'browser', args: [input], cancelKey: crypto.randomUUID(), timeoutMs: input.timeoutMs ?? DEFAULT_BROWSER_TOOL_TIMEOUT_MS }, abortSignal) as Promise<BrowserResult>;
  }

  browserRepl(input: BrowserReplInput, abortSignal?: AbortSignal) {
    if (input.tabId !== undefined) this.assertInputTabId('browserRepl', input.tabId);
    return createBrowserReplController({
      getCurrentTabId: () => this.getCurrentTabId(),
      executePageCommand: (tabId, command, nextSignal) => this.pageExecutor.executePageCommand(tabId, command, nextSignal),
      runSandbox: this.runSandbox,
      navigate: (nextInput, nextSignal) => this.navigate(parseNavigateInput(nextInput), nextSignal),
      browserJsEnabled: this.browserJsEnabled,
    }).run(input, abortSignal);
  }

  async debugger(input: DebuggerInput, abortSignal?: AbortSignal) {
    if (input.tabId !== undefined) this.assertInputTabId('debugger', input.tabId);
    const response = await abortable(() => this.sendMessage({ type: debuggerRequestType, input, windowId: this.windowId, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw await this.errorFromResponse(response.error);
    return response as DebuggerResult;
  }

  private currentTargetTabId() { return this.getTargetTabId?.() ?? this.targetTabId; }
  private async getCurrentTabId() {
    const targetTabId = this.currentTargetTabId();
    if (targetTabId !== undefined) return targetTabId;
    const tab = await this.sendMessage({ type: 'taber.background.currentTab', windowId: this.windowId });
    if (isRecord(tab) && typeof tab.error === 'string') throw await this.errorFromResponse(tab.error);
    if (!isRecord(tab) || !Number.isInteger(tab.id) || Number(tab.id) <= 0) throw new Error('No active tab in the side panel window');
    return Number(tab.id);
  }

  private async extractPageDocument(tabId: number, input: GetDocumentInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.getDocument.extractPage', tabId, input, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(await this.errorFromResponse(response.error));
    return response as PageDocument;
  }

  private async captureVisibleTab(input: ExtractImageInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.extractImage.captureVisibleTab', input, windowId: this.windowId, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw await this.errorFromResponse(response.error);
    return String(response);
  }

  private async extractPageImage(tabId: number, input: ExtractImageInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.extractImage.extractPage', tabId, input, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(await this.errorFromResponse(response.error));
    return response as ExtractImageResult;
  }

  private assertInputTabId(toolName: string, tabId: number) {
    const targetTabId = this.currentTargetTabId();
    if (targetTabId === undefined || tabId === targetTabId) return;
    throw new Error(`${toolName} is locked to target tab ${targetTabId}; received tabId ${tabId}. Use navigate.switchTab to change the task target.`);
  }

  private assertNavigateTabId(input: NavigateInput) {
    if (input.tabId === undefined || input.action === 'switchTab') return;
    this.assertInputTabId(`navigate.${input.action}`, input.tabId);
  }

  private async applyNavigateTargetChange(input: NavigateInput, result: NavigateResult) {
    if (input.action === 'open' && (input.target ?? 'current') === 'new') {
      await this.updateTargetFromResult('openNew', result.tab);
      return;
    }
    if (input.action === 'switchTab') {
      await this.updateTargetFromResult('switchTab', result.tab);
      return;
    }
    if (input.action === 'closeTab' && result.tabId !== undefined && result.tabId === this.currentTargetTabId()) {
      throw await this.targetUnavailableError(`Target tab ${result.tabId} was closed; the task cannot continue.`);
    }
  }

  private async updateTargetFromResult(reason: TargetChangeReason, tab: NavigateResult['tab']) {
    if (!tab?.id) return;
    const fromTabId = this.currentTargetTabId();
    this.targetTabId = tab.id;
    if (fromTabId === tab.id) return;
    await this.onTargetChanged?.({ fromTabId, toTabId: tab.id, reason, tab });
  }

  private async navigateError(input: NavigateInput, message: string) {
    if (this.currentTargetTabId() !== undefined && input.action === 'open' && message.startsWith('Tab is not operable:')) {
      return this.targetUnavailableError(message.replace(/^Tab/, 'Target tab'));
    }
    if (this.currentTargetTabId() !== undefined && (input.action === 'back' || input.action === 'forward' || input.action === 'reload' || input.action === 'currentTab') && message.startsWith('Tab is not operable:')) {
      return this.targetUnavailableError(message.replace(/^Tab/, 'Target tab'));
    }
    return this.errorFromResponse(message);
  }

  private async errorFromResponse(message: string) {
    if (isTargetUnavailableMessage(message)) return this.targetUnavailableError(message);
    return new Error(message);
  }

  private async targetUnavailableError(message: string) {
    await this.onTargetUnavailable?.(message);
    return new Error(message);
  }
}

function createRunLogger(sessionId: number, emitEvent: EmitEvent, taskId?: string) {
  return function withRunLog<Input, Output>(toolName: string, run: (input: Input, abortSignal?: AbortSignal) => Promise<Output>) {
    return async (input: Input, options: { abortSignal?: AbortSignal; toolCallId?: string }) => {
      const toolCallId = options.toolCallId;
      await emitEvent('tool.started', { taskId, toolCallId, toolName, input });
      try {
        const output = await run(input, options.abortSignal);
        await appendToolRun({ sessionId, toolName, input, output });
        await emitEvent('tool.completed', { taskId, toolCallId, toolName, input, output });
        return output;
      } catch (error) {
        await emitEvent('tool.failed', { taskId, toolCallId, toolName, input, error: stringifyError(error) });
        throw error;
      }
    };
  };
}

function validator<T>(parse: (value: unknown) => T) {
  return { validate(value: unknown) { try { return { success: true as const, value: parse(value) }; } catch (error) { return { success: false as const, error: error instanceof Error ? error : new Error(String(error)) }; } } };
}

function abortable<T>(run: () => Promise<T>, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) return Promise.reject(new Error('Task aborted'));
  const promise = run();
  if (!abortSignal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Task aborted'));
    abortSignal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => abortSignal.removeEventListener('abort', abort));
  });
}

function requireOk(response: Response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status}`);
  return response;
}

function normalizePageExecutionError(error: unknown) {
  return isPageAccessError(error) ? new Error(pageAccessErrorMessage()) : error instanceof Error ? error : new Error(String(error));
}

function isTargetUnavailableMessage(message: string) {
  return /^Target tab (?:is no longer available|is not operable|\d+ was closed)/.test(message);
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
