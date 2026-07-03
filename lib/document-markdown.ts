export type ExtractedTable = {
  caption?: string;
  headers: string[];
  rows: string[][];
  markdown: string;
};

export type DocumentMarkdown = {
  article: string;
  markdown: string;
  tables: ExtractedTable[];
};

export function extractDocumentMarkdownFromHtml(html: string, options: { title?: string; includeTables?: boolean } = {}): DocumentMarkdown {
  return extractDocumentMarkdown(new DOMParser().parseFromString(html, 'text/html'), options);
}

export function extractDocumentMarkdown(documentCopy: Document, options: { title?: string; includeTables?: boolean } = {}): DocumentMarkdown {
  const articleRoot = firstElement(documentCopy, 'article') || firstElement(documentCopy, 'main') || documentCopy.body;
  return {
    article: elementToMarkdown(articleRoot),
    markdown: [options.title && `# ${cleanText(options.title)}`, elementToMarkdown(documentCopy.body)].filter(Boolean).join('\n\n'),
    tables: options.includeTables ? extractTables(documentCopy) : [],
  };
}

export function htmlToMarkdown(html: string): string {
  return elementToMarkdown(new DOMParser().parseFromString(html, 'text/html').body);
}

export function elementToMarkdown(root: Element | null): string {
  if (!root) return '';
  const chunks: string[] = [];
  walk(root, chunks);
  return chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractTables(root: ParentNode | null): ExtractedTable[] {
  if (!root) return [];
  return elementsByTag(root, 'table').map(readTable).filter((table) => table.rows.length > 0);
}

function walk(node: Node, chunks: string[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = cleanText(node.textContent ?? '');
    if (text) chunks.push(text);
    return;
  }
  if (!(node instanceof Element) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(node.tagName)) return;
  if (node.tagName === 'TABLE') {
    chunks.push(readTable(node).markdown);
    return;
  }
  const prefix = headingPrefix(node.tagName);
  if (prefix) chunks.push(`${prefix} ${cleanText(node.textContent ?? '')}`);
  else for (const child of node.childNodes) walk(child, chunks);
  if (['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'TR', 'H1', 'H2', 'H3'].includes(node.tagName)) chunks.push('');
}

function readTable(table: Element): ExtractedTable {
  const headerCells = tableHeaderCells(table);
  const bodyRows = elementsByTag(table, 'tbody').flatMap((body) => elementsByTag(body, 'tr'));
  const rowElements = headerCells.length > 0 && bodyRows.length > 0 ? bodyRows : elementsByTag(table, 'tr');
  const rows = rowElements.map((row) => children(row).map((cell) => cleanText(cell.textContent ?? ''))).filter((row) => row.some(Boolean));
  const firstRowIsHeader = headerCells.length === 0 && children(rowElements[0]).some((cell) => isTag(cell, 'th'));
  const headers = headerCells.length > 0 ? headerCells : firstRowIsHeader ? rows.shift() ?? [] : rows[0]?.map((_, index) => `Column ${index + 1}`) ?? [];
  return { caption: cleanText(firstElement(table, 'caption')?.textContent ?? ''), headers, rows, markdown: tableToMarkdown(headers, rows) };
}

function tableHeaderCells(table: Element) {
  const firstHeaderRow = firstElement(firstElement(table, 'thead'), 'tr');
  return firstHeaderRow ? children(firstHeaderRow).filter((cell) => isTag(cell, 'th')).map((cell) => cleanText(cell.textContent ?? '')) : [];
}

function tableToMarkdown(headers: string[], rows: string[][]) {
  if (headers.length === 0) return '';
  const width = headers.length;
  const normalize = (row: string[]) => Array.from({ length: width }, (_, index) => escapeCell(row[index] ?? ''));
  return [normalize(headers), headers.map(() => '---'), ...rows.map(normalize)].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function escapeCell(value: string) {
  return value.replace(/\|/g, '\\|');
}

function firstElement(root: ParentNode | null, tagName: string) {
  return root ? elementsByTag(root, tagName)[0] ?? null : null;
}

function elementsByTag(root: ParentNode, tagName: string): Element[] {
  const byTagName = (root as ParentNode & { getElementsByTagName?(name: string): ArrayLike<Element> }).getElementsByTagName?.(tagName);
  if (byTagName) return Array.from(byTagName);
  return [...root.querySelectorAll(tagName)];
}

function children(element: Element | undefined): Element[] {
  return element ? [...element.children] : [];
}

function isTag(element: Element, tagName: string) {
  return element.tagName.toLowerCase() === tagName;
}

function headingPrefix(tagName: string) {
  if (tagName === 'H1') return '#';
  if (tagName === 'H2') return '##';
  if (tagName === 'H3') return '###';
  return '';
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}
