import { jsonSchema, tool } from 'ai';
import { appendToolRun } from './db.ts';
import { DEFAULT_BROWSER_TOOL_TIMEOUT_MS, browserDescription, browserInputJsonSchema, parseBrowserInput, type BrowserInput, type BrowserResult } from './browser-tool.ts';
import { isPageAccessError, pageAccessErrorMessage } from './browser-access.ts';
import { browserReplToolHelperNames, createBrowserReplController, createBrowserReplInputJsonSchema, parseBrowserReplInput, type BrowserReplInput, type BrowserReplResult, type BrowserReplSuccess } from './browser-repl.ts';
import { runBrowserReplInSandbox } from './browser-repl-sandbox.ts';
import { createBrowserReplPageExecutor } from './browser-repl-executor.ts';
import { extractImageToModelOutput } from './agent-tool-image-output.ts';
import { debuggerInputJsonSchema, debuggerRequestType, parseDebuggerInput, type DebuggerInput, type DebuggerResult } from './debugger-tool.ts';
import { createExtractImageController, extractImageInputJsonSchema, parseExtractImageInput, type ExtractImageInput, type ExtractImageResult } from './extract-image.ts';
import { createGetDocumentController, getDocumentInputJsonSchema, parseGetDocumentInput, type GetDocumentInput, type GetDocumentResult, type PageDocument } from './get-document.ts';
import { navigateInputJsonSchema, navigateRequestType, parseNavigateInput, type NavigateInput, type NavigateResult } from './navigate.ts';
import { availableSkillPathsForUrl } from './skills.ts';
import { createFsController, fsInputJsonSchema, parseFsInput, type FsInput, type FsResult } from './fs-tool.ts';
import { readSessionFile, writeSessionFile } from './workspace-files.ts';
import { DEBUGGER_ENABLED } from './runtime-flags.ts';

type SendMessage = (message: unknown) => Promise<unknown>;
type NavigateToolFailure = {
  ok: false;
  action: NavigateInput['action'];
  code: 'TARGET_TAB_MISMATCH' | 'TARGET_NOT_OPERABLE' | 'NAVIGATION_FAILED';
  message: string;
  retryHint: string;
};
type NavigateToolResult = (NavigateResult & { availableSkills?: string[] }) | NavigateToolFailure;
type EmitEvent = (type: string, payload: unknown) => Promise<void>;
type RunSandbox = typeof runBrowserReplInSandbox;
type TargetChangeReason = 'openNew' | 'switchTab';
type TargetChanged = { fromTabId?: number; toTabId: number; reason: TargetChangeReason; tab?: unknown };

type AgentToolOptions = {
  sessionId: number;
  foregroundMode: boolean;
  taskId?: string;
  windowId?: number;
  targetTabId?: number;
  targetTabUrl?: string;
  getTargetTabId?: () => number | undefined;
  sendMessage: SendMessage;
  emitEvent: EmitEvent;
  onTargetChanged?: (change: TargetChanged) => Promise<void>;
  onTargetUnavailable?: (error: string) => Promise<void>;
  onAuditPersistenceFailure?: (error: string) => Promise<void>;
  runSandbox?: RunSandbox;
  browserJsEnabled?: boolean;
  profileAccess?: boolean;
};

export const AGENT_TOOL_SCHEMA_VERSION = 2;

const getDocumentDescription = 'Read webpage, PDF, or workspace file as structured content. Long content is saved to /workspace and the result carries a preview plus savedTo; read the file for the rest. Use when you need article text, page content, selection, or tables. Fetch-first: for public/static URLs prefer source:"url" (fetches the page or PDF directly, no tab, fast, parallelizable); use source:"currentPage" when content needs login, JS rendering, or the controlled tab. For currentPage: mode:"article" extracts main content, mode:"page" gets full text, mode:"selection" reads user selection. source:"file" reads an uploaded or generated /workspace file (pdf, docx, or text) as text. Results include open shadow root text and same-origin iframe content; cross-origin iframes show metadata with access hints.';
const extractImageDescription = 'Capture screenshots or extract images. Use source:"viewport" for visible area, source:"imageElement" for <img> URLs, source:"canvas" for canvas pixels, source:"backgroundImage" for CSS backgrounds. Viewport results include width/height: the viewport size in CSS px, the coordinate space for browser { x, y } targets (scale screenshot pixel coords by width/imageWidth). Viewport uses the controlled target; Chrome may briefly activate it to capture even when the task runs in background.';
const navigateDescription = 'Navigate tabs: open URLs, back/forward, reload, list/switch/close tabs, or read current tab. Current target is implicit: only switchTab and closeTab take tabId; omit unused fields. Changes target only on action:"switchTab" or open target:"new". Never use page location/history directly. navigation.status:"timeout" means the load event did not fire in time but the page is often already usable: check tab.url and continue with browser snapshot instead of retrying the same navigation.';
const debuggerDescription = 'Debug-build only: read console, network, failed requests, accessibility snapshots, main-world JS state, or raw CDP. Use for diagnosing console errors, network failures, and accessibility issues. Cookies are blocked.';
const fsDescription = 'Session file workspace and site skills. ls lists /workspace (uploads and outputs) and /skills (stored site knowledge). read returns file text. write saves text files (.md/.txt/.html/.csv/.json) or converts Markdown to Word (.docx); for PDF output write .md or .html and tell the user to export it from the sidebar. /skills/*.md files are reusable prior knowledge about sites: read matching skills before blind exploration; they are priors, live page state wins. After a task where you discovered a non-obvious reusable site flow or pitfall, write a concise skill file. Never store secrets or personal data.';

export function createAgentToolPromptEstimateText(options: { browserJsEnabled?: boolean } = {}) {
  return JSON.stringify({
    getDocument: { description: getDocumentDescription, inputSchema: getDocumentInputJsonSchema },
    extractImage: { description: extractImageDescription, inputSchema: extractImageInputJsonSchema },
    navigate: { description: navigateDescription, inputSchema: navigateInputJsonSchema },
    fs: { description: fsDescription, inputSchema: fsInputJsonSchema },
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
    'Single expressions return automatically; multi-statement code must return evidence. ' +
    `Helpers: ${helpers}. All helpers are async. Result shapes: const { elements } = await observe() or query(css); const { text } = await readVisibleText(); queryText("text") returns { count, matches, candidates }. Elements are serializable descriptors (name/value/index/selector), not DOM nodes. Pass the element object directly to actions: const {elements}=await query(css); await fill(elements[0], value); never pass a bare numeric index.${browserJsNote} ` +
    'Page reading: readVisibleText(), readLinksAndButtons(), listInteractiveElements(), queryText("text") cover main document, open shadow roots, and same-origin iframes; cross-origin frames show metadata. ' +
    'Element indexes from observe/query are scoped to one call; never reuse across calls. ' +
    'For page changes, use action auto-wait or waitFor; do not use sleep/setTimeout polling. ' +
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
    sessionId: options.sessionId,
    foregroundMode: options.foregroundMode,
    sendMessage: options.sendMessage,
    windowId: options.windowId,
    targetTabId: options.targetTabId,
    targetTabUrl: options.targetTabUrl,
    getTargetTabId: options.getTargetTabId,
    onTargetChanged: options.onTargetChanged,
    onTargetUnavailable: options.onTargetUnavailable,
    runSandbox: options.runSandbox ?? runBrowserReplInSandbox,
    browserJsEnabled,
  });
  // Skill freshness loop: after repeated tool failures, point the model back at skills it read this task.
  const staleSkillTracker: StaleSkillTracker = { readSkillPaths: [], consecutiveFailures: 0, hinted: false };
  const withRunLog = createRunLogger(options.sessionId, options.emitEvent, options.taskId, staleSkillTracker, options.onAuditPersistenceFailure);
  const serializeTargetOperation = createTargetOperationSerializer();
  const fsController = createFsController({ sessionId: options.sessionId, profileAccess: options.profileAccess });
  const tools = {
    getDocument: tool<GetDocumentInput, GetDocumentResult>({
      description: getDocumentDescription,
      inputSchema: jsonSchema<GetDocumentInput>(getDocumentInputJsonSchema, validator(parseGetDocumentInput)),
      execute: serializeTargetOperation(withRunLog('getDocument', (input, abortSignal) => runtime.getDocument(input, abortSignal)), (input) => input.source === 'currentPage'),
    }),
    extractImage: tool<ExtractImageInput, ExtractImageResult>({
      description: extractImageDescription,
      inputSchema: jsonSchema<ExtractImageInput>(extractImageInputJsonSchema, validator(parseExtractImageInput)),
      execute: serializeTargetOperation(withRunLog('extractImage', (input, abortSignal) => runtime.extractImage(input, abortSignal))),
      toModelOutput: extractImageToModelOutput,
    }),
    navigate: tool<NavigateInput, NavigateToolResult>({
      description: navigateDescription,
      inputSchema: jsonSchema<NavigateInput>(navigateInputJsonSchema, validator(parseNavigateInput)),
      execute: serializeTargetOperation(withRunLog('navigate', (input, abortSignal) => runtime.navigate(input, abortSignal)), (input) => input.action !== 'listTabs'),
    }),
    browser: tool<BrowserInput, BrowserResult>({
      description: browserDescription,
      inputSchema: jsonSchema<BrowserInput>(browserInputJsonSchema, validator(parseBrowserInput)),
      execute: serializeTargetOperation(withRunLog('browser', (input, abortSignal) => runtime.browser(input, abortSignal))),
    }),
    browserRepl: tool<BrowserReplInput, BrowserReplResult>({
      description: browserReplDescription(browserJsEnabled),
      inputSchema: jsonSchema<BrowserReplInput>(createBrowserReplInputJsonSchema({ browserJsEnabled }), validator(parseBrowserReplInput)),
      execute: serializeTargetOperation(withRunLog('browserRepl', (input, abortSignal) => runtime.browserRepl(input, abortSignal))),
    }),
    fs: tool<FsInput, FsResult>({
      description: fsDescription,
      inputSchema: jsonSchema<FsInput>(fsInputJsonSchema, validator(parseFsInput)),
      execute: withRunLog('fs', async (input) => {
        const result = await fsController.run(input);
        if (input.action === 'read' && input.path?.startsWith('/skills/') && !staleSkillTracker.readSkillPaths.includes(input.path)) {
          staleSkillTracker.readSkillPaths.push(input.path);
        }
        return result;
      }),
    }),
  };

  if (!DEBUGGER_ENABLED) return tools;
  return {
    ...tools,
    debugger: tool<DebuggerInput, DebuggerResult>({
      description: debuggerDescription,
      inputSchema: jsonSchema<DebuggerInput>(debuggerInputJsonSchema, validator(parseDebuggerInput)),
      execute: serializeTargetOperation(withRunLog('debugger', (input, abortSignal) => runtime.debugger(input, abortSignal))),
    }),
  };
}

class AgentToolRuntime {
  private readonly sessionId: number;
  private readonly sendMessage: SendMessage;
  private readonly windowId?: number;
  private readonly runSandbox: RunSandbox;
  private readonly browserJsEnabled: boolean;
  private readonly pageExecutor: ReturnType<typeof createBrowserReplPageExecutor>;
  private readonly getTargetTabId?: () => number | undefined;
  private readonly onTargetChanged?: (change: TargetChanged) => Promise<void>;
  private readonly onTargetUnavailable?: (error: string) => Promise<void>;
  private targetTabId?: number;
  private lastPageHost?: string;

  constructor(options: {
    sessionId: number;
    foregroundMode: boolean;
    sendMessage: SendMessage;
    windowId?: number;
    targetTabId?: number;
    targetTabUrl?: string;
    getTargetTabId?: () => number | undefined;
    onTargetChanged?: (change: TargetChanged) => Promise<void>;
    onTargetUnavailable?: (error: string) => Promise<void>;
    runSandbox: RunSandbox;
    browserJsEnabled: boolean;
  }) {
    this.sessionId = options.sessionId;
    this.sendMessage = (message) => options.sendMessage(withForegroundMode(message, options.foregroundMode));
    this.windowId = options.windowId;
    this.targetTabId = options.targetTabId;
    this.lastPageHost = readHost(options.targetTabUrl);
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

  async getDocument(input: GetDocumentInput, abortSignal?: AbortSignal) {
    const result = await createGetDocumentController({
      getCurrentTabId: () => this.getCurrentTabId(),
      executeInTab: (tabId, nextInput) => this.extractPageDocument(tabId, nextInput, abortSignal),
      fetchDocument: (url) => abortable(async () => {
        // Bound the fetch so a hanging server cannot stall the whole task.
        const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS);
        const response = await fetch(url, { redirect: 'follow', signal }).then(requireOk);
        return { contentType: response.headers.get('content-type') ?? '', data: await response.arrayBuffer(), finalUrl: response.url || undefined };
      }, abortSignal),
      readFile: async (name) => {
        const file = await readSessionFile(this.sessionId, name);
        return file ? { mimeType: file.mimeType, data: file.data } : undefined;
      },
    }).run(input);
    return spillLargeDocumentContent(result, (name, data) => writeSessionFile({ sessionId: this.sessionId, name, data }).then(() => undefined));
  }

  extractImage(input: ExtractImageInput, abortSignal?: AbortSignal) {
    return createExtractImageController({
      getCurrentTabId: () => this.getCurrentTabId(),
      captureVisibleTab: (nextInput) => this.captureVisibleTab(nextInput, abortSignal),
      executeInTab: (tabId, nextInput) => this.extractPageImage(tabId, nextInput, abortSignal),
    }).run(input);
  }

  async navigate(input: NavigateInput, abortSignal?: AbortSignal): Promise<NavigateToolResult> {
    const mismatch = this.navigateTargetMismatch(input);
    if (mismatch) return mismatch;
    const response = await abortable(() => this.sendMessage({ type: navigateRequestType, input, windowId: this.windowId, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') {
      if (isTargetUnavailableMessage(response.error)) throw await this.targetUnavailableError(response.error);
      return navigateFailure(input.action, response.error);
    }
    const result = response as NavigateResult;
    await this.applyNavigateTargetChange(input, result);
    return this.withAvailableSkills(result);
  }

  private async withAvailableSkills(result: NavigateResult): Promise<NavigateToolResult> {
    const paths = await this.skillsForHostChange(result.tab?.url ?? result.navigation?.url);
    return paths ? { ...result, availableSkills: paths } : result;
  }

  /** Single source for host-change skill announcements: returns matching /skills paths only when the host changed. */
  private async skillsForHostChange(url: string | undefined): Promise<string[] | undefined> {
    const host = readHost(url);
    if (!host || host === this.lastPageHost) return undefined;
    this.lastPageHost = host;
    const paths = await availableSkillPathsForUrl(url);
    return paths.length > 0 ? paths : undefined;
  }

  private async readTargetTabUrl(abortSignal?: AbortSignal): Promise<string | undefined> {
    if (abortSignal?.aborted) return undefined;
    try {
      const response = await this.sendMessage({ type: navigateRequestType, input: { action: 'currentTab' }, windowId: this.windowId, targetTabId: this.currentTargetTabId() });
      return isRecord(response) && isRecord(response.tab) && typeof response.tab.url === 'string' ? response.tab.url : undefined;
    } catch {
      return undefined;
    }
  }

  async browser(input: BrowserInput, abortSignal?: AbortSignal) {
    const canonicalInput = parseBrowserInput(input);
    const tabId = await this.getCurrentTabId();
    const result = await this.pageExecutor.executePageCommand(tabId, { helper: 'browser', args: [canonicalInput], cancelKey: crypto.randomUUID(), timeoutMs: DEFAULT_BROWSER_TOOL_TIMEOUT_MS }, abortSignal) as BrowserResult;
    return this.withPageHostSkills(result);
  }

  /** When an in-page action lands on a new host (e.g. a link click navigated), surface matching site skills. */
  private async withPageHostSkills(result: BrowserResult): Promise<BrowserResult & { availableSkills?: string[] }> {
    const state = isRecord(result.state) ? result.state : undefined;
    const paths = await this.skillsForHostChange(typeof state?.url === 'string' ? state.url : undefined);
    return paths ? { ...result, availableSkills: paths } : result;
  }

  async browserRepl(input: BrowserReplInput, abortSignal?: AbortSignal) {
    const result = await createBrowserReplController({
      getCurrentTabId: () => this.getCurrentTabId(),
      executePageCommand: (tabId, command, nextSignal) => this.pageExecutor.executePageCommand(tabId, command, nextSignal),
      runSandbox: this.runSandbox,
      navigate: (nextInput, nextSignal) => this.navigate(parseNavigateInput(nextInput), nextSignal),
      browserJsEnabled: this.browserJsEnabled,
    }).run(input, abortSignal);
    const spilled = await spillLargeReplValue(result, (name, data) => writeSessionFile({ sessionId: this.sessionId, name, data }).then(() => undefined));
    // REPL page actions can navigate across hosts; check the target tab afterwards.
    const paths = await this.skillsForHostChange(await this.readTargetTabUrl(abortSignal));
    return paths ? { ...spilled, availableSkills: paths } : spilled;
  }

  async debugger(input: DebuggerInput, abortSignal?: AbortSignal) {
    const canonicalInput = parseDebuggerInput(input);
    const response = await abortable(() => this.sendMessage({ type: debuggerRequestType, input: canonicalInput, windowId: this.windowId, targetTabId: this.currentTargetTabId() }), abortSignal);
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
    if (!isRecord(response) || typeof response.dataUrl !== 'string') throw new Error('extractImage.viewport returned no data URL');
    return { dataUrl: response.dataUrl, width: readPositiveNumber(response.width), height: readPositiveNumber(response.height) };
  }

  private async extractPageImage(tabId: number, input: ExtractImageInput, abortSignal?: AbortSignal) {
    const response = await abortable(() => this.sendMessage({ type: 'taber.extractImage.extractPage', tabId, input, targetTabId: this.currentTargetTabId() }), abortSignal);
    if (isRecord(response) && typeof response.error === 'string') throw normalizePageExecutionError(await this.errorFromResponse(response.error));
    return response as ExtractImageResult;
  }

  private navigateTargetMismatch(input: NavigateInput): NavigateToolFailure | undefined {
    if (input.action !== 'closeTab') return undefined;
    const targetTabId = this.currentTargetTabId();
    if (targetTabId === undefined || input.tabId === targetTabId) return undefined;
    return {
      ok: false,
      action: input.action,
      code: 'TARGET_TAB_MISMATCH',
      message: `navigate.closeTab is locked to target tab ${targetTabId}; received tabId ${input.tabId}.`,
      retryHint: 'Use navigate.switchTab to change the task target, or close the current target tab.',
    };
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
    if (fromTabId === tab.id) return;
    try {
      await this.onTargetChanged?.({ fromTabId, toTabId: tab.id, reason, tab });
    } catch (error) {
      throw new AuditPersistenceError(`Target persistence failure (${auditErrorName(error)}). The browser target may have changed; the task was stopped to avoid repeating operations.`, { cause: error });
    }
    this.targetTabId = tab.id;
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

function navigateFailure(action: NavigateInput['action'], message: string): NavigateToolFailure {
  if (/locked to target tab|Task is locked to target tab/i.test(message)) {
    return {
      ok: false,
      action,
      code: 'TARGET_TAB_MISMATCH',
      message,
      retryHint: 'Use navigate.switchTab to change the task target, or omit tabId when the current target is intended.',
    };
  }
  if (/not operable/i.test(message)) {
    return {
      ok: false,
      action,
      code: 'TARGET_NOT_OPERABLE',
      message,
      retryHint: 'Use navigate.listTabs and switch to an operable http/https tab, or open the URL in the current target.',
    };
  }
  return {
    ok: false,
    action,
    code: 'NAVIGATION_FAILED',
    message,
    retryHint: 'Inspect navigate.currentTab before retrying; if the URL did not change, use a different URL or report the failure.',
  };
}

// Context economy: oversized document content is spilled to /workspace so the
// model context and event log only carry a preview plus a stable file path.
export const DOCUMENT_SPILL_THRESHOLD_CHARS = 12_000;
export const DOCUMENT_SPILL_PREVIEW_CHARS = 4_000;

export async function spillLargeDocumentContent(
  result: GetDocumentResult,
  writeFile: (name: string, data: ArrayBuffer) => Promise<void>,
): Promise<GetDocumentResult & { savedTo?: string; hint?: string }> {
  if (!result.ok || result.source === 'file' || result.content.length <= DOCUMENT_SPILL_THRESHOLD_CHARS) return result;
  try {
    const name = `saved-${await shortContentHash(result.content)}.md`;
    await writeFile(name, new TextEncoder().encode(result.content).buffer as ArrayBuffer);
    return {
      ...result,
      content: result.content.slice(0, DOCUMENT_SPILL_PREVIEW_CHARS),
      truncated: true,
      savedTo: `/workspace/${name}`,
      hint: `Preview only; the full content (${result.contentChars} chars) is saved. Read it with fs read or getDocument source:"file".`,
    };
  } catch (error) {
    console.warn('Taber document spill skipped:', stringifyError(error));
    return result;
  }
}

export async function spillLargeReplValue(
  result: BrowserReplResult,
  writeFile: (name: string, data: ArrayBuffer) => Promise<void>,
): Promise<BrowserReplResult | (Omit<BrowserReplSuccess, 'value'> & { value: string; truncated: true; valueChars: number; savedTo: string; hint: string })> {
  if (!('value' in result)) return result;
  let serialized: string;
  try {
    serialized = JSON.stringify(result.value);
  } catch {
    return result;
  }
  if (typeof serialized !== 'string' || serialized.length <= DOCUMENT_SPILL_THRESHOLD_CHARS) return result;
  try {
    const name = `saved-${await shortContentHash(serialized)}.json`;
    await writeFile(name, new TextEncoder().encode(serialized).buffer as ArrayBuffer);
    return {
      ...result,
      value: serialized.slice(0, DOCUMENT_SPILL_PREVIEW_CHARS),
      truncated: true,
      valueChars: serialized.length,
      savedTo: `/workspace/${name}`,
      hint: `Preview only; the full JSON value (${serialized.length} chars) is saved. Read it with fs read.`,
    };
  } catch (error) {
    console.warn('Taber REPL spill skipped:', stringifyError(error));
    return result;
  }
}

async function shortContentHash(content: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest).slice(0, 4)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

type StaleSkillTracker = { readSkillPaths: string[]; consecutiveFailures: number; hinted: boolean };

type ToolExecutionOptions = { abortSignal?: AbortSignal; toolCallId?: string };

function createTargetOperationSerializer() {
  let tail = Promise.resolve();
  return function serializeTargetOperation<Input, Output>(
    run: (input: Input, options: ToolExecutionOptions) => Promise<Output>,
    isTargetBound: (input: Input) => boolean = () => true,
  ) {
    return (input: Input, options: ToolExecutionOptions) => {
      if (!isTargetBound(input)) return run(input, options);
      const result = tail.then(() => {
        if (options.abortSignal?.aborted) throw new Error('Task aborted');
        return run(input, options);
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
  };
}

class AuditPersistenceError extends Error {}

function createRunLogger(
  sessionId: number,
  emitEvent: EmitEvent,
  taskId: string | undefined,
  staleSkillTracker: StaleSkillTracker,
  onAuditPersistenceFailure?: (error: string) => Promise<void>,
) {
  return function withRunLog<Input, Output>(toolName: string, run: (input: Input, abortSignal?: AbortSignal) => Promise<Output>) {
    return async (input: Input, options: ToolExecutionOptions) => {
      const toolCallId = options.toolCallId;
      const startedAt = nowMs();
      await emitEvent('tool.started', { taskId, toolCallId, toolName, input });

      let output: Output;
      try {
        output = await run(input, options.abortSignal);
      } catch (error) {
        if (error instanceof AuditPersistenceError) {
          await onAuditPersistenceFailure?.(error.message);
          throw error;
        }
        staleSkillTracker.consecutiveFailures += 1;
        if (error instanceof Error && !staleSkillTracker.hinted && staleSkillTracker.consecutiveFailures >= 2 && staleSkillTracker.readSkillPaths.length > 0) {
          staleSkillTracker.hinted = true;
          error.message += `\nHint: you read ${staleSkillTracker.readSkillPaths.join(', ')} earlier. If that guidance is stale and caused these failures, update the skill with fs write.`;
        }
        await emitEvent('tool.failed', { taskId, toolCallId, toolName, input, error: stringifyError(error), durationMs: elapsedMs(startedAt) });
        throw error;
      }

      const durationMs = elapsedMs(startedAt);
      staleSkillTracker.consecutiveFailures = 0;
      const recorded = recordableToolOutput(toolName, input, output);
      try {
        await appendToolRun({ sessionId, toolName, input, output: recorded, durationMs });
        await emitEvent('tool.completed', { taskId, toolCallId, toolName, input, output: recorded, durationMs });
      } catch (error) {
        const failure = new AuditPersistenceError(
          `Audit persistence failed after ${toolName}${toolCallId ? ` (${toolCallId})` : ''} (${auditErrorName(error)}). The action may have completed; the task was stopped to avoid repeating it.`,
          { cause: error },
        );
        await onAuditPersistenceFailure?.(failure.message);
        throw failure;
      }
      return output;
    };
  };
}

function auditErrorName(error: unknown) {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

/**
 * Audit redaction choke point: the model gets the raw result for the current
 * call, but recorded tool runs and tool.completed events — which feed the
 * timeline, session export, compaction, and future-task model context — must
 * never hold personal profile content, or history would bypass the per-task
 * profileAccess gate.
 */
function recordableToolOutput(toolName: string, input: unknown, output: unknown) {
  if (toolName !== 'fs' || !isRecord(input)) return output;
  if (input.action !== 'read' || input.path !== '/profile.md') return output;
  const contentChars = isRecord(output) && typeof output.contentChars === 'number' ? output.contentChars : undefined;
  return { action: 'read', path: '/profile.md', ...(contentChars === undefined ? {} : { contentChars }), redacted: true };
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

const REMOTE_FETCH_TIMEOUT_MS = 30_000;

function requireOk(response: Response) {
  if (!response.ok) throw new Error(`${response.url}: ${response.status}`);
  return response;
}

function normalizePageExecutionError(error: unknown) {
  const original = error instanceof Error ? error : new Error(String(error));
  // Prefix the guidance but keep the original reason for diagnosis.
  return isPageAccessError(original) ? new Error(`${pageAccessErrorMessage()} (${original.message})`) : original;
}

function readPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readHost(url: string | undefined) {
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function isTargetUnavailableMessage(message: string) {
  return /^Target tab (?:is no longer available|\d+ was closed)/.test(message);
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(nowMs() - startedAt));
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withForegroundMode(message: unknown, foregroundMode: boolean) {
  if (!isRecord(message)) throw new Error('Agent broker message must be an object');
  return { ...message, foregroundMode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
