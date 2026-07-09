import { isPageAccessError, pageAccessErrorMessage } from './browser-access.ts';
import { extractDocumentMarkdownFromHtml, htmlToMarkdown as documentHtmlToMarkdown, type ExtractedTable } from './document-markdown.ts';
import type { PageDocument, PageDocumentFrame } from './get-document-page.ts';

export type { ExtractedTable } from './document-markdown.ts';
export { extractDocumentFromPage, type PageDocument, type PageDocumentFrame } from './get-document-page.ts';

export const ARTICLE_CONTENT_LIMIT = 80_000;
export const PAGE_CONTENT_LIMIT = 40_000;
export const MAX_TABLES = 20;

export type GetDocumentCurrentPageMode = 'article' | 'page' | 'selection';

export type GetDocumentInput =
  | { source: 'currentPage'; mode: GetDocumentCurrentPageMode; tabId?: number; includeTables?: boolean }
  | { source: 'url'; url: string; mode?: 'article' | 'page'; includeTables?: boolean }
  | { source: 'file'; name: string };

type GetDocumentSuccessBase = {
  ok: true;
  title?: string;
  url?: string;
  content: string;
  contentChars: number;
  truncated: boolean;
  fallback?: 'page';
  tables?: ExtractedTable[];
  tablesTruncated?: boolean;
  hints?: string[];
  frames?: PageDocumentFrame[];
};

export type GetDocumentSuccess =
  | (GetDocumentSuccessBase & { source: 'currentPage'; mode: GetDocumentCurrentPageMode })
  | (GetDocumentSuccessBase & { source: 'url'; url: string })
  | (GetDocumentSuccessBase & { source: 'file' });

export type GetDocumentErrorCode = 'NO_SELECTION' | 'NO_READABLE_CONTENT' | 'REMOTE_FETCH_FAILED' | 'PAGE_ACCESS_REQUIRED' | 'FILE_NOT_FOUND';

export type GetDocumentRecoverableError = {
  ok: false;
  code: GetDocumentErrorCode;
  message: string;
  retryHint?: string;
  title?: never;
  url?: never;
  content?: never;
  contentChars?: never;
  truncated?: never;
  fallback?: never;
  tables?: never;
  tablesTruncated?: never;
};

export type GetDocumentResult = GetDocumentSuccess | GetDocumentRecoverableError;

export const getDocumentInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['source'],
  properties: {
    source: { type: 'string', enum: ['currentPage', 'url', 'file'], description: 'currentPage reads the controlled browser tab DOM; url fetches an http/https page or PDF directly without opening a tab (fastest for static/public content); file reads an uploaded or generated /workspace file (pdf, docx, or text) as text.' },
    mode: { type: 'string', enum: ['article', 'page', 'selection'], description: 'For source:"currentPage" (required) and source:"url" (optional, defaults to article). article uses Readability with page fallback; page reads full DOM Markdown; selection reads selected text only (currentPage only).' },
    includeTables: { type: 'boolean', description: 'For source:"currentPage" and source:"url". Include extracted table objects with stable rows and Markdown table text.' },
    url: { type: 'string', minLength: 1, description: 'Required for source:"url". http/https URL of a webpage or PDF.' },
    name: { type: 'string', minLength: 1, description: 'Required for source:"file". Workspace file name as listed by fs ls, e.g. "report.docx".' },
  },
} as const;

const currentPageInputKeys = new Set(['source', 'mode', 'tabId', 'includeTables']);
const urlInputKeys = new Set(['source', 'url', 'mode', 'includeTables']);
const fileInputKeys = new Set(['source', 'name']);

type CurrentPageDocumentInput = Extract<GetDocumentInput, { source: 'currentPage' }>;
type UrlDocumentInput = Extract<GetDocumentInput, { source: 'url' }>;
type FileDocumentInput = Extract<GetDocumentInput, { source: 'file' }>;

export function parseGetDocumentInput(value: unknown): GetDocumentInput {
  if (!isRecord(value) || Array.isArray(value)) throw new Error('getDocument input must be an object');
  if (!('source' in value)) throw new Error('getDocument.source is required');

  const source = readSource(value.source);
  if (source === 'currentPage') return readCurrentPageInput(value);
  if (source === 'url') return readUrlInput(value);
  return readFileInput(value);
}

export function createGetDocumentController(options: {
  getCurrentTabId(): Promise<number>;
  executeInTab(tabId: number, input: CurrentPageDocumentInput): Promise<PageDocument>;
  fetchDocument(url: string): Promise<{ contentType: string; data: ArrayBuffer; finalUrl?: string }>;
  readFile?: (name: string) => Promise<{ mimeType: string; data: ArrayBuffer } | undefined>;
}) {
  function run(value: UrlDocumentInput): Promise<GetDocumentResult>;
  function run(value: FileDocumentInput): Promise<GetDocumentResult>;
  function run(value: CurrentPageDocumentInput): Promise<GetDocumentResult>;
  function run(value: unknown): Promise<GetDocumentResult>;
  async function run(value: unknown): Promise<GetDocumentResult> {
    const input = parseGetDocumentInput(value);
    if (input.source === 'file') return extractWorkspaceFile(input, options.readFile);
    if (input.source === 'url') return extractUrl(input, options.fetchDocument);

    const tabId = input.tabId ?? (await options.getCurrentTabId());
    let snapshot: PageDocument;
    try {
      snapshot = await options.executeInTab(tabId, input);
    } catch (error) {
      if (isPageAccessError(error)) return pageAccessRequired();
      throw error;
    }
    if (input.mode === 'selection') return selectionResult(snapshot, input);

    const page = extractDocumentMarkdownFromHtml(snapshot.html, { title: snapshot.title, includeTables: input.includeTables });
    if (input.mode === 'page') {
      const mainContent = page.markdown || snapshot.visibleText || '';
      return currentPageResult(input, snapshot, mainContent, { tables: page.tables, limit: PAGE_CONTENT_LIMIT, hints: pageResultHints(snapshot, page.markdown) });
    }

    const readable = await parseArticleHtml(snapshot.html, snapshot.url).catch(() => undefined);
    if (readable?.content) return currentPageResult(input, snapshot, readable.content, { title: readable.title, url: readable.url, tables: page.tables, limit: ARTICLE_CONTENT_LIMIT, hints: pageResultHints(snapshot, readable.content) });
    const fallbackContent = page.article || page.markdown || snapshot.visibleText || '';
    return currentPageResult(input, snapshot, fallbackContent, { fallback: 'page', tables: page.tables, limit: PAGE_CONTENT_LIMIT, hints: pageResultHints(snapshot, fallbackContent) });
  }

  return { run };
}

function readCurrentPageInput(value: Record<string, unknown>): CurrentPageDocumentInput {
  rejectUnknownInputs(value, currentPageInputKeys, 'currentPage');
  if (!('mode' in value)) throw new Error('getDocument.currentPage requires mode');
  const input: CurrentPageDocumentInput = { source: 'currentPage', mode: readMode(value.mode) };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  if ('includeTables' in value) input.includeTables = readBoolean(value.includeTables, 'includeTables');
  return input;
}

function readUrlInput(value: Record<string, unknown>): UrlDocumentInput {
  rejectUnknownInputs(value, urlInputKeys, 'url');
  if (!('url' in value)) throw new Error('getDocument.url requires url');
  const url = readNonEmptyString(value.url, 'url');
  if (!/^https?:\/\//i.test(url)) throw new Error('getDocument.url only supports http/https URLs');
  const input: UrlDocumentInput = { source: 'url', url };
  if ('mode' in value) {
    if (value.mode !== 'article' && value.mode !== 'page') throw new Error(`Invalid getDocument.url mode: ${String(value.mode)}`);
    input.mode = value.mode;
  }
  if ('includeTables' in value) input.includeTables = readBoolean(value.includeTables, 'includeTables');
  return input;
}

function readFileInput(value: Record<string, unknown>): FileDocumentInput {
  rejectUnknownInputs(value, fileInputKeys, 'file');
  if (!('name' in value)) throw new Error('getDocument.file requires name');
  return { source: 'file', name: readNonEmptyString(value.name, 'name') };
}

function selectionResult(snapshot: PageDocument, input: CurrentPageDocumentInput): GetDocumentResult {
  if (!snapshot.selection) {
    return {
      ok: false,
      code: 'NO_SELECTION',
      message: 'No text is selected on the current page.',
      retryHint: 'Select text in the page, or retry with source:"currentPage" and mode:"page".',
    };
  }
  return currentPageResult(input, snapshot, snapshot.selection, { limit: PAGE_CONTENT_LIMIT });
}

function currentPageResult(
  input: CurrentPageDocumentInput,
  snapshot: PageDocument,
  content: string,
  options: { title?: string; url?: string; fallback?: 'page'; tables?: ExtractedTable[]; limit: number; hints?: string[] },
): GetDocumentResult {
  if (!hasReadableCurrentPageContent(content, snapshot)) return noReadableContent(input.mode);
  return {
    ok: true as const,
    source: 'currentPage' as const,
    mode: input.mode,
    title: options.title ?? snapshot.title,
    url: options.url ?? snapshot.url,
    ...contentFields(content, options.limit),
    ...(options.fallback ? { fallback: options.fallback } : {}),
    ...tableFields(options.tables ?? [], input.includeTables),
    ...hintFields(options.hints),
    ...frameFields(snapshot.frames),
  };
}

function hasReadableCurrentPageContent(mainContent: string, snapshot: PageDocument) {
  // Same-origin frame text is readable content, but it stays under frames[] instead of main content.
  return Boolean(mainContent.trim() || hasReadableFrameText(snapshot));
}

function hasReadableFrameText(snapshot: PageDocument) {
  return Boolean(snapshot.frames?.some((frame) => frame.readable && frame.text?.trim()));
}

function pageResultHints(snapshot: PageDocument, mainContent: string) {
  const hints = [...snapshot.hints ?? []];
  const visibleChars = (snapshot.visibleText ?? '').trim().length;
  const contentChars = mainContent.trim().length;
  if (snapshot.spaShell || contentChars < 80 && (visibleChars > contentChars + 20 || (snapshot.interactiveCount ?? 0) > 0)) {
    hints.push('Dynamic SPA shell likely: article/HTML extraction is sparse; use browser.snapshot, readVisibleText(), or queryText() for runtime-visible content.');
  }
  return [...new Set(hints)];
}

function hintFields(hints: string[] | undefined) {
  return hints?.length ? { hints } : {};
}

function frameFields(frames: PageDocumentFrame[] | undefined) {
  return frames?.length ? { frames } : {};
}

async function extractWorkspaceFile(input: FileDocumentInput, readFile: ((name: string) => Promise<{ mimeType: string; data: ArrayBuffer } | undefined>) | undefined): Promise<GetDocumentResult> {
  const file = await readFile?.(input.name);
  if (!file) {
    return {
      ok: false,
      code: 'FILE_NOT_FOUND',
      message: `Workspace file not found: ${input.name}.`,
      retryHint: 'Use fs ls to list available /workspace files.',
    };
  }
  const content = await workspaceFileText(file);
  if (!content.trim()) return { ok: false, code: 'NO_READABLE_CONTENT', message: `No readable text in file: ${input.name}.` };
  return { ok: true as const, source: 'file' as const, title: input.name, ...contentFields(content, ARTICLE_CONTENT_LIMIT) };
}

async function workspaceFileText(file: { mimeType: string; data: ArrayBuffer }): Promise<string> {
  if (file.mimeType === 'application/pdf') return pdfBytesToText(file.data);
  if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { docxToText } = await import('./document-export.ts');
    return docxToText(file.data);
  }
  return new TextDecoder().decode(file.data);
}

async function parseArticleHtml(html: string, url?: string) {
  const documentCopy = new DOMParser().parseFromString(html, 'text/html');
  const { Readability } = await import('@mozilla/readability');
  const article = new Readability(documentCopy).parse();
  if (!article?.textContent?.trim()) return undefined;
  const content = documentHtmlToMarkdown(article.content || article.textContent);
  return content ? { title: article.title ?? undefined, url, content } : undefined;
}

async function extractUrl(input: UrlDocumentInput, fetchDocument: (url: string) => Promise<{ contentType: string; data: ArrayBuffer; finalUrl?: string }>): Promise<GetDocumentResult> {
  let fetched: { contentType: string; data: ArrayBuffer; finalUrl?: string };
  try {
    fetched = await fetchDocument(input.url);
  } catch (error) {
    if (isTaskAborted(error)) throw error;
    return remoteFetchFailed();
  }
  const url = fetched.finalUrl ?? input.url;
  if (fetched.contentType.includes('application/pdf') || /\.pdf(?:$|[?#])/i.test(url)) {
    const content = await pdfBytesToText(fetched.data);
    if (!content) return noRemoteContent(url);
    return { ok: true as const, source: 'url' as const, url, ...contentFields(content, ARTICLE_CONTENT_LIMIT) };
  }
  const html = new TextDecoder().decode(fetched.data);
  const page = extractDocumentMarkdownFromHtml(html, { includeTables: input.includeTables });
  const htmlTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() || undefined;
  if ((input.mode ?? 'article') === 'article') {
    const readable = await parseArticleHtml(html, url).catch(() => undefined);
    if (readable?.content) {
      return { ok: true as const, source: 'url' as const, url, title: readable.title ?? htmlTitle, ...contentFields(readable.content, ARTICLE_CONTENT_LIMIT), ...tableFields(page.tables, input.includeTables) };
    }
  }
  const content = page.markdown || page.article || '';
  if (!content.trim()) return noRemoteContent(url);
  return { ok: true as const, source: 'url' as const, url, title: htmlTitle, ...(input.mode !== 'page' ? { fallback: 'page' as const } : {}), ...contentFields(content, PAGE_CONTENT_LIMIT), ...tableFields(page.tables, input.includeTables) };
}

function noRemoteContent(url: string): GetDocumentRecoverableError {
  return {
    ok: false,
    code: 'NO_READABLE_CONTENT',
    message: `No readable content at ${url}. The page may require JavaScript rendering or login.`,
    retryHint: 'Open it in the browser instead: navigate open, then getDocument source:"currentPage".',
  };
}

async function pdfBytesToText(bytes: ArrayBuffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true } as never);
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    pages.push(text.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim());
  }
  return pages.filter(Boolean).join('\n\n');
}

function contentFields(content: string, limit?: number) {
  const contentChars = content.length;
  const truncated = limit !== undefined && contentChars > limit;
  return { content: truncated ? content.slice(0, limit) : content, contentChars, truncated };
}

function tableFields(tables: ExtractedTable[], includeTables: boolean | undefined) {
  if (!includeTables) return {};
  const tablesTruncated = tables.length > MAX_TABLES;
  return { tables: tables.slice(0, MAX_TABLES), ...(tablesTruncated ? { tablesTruncated } : {}) };
}

function noReadableContent(mode: GetDocumentCurrentPageMode): GetDocumentResult {
  return {
    ok: false,
    code: 'NO_READABLE_CONTENT',
    message: `No readable ${mode} content was found on the current page.`,
    retryHint: mode === 'article' ? 'Retry with source:"currentPage" and mode:"page" after the page finishes loading.' : undefined,
  };
}

function remoteFetchFailed(): GetDocumentRecoverableError {
  return {
    ok: false,
    code: 'REMOTE_FETCH_FAILED',
    message: 'Could not fetch the URL directly.',
    retryHint: 'Open it in the browser instead: navigate open, then getDocument source:"currentPage".',
  };
}

function pageAccessRequired(): GetDocumentRecoverableError {
  return {
    ok: false,
    code: 'PAGE_ACCESS_REQUIRED',
    message: pageAccessErrorMessage(),
    retryHint: 'Complete Browser Control in settings, then retry.',
  };
}

function rejectUnknownInputs(value: Record<string, unknown>, allowedKeys: Set<string>, branch: string) {
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new Error(`Unknown getDocument.${branch} input: ${key}`);
}

function readSource(value: unknown): GetDocumentInput['source'] {
  if (value === 'currentPage' || value === 'url' || value === 'file') return value;
  throw new Error(`Invalid getDocument source: ${String(value)}`);
}

function readMode(value: unknown): GetDocumentCurrentPageMode {
  if (value === 'article' || value === 'page' || value === 'selection') return value;
  throw new Error(`Invalid getDocument.currentPage mode: ${String(value)}`);
}

function readString(value: unknown, name: string) {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function readNonEmptyString(value: unknown, name: string) {
  const text = readString(value, name);
  if (!text) throw new Error(`${name} must be a non-empty string`);
  return text;
}

function readBoolean(value: unknown, name: string) {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function isTaskAborted(error: unknown) {
  return error instanceof Error ? error.message === 'Task aborted' : String(error) === 'Task aborted';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
