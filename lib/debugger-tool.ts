import { assertAllowedCdpMethod, assertNoCookieExposure, prepareCdpParams, wrapCookieBlockedExpression } from './debugger-cookie-guard.ts';

export const debuggerRequestType = 'taber.debugger.request';

export type DebuggerAction = 'attach' | 'consoleLogs' | 'networkLogs' | 'failedRequests' | 'evaluate' | 'cdp' | 'detach';

export type DebuggerInput = {
  action?: DebuggerAction;
  tabId?: number;
  expression?: string;
  method?: string;
  params?: Record<string, unknown>;
  limit?: number;
};

export type ConsoleLog = { time: number; level: string; text: string; url?: string };
export type NetworkLog = { requestId: string; url: string; method?: string; status?: number; errorText?: string; type?: string; time: number };

export type DebuggerResult =
  | { action: DebuggerAction; attached: boolean; tabId: number }
  | { action: 'consoleLogs'; tabId: number; logs: ConsoleLog[] }
  | { action: 'networkLogs' | 'failedRequests'; tabId: number; requests: NetworkLog[] }
  | { action: 'evaluate' | 'cdp'; tabId: number; value: unknown };

export const debuggerInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['attach', 'consoleLogs', 'networkLogs', 'failedRequests', 'evaluate', 'cdp', 'detach'], description: 'Debugger action. Defaults to failedRequests.' },
    tabId: { type: 'integer', minimum: 1 },
    expression: { type: 'string', description: 'Main world JavaScript expression for evaluate.' },
    method: { type: 'string', description: 'CDP method for cdp action. Cookie methods are blocked.' },
    params: { type: 'object', additionalProperties: true },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
} as const;

type Debuggee = { tabId: number };
type DebuggerApi = {
  attach(debuggee: Debuggee, version: string): Promise<void>;
  detach(debuggee: Debuggee): Promise<void>;
  sendCommand(debuggee: Debuggee, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent: BrowserEvent<(source: Debuggee, method: string, params?: Record<string, unknown>) => void>;
  onDetach?: BrowserEvent<(source: Debuggee) => void>;
};
type BrowserEvent<Listener extends (...args: never[]) => void> = { addListener(listener: Listener): void; removeListener(listener: Listener): void };

type TabDebugState = { attached: boolean; consoleLogs: ConsoleLog[]; networkLogs: Map<string, NetworkLog> };

export function createDebuggerController(options: { debuggerApi: DebuggerApi; getCurrentTabId(): Promise<number> }) {
  const states = new Map<number, TabDebugState>();
  const onEvent = (source: Debuggee, method: string, params?: Record<string, unknown>) => handleEvent(requireTabId(source), method, params ?? {});
  const onDetach = (source: Debuggee) => {
    const state = states.get(requireTabId(source));
    if (state) state.attached = false;
  };
  options.debuggerApi.onEvent.addListener(onEvent);
  options.debuggerApi.onDetach?.addListener(onDetach);

  async function run(value: unknown): Promise<DebuggerResult> {
    const input = parseDebuggerInput(value);
    const action = input.action ?? 'failedRequests';
    const tabId = input.tabId ?? (await options.getCurrentTabId());
    if (action === 'detach') return detach(tabId);
    await ensureAttached(tabId);
    if (action === 'attach') return { action, attached: true, tabId };
    if (action === 'consoleLogs') return { action, tabId, logs: last(stateFor(tabId).consoleLogs, input.limit) };
    if (action === 'networkLogs') return { action, tabId, requests: last([...stateFor(tabId).networkLogs.values()], input.limit) };
    if (action === 'failedRequests') return { action, tabId, requests: last([...stateFor(tabId).networkLogs.values()].filter(isFailed), input.limit) };
    if (action === 'evaluate') return { action, tabId, value: await evaluate(tabId, input.expression) };
    return { action, tabId, value: await sendCdp(tabId, input.method, input.params) };
  }

  async function ensureAttached(tabId: number) {
    const state = stateFor(tabId);
    if (state.attached) return;
    const debuggee = { tabId };
    await options.debuggerApi.attach(debuggee, '1.3');
    try {
      clearDebuggerState(state);
      const enabled = await Promise.allSettled([
        options.debuggerApi.sendCommand(debuggee, 'Runtime.enable'),
        options.debuggerApi.sendCommand(debuggee, 'Log.enable'),
        options.debuggerApi.sendCommand(debuggee, 'Network.enable'),
      ]);
      const failed = enabled.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      state.attached = true;
    } catch (error) {
      state.attached = false;
      await options.debuggerApi.detach(debuggee).catch(() => undefined);
      throw error;
    }
  }

  async function detach(tabId: number): Promise<DebuggerResult> {
    const state = stateFor(tabId);
    if (!state.attached) return { action: 'detach', attached: false, tabId };
    try {
      await options.debuggerApi.detach({ tabId });
      state.attached = false;
      clearDebuggerState(state);
      return { action: 'detach', attached: false, tabId };
    } catch (error) {
      if (!isMissingDebuggerSessionError(error)) throw error;
      state.attached = false;
      clearDebuggerState(state);
      return { action: 'detach', attached: false, tabId };
    }
  }

  function evaluate(tabId: number, expression: string | undefined) {
    if (!expression?.trim()) throw new Error('debugger.evaluate requires expression');
    assertNoCookieExposure(expression);
    return options.debuggerApi.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: wrapCookieBlockedExpression(expression),
      awaitPromise: true,
      returnByValue: true,
    }).then(readEvaluationValue);
  }

  async function sendCdp(tabId: number, method: string | undefined, params?: Record<string, unknown>) {
    if (!method?.trim()) throw new Error('debugger.cdp requires method');
    assertAllowedCdpMethod(method);
    const safeParams = prepareCdpParams(method, params);
    const result = await options.debuggerApi.sendCommand({ tabId }, method, safeParams);
    if (method === 'Runtime.evaluate') rejectCookieEvaluationException(result);
    return result;
  }

  function handleEvent(tabId: number, method: string, params: Record<string, unknown>) {
    const state = stateFor(tabId);
    if (method === 'Runtime.consoleAPICalled') rememberConsole(state, readRuntimeConsole(params));
    if (method === 'Log.entryAdded') rememberConsole(state, readLogEntry(params));
    if (method === 'Network.requestWillBeSent') rememberRequest(state, params);
    if (method === 'Network.responseReceived') rememberResponse(state, params);
    if (method === 'Network.loadingFailed') rememberFailure(state, params);
  }

  function stateFor(tabId: number): TabDebugState {
    let state = states.get(tabId);
    if (!state) {
      state = { attached: false, consoleLogs: [], networkLogs: new Map() };
      states.set(tabId, state);
    }
    return state;
  }

  return { run, dispose: () => { options.debuggerApi.onEvent.removeListener(onEvent); options.debuggerApi.onDetach?.removeListener(onDetach); } };
}

export function parseDebuggerInput(value: unknown): DebuggerInput {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('debugger input must be an object');
  const input: DebuggerInput = {};
  if ('action' in value) input.action = readAction(value.action);
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  if ('expression' in value) input.expression = readString(value.expression, 'expression');
  if ('method' in value) input.method = readString(value.method, 'method');
  if ('params' in value) input.params = readParams(value.params);
  if ('limit' in value) input.limit = readLimit(value.limit);
  return input;
}

function clearDebuggerState(state: TabDebugState) {
  state.consoleLogs = [];
  state.networkLogs.clear();
}

function rememberConsole(state: TabDebugState, log?: ConsoleLog) {
  if (!log) return;
  state.consoleLogs.push(log);
  if (state.consoleLogs.length > 200) state.consoleLogs.splice(0, state.consoleLogs.length - 200);
}

function readRuntimeConsole(params: Record<string, unknown>): ConsoleLog | undefined {
  const args = Array.isArray(params.args) ? params.args : [];
  return { time: readEventTime(params), level: typeof params.type === 'string' ? params.type : 'log', text: args.map(readRemoteValue).join(' '), url: readConsoleUrl(params) };
}

function readLogEntry(params: Record<string, unknown>): ConsoleLog | undefined {
  const entry = isRecord(params.entry) ? params.entry : undefined;
  if (!entry) return undefined;
  return { time: readEventTime(entry), level: String(entry.level ?? 'log'), text: String(entry.text ?? ''), url: typeof entry.url === 'string' ? entry.url : undefined };
}

function rememberRequest(state: TabDebugState, params: Record<string, unknown>) {
  const requestId = readRequestId(params);
  const request = isRecord(params.request) ? params.request : {};
  const current = state.networkLogs.get(requestId);
  state.networkLogs.set(requestId, {
    requestId,
    url: typeof request.url === 'string' ? request.url : current?.url ?? '',
    method: typeof request.method === 'string' ? request.method : current?.method,
    status: current?.status,
    errorText: current?.errorText,
    type: typeof params.type === 'string' ? params.type : current?.type,
    time: readEventTime(params),
  });
}

function rememberResponse(state: TabDebugState, params: Record<string, unknown>) {
  const requestId = readRequestId(params);
  const response = isRecord(params.response) ? params.response : undefined;
  if (!response) return;
  const request = state.networkLogs.get(requestId) ?? { requestId, url: typeof response.url === 'string' ? response.url : '', time: readEventTime(params) };
  const status = Number(response.status);
  if (Number.isFinite(status)) request.status = status;
  if (!request.url && typeof response.url === 'string') request.url = response.url;
  if (typeof params.type === 'string') request.type = params.type;
  state.networkLogs.set(requestId, request);
}

function rememberFailure(state: TabDebugState, params: Record<string, unknown>) {
  const requestId = readRequestId(params);
  const request = state.networkLogs.get(requestId) ?? { requestId, url: '', time: readEventTime(params) };
  request.errorText = String(params.errorText ?? 'Network.loadingFailed');
  if (typeof params.type === 'string') request.type = params.type;
  state.networkLogs.set(requestId, request);
}

function isFailed(request: NetworkLog) {
  return request.errorText !== undefined || (request.status !== undefined && request.status >= 400);
}

function readConsoleUrl(params: Record<string, unknown>) {
  if (typeof params.url === 'string') return params.url;
  const stackTrace = isRecord(params.stackTrace) ? params.stackTrace : undefined;
  const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];
  const frame = callFrames.find((item) => isRecord(item) && typeof item.url === 'string' && item.url.length > 0);
  return isRecord(frame) ? frame.url as string : undefined;
}

function readEventTime(params: Record<string, unknown>) {
  if (typeof params.wallTime === 'number' && Number.isFinite(params.wallTime)) return Math.round(params.wallTime * 1000);
  if (typeof params.timestamp === 'number' && Number.isFinite(params.timestamp)) return Math.round(params.timestamp * 1000);
  return Date.now();
}

function isMissingDebuggerSessionError(error: unknown) {
  return /not attached|no target|cannot detach|No tab with given id/i.test(error instanceof Error ? error.message : String(error));
}

function last<T>(items: T[], limit = 50) {
  return items.slice(-limit);
}

function rejectCookieEvaluationException(result: unknown) {
  if (isRecord(result) && isRecord(result.exceptionDetails) && /debugger does not expose cookies/.test(readExceptionText(result.exceptionDetails))) throw new Error('debugger does not expose cookies');
}

function readEvaluationValue(result: unknown) {
  if (!isRecord(result)) return result;
  if (isRecord(result.exceptionDetails)) throw new Error(`debugger.evaluate failed: ${readExceptionText(result.exceptionDetails)}`);
  const remoteObject = isRecord(result.result) ? result.result : undefined;
  if (!remoteObject) return result;
  if ('value' in remoteObject) return remoteObject.value;
  if ('unserializableValue' in remoteObject) return remoteObject.unserializableValue;
  if ('description' in remoteObject) return remoteObject.description;
  return undefined;
}

function readExceptionText(exceptionDetails: Record<string, unknown>) {
  const exception = isRecord(exceptionDetails.exception) ? exceptionDetails.exception : undefined;
  if (exception && typeof exception.description === 'string') return exception.description;
  if (typeof exceptionDetails.text === 'string') return exceptionDetails.text;
  return 'Runtime.evaluate exception';
}

function readRemoteValue(value: unknown) {
  if (!isRecord(value)) return String(value);
  if ('value' in value) return String(value.value);
  if ('unserializableValue' in value) return String(value.unserializableValue);
  if ('description' in value) return String(value.description);
  return '';
}

function readRequestId(params: Record<string, unknown>) {
  if (typeof params.requestId === 'string') return params.requestId;
  throw new Error('Debugger event missing requestId');
}

function requireTabId(source: Debuggee) {
  if (Number.isInteger(source.tabId) && source.tabId > 0) return source.tabId;
  throw new Error('Debugger event missing tabId');
}

function readAction(value: unknown): DebuggerAction {
  if (value === 'attach' || value === 'consoleLogs' || value === 'networkLogs' || value === 'failedRequests' || value === 'evaluate' || value === 'cdp' || value === 'detach') return value;
  throw new Error(`Invalid debugger action: ${String(value)}`);
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function readParams(value: unknown) {
  if (isRecord(value)) return value;
  throw new Error('params must be an object');
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function readLimit(value: unknown) {
  const limit = readPositiveInteger(value, 'limit');
  if (limit > 200) throw new Error('limit must be <= 200');
  return limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
