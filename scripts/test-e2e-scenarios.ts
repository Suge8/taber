import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { createAgentTools } from '../lib/agent-tools.ts';
import { chromeApiRequestType, createChromeApiBroker } from '../lib/chrome-api-broker.ts';
import { createDebuggerController, debuggerRequestType } from '../lib/debugger-tool.ts';
import { createNavigateController, navigateRequestType } from '../lib/navigate.ts';
import { deriveConversation, deriveSidebarTaskView, deriveSources, deriveToolTimeline } from '../lib/sidepanel-view.ts';
import {
  appendAgentEvent,
  createSession,
  database,
  initializeDatabase,
  readSessionSnapshot,
  type AgentEvent,
} from '../lib/db.ts';
import type { BrowserReplPageCommand, BrowserReplSandboxRun } from '../lib/browser-repl.ts';
import type { ExtractedTable, PageDocument } from '../lib/get-document.ts';
import type { ExtractImageInput, ExtractImageResult } from '../lib/extract-image.ts';

async function testFixedToolRegistration(harness: E2EHarness) {
  assert.deepEqual(new Set(Object.keys(harness.tools)), new Set(['getDocument', 'extractImage', 'navigate', 'browser', 'browserRepl']));
}

async function runFiveMvpScenarios(harness: E2EHarness) {
  await appendAgentEvent({
    sessionId: harness.sessionId,
    type: 'task.started',
    payload: { taskId: 'task-e2e', prompt: 'Run the five MVP browser tasks', context: harness.currentTabContext() },
    now: 1,
  });

  const article = await harness.runTool('getDocument', { source: 'currentPage', mode: 'article' });
  assert.equal(article.ok, true);
  assert.match(String(article.content), /capable browser agent/i);
  const summary = summarize(String(article.content));
  assert.match(summary, /capable browser agent/i);

  const image = await harness.runTool('extractImage', { source: 'viewport', format: 'png' });
  assert.deepEqual(pick(image, ['ok', 'source', 'mediaType']), { ok: true, source: 'viewport', mediaType: 'image/png' });

  await harness.runTool('navigate', { action: 'open', url: 'https://fixture.test/table', target: 'current' });
  const tableDocument = await harness.runTool('getDocument', { source: 'currentPage', mode: 'page', includeTables: true });
  assert.equal(tableDocument.ok, true);
  assert.deepEqual(tableDocument.tables?.[0]?.headers, ['Plan', 'Price', 'Owner']);
  assert.deepEqual(tableDocument.tables?.[0]?.rows, [['Pro', '$20', 'Ada'], ['Team', '$50', 'Grace']]);
  const selection = await harness.runTool('getDocument', { source: 'currentPage', mode: 'selection' });
  assert.deepEqual(pick(selection, ['ok', 'code']), { ok: false, code: 'NO_SELECTION' });

  const urls = ['https://fixture.test/a', 'https://fixture.test/b', 'https://fixture.test/c'];
  const collected = [];
  for (const url of urls) {
    await harness.runTool('navigate', { action: 'open', url, target: 'current' });
    const result = await harness.runTool('getDocument', { source: 'currentPage', mode: 'page' });
    collected.push({ title: result.title, url: result.url });
  }
  assert.deepEqual(harness.visitedUrls.slice(-3), urls);
  assert.deepEqual(collected.map((item) => item.url), urls);
  assert.equal(collected[2].title, 'Fixture C');

  await harness.runTool('navigate', { action: 'open', url: 'https://fixture.test/form', target: 'current' });
  const emailFill = await harness.runTool('browser', { action: 'fill', target: { label: 'Email' }, value: 'user@example.test' });
  const nameFill = await harness.runTool('browser', { action: 'fill', target: { label: 'Name' }, value: 'Ada Lovelace' });
  const formSnapshot = await harness.runTool('browser', { action: 'snapshot' });
  const submitRef = formSnapshot.state.elements.find((item: Record<string, unknown>) => item.name === 'Submit')?.ref;
  const refSubmit = await harness.runTool('browser', { action: 'click', target: { ref: submitRef } });
  const staleSubmit = await harness.runTool('browser', { action: 'click', target: { ref: submitRef } });
  const textSubmit = await harness.runTool('browser', { action: 'click', target: { text: 'Submit' } });
  const roleSubmit = await harness.runTool('browser', { action: 'click', target: { role: 'button', name: 'Submit' } });
  const formResult = await harness.runTool('browserRepl', { code: 'return await waitFor("Submitted user@example.test")' });
  assert.equal(emailFill.ok, true);
  assert.equal(nameFill.ok, true);
  assert.equal(refSubmit.ok, true);
  assert.equal(staleSubmit.ok, false);
  assert.equal(staleSubmit.code, 'STALE_REF');
  assert.equal(textSubmit.ok, true);
  assert.equal(roleSubmit.ok, true);
  assert.match(String(textSubmit.state.text), /Submitted user@example.test by Ada Lovelace/);
  assert.equal(formResult.value.text, 'Submitted user@example.test by Ada Lovelace');
  assert.deepEqual(harness.pageFor('https://fixture.test/form').form, { email: 'user@example.test', name: 'Ada Lovelace', submitted: true });

  await appendAgentEvent({ sessionId: harness.sessionId, type: 'task.completed', payload: { taskId: 'task-e2e', text: summary }, now: 99 });
}

async function testPersistedRecovery(sessionId: number) {
  const snapshot = await readSessionSnapshot(sessionId);
  const toolNames = new Set(snapshot.toolRuns.map((run) => run.toolName));
  assert.deepEqual([...toolNames].sort(), ['browser', 'browserRepl', 'extractImage', 'getDocument', 'navigate']);

  const eventTypes = snapshot.agentEvents.map((event) => event.type);
  assert(eventTypes.includes('task.started'));
  assert(eventTypes.includes('task.completed'));
  assert.equal(eventTypes.filter((type) => type === 'tool.started').length, snapshot.toolRuns.length);
  assert.equal(eventTypes.filter((type) => type === 'tool.completed').length, snapshot.toolRuns.length);
  assert.equal(eventTypes.some((type) => type === 'tool.failed'), false);

  const timeline = deriveToolTimeline(snapshot.agentEvents);
  assert.equal(timeline.length, snapshot.toolRuns.length);
  assert.equal(timeline.every((item) => item.status === 'completed'), true);

  const taskView = deriveSidebarTaskView(snapshot.agentEvents);
  assert.equal(taskView.status, 'idle');
  assert.equal(taskView.detail, 'Last task completed.');

  const conversation = deriveConversation(snapshot.agentEvents);
  assert.deepEqual(conversation.map((message) => message.role), ['user', 'assistant']);
  assert.match(conversation[1]?.text ?? '', /capable browser agent/i);

  const sources = deriveSources(taskView.context, snapshot.agentEvents);
  assert(sources.some((source) => source.url === 'https://fixture.test/article'));
}

async function createE2EHarness(): Promise<E2EHarness> {
  await initializeDatabase();
  const session = await createSession({ title: 'MVP E2E', now: 0 });
  const broker = new FakeBrowserBroker();
  const tools = createAgentTools({
    sessionId: session.id,
    windowId: 1,
    sendMessage: (message) => broker.handleMessage(message),
    emitEvent: (type, payload) => appendAgentEvent({ sessionId: session.id, type, payload }).then(() => undefined),
    runSandbox: runInlineBrowserReplSandbox,
    browserJsEnabled: true,
  });

  return {
    broker,
    sessionId: session.id,
    tools,
    visitedUrls: broker.visitedUrls,
    currentTabContext: () => broker.currentTabContext(),
    emitDebuggerFailure: (url, status, method, context) => broker.emitDebuggerFailure(url, status, method, context),
    pageFor: (url) => broker.pageFor(url),
    async runTool(toolName, input) {
      const tool = tools[toolName] as unknown as { execute(input: unknown, options: { abortSignal: AbortSignal }): Promise<unknown> } | undefined;
      if (!tool) throw new Error(`Unknown tool: ${toolName}`);
      return tool.execute(input, { abortSignal: new AbortController().signal });
    },
  };
}

type ToolName = 'getDocument' | 'extractImage' | 'navigate' | 'browser' | 'browserRepl';
type E2EHarness = {
  broker: FakeBrowserBroker;
  sessionId: number;
  tools: ReturnType<typeof createAgentTools>;
  visitedUrls: string[];
  currentTabContext(): Record<string, unknown>;
  emitDebuggerFailure(url: string, status: number, method: string, context: string): void;
  pageFor(url: string): FakePage;
  runTool(toolName: ToolName, input: Record<string, unknown>): Promise<any>;
};

const e2eDocumentHtmlPrefix = 'taber:e2e-document:';

function e2eDocumentHtml(url: string) {
  return `${e2eDocumentHtmlPrefix}${url}`;
}

class FakeBrowserBroker {
  readonly visitedUrls: string[] = [];
  private readonly pageByUrl = createFixturePages();
  private readonly tabsApi = new FakeTabsApi(this.pageByUrl, this.visitedUrls);
  private readonly webNavigationApi = new FakeWebNavigationApi();
  private readonly debuggerApi = new FakeDebuggerApi(() => this.currentPage());
  private readonly chromeApiBroker = createChromeApiBroker({
    tabs: this.tabsApi as never,
    scripting: { executeScript: async () => { throw new Error('chrome.scripting API is unavailable in deterministic E2E'); } },
    userScripts: { execute: (injection: unknown) => this.executeUserScript(injection) },
    webNavigation: this.webNavigationApi as never,
    debugger: this.debuggerApi as never,
  });
  private readonly navigateController = createNavigateController({ tabs: this.tabsApi as never, webNavigation: this.webNavigationApi as never });
  private readonly debuggerController = createDebuggerController({ debuggerApi: this.debuggerApi as never, getCurrentTabId: () => this.tabsApi.currentTabId() });

  constructor() {
    installE2EDocumentMarkdownDom(this.pageByUrl);
    this.tabsApi.onNavigate((tab) => this.webNavigationApi.completed({ tabId: tab.id, frameId: 0, url: tab.url }));
  }

  async handleMessage(message: unknown): Promise<unknown> {
    const record = readRecord(message);
    if (!record || typeof record.type !== 'string') return undefined;
    if (record.type === chromeApiRequestType) return this.chromeApiBroker(record);
    if (record.type === navigateRequestType) return this.navigateController.navigate(record.input);
    if (record.type === debuggerRequestType) {
      assert.equal(record.windowId, 1);
      return this.debuggerController.run(record.input);
    }
    if (record.type === 'taber.background.currentTab') return this.tabsApi.currentTab();
    if (record.type === 'taber.getDocument.extractPage') return this.extractPageDocument(record);
    if (record.type === 'taber.extractImage.captureVisibleTab') {
      assert.deepEqual(record.input, { source: 'viewport', format: 'png' });
      return 'data:image/png;base64,fixtureviewport';
    }
    if (record.type === 'taber.extractImage.extractPage') return this.extractPageImage(record);
    if (record.type === 'taber.browserRepl.scriptingCommand') return this.executeBrowserReplCommand(record);
    if (record.type === 'taber.browserRepl.cancelPageCommand') return true;
    if (record.type === 'taber.browserRepl.isPageCommandCancelled') return false;
    throw new Error(`Unhandled E2E broker message: ${record.type}`);
  }

  currentTabContext() {
    const tab = this.tabsApi.currentTab();
    return { id: tab.id, title: tab.title, url: tab.url };
  }

  emitDebuggerFailure(url: string, status: number, method: string, context: string) {
    const tabId = this.tabsApi.currentTabIdSync();
    this.debuggerApi.emit({ tabId }, 'Network.requestWillBeSent', { requestId: 'request-fail', type: 'Fetch', request: { url, method } });
    this.debuggerApi.emit({ tabId }, 'Network.responseReceived', { requestId: 'request-fail', type: 'Fetch', response: { url, status } });
    this.debuggerApi.emit({ tabId }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: `Failed during ${context}` }], stackTrace: { callFrames: [{ url: this.currentPage().url }] } });
  }

  pageFor(url: string) {
    const page = this.pageByUrl.get(url);
    if (!page) throw new Error(`Missing fixture page: ${url}`);
    return page;
  }

  private currentPage() {
    return this.pageFor(this.tabsApi.currentTab().url);
  }

  private extractPageDocument(message: Record<string, unknown>): PageDocument {
    const tabId = readPositiveInteger(message.tabId, 'tabId');
    const input = readRecord(message.input);
    assert.equal(input?.source, 'currentPage');
    return this.pageFor(this.tabsApi.tabUrl(tabId)).document();
  }

  private extractPageImage(message: Record<string, unknown>): ExtractImageResult {
    const input = readRecord(message.input) as ExtractImageInput | undefined;
    if (input?.source === 'canvas') return { ok: true, source: 'canvas', selector: input.selector, dataUrl: 'data:image/png;base64,fixtureimage', mediaType: 'image/png', width: 32, height: 24 };
    if (input?.source === 'backgroundImage') return { ok: true, source: 'backgroundImage', selector: input.selector, dataUrl: 'data:image/png;base64,fixtureimage', mediaType: 'image/png', width: 32, height: 24 };
    return { ok: true, source: 'imageElement', selector: input?.source === 'imageElement' ? input.selector : 'img.fixture', dataUrl: 'data:image/png;base64,fixtureimage', mediaType: 'image/png', width: 32, height: 24, alt: 'fixture image' };
  }

  private executeBrowserReplCommand(message: Record<string, unknown>) {
    const command = readRecord(message.command) as BrowserReplPageCommand | undefined;
    if (!command) throw new Error('taber.browserRepl.scriptingCommand requires command');
    return this.currentPage().executeCommand(command);
  }

  private async executeUserScript(injection: unknown) {
    const record = readRecord(injection);
    const code = readRecord((record?.js as unknown[])?.[0])?.code;
    if (record?.world !== 'MAIN' || typeof code !== 'string') throw new Error('chrome.userScripts API did not return a result');
    const value = await this.currentPage().evaluateBrowserJs(code);
    return [{ result: value }];
  }
}

class FakePage {
  readonly form = { email: '', name: '', submitted: false };
  readonly url: string;
  readonly title: string;
  private readonly content: string;
  private readonly tables: ExtractedTable[];
  private snapshotRefs = new Map<string, string>();
  private snapshotSeq = 0;

  constructor(url: string, title: string, content: string, tables: ExtractedTable[] = []) {
    this.url = url;
    this.title = title;
    this.content = content;
    this.tables = tables;
  }

  document(): PageDocument {
    return { title: this.title, url: this.url, selection: '', html: e2eDocumentHtml(this.url) };
  }

  documentContent() {
    return this.content;
  }

  documentTables() {
    return this.tables;
  }

  text() {
    if (!this.form.submitted) return this.content;
    return `${this.content} Submitted ${this.form.email} by ${this.form.name}`;
  }

  executeCommand(command: BrowserReplPageCommand) {
    if (command.helper === 'observe') return { summary: { title: this.title, url: this.url }, elements: this.elements() };
    if (command.helper === 'fill') return this.fill(command.args[0], String(command.args[1] ?? ''));
    if (command.helper === 'click') return this.click(command.args[0]);
    if (command.helper === 'waitFor') return this.waitFor(readRecord(command.args[0]));
    if (command.helper === 'batch') return this.batch(Array.isArray(command.args[0]) ? command.args[0] : [], readRecord(command.args[1]));
    if (command.helper === 'fillForm') return this.fillForm(readRecord(command.args[0]));
    if (command.helper === 'browser') return this.browser(readRecord(command.args[0]));
    if (command.helper === 'query') return { summary: { title: this.title, url: this.url }, elements: this.elements() };
    throw new Error(`Unsupported fake page command: ${command.helper}`);
  }

  async evaluateBrowserJs(code: string) {
    const previousDocument = Reflect.get(globalThis, 'document');
    const previousLocation = Reflect.get(globalThis, 'location');
    Reflect.set(globalThis, 'document', { title: this.title, body: { innerText: this.text() } });
    Reflect.set(globalThis, 'location', { href: this.url });
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return await new AsyncFunction(`return (${code});`)();
    } finally {
      restoreGlobal('document', previousDocument);
      restoreGlobal('location', previousLocation);
    }
  }

  private elements() {
    return [
      element(1, '#email', 'input', 'Email'),
      element(2, '#name', 'input', 'Name'),
      element(3, '#submit', 'button', 'Submit'),
    ];
  }

  private browser(input: Record<string, unknown> | undefined) {
    const action = typeof input?.action === 'string' ? input.action : '';
    if (action === 'snapshot') return { ok: true, action, state: this.browserState() };
    const target = readRecord(input?.target);
    const staleRef = typeof target?.ref === 'string' && !this.snapshotRefs.has(target.ref);
    const selector = this.browserSelector(target);
    if (!selector) return { ok: false, action, code: staleRef ? 'STALE_REF' : 'NO_TARGET', message: staleRef ? 'Ref is stale' : 'No target', state: this.browserState() };
    if (action === 'fill') {
      this.fill(selector, String(input?.value ?? ''));
      return { ok: true, action, evidence: { selector }, state: this.browserState() };
    }
    if (action === 'click') {
      this.click(selector);
      return { ok: true, action, evidence: { selector }, state: this.browserState() };
    }
    return { ok: false, action, code: 'ACTION_FAILED', message: `Unsupported browser action: ${action}`, state: this.browserState() };
  }

  private browserSelector(target: Record<string, unknown> | undefined) {
    if (!target) return undefined;
    if (typeof target.ref === 'string') return this.snapshotRefs.get(target.ref);
    const ref = readRecord(target.ref);
    if (ref?.selector) return String(ref.selector);
    if (typeof target.selector === 'string') return target.selector;
    if (typeof target.label === 'string') return this.fieldSelector(target.label);
    if (target.text === 'Submit') return '#submit';
    if (target.role === 'button' && target.name === 'Submit') return '#submit';
    return undefined;
  }

  private browserState() {
    this.snapshotSeq += 1;
    const refs = new Map<string, string>();
    const elements = this.elements().map((item, offset) => {
      const ref = `r${this.snapshotSeq}.${offset + 1}`;
      refs.set(ref, item.ref.selector);
      const { ref: _internalRef, ...element } = item;
      return { ...element, ref, role: item.tag === 'button' ? 'button' : 'textbox' };
    });
    this.snapshotRefs = refs;
    return { title: this.title, url: this.url, text: this.text(), elements };
  }

  private fill(refValue: unknown, text: string) {
    const ref = readElementRef(refValue);
    if (ref.selector === '#email') this.form.email = text;
    else if (ref.selector === '#name') this.form.name = text;
    else throw new Error(`Element is not fillable: ${ref.selector}`);
    return { filled: true, element: { selector: ref.selector } };
  }

  private click(refValue: unknown) {
    const ref = readElementRef(refValue);
    if (ref.selector !== '#submit') throw new Error(`Element is not clickable: ${ref.selector}`);
    this.form.submitted = true;
    return { clicked: true, element: { selector: ref.selector } };
  }

  private waitFor(options: Record<string, unknown> | undefined) {
    const text = typeof options?.text === 'string' ? options.text : '';
    if (text && !this.text().includes(text)) throw new Error(`waitFor timed out after ${options?.timeoutMs ?? 8000}ms`);
    return { matched: true, text: this.text().match(/Submitted[^\n]*/)?.[0] };
  }

  private fillForm(options: Record<string, unknown> | undefined) {
    const fields = readRecord(options?.fields) ?? {};
    const dryRun = options?.dryRun === true;
    const filled = [];
    const missing = [];
    for (const [field, value] of Object.entries(fields)) {
      const selector = this.fieldSelector(field);
      if (!selector) {
        missing.push({ field });
        continue;
      }
      if (!dryRun) this.fill(selector, String(value));
      filled.push({ field, selector, dryRun, finalValue: dryRun ? undefined : String(value) });
    }
    return { ok: missing.length === 0, filled, missing, ambiguous: [] };
  }

  private batch(actions: unknown[], options: Record<string, unknown> | undefined) {
    const steps = [];
    const stopOnError = options?.continueOnError === true || options?.stopOnError === false ? false : true;
    for (const actionValue of actions) {
      const action = readRecord(actionValue) ?? {};
      try {
        const result = this.runBatchAction(action);
        steps.push({ action: action.action, selector: action.selector, ok: true, ...result });
      } catch (error) {
        steps.push({ action: action.action, selector: action.selector, ok: false, error: error instanceof Error ? error.message : String(error) });
        if (stopOnError) return { ok: false, steps, error: 'One or more batch steps failed' };
      }
    }
    return { ok: steps.every((step) => step.ok), steps };
  }

  private runBatchAction(action: Record<string, unknown>) {
    if (action.action === 'fill') return this.fill(action.selector ?? action.target, String(action.value ?? ''));
    if (action.action === 'click') return this.click(action.selector ?? action.target);
    if (action.action === 'waitFor') return this.waitFor(action);
    throw new Error(`Unsupported batch action: ${String(action.action)}`);
  }

  private fieldSelector(field: string) {
    if (/email/i.test(field)) return '#email';
    if (/name/i.test(field)) return '#name';
    return undefined;
  }
}

class FakeTabsApi {
  readonly onUpdated = createEvent<(tabId: number, changeInfo: { status?: string }, tab: BrowserTab) => void>();
  readonly onRemoved = createEvent<(tabId: number) => void>();
  private readonly tabs: BrowserTab[] = [{ id: 1, active: true, index: 0, status: 'complete', title: 'Taber Article', url: 'https://fixture.test/article', windowId: 1 }];
  private navigateListener: (tab: BrowserTab) => void = () => undefined;
  private nextTabId = 2;

  private readonly pages: Map<string, FakePage>;
  private readonly visitedUrls: string[];

  constructor(pages: Map<string, FakePage>, visitedUrls: string[]) {
    this.pages = pages;
    this.visitedUrls = visitedUrls;
  }

  onNavigate(listener: (tab: BrowserTab) => void) {
    this.navigateListener = listener;
  }

  async query(query: Record<string, unknown>) {
    if (query.active && query.currentWindow) return this.tabs.filter((tab) => tab.active);
    return [...this.tabs];
  }

  async get(tabId: number) {
    return this.requireTab(tabId);
  }

  async create(properties: Record<string, unknown>) {
    const url = readUrl(properties.url);
    const page = this.requirePage(url);
    const tab: BrowserTab = { id: this.nextTabId, active: properties.active !== false, index: this.tabs.length, status: 'complete', title: page.title, url, windowId: 1 };
    this.nextTabId += 1;
    if (tab.active) this.deactivateTabs();
    this.tabs.push(tab);
    this.visitedUrls.push(url);
    this.navigateListener(tab);
    return tab;
  }

  async update(tabId: number, properties: Record<string, unknown>) {
    const tab = this.requireTab(tabId);
    if (properties.active) {
      this.deactivateTabs();
      tab.active = true;
    }
    if (properties.url !== undefined) {
      const url = readUrl(properties.url);
      const page = this.requirePage(url);
      Object.assign(tab, { url, title: page.title, status: 'complete' });
      this.visitedUrls.push(url);
      this.onUpdated.emit(tab.id, { status: 'complete' }, tab);
      this.navigateListener(tab);
    }
    return tab;
  }

  async remove(tabId: number) {
    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex < 0) throw new Error(`No tab with id: ${tabId}`);
    this.tabs.splice(tabIndex, 1);
    this.onRemoved.emit(tabId);
  }

  async reload(tabId?: number) {
    const tab = this.requireTab(tabId ?? this.currentTabIdSync());
    this.onUpdated.emit(tab.id, { status: 'complete' }, tab);
    this.navigateListener(tab);
  }

  async goBack() {
    throw new Error('History is not used by deterministic E2E');
  }

  async goForward() {
    throw new Error('History is not used by deterministic E2E');
  }

  currentTab() {
    return this.tabs.find((tab) => tab.active) ?? this.tabs[0];
  }

  async currentTabId() {
    return this.currentTabIdSync();
  }

  currentTabIdSync() {
    const tabId = this.currentTab()?.id;
    if (!tabId) throw new Error('No active tab');
    return tabId;
  }

  tabUrl(tabId: number) {
    return this.requireTab(tabId).url;
  }

  private deactivateTabs() {
    for (const tab of this.tabs) tab.active = false;
  }

  private requireTab(tabId: number) {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  }

  private requirePage(url: string) {
    const page = this.pages.get(url);
    if (!page) throw new Error(`No fixture page for URL: ${url}`);
    return page;
  }
}

class FakeWebNavigationApi {
  readonly onCompleted = createEvent<(details: { tabId: number; frameId: number; url?: string }) => void>();
  readonly onErrorOccurred = createEvent<(details: { tabId: number; frameId: number; error?: string }) => void>();

  completed(details: { tabId: number; frameId: number; url?: string }) {
    this.onCompleted.emit(details);
  }

  async getAllFrames(details: { tabId: number }) {
    return [{ tabId: details.tabId, frameId: 0, parentFrameId: -1, url: 'https://fixture.test/form' }];
  }
}

class FakeDebuggerApi {
  readonly onEvent = createEvent<(source: { tabId: number }, method: string, params?: Record<string, unknown>) => void>();
  readonly onDetach = createEvent<(source: { tabId: number }) => void>();
  private readonly currentPage: () => FakePage;

  constructor(currentPage: () => FakePage) {
    this.currentPage = currentPage;
  }

  async attach() {}

  async detach(source: { tabId: number }) {
    this.onDetach.emit(source);
  }

  async sendCommand(_source: { tabId: number }, method: string, params?: Record<string, unknown>) {
    if (method === 'Runtime.evaluate' && typeof params?.expression === 'string') {
      return { result: { value: await this.currentPage().evaluateBrowserJs(params.expression) } };
    }
    return {};
  }

  emit(source: { tabId: number }, method: string, params?: Record<string, unknown>) {
    this.onEvent.emit(source, method, params);
  }
}

function createEvent<Listener extends (...args: never[]) => void>() {
  const listeners = new Set<Listener>();
  return {
    addListener(listener: Listener) { listeners.add(listener); },
    removeListener(listener: Listener) { listeners.delete(listener); },
    emit(...args: Parameters<Listener>) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function createFixturePages() {
  const pricesTable: ExtractedTable = {
    headers: ['Plan', 'Price', 'Owner'],
    rows: [['Pro', '$20', 'Ada'], ['Team', '$50', 'Grace']],
    markdown: '| Plan | Price | Owner |\n| --- | --- | --- |\n| Pro | $20 | Ada |\n| Team | $50 | Grace |',
  };

  return new Map([
    ['https://fixture.test/article', new FakePage('https://fixture.test/article', 'Taber Article', 'Taber runs a capable browser agent in a side panel. Users can stop tasks and recover the event log.')],
    ['https://fixture.test/table', new FakePage('https://fixture.test/table', 'Plan Prices', 'Plan pricing table', [pricesTable])],
    ['https://fixture.test/a', new FakePage('https://fixture.test/a', 'Fixture A', 'Alpha metric: 10')],
    ['https://fixture.test/b', new FakePage('https://fixture.test/b', 'Fixture B', 'Beta metric: 20')],
    ['https://fixture.test/c', new FakePage('https://fixture.test/c', 'Fixture C', 'Gamma metric: 30')],
    ['https://fixture.test/form', new FakePage('https://fixture.test/form', 'Signup Form', 'Email Name Submit')],
    ['https://fixture.test/debug', new FakePage('https://fixture.test/debug', 'Debug Fixture', 'Clicking submit checkout sends a failing API request.')],
  ]);
}

function installE2EDocumentMarkdownDom(pages: Map<string, FakePage>) {
  class FakeText {
    readonly nodeType = 3;
    readonly childNodes: FakeChild[] = [];
    readonly children: FakeElement[] = [];
    textContent: string;

    constructor(textContent: string) {
      this.textContent = textContent;
    }
  }

  class FakeElement {
    readonly nodeType = 1;
    readonly tagName: string;
    readonly childNodes: FakeChild[];

    constructor(tagName: string, childNodes: FakeChild[] = []) {
      this.tagName = tagName.toUpperCase();
      this.childNodes = childNodes;
    }

    get children() {
      return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
    }

    get textContent(): string {
      return this.childNodes.map((child) => child.textContent).join('');
    }

    querySelector(selector: string): FakeElement | null {
      if (selector === 'tr:first-child th') return this.querySelectorAll('tr')[0]?.querySelector('th') ?? null;
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
      if (selector === 'thead tr:first-child th') return descendants(this, 'THEAD').flatMap((thead) => firstChild(thead, 'TR')?.querySelectorAll('th') ?? []);
      if (selector === 'tbody tr') return descendants(this, 'TBODY').flatMap((tbody) => descendants(tbody, 'TR'));
      return descendants(this, selector.toUpperCase());
    }
  }

  class FakeTableElement extends FakeElement {}

  class FakeDocument {
    readonly body: FakeElement;
    readonly documentElement: FakeElement;

    constructor(body: FakeElement) {
      this.body = body;
      this.documentElement = element('html', [body]);
    }

    querySelector(selector: string): FakeElement | null {
      if (selector === 'body') return this.body;
      return this.body.querySelector(selector);
    }

    querySelectorAll(selector: string) {
      return this.body.querySelectorAll(selector);
    }
  }

  type FakeChild = FakeElement | FakeText;
  const globalObject = globalThis as Record<string, unknown>;
  Object.defineProperty(globalObject, 'Node', { value: { TEXT_NODE: 3 }, configurable: true, writable: true });
  Object.defineProperty(globalObject, 'Element', { value: FakeElement, configurable: true, writable: true });
  Object.defineProperty(globalObject, 'HTMLTableElement', { value: FakeTableElement, configurable: true, writable: true });
  Object.defineProperty(globalObject, 'DOMParser', { value: class {
    parseFromString(markup: string) {
      const url = markup.startsWith(e2eDocumentHtmlPrefix) ? markup.slice(e2eDocumentHtmlPrefix.length) : '';
      const page = pages.get(url);
      return new FakeDocument(page ? pageBody(page) : element('body'));
    }
  }, configurable: true, writable: true });

  function text(value: string) {
    return new FakeText(value);
  }

  function element(tagName: string, children: (FakeChild | string)[] = []) {
    const childNodes = children.map((child) => (typeof child === 'string' ? text(child) : child));
    return tagName.toUpperCase() === 'TABLE' ? new FakeTableElement(tagName, childNodes) : new FakeElement(tagName, childNodes);
  }

  function pageBody(page: FakePage) {
    return element('body', [element('article', [element('p', [page.documentContent()]), ...page.documentTables().map(tableElement)])]);
  }

  function tableElement(table: ExtractedTable) {
    return element('table', [
      element('thead', [element('tr', table.headers.map((header) => element('th', [header])))]),
      element('tbody', table.rows.map((row) => element('tr', row.map((cell) => element('td', [cell]))))),
    ]);
  }

  function descendants(root: FakeElement, tagName: string): FakeElement[] {
    return root.children.flatMap((child) => [child, ...descendants(child, tagName)]).filter((child) => child.tagName === tagName);
  }

  function firstChild(root: FakeElement, tagName: string) {
    return root.children.find((child) => child.tagName === tagName);
  }
}

async function runInlineBrowserReplSandbox(run: BrowserReplSandboxRun) {
  if (run.abortSignal?.aborted) throw new Error('Task aborted');
  const helperNames = Object.keys(run.helpers).filter((name) => name !== 'sandbox');
  const helpers = helperNames.map((name) => run.helpers[name]);
  const nestedSandbox = async (code: string, args?: unknown) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('args', `"use strict";\n${code}`)(args);
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction(...helperNames, 'sandbox', `"use strict";\n${run.code}`)(...helpers, nestedSandbox);
}

function summarize(content: string) {
  return content.split('.').map((part) => part.trim()).filter(Boolean).slice(0, 2).join('. ');
}

function explainFailure(requests: unknown[], logs: unknown[]) {
  const request = readRecord(requests[0]) ?? {};
  const log = readRecord(logs[0]) ?? {};
  return `Failed request ${request.url} returned ${request.status ?? request.errorText}; context: ${log.text ?? request.type}.`;
}

function element(index: number, selector: string, tagName: string, name: string) {
  return { index, tag: tagName, name, ref: { stableId: `${tagName}|${selector}|${name}`, selector, tagName, name } };
}

function readElementRef(value: unknown) {
  if (typeof value === 'string') return { selector: value };
  const ref = readRecord(value);
  if (!ref || typeof ref.selector !== 'string') throw new Error('Missing element ref');
  return ref as { selector: string };
}

function pick(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function readUrl(value: unknown) {
  if (typeof value === 'string' && value.trim()) return value;
  throw new Error(`Invalid URL: ${String(value)}`);
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function restoreGlobal(name: string, value: unknown) {
  if (value === undefined) Reflect.deleteProperty(globalThis, name);
  else Reflect.set(globalThis, name, value);
}

async function resetDatabase() {
  database.close();
  await database.delete();
  await initializeDatabase();
}

type BrowserTab = { id: number; active: boolean; index: number; status: string; title: string; url: string; windowId: number };

await resetDatabase();
const harness = await createE2EHarness();
await testFixedToolRegistration(harness);
await runFiveMvpScenarios(harness);
await testPersistedRecovery(harness.sessionId);
database.close();
console.info('e2e scenario tests passed');
