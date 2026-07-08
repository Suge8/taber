import { isPageAccessError, pageAccessErrorMessage, userScriptsErrorMessage } from './browser-access.ts';
import { DEFAULT_BROWSER_REPL_TIMEOUT_MS, browserJsPageResult, browserReplFallbackFor, type BrowserReplPageCommand } from './browser-repl.ts';
import { canUseCdpFallback, executeBrowserReplCdpFallback } from './browser-repl-cdp.ts';
import { createBrowserFrameRouter } from './browser-frame-router.ts';
import { createBrowserReplUserScript } from './browser-repl-page.ts';
import { chromeApiRequestType, type ChromeApiAction } from './chrome-api-broker.ts';
import { DEBUGGER_ENABLED } from './runtime-flags.ts';

type SendMessage = (message: unknown) => Promise<unknown>;
type ReadTargetTabId = () => number | undefined;
type ErrorFromResponse = (message: string) => Promise<Error>;

export function createBrowserReplPageExecutor(options: {
  sendMessage: SendMessage;
  readTargetTabId: ReadTargetTabId;
  errorFromResponse: ErrorFromResponse;
}) {
  return new BrowserReplPageExecutor(options);
}

class BrowserReplPageExecutor {
  private readonly sendMessage: SendMessage;
  private readonly readTargetTabId: ReadTargetTabId;
  private readonly errorFromResponse: ErrorFromResponse;
  private readonly browserFrameRouter: ReturnType<typeof createBrowserFrameRouter>;

  constructor(options: { sendMessage: SendMessage; readTargetTabId: ReadTargetTabId; errorFromResponse: ErrorFromResponse }) {
    this.sendMessage = options.sendMessage;
    this.readTargetTabId = options.readTargetTabId;
    this.errorFromResponse = options.errorFromResponse;
    this.browserFrameRouter = createBrowserFrameRouter({
      runFrameCommand: (tabId, frameId, command, abortSignal) => this.executeFramePageCommand(tabId, frameId, command, abortSignal),
      callChromeApi: (action, args, abortSignal) => this.callChromeApi(action, args, abortSignal),
    });
  }

  async executePageCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    try {
      if (command.helper === 'browser') return this.browserFrameRouter.execute(tabId, command, abortSignal);
      const result = await this.executeUserScriptCommand(tabId, command, abortSignal);
      return await this.executeBrowserNativeFallbackIfNeeded(tabId, command, result, abortSignal);
    } catch (error) {
      if (isTaskAborted(error) || abortSignal?.aborted || !DEBUGGER_ENABLED || !canUseCdpFallback(command, error)) throw error;
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

  private async executeFramePageCommand(tabId: number, frameId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    const frameCommand = { ...command, frameId };
    const result = await this.executeUserScriptCommand(tabId, frameCommand, abortSignal);
    return this.executeBrowserNativeFallbackIfNeeded(tabId, frameCommand, result, abortSignal);
  }

  private async executeBrowserNativeFallbackIfNeeded(tabId: number, command: BrowserReplPageCommand, result: unknown, abortSignal?: AbortSignal) {
    const fallbackCommand = browserNativeFallbackCommand(command, result);
    if (!DEBUGGER_ENABLED || !fallbackCommand) return result;
    try {
      const native = await this.executeCdpPageCommand(tabId, fallbackCommand, abortSignal);
      const state = await this.executeUserScriptCommand(tabId, { helper: 'browser', args: [browserSnapshotInput(command)] }, abortSignal);
      return { ok: true, action: fallbackCommand.helper, message: 'Used CDP/native fallback after DOM action failed.', evidence: { fallback: 'cdp/native', original: browserFailureSummary(result), native }, state: isRecord(state) ? state.state : undefined };
    } catch (error) {
      return browserFallbackFailedResult(result, error);
    }
  }

  private async executeUserScriptCommand(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal): Promise<unknown> {
    if (requiresScriptingCancel(command)) return this.executeScriptingPageCommand(tabId, command, abortSignal);
    const cleanupAbort = this.cancelPageCommandOnAbort(tabId, command, abortSignal);
    const cleanupBrowserJs = this.terminateBrowserJsOnAbort(tabId, command, abortSignal);
    try {
      const pageCommand = pageCommandForInjection(command);
      const injection = {
        target: command.frameId === undefined ? { tabId } : { tabId, frameIds: [command.frameId] },
        js: [{ code: createBrowserReplUserScript(pageCommand) }],
        taberTimeoutMs: (command.timeoutMs ?? DEFAULT_BROWSER_REPL_TIMEOUT_MS) + 1_000,
        ...(pageCommand.helper === 'browserjs' ? { world: 'MAIN' } : {}),
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
        throw await this.errorFromResponse(response.error);
      }
      const result = Array.isArray(response) ? response[0]?.result : undefined;
      if (!isRecord(result)) return this.executePageFallback(tabId, command, abortSignal);
      if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'browserRepl page execution failed');
      return pageCommand.helper === 'browserjs' ? browserJsPageResult(result.value, result.console) : result.value;
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
      return browserJsPageResult(result.value, result.console);
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
      const response = await abortable(() => this.sendMessage({ type: 'taber.browserRepl.scriptingCommand', tabId, frameId: command.frameId, command: pageCommandForInjection(command), targetTabId: this.readTargetTabId() }), abortSignal);
      if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(await this.errorFromResponse(response.error));
      return response;
    } finally {
      cleanupAbort();
    }
  }

  private cancelPageCommandOnAbort(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    if (!abortSignal || !command.cancelKey) return () => undefined;
    const cancel = () => { void this.sendMessage({ type: 'taber.browserRepl.cancelPageCommand', tabId, cancelKey: command.cancelKey, targetTabId: this.readTargetTabId() }).catch(() => undefined); };
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
    const response = await abortable(() => this.sendMessage({ type: chromeApiRequestType, action, args, targetTabId: this.readTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw await this.errorFromResponse(response.error);
    return response;
  }
}

function browserNativeFallbackCommand(command: BrowserReplPageCommand, result: unknown): BrowserReplPageCommand | undefined {
  if (command.frameId !== undefined && command.frameId !== 0) return undefined;
  if (command.helper !== 'browser' || !isRecord(result) || result.ok !== false) return undefined;
  const input = isRecord(command.args[0]) ? command.args[0] : undefined;
  const action = typeof input?.action === 'string' ? input.action : '';
  if (action !== 'click' && action !== 'fill' && action !== 'press') return undefined;
  if (typeof result.code === 'string' && result.code !== 'ACTION_FAILED') return undefined;
  const selector = browserFailureSelector(result);
  if (!selector) return undefined;
  const error = new Error(typeof result.message === 'string' ? result.message : 'browser DOM action failed');
  if (!canUseCdpFallback({ helper: action, args: [] }, error)) return undefined;
  if (action === 'click') return { helper: 'click', args: [selector] };
  if (action === 'fill') return typeof input?.value === 'string' ? { helper: 'fill', args: [selector, input.value] } : undefined;
  return typeof input?.key === 'string' ? { helper: 'press', args: [selector, input.key] } : undefined;
}

function pageCommandForInjection(command: BrowserReplPageCommand): BrowserReplPageCommand {
  const { frameId: _frameId, ...pageCommand } = command;
  return pageCommand;
}

function browserSnapshotInput(command: BrowserReplPageCommand) {
  const input = isRecord(command.args[0]) ? command.args[0] : {};
  return { action: 'snapshot', ...(typeof input.scope === 'string' ? { scope: input.scope } : {}), ...(typeof input.limit === 'number' ? { limit: input.limit } : {}) };
}

function browserFailureSelector(result: Record<string, unknown>) {
  const evidence = isRecord(result.evidence) ? result.evidence : undefined;
  return typeof evidence?.selector === 'string' && evidence.selector ? evidence.selector : undefined;
}

function browserFailureSummary(result: unknown) {
  if (!isRecord(result)) return { message: String(result) };
  return { ...(typeof result.code === 'string' ? { code: result.code } : {}), ...(typeof result.message === 'string' ? { message: result.message } : {}) };
}

function browserFallbackFailedResult(result: unknown, error: unknown) {
  if (!isRecord(result)) throw error;
  const summary = browserFailureSummary(result);
  return { ...result, message: `browser ${String(result.action ?? 'action')} failed; CDP/native fallback failed: ${stringifyError(error)}; original: ${String(summary.message ?? 'browser DOM action failed')}`, evidence: { ...(isRecord(result.evidence) ? result.evidence : {}), fallback: 'cdp/native', fallbackError: stringifyError(error) } };
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

function normalizePageExecutionError(error: unknown) {
  return isPageAccessError(error) ? new Error(pageAccessErrorMessage()) : error instanceof Error ? error : new Error(String(error));
}

function isUserScriptsUnavailable(error: unknown) {
  const message = stringifyError(error);
  return message.includes('chrome.userScripts') || message.includes('did not return a result');
}

function requiresScriptingCancel(command: BrowserReplPageCommand) {
  return command.helper === 'pickUserElement' || command.helper === 'waitFor' || (command.helper === 'batch' && Array.isArray(command.args[0]) && command.args[0].some((action) => isRecord(action) && (action.action === 'waitFor' || action.type === 'waitFor')));
}

function isTaskAborted(error: unknown) {
  return stringifyError(error) === 'Task aborted';
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
