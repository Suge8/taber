import { jsonSchema, tool, type JSONValue } from 'ai';
import { appendToolRun } from './db.ts';
import { isPageAccessError, pageAccessErrorMessage, userScriptsErrorMessage } from './browser-access.ts';
import { DEFAULT_BROWSER_REPL_TIMEOUT_MS, browserReplFallbackFor, browserReplInputJsonSchema, createBrowserReplController, parseBrowserReplInput, type BrowserReplInput, type BrowserReplPageCommand, type BrowserReplResult } from './browser-repl.ts';
import { canUseCdpFallback, executeBrowserReplCdpFallback } from './browser-repl-cdp.ts';
import { createBrowserReplUserScript } from './browser-repl-page.ts';
import { runBrowserReplInSandbox } from './browser-repl-sandbox.ts';
import { chromeApiRequestType, type ChromeApiAction } from './chrome-api-broker.ts';
import { debuggerInputJsonSchema, debuggerRequestType, parseDebuggerInput, type DebuggerInput, type DebuggerResult } from './debugger-tool.ts';
import { createExtractImageController, extractImageInputJsonSchema, parseExtractImageInput, type ExtractImageInput, type ExtractImageResult } from './extract-image.ts';
import { createGetDocumentController, getDocumentInputJsonSchema, parseGetDocumentInput, type GetDocumentInput, type GetDocumentResult, type PageDocument } from './get-document.ts';
import { navigateInputJsonSchema, navigateRequestType, parseNavigateInput, type NavigateInput, type NavigateResult } from './navigate.ts';
import { DEBUGGER_ENABLED } from './runtime-flags.ts';

type SendMessage = (message: unknown) => Promise<unknown>;
type EmitEvent = (type: string, payload: unknown) => Promise<void>;
type RunSandbox = typeof runBrowserReplInSandbox;

type AgentToolOptions = { sessionId: number; taskId?: string; windowId?: number; sendMessage: SendMessage; emitEvent: EmitEvent; runSandbox?: RunSandbox; browserJsEnabled?: boolean };

const getDocumentDescription = 'Read documents with explicit source contracts. Current page DOM uses source:"currentPage" with mode:"article"|"page"|"selection" and optional tabId/includeTables. PDF uses source:"pdf" + url. UI-provided text only uses source:"file" + fileText. Do not pass url for currentPage; remote HTML reader is unsupported.';
const extractImageDescription = 'Extract images with explicit source contracts. Use source:"viewport" for the current visible tab only; to capture another tab, call navigate switchTab first, then viewport. Use source:"imageElement" + selector for an <img> URL, source:"canvas" + selector for canvas pixels, and source:"backgroundImage" + selector for CSS background-image. format defaults to png; jpegQuality is an integer 0-100 and is only valid with format:"jpeg". No full-page stitching.';

export function createAgentToolPromptEstimateText(options: { browserJsEnabled?: boolean } = {}) {
  return JSON.stringify({
    getDocument: { description: getDocumentDescription, inputSchema: getDocumentInputJsonSchema },
    extractImage: { description: extractImageDescription, inputSchema: extractImageInputJsonSchema },
    navigate: { description: 'Navigate browser tabs: open URLs, back, forward, reload, list tabs, switch tab, close tab, or read current tab.', inputSchema: navigateInputJsonSchema },
    browserRepl: { description: browserReplDescription(options.browserJsEnabled !== false), inputSchema: browserReplInputJsonSchema },
    ...(DEBUGGER_ENABLED ? { debugger: { description: 'Read console logs, network logs, failed requests, evaluate main-world JavaScript, or call CDP. Cookies are blocked.', inputSchema: debuggerInputJsonSchema } } : {}),
  });
}

export const AGENT_TOOL_PROMPT_ESTIMATE_TEXT = createAgentToolPromptEstimateText({ browserJsEnabled: true });

function browserReplDescription(browserJsEnabled: boolean) {
  const helpers = browserJsEnabled
    ? 'observe, query, click, fill, press, scroll, waitFor, browserjs, sandbox, pickElement'
    : 'observe, query, click, fill, press, scroll, waitFor, sandbox, pickElement';
  return `Run browser REPL JavaScript. Helpers: ${helpers}.`;
}

export function createAgentTools(options: AgentToolOptions) {
  const browserJsEnabled = options.browserJsEnabled !== false;
  const runtime = new AgentToolRuntime(options.sendMessage, options.windowId, options.runSandbox ?? runBrowserReplInSandbox, browserJsEnabled);
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
      description: 'Navigate browser tabs: open URLs, back, forward, reload, list tabs, switch tab, close tab, or read current tab.',
      inputSchema: jsonSchema<NavigateInput>(navigateInputJsonSchema, validator(parseNavigateInput)),
      execute: withRunLog('navigate', (input, abortSignal) => runtime.navigate(input, abortSignal)),
    }),
    browserRepl: tool<BrowserReplInput, BrowserReplResult>({
      description: browserReplDescription(browserJsEnabled),
      inputSchema: jsonSchema<BrowserReplInput>(browserReplInputJsonSchema, validator(parseBrowserReplInput)),
      execute: withRunLog('browserRepl', (input, abortSignal) => runtime.browserRepl(input, abortSignal)),
    }),
  };

  if (!DEBUGGER_ENABLED) return tools;
  return {
    ...tools,
    debugger: tool<DebuggerInput, DebuggerResult>({
      description: 'Read console logs, network logs, failed requests, evaluate main-world JavaScript, or call CDP. Cookies are blocked.',
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

  constructor(sendMessage: SendMessage, windowId: number | undefined, runSandbox: RunSandbox, browserJsEnabled: boolean) {
    this.sendMessage = sendMessage;
    this.windowId = windowId;
    this.runSandbox = runSandbox;
    this.browserJsEnabled = browserJsEnabled;
  }

  getDocument(input: GetDocumentInput, abortSignal?: AbortSignal) {
    return createGetDocumentController({
      getCurrentTabId: () => this.getCurrentTabId(),
      executeInTab: (tabId, nextInput) => this.extractPageDocument(tabId, nextInput, abortSignal),
      fetchArrayBuffer: (url) => abortable(() => fetch(url).then(requireOk).then((response) => response.arrayBuffer()), abortSignal),
    }).run(input);
  }

  extractImage(input: ExtractImageInput, abortSignal?: AbortSignal) {
    return createExtractImageController({
      getCurrentTabId: () => this.getCurrentTabId(),
      captureVisibleTab: (nextInput) => this.captureVisibleTab(nextInput, abortSignal),
      executeInTab: (tabId, nextInput) => this.extractPageImage(tabId, nextInput, abortSignal),
    }).run(input);
  }

  async navigate(input: NavigateInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: navigateRequestType, input, windowId: this.windowId }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
    return response as NavigateResult;
  }

  browserRepl(input: BrowserReplInput, abortSignal?: AbortSignal) {
    return createBrowserReplController({
      getCurrentTabId: () => this.getCurrentTabId(),
      executePageCommand: (tabId, command, nextSignal) => this.executePageCommand(tabId, command, nextSignal),
      runSandbox: this.runSandbox,
      browserJsEnabled: this.browserJsEnabled,
    }).run(input, abortSignal);
  }

  async debugger(input: DebuggerInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: debuggerRequestType, input, windowId: this.windowId }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
    return response as DebuggerResult;
  }

  private async getCurrentTabId() {
    const tab = await this.sendMessage({ type: 'taber.background.currentTab', windowId: this.windowId });
    if (isRecord(tab) && typeof tab.error === 'string') throw new Error(tab.error);
    if (!isRecord(tab) || !Number.isInteger(tab.id) || Number(tab.id) <= 0) throw new Error('No active tab in the side panel window');
    return Number(tab.id);
  }

  private async extractPageDocument(tabId: number, input: GetDocumentInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.getDocument.extractPage', tabId, input }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(new Error(response.error));
    return response as PageDocument;
  }

  private async captureVisibleTab(input: ExtractImageInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.extractImage.captureVisibleTab', input, windowId: this.windowId }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
    return String(response);
  }

  private async extractPageImage(tabId: number, input: ExtractImageInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.extractImage.extractPage', tabId, input }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(new Error(response.error));
    return response as ExtractImageResult;
  }

  private async executePageCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    try {
      return await this.executeUserScriptCommand(tabId, command, abortSignal);
    } catch (error) {
      if (!DEBUGGER_ENABLED || !canUseCdpFallback(command, error)) throw error;
      try {
        return await executeBrowserReplCdpFallback({
          tabId,
          command,
          runPageCommand: (fallbackCommand) => this.executeUserScriptCommand(tabId, fallbackCommand, abortSignal),
          callChromeApi: (action, args) => this.callChromeApi(action, args, abortSignal),
          abortSignal,
        });
      } catch (fallbackError) {
        throw new Error(`browserRepl ${command.helper} failed; CDP fallback failed: ${stringifyError(fallbackError)}; original: ${stringifyError(error)}`);
      }
    }
  }

  private async executeUserScriptCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal): Promise<unknown> {
    const cleanupAbort = this.cancelPageCommandOnAbort(tabId, command, abortSignal);
    const cleanupBrowserJs = this.terminateBrowserJsOnAbort(tabId, command, abortSignal);
    try {
      const injection = {
        target: { tabId },
        js: [{ code: createBrowserReplUserScript(command) }],
        taberTimeoutMs: (command.timeoutMs ?? DEFAULT_BROWSER_REPL_TIMEOUT_MS) + 1_000,
        ...(command.helper === 'browserjs' ? { world: 'MAIN' } : {}),
      };
      const response = await abortable(
        () => this.callChromeApi('userScripts.execute', [injection]),
        abortSignal,
      ).catch((error) => {
        if (isUserScriptsUnavailable(error)) return undefined;
        throw normalizePageExecutionError(error);
      });
      if (isRecord(response) && typeof response.error === 'string') {
        if (response.error.includes('chrome.userScripts') || response.error.includes('did not return a result')) return this.executePageFallback(tabId, command, abortSignal);
        throw new Error(response.error);
      }
      const result = Array.isArray(response) ? response[0]?.result : undefined;
      if (!isRecord(result)) return this.executePageFallback(tabId, command, abortSignal);
      if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'browserRepl page execution failed');
      return result.value;
    } finally {
      cleanupAbort();
      cleanupBrowserJs();
    }
  }

  private executePageFallback(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    const fallback = browserReplFallbackFor(command);
    if (fallback === 'browserjsCdp') {
      if (DEBUGGER_ENABLED) return this.executeBrowserJsCdp(tabId, command, abortSignal);
      throw new Error(userScriptsErrorMessage());
    }
    if (fallback === 'pressCdp') {
      if (DEBUGGER_ENABLED) return this.executeCdpPageCommand(tabId, command, abortSignal);
      throw new Error('press native fallback requires the Taber debug build');
    }
    return this.executeScriptingPageCommand(tabId, command, abortSignal);
  }

  private executeCdpPageCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    return executeBrowserReplCdpFallback({
      tabId,
      command,
      abortSignal,
      runPageCommand: (fallbackCommand) => this.executeUserScriptCommand(tabId, fallbackCommand, abortSignal),
      callChromeApi: (action, args) => this.callChromeApi(action, args, abortSignal),
    });
  }

  private async executeBrowserJsCdp(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    const debuggee = { tabId };
    const shouldDetach = await this.attachDebugger(debuggee, abortSignal);
    try {
      const response = await this.evaluateBrowserJs(debuggee, command, abortSignal);
      const result = isRecord(response) && isRecord(response.result) ? response.result.value : undefined;
      if (!isRecord(result)) throw new Error('browserjs CDP fallback returned no result');
      if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'browserjs CDP fallback failed');
      return result.value;
    } finally {
      if (shouldDetach) await this.callChromeApi('debugger.detach', [debuggee]).catch(() => undefined);
    }
  }

  private async attachDebugger(debuggee: { tabId: number }, abortSignal?: AbortSignal) {
    if (abortSignal?.aborted) throw new Error('Task aborted');
    let aborted = false;
    const abort = () => { aborted = true; };
    abortSignal?.addEventListener('abort', abort, { once: true });
    try {
      const attachedHere = await this.callChromeApi('debugger.attach', [debuggee, '1.3']).then(
        () => true,
        (error) => {
          if (String(error).includes('Another debugger') || String(error).includes('already attached')) return false;
          throw error;
        },
      );
      if (aborted || abortSignal?.aborted) {
        await this.callChromeApi('debugger.sendCommand', [debuggee, 'Runtime.terminateExecution']).catch(() => undefined);
        if (attachedHere) await this.callChromeApi('debugger.detach', [debuggee]).catch(() => undefined);
        throw new Error('Task aborted');
      }
      return attachedHere;
    } finally {
      abortSignal?.removeEventListener('abort', abort);
    }
  }

  private evaluateBrowserJs(debuggee: { tabId: number }, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    if (abortSignal?.aborted) return Promise.reject(new Error('Task aborted'));
    const timeoutMs = command.timeoutMs ?? DEFAULT_BROWSER_REPL_TIMEOUT_MS;
    let timeoutId: ReturnType<typeof setTimeout>;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timeoutId); abortSignal?.removeEventListener('abort', abort); };
      const finish = (callback: () => void) => { if (!settled) { settled = true; cleanup(); callback(); } };
      const terminate = () => void this.callChromeApi('debugger.sendCommand', [debuggee, 'Runtime.terminateExecution']).catch(() => undefined);
      const fail = (error: Error) => finish(() => { terminate(); reject(error); });
      const abort = () => fail(new Error('Task aborted'));
      abortSignal?.addEventListener('abort', abort, { once: true });
      timeoutId = setTimeout(() => fail(new Error(`browserjs timed out after ${timeoutMs}ms`)), timeoutMs);
      void this.callChromeApi('debugger.sendCommand', [debuggee, 'Runtime.evaluate', { expression: createBrowserReplUserScript(command), awaitPromise: true, returnByValue: true }]).then(
        (value) => finish(() => resolve(value)),
        (error) => fail(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  private async executeScriptingPageCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    const cleanupAbort = this.cancelPageCommandOnAbort(tabId, command, abortSignal);
    try {
      const response = await abortable(() => this.sendMessage({ type: 'taber.browserRepl.scriptingCommand', tabId, command }), abortSignal);
      if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(new Error(response.error));
      return response;
    } finally {
      cleanupAbort();
    }
  }

  private cancelPageCommandOnAbort(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    if (!abortSignal || !command.cancelKey) return () => undefined;
    const cancel = () => { void this.sendMessage({ type: 'taber.browserRepl.cancelPageCommand', tabId, cancelKey: command.cancelKey }).catch(() => undefined); };
    abortSignal.addEventListener('abort', cancel, { once: true });
    return () => abortSignal.removeEventListener('abort', cancel);
  }

  private terminateBrowserJsOnAbort(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    if (!DEBUGGER_ENABLED || !abortSignal || command.helper !== 'browserjs') return () => undefined;
    const terminate = () => void this.terminatePageExecution(tabId).catch(() => undefined);
    abortSignal.addEventListener('abort', terminate, { once: true });
    return () => abortSignal.removeEventListener('abort', terminate);
  }

  private async terminatePageExecution(tabId: number) {
    const debuggee = { tabId };
    const shouldDetach = await this.callChromeApi('debugger.attach', [debuggee, '1.3']).then(() => true, () => false);
    try {
      await this.callChromeApi('debugger.sendCommand', [debuggee, 'Runtime.terminateExecution']);
    } finally {
      if (shouldDetach) await this.callChromeApi('debugger.detach', [debuggee]).catch(() => undefined);
    }
  }

  private async callChromeApi(action: ChromeApiAction, args: unknown[], abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: chromeApiRequestType, action, args }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw new Error(response.error);
    return response;
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

function extractImageToModelOutput({ output }: { output: ExtractImageResult }) {
  if (output.ok === false || !output.dataUrl) return { type: 'json' as const, value: toJsonValue(output) };

  const file = fileDataFromDataUrl(output.dataUrl, output.mediaType);
  if (!file) return { type: 'json' as const, value: toJsonValue(output) };
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: `extractImage: ${JSON.stringify(imageMetadata(output))}` },
      { type: 'file-data' as const, mediaType: file.mediaType, data: file.data },
    ],
  };
}

function imageMetadata(output: Exclude<ExtractImageResult, { ok: false }>) {
  const { dataUrl: _dataUrl, ...metadata } = output;
  return metadata;
}

function fileDataFromDataUrl(dataUrl: string, fallbackMediaType?: string) {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) return undefined;
  const parsedMediaType = match[1].split(';')[0];
  const mediaType = fallbackMediaType ?? (parsedMediaType || 'application/octet-stream');
  const data = /(^|;)base64(?:;|$)/i.test(match[1]) ? match[2] : bytesToBase64(dataUrlPayloadBytes(match[2]));
  return { mediaType, data };
}

function dataUrlPayloadBytes(payload: string) {
  const bytes: number[] = [];
  let text = '';
  const textEncoder = new TextEncoder();
  const flushText = () => {
    if (!text) return;
    bytes.push(...textEncoder.encode(text));
    text = '';
  };
  for (let index = 0; index < payload.length; index += 1) {
    if (payload[index] !== '%' || !isHexByte(payload.slice(index + 1, index + 3))) {
      text += payload[index];
      continue;
    }
    flushText();
    bytes.push(Number.parseInt(payload.slice(index + 1, index + 3), 16));
    index += 2;
  }
  flushText();
  return Uint8Array.from(bytes);
}

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

function isHexByte(value: string) {
  return /^[\da-f]{2}$/i.test(value);
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
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

function isUserScriptsUnavailable(error: unknown) {
  const message = stringifyError(error);
  return message.includes('chrome.userScripts') || message.includes('did not return a result');
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
