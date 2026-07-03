import { isPageAccessError, pageAccessErrorMessage } from './browser-access.ts';
import { extractDocumentMarkdownFromHtml, htmlToMarkdown as documentHtmlToMarkdown, type ExtractedTable } from './document-markdown.ts';

export type { ExtractedTable } from './document-markdown.ts';

export const ARTICLE_CONTENT_LIMIT = 80_000;
export const PAGE_CONTENT_LIMIT = 40_000;
export const MAX_TABLES = 20;

export type GetDocumentCurrentPageMode = 'article' | 'page' | 'selection';

export type GetDocumentInput =
  | { source: 'currentPage'; mode: GetDocumentCurrentPageMode; tabId?: number; includeTables?: boolean }
  | { source: 'pdf'; url: string }
  | { source: 'file'; fileName?: string; fileText: string };

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
};

export type GetDocumentSuccess =
  | (GetDocumentSuccessBase & { source: 'currentPage'; mode: GetDocumentCurrentPageMode })
  | (GetDocumentSuccessBase & { source: 'pdf'; url: string })
  | (GetDocumentSuccessBase & { source: 'file' });

export type GetDocumentErrorCode = 'NO_SELECTION' | 'NO_READABLE_CONTENT' | 'REMOTE_FETCH_FAILED' | 'PAGE_ACCESS_REQUIRED';

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
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'mode'],
      properties: {
        source: { type: 'string', enum: ['currentPage'], description: 'Read the current browser tab DOM.' },
        mode: { type: 'string', enum: ['article', 'page', 'selection'], description: 'article uses Readability with page fallback; page reads full DOM Markdown; selection reads selected text only.' },
        tabId: { type: 'integer', minimum: 1, description: 'Browser tab id. Defaults to the active tab.' },
        includeTables: { type: 'boolean', description: 'Include extracted table objects with stable rows and Markdown table text.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'url'],
      properties: {
        source: { type: 'string', enum: ['pdf'], description: 'Fetch and extract text from a PDF URL.' },
        url: { type: 'string', minLength: 1, description: 'PDF URL.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['source', 'fileText'],
      properties: {
        source: { type: 'string', enum: ['file'], description: 'Use text that was already provided by the UI.' },
        fileName: { type: 'string', description: 'Display name for the provided text.' },
        fileText: { type: 'string', description: 'Plain text file content supplied by the UI.' },
      },
    },
  ],
} as const;

const currentPageInputKeys = new Set(['source', 'mode', 'tabId', 'includeTables']);
const pdfInputKeys = new Set(['source', 'url']);
const fileInputKeys = new Set(['source', 'fileName', 'fileText']);

type CurrentPageDocumentInput = Extract<GetDocumentInput, { source: 'currentPage' }>;
type PdfDocumentInput = Extract<GetDocumentInput, { source: 'pdf' }>;
type FileDocumentInput = Extract<GetDocumentInput, { source: 'file' }>;

export function parseGetDocumentInput(value: unknown): GetDocumentInput {
  if (!isRecord(value) || Array.isArray(value)) throw new Error('getDocument input must be an object');
  if (!('source' in value)) throw new Error('getDocument.source is required');

  const source = readSource(value.source);
  if (source === 'currentPage') return readCurrentPageInput(value);
  if (source === 'pdf') return readPdfInput(value);
  return readFileInput(value);
}

export function createGetDocumentController(options: {
  getCurrentTabId(): Promise<number>;
  executeInTab(tabId: number, input: CurrentPageDocumentInput): Promise<PageDocument>;
  fetchText?: (url: string) => Promise<string>;
  fetchArrayBuffer(url: string): Promise<ArrayBuffer>;
}) {
  function run(value: PdfDocumentInput): Promise<GetDocumentResult>;
  function run(value: FileDocumentInput): Promise<Extract<GetDocumentSuccess, { source: 'file' }>>;
  function run(value: CurrentPageDocumentInput): Promise<GetDocumentResult>;
  function run(value: unknown): Promise<GetDocumentResult>;
  async function run(value: unknown): Promise<GetDocumentResult> {
    const input = parseGetDocumentInput(value);
    if (input.source === 'file') return fileResult(input);
    if (input.source === 'pdf') return extractPdf(input, options.fetchArrayBuffer);

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
    if (input.mode === 'page') return currentPageResult(input, snapshot, page.markdown, { tables: page.tables, limit: PAGE_CONTENT_LIMIT });

    const readable = await parseArticleHtml(snapshot.html, snapshot.url).catch(() => undefined);
    if (readable?.content) return currentPageResult(input, snapshot, readable.content, { title: readable.title, url: readable.url, tables: page.tables, limit: ARTICLE_CONTENT_LIMIT });
    return currentPageResult(input, snapshot, page.article || page.markdown, { fallback: 'page', tables: page.tables, limit: PAGE_CONTENT_LIMIT });
  }

  return { run };
}

export type PageDocument = {
  title?: string;
  url?: string;
  selection: string;
  html: string;
};

export function extractDocumentFromPage(_input: CurrentPageDocumentInput): PageDocument {
  return {
    title: document.title,
    url: location.href,
    selection: String(getSelection()?.toString() ?? '').trim(),
    html: document.documentElement.outerHTML,
  };
}

function readCurrentPageInput(value: Record<string, unknown>): CurrentPageDocumentInput {
  rejectUnknownInputs(value, currentPageInputKeys, 'currentPage');
  if (!('mode' in value)) throw new Error('getDocument.currentPage requires mode');
  const input: CurrentPageDocumentInput = { source: 'currentPage', mode: readMode(value.mode) };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  if ('includeTables' in value) input.includeTables = readBoolean(value.includeTables, 'includeTables');
  return input;
}

function readPdfInput(value: Record<string, unknown>): PdfDocumentInput {
  rejectUnknownInputs(value, pdfInputKeys, 'pdf');
  if (!('url' in value)) throw new Error('getDocument.pdf requires url');
  return { source: 'pdf', url: readNonEmptyString(value.url, 'url') };
}

function readFileInput(value: Record<string, unknown>): FileDocumentInput {
  rejectUnknownInputs(value, fileInputKeys, 'file');
  if (!('fileText' in value)) throw new Error('getDocument.file requires fileText');
  const input: FileDocumentInput = { source: 'file', fileText: readString(value.fileText, 'fileText') };
  if ('fileName' in value) input.fileName = readString(value.fileName, 'fileName');
  return input;
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
  options: { title?: string; url?: string; fallback?: 'page'; tables?: ExtractedTable[]; limit: number },
): GetDocumentResult {
  if (!content.trim()) return noReadableContent(input.mode);
  return {
    ok: true as const,
    source: 'currentPage' as const,
    mode: input.mode,
    title: options.title ?? snapshot.title,
    url: options.url ?? snapshot.url,
    ...contentFields(content, options.limit),
    ...(options.fallback ? { fallback: options.fallback } : {}),
    ...tableFields(options.tables ?? [], input.includeTables),
  };
}

function fileResult(input: FileDocumentInput): GetDocumentResult {
  return { ok: true as const, source: 'file' as const, title: input.fileName, ...contentFields(input.fileText) };
}

async function parseArticleHtml(html: string, url?: string) {
  const documentCopy = new DOMParser().parseFromString(html, 'text/html');
  const { Readability } = await import('@mozilla/readability');
  const article = new Readability(documentCopy).parse();
  if (!article?.textContent?.trim()) return undefined;
  const content = documentHtmlToMarkdown(article.content || article.textContent);
  return content ? { title: article.title ?? undefined, url, content } : undefined;
}

async function extractPdf(input: PdfDocumentInput, fetchArrayBuffer: (url: string) => Promise<ArrayBuffer>): Promise<GetDocumentResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let bytes: ArrayBuffer;
  try {
    bytes = await fetchArrayBuffer(input.url);
  } catch (error) {
    if (isTaskAborted(error)) throw error;
    return remoteFetchFailed();
  }
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, useSystemFonts: true } as never);
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    pages.push(text.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim());
  }
  const content = pages.filter(Boolean).join('\n\n');
  if (!content) throw new Error('getDocument.pdf returned no text');
  return { ok: true as const, source: 'pdf' as const, url: input.url, ...contentFields(content) };
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
    message: 'Could not fetch the remote document.',
    retryHint: 'Check that the URL is reachable, or provide the text with source:"file".',
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
  if (value === 'currentPage' || value === 'pdf' || value === 'file') return value;
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
