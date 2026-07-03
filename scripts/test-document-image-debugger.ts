import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDebuggerController, type NetworkLog } from '../lib/debugger-tool.ts';
import { elementToMarkdown, extractTables, htmlToMarkdown } from '../lib/document-markdown.ts';
import { createExtractImageController, extractImageFromPage, parseExtractImageInput } from '../lib/extract-image.ts';
import { createGetDocumentController, parseGetDocumentInput } from '../lib/get-document.ts';

const require = createRequire(import.meta.url);
const JSDOMParser = require('@mozilla/readability/JSDOMParser.js') as new () => { parse(html: string, url?: string): Document };

async function testGetDocumentController() {
  const { cleanup, html } = installDocumentMarkdownDom();
  try {
    const controller = createGetDocumentController({
      async getCurrentTabId() {
        return 7;
      },
      async executeInTab(tabId) {
        assert.equal(tabId, 7);
        return { title: 'Quarterly report', url: 'https://example.test/report', selection: 'selected text', html: html.page } as never;
      },
      async fetchText() {
        throw new Error('fetch blocked');
      },
      async fetchArrayBuffer() {
        return new ArrayBuffer(0);
      },
    });

    assert.deepEqual(parseGetDocumentInput({ source: 'file', fileText: 'hello' }), { source: 'file', fileText: 'hello' });
    assert.throws(() => parseGetDocumentInput({ source: 'currentPage', mode: 'page', extra: true }), /Unknown getDocument\.currentPage input: extra/);
    assert.throws(() => parseGetDocumentInput({ source: 'pdf' }), /getDocument.pdf requires url/);
    for (const oldSource of ['reader', 'page', 'selection']) {
      assert.throws(() => parseGetDocumentInput({ source: oldSource }), new RegExp(`Invalid getDocument source: ${oldSource}`));
    }

    const pageResult = await controller.run({ source: 'currentPage', mode: 'page', includeTables: true });
    assert.equal(pageResult.ok, true);
    if (pageResult.ok) {
      assert.equal(pageResult.source, 'currentPage');
      assert.equal(pageResult.mode, 'page');
      assert.equal(pageResult.content, '# Quarterly report\n\n# Report\n\nSummary text\n\nFirst item\n\nSecond item\n\n| Name | Value\\|Raw |\n| --- | --- |\n| A\\|B | 2 |\n| C | 3 |\n| Column 1 | Column 2 |\n| --- | --- |\n| Fallback A | Fallback B |\n| Fallback C | Fallback D |');
      assert.equal(pageResult.tables?.[0]?.rows[0]?.[1], '2');
      assert.equal(pageResult.tables?.[0]?.markdown, '| Name | Value\\|Raw |\n| --- | --- |\n| A\\|B | 2 |\n| C | 3 |');
    }

    const selectionResult = await controller.run({ source: 'currentPage', mode: 'selection' });
    assert.equal(selectionResult.ok, true);
    if (selectionResult.ok) assert.equal(selectionResult.content, 'selected text');

    const fileResult = await controller.run({ source: 'file', fileName: 'notes.txt', fileText: 'Plain file\n' });
    assert.equal(fileResult.ok, true);
    assert.equal(fileResult.content, 'Plain file\n');
  } finally {
    cleanup();
  }
}

async function testGetDocumentReaderDoesNotRefetchCurrentPage() {
  const { cleanup, html } = installDocumentMarkdownDom();
  let fetched = false;
  try {
    const controller = createGetDocumentController({
      async getCurrentTabId() { return 2; },
      async executeInTab() {
        return { title: 'Current app', url: 'https://example.test/app', selection: '', html: html.reader } as never;
      },
      async fetchText() { fetched = true; throw new Error('stale network HTML'); },
      async fetchArrayBuffer() { return new ArrayBuffer(0); },
    });

    const result = await controller.run({ source: 'currentPage', mode: 'article' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, '# Reader article\n\nReader body');
    assert.equal(fetched, false);
  } finally {
    cleanup();
  }
}

async function testGetDocumentRemoteReaderIncludesTables() {
  assert.throws(
    () => parseGetDocumentInput({ source: 'currentPage', mode: 'article', url: 'https://remote.test/article' }),
    /Unknown getDocument\.currentPage input: url/,
  );
}

async function testGetDocumentReaderUrlDoesNotFallback() {
  const controller = createGetDocumentController({
    async getCurrentTabId() { return 2; },
    async executeInTab() {
      throw new Error('pdf should not inject into current page');
    },
    async fetchText() { throw new Error('unused'); },
    async fetchArrayBuffer() { throw new Error('remote fetch failed'); },
  });

  const result = await controller.run({ source: 'pdf', url: 'https://remote.test/article.pdf' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'REMOTE_FETCH_FAILED');
}

async function testGetDocumentSelectionFallback() {
  const { cleanup, html } = installDocumentMarkdownDom();
  try {
    const controller = createGetDocumentController({
      async getCurrentTabId() { return 3; },
      async executeInTab() {
        return { title: 'No selection', url: 'https://example.test/no-selection', selection: '', html: html.selection } as never;
      },
      async fetchText() { throw new Error('offline'); },
      async fetchArrayBuffer() { return new ArrayBuffer(0); },
    });

    const result = await controller.run({ source: 'currentPage', mode: 'selection' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'NO_SELECTION');
  } finally {
    cleanup();
  }
}

function testDocumentMarkdownElementRules() {
  const { cleanup, sampleArticle } = installDocumentMarkdownDom();
  try {
    assert.equal(elementToMarkdown(sampleArticle() as never), '# Report\n\nSummary text\n\nFirst item\n\nSecond item');
  } finally {
    cleanup();
  }
}

function testDocumentMarkdownTableRules() {
  const { cleanup, tablePage } = installDocumentMarkdownDom();
  try {
    const tables = extractTables(tablePage() as never);
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0], {
      caption: 'Quarterly data',
      headers: ['Name', 'Value|Raw'],
      rows: [['A|B', '2'], ['C', '3']],
      markdown: '| Name | Value\\|Raw |\n| --- | --- |\n| A\\|B | 2 |\n| C | 3 |',
    });
    assert.deepEqual(tables[1]?.headers, ['Column 1', 'Column 2']);
    assert.deepEqual(tables[1]?.rows, [['Fallback A', 'Fallback B'], ['Fallback C', 'Fallback D']]);
  } finally {
    cleanup();
  }
}

function testRemoteHtmlUsesSharedMarkdownRules() {
  const { cleanup, html } = installDocumentMarkdownDom();
  try {
    assert.equal(htmlToMarkdown(html.remote), '## Remote\n\nRemote text\n\n| Name | Value\\|Raw |\n| --- | --- |\n| A\\|B | 2 |\n| C | 3 |');
  } finally {
    cleanup();
  }
}

async function testGetDocumentPageSnapshotConversion() {
  const { cleanup, html } = installDocumentMarkdownDom();
  try {
    const controller = createGetDocumentController({
      async getCurrentTabId() { return 11; },
      async executeInTab(tabId) {
        assert.equal(tabId, 11);
        return { title: 'Snapshot page', url: 'https://example.test/snapshot', selection: '', html: html.page } as never;
      },
      async fetchText() { throw new Error('offline'); },
      async fetchArrayBuffer() { return new ArrayBuffer(0); },
    });

    const result = await controller.run({ source: 'currentPage', mode: 'page', includeTables: true });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.content, '# Snapshot page\n\n# Report\n\nSummary text\n\nFirst item\n\nSecond item\n\n| Name | Value\\|Raw |\n| --- | --- |\n| A\\|B | 2 |\n| C | 3 |\n| Column 1 | Column 2 |\n| --- | --- |\n| Fallback A | Fallback B |\n| Fallback C | Fallback D |');
      assert.equal(result.tables?.[0]?.markdown, '| Name | Value\\|Raw |\n| --- | --- |\n| A\\|B | 2 |\n| C | 3 |');
    }
  } finally {
    cleanup();
  }
}

async function testGetDocumentSelectionSnapshotFallback() {
  const { cleanup, html } = installDocumentMarkdownDom();
  try {
    const controller = createGetDocumentController({
      async getCurrentTabId() { return 12; },
      async executeInTab() {
        return { title: 'No selection snapshot', url: 'https://example.test/no-selection', selection: '', html: html.selection } as never;
      },
      async fetchText() { throw new Error('offline'); },
      async fetchArrayBuffer() { return new ArrayBuffer(0); },
    });

    const result = await controller.run({ source: 'currentPage', mode: 'selection' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'NO_SELECTION');
  } finally {
    cleanup();
  }
}

async function testGetDocumentReaderCurrentPageSnapshot() {
  const { cleanup, html } = installDocumentMarkdownDom();
  let fetched = false;
  try {
    const controller = createGetDocumentController({
      async getCurrentTabId() { return 13; },
      async executeInTab() {
        return { title: 'Reader snapshot', url: 'https://example.test/reader', selection: '', html: html.reader } as never;
      },
      async fetchText() { fetched = true; throw new Error('must not fetch current page'); },
      async fetchArrayBuffer() { return new ArrayBuffer(0); },
    });

    const result = await controller.run({ source: 'currentPage', mode: 'article' });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, '# Reader article\n\nReader body');
    assert.equal(fetched, false);
  } finally {
    cleanup();
  }
}

async function testGetDocumentPdf() {
  const controller = createGetDocumentController({
    async getCurrentTabId() { return 1; },
    async executeInTab() { throw new Error('pdf should not inject into page'); },
    async fetchText() { throw new Error('pdf should not fetch text'); },
    async fetchArrayBuffer() { return helloPdf(); },
  });

  const result = await controller.run({ source: 'pdf', url: 'https://example.test/file.pdf' });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.content, /Hello PDF/);
}

async function testExtractImageController() {
  const capturedViewportInputs: unknown[] = [];
  const controller = createExtractImageController({
    async getCurrentTabId() {
      return 5;
    },
    async captureVisibleTab(input) {
      capturedViewportInputs.push(input);
      if (input.format === 'jpeg') return 'data:image/jpeg;base64,JPEG=';
      assert.equal(input.format, 'png');
      return 'data:image/png;base64,AAA=';
    },
    async executeInTab(tabId, input) {
      assert.equal(tabId, 5);
      assert.equal(input.selector, 'img.product');
      return { ok: true, source: 'imageElement', selector: input.selector, url: 'https://example.test/product.png', width: 640, height: 480 };
    },
  });

  assert.deepEqual(await controller.run({ source: 'viewport', format: 'png' }), { ok: true, source: 'viewport', dataUrl: 'data:image/png;base64,AAA=', mediaType: 'image/png' });
  assert.deepEqual(capturedViewportInputs[0], { source: 'viewport', format: 'png' });
  const jpegResult = await controller.run({ source: 'viewport', format: 'jpeg', jpegQuality: 80 });
  assert.equal(jpegResult.ok, true);
  if (jpegResult.ok) assert.equal(jpegResult.mediaType, 'image/jpeg');
  assert.deepEqual(capturedViewportInputs[1], { source: 'viewport', format: 'jpeg', jpegQuality: 80 });
  assert.equal('quality' in (capturedViewportInputs[1] as Record<string, unknown>), false);
  const imageResult = await controller.run({ source: 'imageElement', selector: 'img.product' });
  assert.equal(imageResult.ok, true);
  if (imageResult.ok) assert.equal(imageResult.url, 'https://example.test/product.png');
  await assert.rejects(() => controller.run({ source: 'canvas' }), /extractImage.canvas requires selector/);
  for (const oldSource of ['selector', 'background']) {
    assert.throws(() => parseExtractImageInput({ source: oldSource, selector: 'img' }), new RegExp(`Invalid extractImage source: ${oldSource}`));
  }
  assert.throws(() => parseExtractImageInput({ source: 'viewport', format: 'jpeg', quality: Number('0.8') }), /Unknown extractImage\.viewport input: quality/);
  assert.throws(() => parseExtractImageInput({ source: 'imageElement', selector: 'img', fullPage: true }), /Unknown extractImage\.imageElement input: fullPage/);
  assert.throws(() => parseExtractImageInput([]), /extractImage input must be an object/);

  const screenshotController = createExtractImageController({
    async getCurrentTabId() { return 1; },
    async captureVisibleTab() { throw new Error('tab not visible'); },
    async executeInTab() { throw new Error('unused'); },
  });
  const screenshot = await screenshotController.run({ source: 'viewport' });
  assert.equal(screenshot.ok, false);
  if (!screenshot.ok) assert.equal(screenshot.code, 'SCREENSHOT_UNAVAILABLE');

  const accessController = createExtractImageController({
    async getCurrentTabId() { return 1; },
    async captureVisibleTab() { throw new Error('unused'); },
    async executeInTab() { throw new Error('Cannot access contents of url'); },
  });
  const access = await accessController.run({ source: 'imageElement', selector: 'img.product' });
  assert.equal(access.ok, false);
  if (!access.ok) assert.equal(access.code, 'PAGE_ACCESS_REQUIRED');
}

function testExtractImagePageSources() {
  const { cleanup, canvas } = installImageDocument();
  try {
    assert.deepEqual(extractImageFromPage({ source: 'imageElement', selector: '#product' }), {
      ok: true, source: 'imageElement', selector: '#product', url: 'https://cdn.test/product.png', width: 640, height: 480, alt: 'Product image',
    });
    assert.deepEqual(extractImageFromPage({ source: 'imageElement', selector: '#inline' }), {
      ok: true, source: 'imageElement', selector: '#inline', dataUrl: 'data:image/webp;base64,INLINE', mediaType: 'image/webp', width: 32, height: 24, alt: 'Inline image',
    });
    assert.deepEqual(extractImageFromPage({ source: 'canvas', selector: '#chart', format: 'jpeg', jpegQuality: 80 }), {
      ok: true, source: 'canvas', selector: '#chart', dataUrl: 'data:image/jpeg;base64,CANVAS', mediaType: 'image/jpeg', width: 16, height: 16,
    });
    assert.equal(canvas.lastQuality, 0.8);
    assert.throws(() => extractImageFromPage({ source: 'canvas' }), /extractImage.canvas requires selector/);
    assert.deepEqual(extractImageFromPage({ source: 'backgroundImage', selector: '#hero' }), {
      ok: true, source: 'backgroundImage', selector: '#hero', dataUrl: 'data:image/png;base64,BG', mediaType: 'image/png', width: 300, height: 120,
    });
    const missing = extractImageFromPage({ source: 'imageElement', selector: '#missing' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, 'ELEMENT_NOT_FOUND');
    const invalid = extractImageFromPage({ source: 'imageElement', selector: '[' });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.code, 'INVALID_SELECTOR');
  } finally {
    cleanup();
  }
}

function installReadabilityDomParser() {
  const globalObject = globalThis as Record<string, unknown>;
  const keys = ['Node', 'Element', 'DOMParser'];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const setGlobal = (key: string, value: unknown) => Object.defineProperty(globalObject, key, { value, configurable: true, writable: true });
  setGlobal('Node', { TEXT_NODE: 3 });
  setGlobal('DOMParser', class {
    parseFromString(markup: string) {
      const source = /<html[\s>]/i.test(markup) ? markup : `<html><body>${markup}</body></html>`;
      const documentCopy = new JSDOMParser().parse(source);
      setGlobal('Element', documentCopy.documentElement.constructor);
      return documentCopy;
    }
  });
  return () => {
    for (const [key, descriptor] of previous) restoreGlobal(key, descriptor);
  };
}

function installDocumentMarkdownDom() {
  type FakeChild = FakeElement | FakeText;
  const html = {
    page: 'taber:test-page-html',
    remote: 'taber:test-remote-html',
    selection: 'taber:test-selection-html',
    reader: 'taber:test-reader-html',
  };

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

  function text(value: string) {
    return new FakeText(value);
  }

  function element(tagName: string, children: (FakeChild | string)[] = []) {
    const childNodes = children.map((child) => (typeof child === 'string' ? text(child) : child));
    return tagName.toUpperCase() === 'TABLE' ? new FakeTableElement(tagName, childNodes) : new FakeElement(tagName, childNodes);
  }

  function descendants(root: FakeElement, tagName: string): FakeElement[] {
    return root.children.flatMap((child) => [child, ...descendants(child, tagName)]).filter((child) => child.tagName === tagName);
  }

  function firstChild(root: FakeElement, tagName: string) {
    return root.children.find((child) => child.tagName === tagName);
  }

  function dataTable() {
    return element('table', [
      element('caption', ['Quarterly data']),
      element('thead', [element('tr', [element('th', ['Name']), element('th', ['Value|Raw'])])]),
      element('tbody', [
        element('tr', [element('td', ['A|B']), element('td', ['2'])]),
        element('tr', [element('td', ['C']), element('td', ['3'])]),
      ]),
    ]);
  }

  function fallbackTable() {
    return element('table', [
      element('tr', [element('td', ['Fallback A']), element('td', ['Fallback B'])]),
      element('tr', [element('td', ['Fallback C']), element('td', ['Fallback D'])]),
    ]);
  }

  function sampleArticle() {
    return element('article', [
      element('h1', ['Report']),
      element('p', [' Summary   text ']),
      element('ul', [element('li', ['First item']), element('li', ['Second item'])]),
    ]);
  }

  function pageBody() {
    return element('body', [element('article', [...sampleArticle().childNodes, dataTable(), fallbackTable()])]);
  }

  function remoteBody() {
    return element('body', [element('main', [element('h2', ['Remote']), element('p', ['Remote text']), dataTable()])]);
  }

  function selectionBody() {
    return element('body', [element('p', ['Selection fallback body'])]);
  }

  function readerBody() {
    return element('body', [element('article', [element('h1', ['Reader article']), element('p', ['Reader body'])])]);
  }

  const documents = new Map([
    [html.page, pageBody],
    [html.remote, remoteBody],
    [html.selection, selectionBody],
    [html.reader, readerBody],
  ]);
  const globalObject = globalThis as Record<string, unknown>;
  const keys = ['Node', 'Element', 'HTMLTableElement', 'DOMParser'];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const setGlobal = (key: string, value: unknown) => Object.defineProperty(globalObject, key, { value, configurable: true, writable: true });
  setGlobal('Node', { TEXT_NODE: 3 });
  setGlobal('Element', FakeElement);
  setGlobal('HTMLTableElement', FakeTableElement);
  setGlobal('DOMParser', class {
    parseFromString(markup: string) {
      const createBody = documents.get(markup) ?? (() => element('body'));
      return new FakeDocument(createBody());
    }
  });

  return {
    cleanup() {
      for (const [key, descriptor] of previous) restoreGlobal(key, descriptor);
    },
    html,
    sampleArticle,
    tablePage: pageBody,
  };
}

function installImageDocument() {
  class FakeElement {
    private rectWidth: number;
    private rectHeight: number;
    constructor(width: number, height: number) {
      this.rectWidth = width;
      this.rectHeight = height;
    }
    getBoundingClientRect() { return { width: this.rectWidth, height: this.rectHeight }; }
  }
  class FakeImage extends FakeElement {
    src: string;
    width: number;
    height: number;
    currentSrc: string;
    naturalWidth: number;
    naturalHeight: number;
    alt: string;
    constructor(currentSrc: string, naturalWidth: number, naturalHeight: number, alt: string) {
      super(naturalWidth, naturalHeight);
      this.currentSrc = currentSrc;
      this.naturalWidth = naturalWidth;
      this.naturalHeight = naturalHeight;
      this.alt = alt;
      this.src = currentSrc;
      this.width = naturalWidth;
      this.height = naturalHeight;
    }
  }
  class FakeCanvas extends FakeElement {
    width: number;
    height: number;
    lastQuality: number | undefined;
    constructor(width: number, height: number) {
      super(width, height);
      this.width = width;
      this.height = height;
    }
    toDataURL(type: string, quality?: number) {
      this.lastQuality = quality;
      return `data:${type};base64,CANVAS`;
    }
  }

  const product = new FakeImage('https://cdn.test/product.png', 640, 480, 'Product image');
  const inline = new FakeImage('data:image/webp;base64,INLINE', 32, 24, 'Inline image');
  const canvas = new FakeCanvas(16, 16);
  const hero = new FakeElement(300, 120);
  const elements = new Map<string, unknown>([['#product', product], ['#inline', inline], ['#chart', canvas], ['#hero', hero]]);
  const styles = new Map<unknown, string>([[hero, 'url("data:image/png;base64,BG")']]);
  const globalObject = globalThis as Record<string, unknown>;
  const keys = ['document', 'HTMLImageElement', 'HTMLCanvasElement', 'getComputedStyle', 'location'];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const setGlobal = (key: string, value: unknown) => Object.defineProperty(globalObject, key, { value, configurable: true, writable: true });
  setGlobal('document', { querySelector: (selector: string) => {
    if (selector === '[') throw new Error('Invalid selector');
    return elements.get(selector) ?? null;
  } });
  setGlobal('HTMLImageElement', FakeImage);
  setGlobal('HTMLCanvasElement', FakeCanvas);
  setGlobal('getComputedStyle', (target: unknown) => ({ backgroundImage: styles.get(target) ?? 'none' }));
  setGlobal('location', { href: 'https://shop.test/page' });
  return {
    canvas,
    cleanup() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalObject, key, descriptor);
        else delete globalObject[key];
      }
    },
  };
}

async function testDebuggerAttachFailureDoesNotMarkAttached() {
  const debuggerApi = createFakeDebuggerApi();
  debuggerApi.attachError = new Error('Another debugger is already attached to the tab with id: 9');
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  await assert.rejects(() => controller.run({ action: 'attach' }), /Another debugger/);
  debuggerApi.attachError = undefined;
  await controller.run({ action: 'attach' });
  assert.equal(debuggerApi.attachCount, 2);
}

async function testDebuggerEnableFailureDoesNotMarkAttached() {
  const debuggerApi = createFakeDebuggerApi();
  debuggerApi.commandError = new Error('Runtime.enable failed');
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  await assert.rejects(() => controller.run({ action: 'attach' }), /Runtime\.enable failed/);
  debuggerApi.commandError = undefined;
  await controller.run({ action: 'attach' });
  assert.equal(debuggerApi.attachCount, 2);
}

async function testDebuggerDetachClearsState() {
  const debuggerApi = createFakeDebuggerApi();
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  await controller.run({ action: 'attach' });
  debuggerApi.emit({ tabId: 9 }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'old error' }] });
  await controller.run({ action: 'detach' });
  await controller.run({ action: 'attach' });
  const logs = await controller.run({ action: 'consoleLogs' });

  assert('logs' in logs);
  assert.deepEqual(logs.logs, []);
  assert.equal(debuggerApi.detachCount, 1);
}

async function testDebuggerRejectsCookieBypassExpressions() {
  const debuggerApi = createFakeDebuggerApi();
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  await controller.run({ action: 'attach' });
  const runtimeEvaluateCalls = () => debuggerApi.commandCalls.filter((call) => call.method === 'Runtime.evaluate').length;
  const beforeEvaluate = runtimeEvaluateCalls();
  const beforeCalls = debuggerApi.commandCalls.length;

  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document.cookie' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document.coo\\u006bie' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document/*x*/.cookie' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document/*x*/.cookie' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document[secretKey]' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'globalThis.document[secretKey]' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document[secretKey]' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'globalThis.document[secretKey]' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "globalThis['doc'+'ument'].cookie" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "globalThis['doc'+'ument'].cookie" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.coo\\u006bie' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document?.cookie' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document?.cookie' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "document['co' + 'okie']" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document["coo"+"kie"]' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'Reflect.get(document, String.fromCharCode(99,111,111,107,105,101))' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "globalThis['ev'+'al']('document.cookie')" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'cookieStore.getAll()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'window.cookieStore.getAll()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'savedCookieGetter.call(document)' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'savedCookieGetter()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'g()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: '(0,g)()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: '((()=>g)())()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "((()=>window['g'])())()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "((()=>globalThis['g'])())()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '((()=>g)())()' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "((()=>window['g'])())()" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'g?.()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: '(g)()' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '(0,g)()' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'g?.()' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '(g)()' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'Array.from({ length: 1 }, g)' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'JSON.stringify([1], g)' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "window['g']()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "globalThis['g']()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "globalThis['g']?.()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "(globalThis['g'])?.()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "(0,globalThis['g'])?.()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "globalThis['g']?.()" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "(globalThis['g'])?.()" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "(0,globalThis['g'])?.()" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "this['g']()" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "window['g']()" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "globalThis['g']()" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'Promise.resolve(1).then(g)' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'Promise.resolve(1).then(window.g)' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'g()' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'Promise.resolve(1).then(g)' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'cookieStore.getAll()' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: "document['co'+'okie']" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'window.open("about:blank").document[String.fromCharCode(99,111,111,107,105,101)]' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document.body.appendChild(document.createElement("iframe")).contentWindow.document[String.fromCharCode(99,111,111,107,105,101)]' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document.body.innerHTML="<iframe srcdoc=x></iframe>",window[0].document[String.fromCharCode(99,111,111,107,105,101)]' }), /does not expose cookies/);
  const obfuscatedIframe = "document.body['in'+'ner'+'HTML']='<'+'i'+'fr'+'ame'+'></'+'i'+'fr'+'ame'+'>';window['fr'+'ames'][0].document[atob('Y29va2ll')]";
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: obfuscatedIframe }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: obfuscatedIframe } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'setTimeout(()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)]),0)' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'queueMicrotask(()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)]))' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: "Promise.resolve().then.call(Promise.resolve(),()=>document['co'+'okie'])" }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'Promise.resolve(1).then(async function(){ return (0,g)() })' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'Promise.resolve(1).then(async function(){ return (0,g)() })' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'new MutationObserver(()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)]))' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'new MessageChannel().port1.onmessage=()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)])' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '1 + 1', objectGroup: 'cookie' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'window.open("about:blank").document[String.fromCharCode(99,111,111,107,105,101)]' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'setTimeout(()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)]),0)' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'queueMicrotask(()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)]))' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Page.evaluate', params: { expression: 'Reflect.get(document, String.fromCharCode(99,111,111,107,105,101))' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.callFunctionOn', params: { functionDeclaration: "function(){return document['co'+'okie']}" } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.callAsyncFunctionOn', params: { functionDeclaration: 'async function(){return g()}' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Debugger.evaluateOnCallFrame', params: { callFrameId: '1', expression: 'Reflect.get(document, String.fromCharCode(99,111,111,107,105,101))' } }), /does not expose cookies/);
  assert.equal(runtimeEvaluateCalls(), beforeEvaluate);
  assert.equal(debuggerApi.commandCalls.length, beforeCalls);
}

async function testDebuggerAllowsPromiseStateRead() {
  const debuggerApi = createFakeDebuggerApi();
  debuggerApi.evaluateExpressions = true;
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  const result = await controller.run({ action: 'evaluate', expression: 'Promise.resolve(1).then((value)=>value)' });

  assert('value' in result);
  assert.equal(result.value, 1);
}

async function testDebuggerCookieGuardRestoresDocument() {
  const cleanup = installCookieDocument();
  const debuggerApi = createFakeDebuggerApi();
  debuggerApi.evaluateExpressions = true;
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });
  const documentPrototype = Object.getPrototypeOf(globalThis.document);
  const before = Object.getOwnPropertyDescriptor(documentPrototype, 'cookie');

  try {
    await controller.run({ action: 'evaluate', expression: 'Promise.resolve(1).then((value)=>value)' });
    const after = Object.getOwnPropertyDescriptor(documentPrototype, 'cookie');
    assert.equal(after?.get, before?.get);
    assert.equal((globalThis.document as { cookie: string }).cookie, 'secret=1');
  } finally {
    cleanup();
  }
}

async function testDebuggerRuntimeCookieGuardBlocksDynamicProperty() {
  const cleanup = installCookieDocument({ shadowConstructors: true });
  const debuggerApi = createFakeDebuggerApi();
  debuggerApi.evaluateExpressions = true;
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  try {
    const expression = "document['co'/**/+/**/'okie']";
    const delayedExpression = "globalThis['set'+'Timeout'](()=>console.log(document[String.fromCharCode(99,111,111,107,105,101)]),0)";
    const savedDefineProperty = Object.defineProperty;
    await assert.rejects(() => controller.run({ action: 'evaluate', expression }), /does not expose cookies/);
    await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression } }), /does not expose cookies/);
    await assert.rejects(() => controller.run({ action: 'evaluate', expression: delayedExpression }), /does not expose cookies/);
    await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: delayedExpression } }), /does not expose cookies/);
    try {
      savedDefineProperty(Object, 'defineProperty', { value: () => undefined, configurable: true });
      await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'const d=document; d[secretKey]' }), /does not expose cookies/);
      await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'const d=document; d[secretKey]' } }), /does not expose cookies/);
    } finally {
      savedDefineProperty(Object, 'defineProperty', { value: savedDefineProperty, configurable: true });
    }
  } finally {
    cleanup();
  }
}

async function testDebuggerController() {
  const debuggerApi = createFakeDebuggerApi();
  const controller = createDebuggerController({ debuggerApi, async getCurrentTabId() { return 9; } });

  const attached = await controller.run({ action: 'attach' });
  assert('attached' in attached);
  assert.equal(attached.attached, true);
  debuggerApi.emit({ tabId: 9 }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }], stackTrace: { callFrames: [{ url: 'https://example.test/app.js' }] } });
  debuggerApi.emit({ tabId: 9 }, 'Network.requestWillBeSent', { requestId: '1', request: { url: 'https://api.test/items', method: 'GET' }, type: 'Fetch', timestamp: 123 });
  debuggerApi.emit({ tabId: 9 }, 'Network.responseReceived', { requestId: '1', response: { status: 500 } });
  debuggerApi.emit({ tabId: 9 }, 'Network.requestWillBeSent', { requestId: '2', request: { url: 'https://api.test/fail', method: 'POST' }, type: 'XHR' });
  debuggerApi.emit({ tabId: 9 }, 'Network.loadingFailed', { requestId: '2', errorText: 'net::ERR_FAILED', type: 'XHR' });

  const logs = await controller.run({ action: 'consoleLogs' });
  assert('logs' in logs);
  assert.equal(logs.logs[0]?.text, 'boom');
  assert.equal(logs.logs[0]?.url, 'https://example.test/app.js');
  const network = await controller.run({ action: 'networkLogs' });
  assert('requests' in network);
  assert.deepEqual(network.requests.map((request: NetworkLog) => [request.url, request.method, request.status, request.type]), [['https://api.test/items', 'GET', 500, 'Fetch'], ['https://api.test/fail', 'POST', undefined, 'XHR']]);
  assert.equal(typeof network.requests[0]?.time, 'number');
  const failed = await controller.run({ action: 'failedRequests' });
  assert('requests' in failed);
  assert.deepEqual(failed.requests.map((request: NetworkLog) => request.status ?? request.errorText), [500, 'net::ERR_FAILED']);
  assert.deepEqual(failed.requests.map((request: NetworkLog) => [request.url, request.method, request.type]), [['https://api.test/items', 'GET', 'Fetch'], ['https://api.test/fail', 'POST', 'XHR']]);
  assert.equal(typeof failed.requests[0]?.time, 'number');
  const evaluated = await controller.run({ action: 'evaluate', expression: 'window.appState' });
  assert('value' in evaluated);
  assert.equal(evaluated.value, 42);
  const evaluatedBracket = await controller.run({ action: 'evaluate', expression: 'window["appState"]' });
  assert('value' in evaluatedBracket);
  assert.equal(evaluatedBracket.value, 42);
  const cookieConsent = await controller.run({ action: 'evaluate', expression: 'window.cookieConsent' });
  assert('value' in cookieConsent);
  assert.equal(cookieConsent.value, true);
  const stringified = await controller.run({ action: 'evaluate', expression: 'JSON.stringify(window.appState)' });
  assert('value' in stringified);
  assert.equal(stringified.value, '{"ready":true}');
  const asyncIife = await controller.run({ action: 'evaluate', expression: '(async () => window.appState)()' });
  assert('value' in asyncIife);
  assert.equal(asyncIife.value, 42);
  const cdpCookieConsent = await controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'window.cookieConsent', returnByValue: true } });
  assert('value' in cdpCookieConsent);
  assert.deepEqual(cdpCookieConsent.value, { result: { value: true } });
  const cdpAsyncIife = await controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '(async()=>window.appState)()', returnByValue: true } });
  assert('value' in cdpAsyncIife);
  assert.deepEqual(cdpAsyncIife.value, { result: { value: 42 } });
  const cdp = await controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: '1 + 1', returnByValue: true } });
  assert('value' in cdp);
  assert.deepEqual(cdp.value, { result: { value: 2 } });
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Network.getCookies' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'document.cookie' }), /does not expose cookies/);
  await assert.rejects(() => controller.run({ action: 'evaluate', expression: 'throwError' }), /boom from page/);
}

function helloPdf() {
  const stream = 'BT /F1 24 Tf 72 72 Td (Hello PDF) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj',
  ];
  let pdf = '%PDF-1.1\n';
  const offsets = objects.map((object) => {
    const offset = pdf.length;
    pdf += `${object}\n`;
    return offset;
  });
  const xrefOffset = pdf.length;
  const xrefRows = offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `);
  pdf += `xref\n0 6\n0000000000 65535 f \n${xrefRows.join('\n')}\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const bytes = new TextEncoder().encode(pdf);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function installCookieDocument(options: { shadowConstructors?: boolean } = {}) {
  class RealDocument {}
  class ShadowDocument {}
  Object.defineProperty(RealDocument.prototype, 'cookie', { configurable: true, get() { return 'secret=1'; } });
  const constructorValue = options.shadowConstructors ? ShadowDocument : RealDocument;
  const globalObject = globalThis as Record<string, unknown>;
  const previousDocumentClass = Object.getOwnPropertyDescriptor(globalThis, 'Document');
  const previousHtmlDocumentClass = Object.getOwnPropertyDescriptor(globalThis, 'HTMLDocument');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalObject, 'Document', { value: constructorValue, configurable: true });
  Object.defineProperty(globalObject, 'HTMLDocument', { value: constructorValue, configurable: true });
  Object.defineProperty(globalObject, 'document', { value: new RealDocument(), configurable: true });
  return () => {
    restoreGlobal('Document', previousDocumentClass);
    restoreGlobal('HTMLDocument', previousHtmlDocumentClass);
    restoreGlobal('document', previousDocument);
  };
}

function restoreGlobal(key: string, descriptor: PropertyDescriptor | undefined) {
  const globalObject = globalThis as Record<string, unknown>;
  if (descriptor) Object.defineProperty(globalObject, key, descriptor);
  else delete globalObject[key];
}

async function evaluateExpression(expression: string) {
  try {
    return { result: { value: await eval(expression) } };
  } catch (error) {
    return { exceptionDetails: { exception: { description: error instanceof Error ? error.message : String(error) } } };
  }
}

function createFakeDebuggerApi() {
  type DebugListener = (source: { tabId: number }, method: string, params?: Record<string, unknown>) => void;
  const eventListeners = new Set<DebugListener>();
  return {
    attachError: undefined as Error | undefined,
    commandError: undefined as Error | undefined,
    evaluateExpressions: false,
    attachCount: 0,
    detachCount: 0,
    commandCalls: [] as { method: string; params?: Record<string, unknown> }[],
    onEvent: {
      addListener(listener: DebugListener) { eventListeners.add(listener); },
      removeListener(listener: DebugListener) { eventListeners.delete(listener); },
    },
    async attach() {
      this.attachCount += 1;
      if (this.attachError) throw this.attachError;
    },
    async detach() {
      this.detachCount += 1;
    },
    async sendCommand(_debuggee: { tabId: number }, method: string, params?: Record<string, unknown>) {
      this.commandCalls.push({ method, params });
      if (this.commandError) throw this.commandError;
      const expression = String(params?.expression ?? '');
      if (method === 'Runtime.evaluate' && this.evaluateExpressions) return evaluateExpression(expression);
      if (method === 'Runtime.evaluate' && expression.includes('throwError')) return { exceptionDetails: { exception: { description: 'Error: boom from page' } } };
      if (method === 'Runtime.evaluate' && expression.includes('document.cookie')) return { exceptionDetails: { exception: { description: 'debugger does not expose cookies' } } };
      if (method === 'Runtime.evaluate' && expression.includes('JSON.stringify')) return { result: { value: '{"ready":true}' } };
      if (method === 'Runtime.evaluate' && expression.includes('cookieConsent')) return { result: { value: true } };
      if (method === 'Runtime.evaluate' && expression.includes('1 + 1')) return { result: { value: 2 } };
      if (method === 'Runtime.evaluate') return { result: { value: 42 } };
      return {};
    },
    emit(source: { tabId: number }, method: string, params?: Record<string, unknown>) {
      for (const listener of eventListeners) listener(source, method, params);
    },
  };
}

await testGetDocumentController();
await testGetDocumentReaderDoesNotRefetchCurrentPage();
await testGetDocumentRemoteReaderIncludesTables();
await testGetDocumentReaderUrlDoesNotFallback();
await testGetDocumentSelectionFallback();
testDocumentMarkdownElementRules();
testDocumentMarkdownTableRules();
testRemoteHtmlUsesSharedMarkdownRules();
await testGetDocumentPageSnapshotConversion();
await testGetDocumentSelectionSnapshotFallback();
await testGetDocumentReaderCurrentPageSnapshot();
await testGetDocumentPdf();
await testExtractImageController();
testExtractImagePageSources();
await testDebuggerAttachFailureDoesNotMarkAttached();
await testDebuggerEnableFailureDoesNotMarkAttached();
await testDebuggerDetachClearsState();
await testDebuggerRejectsCookieBypassExpressions();
await testDebuggerAllowsPromiseStateRead();
await testDebuggerCookieGuardRestoresDocument();
await testDebuggerRuntimeCookieGuardBlocksDynamicProperty();
await testDebuggerController();
console.info('document image debugger tests passed');
