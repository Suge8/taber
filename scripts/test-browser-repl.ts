import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { browserReplFallbackFor, createBrowserReplController, DEFAULT_BROWSER_REPL_TIMEOUT_MS, MAX_BROWSER_REPL_TIMEOUT_MS, parseBrowserReplInput, type BrowserReplPageCommand } from '../lib/browser-repl.ts';
import { canUseCdpFallback, executeBrowserReplCdpFallback } from '../lib/browser-repl-cdp.ts';
import { chromeApiRequestType } from '../lib/chrome-api-broker.ts';
import { createAgentTools } from '../lib/agent-tools.ts';
import { createBrowserReplUserScript, runBrowserReplPageRuntime } from '../lib/browser-repl-page.ts';
import { createSession, database, initializeDatabase } from '../lib/db.ts';

async function testPageRuntimeHelpersBehaveInFakePage() {
  const page = createFakePage();
  const button = page.addElement(new FakeHTMLButtonElement('button'), { id: 'save', text: 'Save' });
  const input = page.addElement(new FakeHTMLInputElement('input'), { id: 'name', placeholder: 'Name' });
  const editor = page.addElement(new FakeHTMLElement('div'), { id: 'editor', ariaLabel: 'Editor', contentEditable: true });
  const select = page.addElement(new FakeHTMLSelectElement('select'), { id: 'choice', ariaLabel: 'Choice' });

  const observed = await runPageValue(page, { helper: 'observe', args: [{ scope: 'page' }] });
  assert.equal(observed.summary.title, 'BrowserRepl Test');
  assert(observed.elements.some((element: Record<string, unknown>) => element.name === 'Save' && element.role === 'button'));

  const queried = await runPageValue(page, { helper: 'query', args: ['#name', { scope: 'page', limit: 1 }] });
  const inputRef = queried.elements[0].ref;
  const buttonRef = observed.elements.find((element: Record<string, unknown>) => element.name === 'Save').ref;
  const editorRef = observed.elements.find((element: Record<string, unknown>) => element.name === 'Editor').ref;
  const selectRef = observed.elements.find((element: Record<string, unknown>) => element.name === 'Choice').ref;

  assert.equal((await runPageValue(page, { helper: 'fill', args: [inputRef, 'alpha'] })).filled, true);
  assert.equal(input.value, 'alpha');
  assert.deepEqual(input.dispatchedEvents, ['input', 'change']);
  assert.equal((await runPageValue(page, { helper: 'fill', args: [editorRef, 'editable'] })).filled, true);
  assert.equal(editor.textContent, 'editable');
  assert.equal((await runPageValue(page, { helper: 'fill', args: [selectRef, 'b'] })).filled, true);
  assert.equal(select.value, 'b');
  assert.equal((await runPageValue(page, { helper: 'click', args: [buttonRef] })).clicked, true);
  assert.equal(button.clicked, true);
  assert.equal((await runPageValue(page, { helper: 'press', args: [inputRef, 'Enter'] })).pressed, 'Enter');
  assert.deepEqual(input.dispatchedEvents.slice(-2), ['keydown:Enter', 'keyup:Enter']);
  assert.equal((await runPageValue(page, { helper: 'scroll', args: [{ y: 200 }] })).y, 200);
}

async function testScriptingScriptUsesSameJsonCommandSemantics() {
  const command: BrowserReplPageCommand = { helper: 'scroll', args: [{ x: Infinity, y: NaN }] };
  const userScriptPage = createFakePage();
  const scriptingPage = createFakePage();
  assert.deepEqual(await runPageValue(userScriptPage, command), await runPageValue(scriptingPage, command));
}

async function testScriptingFallbackResultIsReturned() {
  const messages: unknown[] = [];
  const result = await runBrowserReplTool({ code: 'return observe()', tabId: 5 }, {
    async runSandbox(run) {
      return run.helpers.observe({ scope: 'page' });
    },
    async sendMessage(message) {
      messages.push(message);
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [];
      if (isRecord(message) && message.type === 'taber.browserRepl.scriptingCommand') return { summary: { title: 'fallback' }, elements: [] };
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    },
  });

  assert.deepEqual(result, { value: { summary: { title: 'fallback' }, elements: [] } });
  assert.deepEqual(messages.filter(isRecord).map((message) => message.type), [chromeApiRequestType, 'taber.browserRepl.scriptingCommand']);
}

async function testBrowserJsUsesUserScriptsMainWorld() {
  const messages: unknown[] = [];
  const result = await runBrowserReplTool({ code: 'return browserjs("return args.value", { value: 7 })', tabId: 5 }, {
    async runSandbox(run) {
      return run.helpers.browserjs('return args.value', { value: 7 });
    },
    async sendMessage(message) {
      messages.push(message);
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [{ result: { ok: true, value: 7 } }];
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    },
  });

  assert.deepEqual(result, { value: 7 });
  const injection = ((messages[0] as { args: unknown[] }).args[0]) as { world?: string; js?: Array<{ code?: string }> };
  assert.equal(injection.world, 'MAIN');
  assert.match(String(injection.js?.[0]?.code), /return args.value/);
}

async function testBrowserJsUnavailableFailsClearlyWithoutProductionFallback() {
  await assert.rejects(
    runBrowserReplTool({ code: 'return browserjs("return document.title")', tabId: 5 }, {
      async runSandbox(run) {
        return run.helpers.browserjs('return document.title');
      },
      async sendMessage(message) {
        if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [];
        throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
      },
    }),
    /browserjs requires Chrome User Scripts/,
  );
}

async function testBrowserJsSharesPageGlobalsButNotExtensionLexicals() {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { sendMessage() { throw new Error('should not call extension runtime'); } } } });
  try {
    const result = await eval(createBrowserReplUserScript({
      helper: 'browserjs',
      args: [`return {
        chromeType: typeof chrome,
        browserType: typeof browser,
        runtimeType: typeof runtime,
        extensionRuntimeType: typeof extensionRuntime,
        globalChromeType: typeof globalThis.chrome,
        fetchType: typeof fetch,
        constructorText: '(() => {}).constructor',
      };`],
    }));
    assert.deepEqual(result, {
      ok: true,
      value: {
        chromeType: 'undefined',
        browserType: 'undefined',
        runtimeType: 'undefined',
        extensionRuntimeType: 'undefined',
        globalChromeType: 'object',
        fetchType: 'function',
        constructorText: '(() => {}).constructor',
      },
    });
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
}

async function testBrowserJsCanBeDisabledForAgentConsent() {
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { throw new Error('should not execute page command'); },
    async runSandbox(run) { return Object.keys(run.helpers).sort(); },
    browserJsEnabled: false,
  });

  assert.deepEqual(await controller.run({ code: 'return Object.keys(arguments[0] ?? {})' }), { value: ['click', 'fill', 'observe', 'pickElement', 'press', 'query', 'sandbox', 'scroll', 'waitFor'] });
}

function testParsesInput() {
  assert.deepEqual(parseBrowserReplInput({ code: 'return 1', tabId: 7, timeoutMs: 1 }), { code: 'return 1', tabId: 7, timeoutMs: 1 });
  assert.throws(() => parseBrowserReplInput({ code: '' }), /browserRepl.code is required/);
  assert.throws(() => parseBrowserReplInput({ code: 'return 1', timeoutMs: MAX_BROWSER_REPL_TIMEOUT_MS + 1 }), /timeoutMs must be <= 120000/);
}

function testRoutesFallbacks() {
  assert.equal(browserReplFallbackFor({ helper: 'browserjs', args: ['return 1'] }), 'browserjsCdp');
  assert.equal(browserReplFallbackFor({ helper: 'press', args: [undefined, 'Enter'] }), 'pressCdp');
  assert.equal(browserReplFallbackFor({ helper: 'click', args: [] }), 'scripting');
}

async function testRunsSandboxWithHelpersAndElementRefs() {
  const pageCommands: BrowserReplPageCommand[] = [];
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 3; },
    async executePageCommand(tabId, command) {
      assert.equal(tabId, 3);
      pageCommands.push(command);
      if (command.helper === 'observe') return { summary: { title: 'Test' }, elements: [{ index: 1, tag: 'button', name: 'Save', ref: { stableId: 'button|#save|Save', selector: '#save', tagName: 'button', name: 'Save' } }] };
      if (command.helper === 'click') return { clicked: true };
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async runSandbox(run) {
      assert.equal(run.timeoutMs, DEFAULT_BROWSER_REPL_TIMEOUT_MS);
      assert.deepEqual(Object.keys(run.helpers).sort(), ['browserjs', 'click', 'fill', 'observe', 'pickElement', 'press', 'query', 'sandbox', 'scroll', 'waitFor']);
      assert.equal(await run.helpers.sandbox('return args.value + 1', { value: 1 }), 2);
      const observed = await run.helpers.observe();
      assert.deepEqual(observed, { summary: { title: 'Test' }, elements: [{ index: 1, tag: 'button', name: 'Save' }] });
      return run.helpers.click(1);
    },
  });

  assert.deepEqual(await controller.run({ code: 'return click(1)' }), { value: { clicked: true } });
  assert.equal(pageCommands[1].helper, 'click');
  assert.equal(pageCommands[1].timeoutMs, 5_000);
  assert.equal(typeof pageCommands[1].cancelKey, 'string');
}

async function testCdpFallbackDispatchesNativeClick() {
  const calls: unknown[] = [];
  const command: BrowserReplPageCommand = { helper: 'click', args: [{ stableId: 'button|#save|Save', selector: '#save', tagName: 'button', name: 'Save' }] };

  assert.equal(canUseCdpFallback(command, new Error('DOM click failed')), true);
  assert.equal(canUseCdpFallback(command, new Error('Element is disabled')), false);

  const result = await executeBrowserReplCdpFallback({
    tabId: 9,
    command,
    async runPageCommand(pageCommand) {
      assert.equal(pageCommand.helper, 'pickElement');
      return { rect: { x: 10, y: 20, width: 30, height: 40 } };
    },
    async callChromeApi(action, args) {
      calls.push({ action, args });
      return undefined;
    },
  });

  assert.deepEqual(result, { clicked: true, fallback: 'cdp' });
  assert.deepEqual(calls.map((call) => (call as { action: string }).action), ['debugger.attach', 'debugger.sendCommand', 'debugger.sendCommand', 'debugger.detach']);
}

async function testHelperTimeoutUsesScheduler() {
  const scheduler = createScheduler();
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { return new Promise(() => undefined); },
    async runSandbox(run) { return run.helpers.observe(); },
    scheduler,
  });
  const pending = controller.run({ code: 'return observe()' });
  await Promise.resolve();
  assert.equal(scheduler.delayMs, 5_000);
  scheduler.fire();
  await assert.rejects(pending, /observe timed out after 5000ms/);
}

async function runBrowserReplTool(input: unknown, options: { runSandbox(run: Parameters<Parameters<typeof createBrowserReplController>[0]['runSandbox']>[0]): Promise<unknown>; sendMessage(message: unknown): Promise<unknown> }) {
  await initializeDatabase();
  if (!(await database.sessions.get(1))) await createSession({ now: 1 });
  const tools = createAgentTools({
    sessionId: 1,
    async emitEvent() {},
    sendMessage: options.sendMessage,
    runSandbox: options.runSandbox,
  });
  return (tools.browserRepl.execute as (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>)(input, { abortSignal: new AbortController().signal });
}

async function runRawPageCommand(page: FakePage, command: BrowserReplPageCommand) {
  return withFakePage(page, () => runBrowserReplPageRuntime(command));
}

async function runPageValue(page: FakePage, command: BrowserReplPageCommand) {
  const result = await runRawPageCommand(page, command) as { ok: true; value: Record<string, any> } | { ok: false; error: string };
  if (!result.ok) throw new Error(String(result.error));
  return result.value;
}

function createFakePage() {
  return new FakePage();
}

class FakePage {
  readonly document = new FakeDocument();
  readonly runtime = createFakeRuntime();
  readonly windowState = { innerWidth: 1024, innerHeight: 768, scrollX: 0, scrollY: 0 };

  addElement<T extends FakeHTMLElement>(element: T, options: { id?: string; text?: string; placeholder?: string; ariaLabel?: string; contentEditable?: boolean } = {}) {
    if (options.id) element.id = options.id;
    if (options.text) element.textContent = options.text;
    if (options.placeholder) element.setAttribute('placeholder', options.placeholder);
    if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
    if (options.contentEditable) element.setAttribute('contenteditable', 'true');
    this.document.body.append(element);
    return element;
  }
}

async function withFakePage<T>(page: FakePage, run: () => Promise<T>): Promise<T> {
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const define = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const setScroll = (next: { x?: number; y?: number }) => {
    if (Number.isFinite(next.x)) page.windowState.scrollX = Number(next.x);
    if (Number.isFinite(next.y)) page.windowState.scrollY = Number(next.y);
    Object.defineProperty(globalThis, 'scrollX', { configurable: true, writable: true, value: page.windowState.scrollX });
    Object.defineProperty(globalThis, 'scrollY', { configurable: true, writable: true, value: page.windowState.scrollY });
  };

  define('document', page.document);
  define('location', { href: 'https://example.test/page' });
  define('innerWidth', page.windowState.innerWidth);
  define('innerHeight', page.windowState.innerHeight);
  define('scrollX', page.windowState.scrollX);
  define('scrollY', page.windowState.scrollY);
  define('window', globalThis);
  define('chrome', { runtime: page.runtime.api });
  define('Element', FakeElement);
  define('HTMLElement', FakeHTMLElement);
  define('HTMLInputElement', FakeHTMLInputElement);
  define('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  define('HTMLSelectElement', FakeHTMLSelectElement);
  define('HTMLButtonElement', FakeHTMLButtonElement);
  define('Event', FakeEvent);
  define('KeyboardEvent', FakeKeyboardEvent);
  define('MutationObserver', FakeMutationObserver);
  define('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') });
  define('getComputedStyle', (element: FakeElement) => element.style);
  define('scrollBy', (options: { left?: number; top?: number }) => setScroll({ x: page.windowState.scrollX + Number(options.left ?? 0), y: page.windowState.scrollY + Number(options.top ?? 0) }));
  define('scrollTo', (options: { left?: number; top?: number }) => setScroll({ x: Number(options.left ?? page.windowState.scrollX), y: Number(options.top ?? page.windowState.scrollY) }));

  try {
    return await run();
  } finally {
    for (const [key, descriptor] of [...descriptors].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

class FakeDocument {
  title = 'BrowserRepl Test';
  activeElement: FakeHTMLElement | null = null;
  body = new FakeHTMLElement('body');
  documentElement = new FakeHTMLElement('html');

  constructor() {
    this.documentElement.append(this.body);
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    return this.elements().filter((element) => matchesSelector(element, selector));
  }

  elements() {
    const result: FakeHTMLElement[] = [];
    const visit = (element: FakeHTMLElement) => {
      for (const child of element.children) {
        result.push(child as FakeHTMLElement);
        visit(child as FakeHTMLElement);
      }
    };
    visit(this.body);
    return result;
  }
}

class FakeElement {
  readonly tagName: string;
  parentElement: FakeHTMLElement | null = null;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  style = { display: 'block', visibility: 'visible', opacity: '1' };
  rect = { x: 10, y: 20, width: 100, height: 24 };
  dispatchedEvents: string[] = [];
  clicked = false;
  private text = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get textContent(): string { return [this.text, ...this.children.map((child) => child.textContent)].filter(Boolean).join(' '); }
  set textContent(value: string) { this.text = String(value); }
  get innerText() { return this.textContent; }
  set innerText(value: string) { this.textContent = value; }
  get isContentEditable() { return this.attributes.has('contenteditable') && this.getAttribute('contenteditable') !== 'false'; }
  append(child: FakeElement) { child.parentElement = this as unknown as FakeHTMLElement; this.children.push(child); }
  getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView() {}
  click() { this.clicked = true; }
  focus() { const document = (globalThis as any).document as FakeDocument | undefined; if (document) document.activeElement = this as unknown as FakeHTMLElement; }
  dispatchEvent(event: FakeEvent) { this.dispatchedEvents.push(event instanceof FakeKeyboardEvent ? `${event.type}:${event.key}` : event.type); return true; }
}

class FakeHTMLElement extends FakeElement {}
class FakeHTMLTextAreaElement extends FakeHTMLElement { value = ''; }
class FakeHTMLSelectElement extends FakeHTMLElement { value = ''; }
class FakeHTMLButtonElement extends FakeHTMLElement { disabled = false; }
class FakeHTMLInputElement extends FakeHTMLElement { value = ''; disabled = false; labels: FakeHTMLElement[] = []; }

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) { this.type = type; this.bubbles = Boolean(init.bubbles); this.cancelable = Boolean(init.cancelable); }
}

class FakeKeyboardEvent extends FakeEvent {
  readonly key: string;
  constructor(type: string, init: { key?: string; bubbles?: boolean; cancelable?: boolean } = {}) { super(type, init); this.key = init.key ?? ''; }
}

class FakeMutationObserver {
  private static observers = new Set<FakeMutationObserver>();
  private readonly callback: () => void;
  constructor(callback: () => void) { this.callback = callback; }
  observe() { FakeMutationObserver.observers.add(this); }
  disconnect() { FakeMutationObserver.observers.delete(this); }
  static notify() { for (const observer of FakeMutationObserver.observers) queueMicrotask(observer.callback); }
}

function createFakeRuntime() {
  const listeners = new Set<(message: unknown) => void>();
  const sentMessages: unknown[] = [];
  return {
    sentMessages,
    api: {
      onMessage: {
        addListener(listener: (message: unknown) => void) { listeners.add(listener); },
        removeListener(listener: (message: unknown) => void) { listeners.delete(listener); },
      },
      sendMessage(message: unknown) { sentMessages.push(message); return Promise.resolve(false); },
    },
    dispatch(message: unknown) { for (const listener of [...listeners]) listener(message); },
  };
}

function matchesSelector(element: FakeHTMLElement, selector: string): boolean {
  return selector.split(',').map((part) => part.trim()).some((part) => matchesSelectorPart(element, part));
}

function matchesSelectorPart(element: FakeHTMLElement, selector: string): boolean {
  if (selector.startsWith('body > ')) return matchesSelectorPath(element, selector);
  if (selector.startsWith('#')) return element.id === unescapeCss(selector.slice(1));
  if (selector.endsWith(']') || selector.includes(']:not')) return matchesAttributeSelector(element, selector);
  const nth = selector.match(/^(\w+):nth-of-type\((\d+)\)$/);
  if (nth) return element.tagName.toLowerCase() === nth[1] && nthOfType(element) === Number(nth[2]);
  return element.tagName.toLowerCase() === selector;
}

function matchesSelectorPath(element: FakeHTMLElement, selector: string) {
  const parts = selector.split('>').map((part) => part.trim());
  if (parts.shift() !== 'body') return false;
  let current: FakeHTMLElement | null = element;
  for (const part of parts.reverse()) {
    if (!current || !matchesSelectorPart(current, part)) return false;
    current = current.parentElement;
  }
  return current?.tagName.toLowerCase() === 'body';
}

function matchesAttributeSelector(element: FakeHTMLElement, selector: string) {
  if (selector === 'a[href]') return element.tagName === 'A' && element.getAttribute('href') !== null;
  if (selector === '[contenteditable]:not([contenteditable="false"])') return element.isContentEditable;
  if (selector === '[tabindex]:not([tabindex="-1"])') return element.getAttribute('tabindex') !== null && element.getAttribute('tabindex') !== '-1';
  const role = selector.match(/^\[role="([^"]+)"\]$/)?.[1];
  return role ? element.getAttribute('role') === role : false;
}

function nthOfType(element: FakeHTMLElement) {
  const siblings = element.parentElement?.children.filter((sibling) => sibling.tagName === element.tagName) ?? [];
  return siblings.indexOf(element) + 1;
}

function unescapeCss(value: string) {
  return value.replace(/\\([^a-zA-Z0-9])/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createScheduler() {
  let callback: () => void = () => undefined;
  return {
    delayMs: 0,
    setTimeout(nextCallback: () => void, delayMs: number) { callback = nextCallback; this.delayMs = delayMs; return 1; },
    clearTimeout() { callback = () => undefined; },
    fire() { callback(); },
  };
}

assert.equal(DEFAULT_BROWSER_REPL_TIMEOUT_MS, 30_000);

await testPageRuntimeHelpersBehaveInFakePage();
await testScriptingScriptUsesSameJsonCommandSemantics();
await testScriptingFallbackResultIsReturned();
await testBrowserJsUsesUserScriptsMainWorld();
await testBrowserJsUnavailableFailsClearlyWithoutProductionFallback();
await testBrowserJsSharesPageGlobalsButNotExtensionLexicals();
await testBrowserJsCanBeDisabledForAgentConsent();
testParsesInput();
testRoutesFallbacks();
await testRunsSandboxWithHelpersAndElementRefs();
await testCdpFallbackDispatchesNativeClick();
await testHelperTimeoutUsesScheduler();
database.close();

console.info('browser repl tests passed');
