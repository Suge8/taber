import type { PageFrameSummary } from './browser-repl-page-introspection.ts';

export type PageDocumentFrame = Omit<PageFrameSummary, 'elements'>;

export type PageDocument = {
  title?: string;
  url?: string;
  selection: string;
  html: string;
  visibleText?: string;
  interactiveCount?: number;
  shadowRootCount?: number;
  spaShell?: boolean;
  hints?: string[];
  frames?: PageDocumentFrame[];
};

export function extractDocumentFromPage(_input: { source: 'currentPage'; mode: 'article' | 'page' | 'selection'; includeTables?: boolean }): PageDocument {
  let shadowRootCount = 0;
  const html = cloneDocumentHtml(document);
  const visibleText = visibleTextFromDocument(document, 12_000).text;
  const interactiveCount = queryVisible(document, 'a[href],button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[tabindex]:not([tabindex="-1"])').length;
  const frames = [...document.querySelectorAll('iframe,frame')].filter((frame): frame is HTMLElement => frame instanceof HTMLElement && isVisible(frame)).map(readFrame);
  const spaShell = Boolean(document.querySelector('#root,#app,#__next,[data-reactroot],[ng-version],[data-sveltekit-preload-data]')) && Boolean(visibleText || interactiveCount);
  const hints = boundaryHints();
  return { title: document.title, url: location.href, selection: String(getSelection()?.toString() ?? '').trim(), html, visibleText, interactiveCount, shadowRootCount, spaShell, ...(hints.length ? { hints } : {}), ...(frames.length ? { frames } : {}) };

  function cloneDocumentHtml(source: Document) {
    const clone = source.documentElement.cloneNode(true) as Element;
    appendOpenShadowRoots(source, clone);
    return clone.outerHTML;
  }
  function appendOpenShadowRoots(sourceRoot: ParentNode, cloneRoot: ParentNode) {
    const sourceElements = [...sourceRoot.querySelectorAll('*')], cloneElements = [...cloneRoot.querySelectorAll('*')];
    for (let index = 0; index < sourceElements.length; index += 1) {
      const shadowRoot = (sourceElements[index] as HTMLElement).shadowRoot, cloneElement = cloneElements[index];
      if (!shadowRoot || !cloneElement) continue;
      shadowRootCount += 1;
      const section = document.createElement('section');
      section.setAttribute('data-taber-boundary', 'open-shadow-root');
      section.setAttribute('aria-label', `Open shadow root on ${sourceElements[index].tagName.toLowerCase()}`);
      for (const child of [...shadowRoot.childNodes]) section.append(child.cloneNode(true));
      cloneElement.append(section);
      appendOpenShadowRoots(shadowRoot, section);
    }
  }
  function readFrame(frame: HTMLElement, offset: number): PageDocumentFrame {
    const rect = frameRect(frame), base = { number: offset + 1, ...frameTitle(frame), ...frameSource(frame), rect };
    const frameDocument = readableFrameDocument(frame);
    if (!frameDocument) return { ...base, sameOrigin: false, readable: false, reason: 'Cross-origin or inaccessible frame; browser permissions do not allow reading this frame from the parent page.' };
    const text = visibleTextFromDocument(frameDocument, 4_000);
    return { ...base, title: shortText(frameDocument.title || (base as { title?: string }).title || ''), sameOrigin: true, readable: true, text: text.text, chars: text.chars, truncated: text.truncated };
  }
  function readableFrameDocument(frame: HTMLElement) {
    try {
      const frameDocument = (frame as HTMLIFrameElement | HTMLFrameElement).contentDocument;
      if (!frameDocument?.documentElement) return undefined;
      void frameDocument.location?.href;
      return frameDocument;
    } catch { return undefined; }
  }
  function visibleTextFromDocument(rootDocument: Document, limit: number) {
    const chunks: string[] = [];
    const visitRoot = (root: Document | ShadowRoot) => { for (const child of (root === rootDocument ? [rootDocument.body].filter(Boolean) : [...root.children])) visitElement(child as HTMLElement); };
    const visitElement = (element: HTMLElement) => {
      if (!element || skipsText(element) || isTaberOverlay(element) || !isVisible(element)) return;
      const childNodes = 'childNodes' in element ? [...element.childNodes] : [];
      if (childNodes.length) for (const node of childNodes) node.nodeType === 3 ? addText(node.textContent) : node.nodeType === 1 ? visitElement(node as HTMLElement) : undefined;
      else if (element.children.length) for (const child of [...element.children]) visitElement(child as HTMLElement);
      else if (!element.shadowRoot) addText(element.textContent);
      if (element.shadowRoot) visitRoot(element.shadowRoot);
    };
    const addText = (value: string | null | undefined) => {
      const text = (value || '').replace(/\s+/g, ' ').trim();
      if (text && chunks.join('\n').length < limit) chunks.push(text);
    };
    visitRoot(rootDocument);
    const fullText = chunks.join('\n');
    const truncated = fullText.length > limit;
    return { text: truncated ? `${fullText.slice(0, limit)}…` : fullText, chars: fullText.length, truncated };
  }
  function queryVisible(rootDocument: Document, selector: string) {
    const roots: (Document | ShadowRoot)[] = [rootDocument];
    for (let offset = 0; offset < roots.length && offset < 20; offset += 1) for (const element of [...roots[offset].querySelectorAll('*')].slice(0, 1000)) {
      const shadowRoot = (element as HTMLElement).shadowRoot;
      if (shadowRoot && !roots.includes(shadowRoot)) roots.push(shadowRoot);
    }
    return roots.flatMap((root) => [...root.querySelectorAll(selector)]).filter((element): element is HTMLElement => element instanceof HTMLElement && isVisible(element));
  }
  function isVisible(element: Element) {
    for (let node: Element | null = element; node; node = composedParent(node)) {
      const style = safeComputedStyle(node);
      if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0)) return false;
    }
    const rect = element.getBoundingClientRect?.();
    return !rect || rect.width > 0 && rect.height > 0;
  }
  function composedParent(element: Element) {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    return root && root !== document && 'host' in root ? root.host as Element : null;
  }
  function boundaryHints() {
    const hints: string[] = [];
    if (shadowRootCount) hints.push(`Included ${shadowRootCount} open shadow root(s); closed shadow roots are not readable.`);
    if (frames.length) {
      const readable = frames.filter((frame) => frame.readable).length;
      hints.push(`${frames.length} iframe/frame(s) detected; ${readable} same-origin readable, ${frames.length - readable} cross-origin/inaccessible listed as metadata only. Frame content is reported under frames[] and is not mixed into the main document.`);
    }
    if (spaShell) hints.push('Dynamic SPA shell likely: article/HTML extraction may be sparse; use browser.snapshot, readVisibleText(), or queryText() for runtime-visible content.');
    return hints;
  }
  function safeComputedStyle(element: Element) { try { return getComputedStyle(element); } catch { return undefined; } }
  function frameRect(frame: HTMLElement) { const rect = frame.getBoundingClientRect(); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }; }
  function frameTitle(frame: HTMLElement) { const title = shortText(frame.getAttribute('title') || frame.getAttribute('aria-label') || ''); return title ? { title } : {}; }
  function frameSource(frame: HTMLElement) { const src = shortText((frame as HTMLIFrameElement | HTMLFrameElement).src || frame.getAttribute('src') || ''); return src ? { src } : {}; }
  function skipsText(element: HTMLElement) { return /^(script|style|noscript|template|svg|canvas)$/i.test(element.tagName); }
  function isTaberOverlay(element: HTMLElement) { return element.id === 'taber-page-control-overlay' || element.getAttribute('data-taber-overlay') === 'true'; }
  function shortText(value: string) { return value.replace(/\s+/g, ' ').trim().slice(0, 160); }
}
