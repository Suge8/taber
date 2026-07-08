export type PageFrameSummary = {
  number: number;
  title?: string;
  src?: string;
  rect: { x: number; y: number; width: number; height: number };
  sameOrigin: boolean;
  readable: boolean;
  reason?: string;
  text?: string;
  chars?: number;
  truncated?: boolean;
  elements?: Record<string, unknown>[];
};

type TextChunk = { text: string; element: HTMLElement };

type PageIntrospectionApi = {
  isVisible(element: Element, scope: 'viewport' | 'page'): boolean;
  isVisualElement(element: Element): boolean;
  shortText(text: string): string;
  summarizeFrameElement(element: HTMLElement, number: number): Record<string, unknown>;
};

export function createBrowserReplPageIntrospection(api?: PageIntrospectionApi) {
  if (!api) {
    (globalThis as typeof globalThis & { createBrowserReplPageIntrospection?: typeof createBrowserReplPageIntrospection }).createBrowserReplPageIntrospection = createBrowserReplPageIntrospection;
    return undefined as never;
  }
  const hooks = api;
  return {
    allText,
    frameHintSentence,
    frameSummaries,
    hints,
    observeMutations,
    querySelectorAll,
    rejectUnsupportedSelector,
    visibleTextChunks,
  };

  function querySelectorAll(selector: string, rootDocument: Document = document) {
    rejectUnsupportedSelector(selector);
    const seen = new Set<Element>();
    const elements: Element[] = [];
    for (const root of allRoots(rootDocument)) {
      for (const element of [...root.querySelectorAll(selector)]) {
        if (!seen.has(element) && !hooks.isVisualElement(element)) {
          seen.add(element);
          elements.push(element);
        }
      }
    }
    return elements;
  }

  function rejectUnsupportedSelector(selector: string) {
    const unsupported = unsupportedSelector(selector);
    if (unsupported) throw new Error(`Native CSS does not support ${unsupported}. browserRepl selectors use native CSS only; use a text/role locator when available, waitFor({ text: "..." }) for text waits, or observe()/query() then a same-call index for actions.`);
  }

  function visibleTextChunks(maxChunks: number, rootDocument: Document = document) {
    const chunks: TextChunk[] = [];
    let truncated = false;
    const add = (element: HTMLElement, text: string | null | undefined) => {
      const value = (text || '').replace(/\s+/g, ' ').trim();
      if (!value) return;
      if (chunks.length >= maxChunks) { truncated = true; return; }
      chunks.push({ text: value, element });
    };
    const visitRoot = (root: Document | ShadowRoot) => {
      const children = root === rootDocument ? [rootDocument.body].filter(Boolean) : [...root.children];
      for (const child of children) visitElement(child as HTMLElement);
    };
    const visitElement = (element: HTMLElement) => {
      if (!element || skipsText(element) || hooks.isVisualElement(element) || !hooks.isVisible(element, 'page')) return;
      const childNodes = 'childNodes' in element ? [...element.childNodes] : [];
      if (childNodes.length) for (const node of childNodes) {
        if (node.nodeType === 3) add(element, node.textContent);
        else if (node.nodeType === 1) visitElement(node as HTMLElement);
      }
      else if (element.children.length) for (const child of [...element.children]) visitElement(child as HTMLElement);
      else if (!element.shadowRoot) add(element, element.innerText || element.textContent);
      if (element.shadowRoot) visitRoot(element.shadowRoot);
    };
    visitRoot(rootDocument);
    return { chunks, truncated };
  }

  function allText(rootDocument: Document = document) {
    return allRoots(rootDocument).map((root) => root === rootDocument ? rootDocument.body?.innerText || '' : root.textContent || '').join(' ');
  }

  function observeMutations(observer: MutationObserver) {
    const roots = allRoots(document);
    for (const root of roots) observer.observe(root === document ? document.documentElement : root, { childList: true, subtree: true, characterData: true, attributes: true });
    return roots.length;
  }

  function hints(empty: boolean, options: { runtimeContent?: boolean } = {}) {
    const openShadowRoots = Math.max(0, allRoots().length - 1);
    const frames = frameSummaries({ metadataOnly: true });
    const result = [`Scanned the main document${openShadowRoots ? ` and ${openShadowRoots} open shadow root(s)` : ''}; closed shadow roots are not readable.`];
    if (frames.length) result.push(frameSummaryHint(frames));
    if (options.runtimeContent) result.push('Dynamic SPA shell likely: initial HTML/article extraction may be sparse; use browser.snapshot, readVisibleText(), or queryText() for runtime-visible content.');
    if (empty) result.push('Little visible content found; the page may be a SPA shell, canvas app, iframe-only, or still loading.');
    return result;
  }

  function frameHintSentence() {
    const frames = frameSummaries({ metadataOnly: true });
    if (!frames.length) return '';
    return `. The target may be inside an iframe/frame. ${frameSummaryHint(frames)} Inspect frames[] from browser.snapshot/read helpers, open the iframe source page, or switch target if needed.`;
  }

  function frameSummaries(options: { includeText?: boolean; includeElements?: boolean; elementSelector?: string; textLimit?: number; elementLimit?: number; metadataOnly?: boolean } = {}): PageFrameSummary[] {
    return querySelectorAll('iframe,frame').filter((element): element is HTMLElement => element instanceof HTMLElement && hooks.isVisible(element, 'page')).map((frame, offset) => frameSummary(frame, offset + 1, options));
  }

  function frameSummary(frame: HTMLElement, number: number, options: { includeText?: boolean; includeElements?: boolean; elementSelector?: string; textLimit?: number; elementLimit?: number; metadataOnly?: boolean }) {
    const rect = frame.getBoundingClientRect();
    const base = { number, ...frameTitle(frame), ...frameSource(frame), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    const frameDocument = readableFrameDocument(frame);
    if (!frameDocument) return { ...base, sameOrigin: false, readable: false, reason: 'Cross-origin or inaccessible frame; browser permissions do not allow reading this frame from the parent page.' };
    const textResult = options.includeText ? frameText(frameDocument, options.textLimit ?? 1_000) : undefined;
    const elements = options.includeElements ? frameElements(frameDocument, options.elementSelector ?? 'a[href],button,input,select,textarea,[role="button"],[role="link"]', options.elementLimit ?? 20) : undefined;
    return { ...base, title: hooks.shortText(frameDocument.title || (base as { title?: string }).title || ''), sameOrigin: true, readable: true, ...(textResult ? { text: textResult.text, chars: textResult.chars, truncated: textResult.truncated } : {}), ...(elements?.length ? { elements } : {}) };
  }

  function frameText(frameDocument: Document, limit: number) {
    const result = visibleTextChunks(500, frameDocument);
    const fullText = result.chunks.map((chunk) => chunk.text).join('\n');
    const truncated = fullText.length > limit;
    return { text: truncated ? `${fullText.slice(0, limit)}…` : fullText, chars: fullText.length, truncated: result.truncated || truncated };
  }

  function frameElements(frameDocument: Document, selector: string, limit: number) {
    const elements = querySelectorAll(selector, frameDocument).filter((element): element is HTMLElement => element instanceof HTMLElement && hooks.isVisible(element, 'page'));
    return elements.slice(0, limit).map((element, offset) => hooks.summarizeFrameElement(element, offset + 1));
  }

  function readableFrameDocument(frame: HTMLElement) {
    try {
      const frameDocument = (frame as HTMLIFrameElement | HTMLFrameElement).contentDocument;
      if (!frameDocument?.documentElement) return undefined;
      void frameDocument.location?.href;
      return frameDocument;
    } catch {
      return undefined;
    }
  }

  function frameSummaryHint(frames: PageFrameSummary[]) {
    const readable = frames.filter((frame) => frame.readable).length;
    const blocked = frames.length - readable;
    return `${frames.length} iframe/frame(s) detected; ${readable} same-origin readable, ${blocked} cross-origin/inaccessible listed as metadata only. Frame content is reported under frames[] and is not mixed into the main document.`;
  }

  function allRoots(rootDocument: Document = document) {
    const roots: (Document | ShadowRoot)[] = [rootDocument];
    for (let offset = 0; offset < roots.length && offset < 20; offset += 1) {
      for (const element of [...roots[offset].querySelectorAll('*')].slice(0, 1000)) {
        const shadowRoot = (element as HTMLElement).shadowRoot;
        if (shadowRoot && !roots.includes(shadowRoot)) roots.push(shadowRoot);
      }
    }
    return roots;
  }

  function unsupportedSelector(selector: string) {
    const match = selector.match(/:(has-text|text|text-is|text-matches|nth-match|right-of|left-of|above|below|near|visible)\b/i);
    if (!match) return undefined;
    const tail = selector.slice((match.index ?? 0) + match[0].length).trimStart();
    return `${match[0]}${tail.startsWith('(') ? '()' : ''}`;
  }

  function frameTitle(frame: HTMLElement) {
    const title = hooks.shortText(frame.getAttribute('title') || frame.getAttribute('aria-label') || '');
    return title ? { title } : {};
  }

  function frameSource(frame: HTMLElement) {
    const src = hooks.shortText((frame as HTMLIFrameElement | HTMLFrameElement).src || frame.getAttribute('src') || '');
    return src ? { src } : {};
  }

  function skipsText(element: HTMLElement) {
    return /^(script|style|noscript|template|svg|canvas)$/i.test(element.tagName);
  }
}
