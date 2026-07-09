import type { BrowserReplElementRef } from './browser-repl-command.ts';
import { createBrowserReplPageIntrospection } from './browser-repl-page-introspection.ts';
import type { BrowserPageTarget, BrowserReplPageLocator, BrowserStateOptions } from './browser-repl-page-types.ts';
type BrowserSnapshotStore = { id: string; document: Document; url: string; dirty: boolean; refs: Map<string, BrowserReplElementRef>; observer?: MutationObserver };
export function installBrowserReplPageLocator() {
  const locator = {
    readVisibleText: pageReadVisibleText,
    readLinksAndButtons: pageReadLinksAndButtons,
    listInteractiveElements: pageListInteractiveElements,
    queryText: pageQueryText,
    browserState: pageBrowserState,
    resolvePageTarget: pageResolvePageTarget,
    observe: pageObserve,
    query: pageQuery,
    resolveTarget: pageResolveTarget,
    summarizeElement: pageSummarizeElement,
    elementEvidence: pageElementEvidence,
    pickedElement: pagePickedElement,
    evidenceElement: pageEvidenceElement,
    evidenceAnchor: pageEvidenceAnchor,
    matchesWait: pageMatchesWait,
    observeMutations: pageObserveMutations,
    allText: pageAllText,
    fieldCandidates: pageFieldCandidates,
    bestFieldMatch: pageBestFieldMatch,
    readFillFormOptions: pageReadFillFormOptions,
    elementRef: pageElementRef,
    elementFingerprint: pageElementFingerprint,
    elementValue: pageElementValue,
    valueSummary: pageValueSummary,
    isFillable: pageIsFillable,
    isDisabled: pageIsDisabled,
    shortText: pageShortText,
    round: pageRound,
  };
  const inspect = pageIntrospectionFactory()({
    isVisible: pageIsVisible,
    isVisualElement: pageIsVisualElement,
    shortText: pageShortText,
    summarizeFrameElement: pageBrowserSummaryElement,
  });
  (globalThis as typeof globalThis & { __taberBrowserReplPageLocator?: BrowserReplPageLocator }).__taberBrowserReplPageLocator = locator;
  return { installed: true };
  function pageIntrospectionFactory() {
    const global = globalThis as typeof globalThis & { createBrowserReplPageIntrospection?: typeof createBrowserReplPageIntrospection };
    const factory = global.createBrowserReplPageIntrospection ?? (typeof createBrowserReplPageIntrospection === 'function' ? createBrowserReplPageIntrospection : undefined);
    if (!factory) throw new Error('Taber page introspection runtime is unavailable');
    return factory;
  }
  function pageObserve(options?: { scope?: 'page'; limit?: number }) { return { summary: pageSummary(), elements: pageCollectElements(undefined, options) }; }
  function pageQuery(selector: string, options?: { scope?: 'page'; limit?: number }) { return { summary: pageSummary(), elements: pageCollectElements(selector, options) }; }
  function pageReadVisibleText(options?: { limit?: number }) {
    const limit = pageLimit(options?.limit, 4_000, 12_000);
    const result = pageVisibleTextChunks(1_000);
    const fullText = result.chunks.map((chunk) => chunk.text).join('\n');
    const text = pageTruncate(fullText, limit);
    const frames = pageFrameSummaries({ includeText: true, textLimit: 1_000 });
    return { title: document.title, url: location.href, text: text.value, count: result.chunks.length, chars: fullText.length, truncated: result.truncated || text.truncated, limit, ...(frames.length ? { frames } : {}), hints: pageSenseHints(fullText.length === 0, fullText.length > 0) };
  }
  function pageReadLinksAndButtons(options?: { limit?: number }) { return pageSenseElements(pageLinksAndButtonsSelector(), options); }
  function pageListInteractiveElements(options?: { limit?: number }) { return pageSenseElements(pageInteractiveSelector(), options); }
  function pageQueryText(text: string, options?: { limit?: number; contextChars?: number }) {
    const query = pageShortText(String(text || ''));
    if (!query) throw new Error('queryText requires non-empty text');
    const limit = pageLimit(options?.limit, 12, 50), contextChars = pageLimit(options?.contextChars, 90, 240), normalized = pageNormalizeText(query);
    const result = pageVisibleTextChunks(1_000), matches: Record<string, unknown>[] = [], candidateSet = new Set<HTMLElement>();
    for (const chunk of result.chunks) if (pageNormalizeText(chunk.text).includes(normalized)) {
      if (matches.length < limit) matches.push({ text: pageShortText(chunk.text), context: pageContext(chunk.text, query, contextChars), selector: pageSelectorPath(chunk.element).join(' >>> ') });
      const interactive = pageClosestInteractive(chunk.element);
      if (interactive) candidateSet.add(interactive);
    }
    for (const element of pageQuerySelectorAll(pageInteractiveSelector())) if (element instanceof HTMLElement && pageIsVisible(element, 'page') && pageNormalizeText(pageElementSearchText(element)).includes(normalized)) candidateSet.add(element);
    const candidates = [...candidateSet].sort(pageCompareElements).slice(0, limit).map((element, offset) => pageSenseElement(element, offset + 1));
    const matchCount = result.chunks.filter((chunk) => pageNormalizeText(chunk.text).includes(normalized)).length;
    const frames = pageFrameSummaries({ includeText: true, includeElements: true, elementSelector: pageInteractiveSelector(), textLimit: 1_000, elementLimit: Math.min(limit, 20) });
    return { title: document.title, url: location.href, query, count: { matches: matchCount, candidates: candidateSet.size }, matches, candidates, truncated: result.truncated || matchCount > matches.length || candidateSet.size > candidates.length, limit, ...(frames.length ? { frames } : {}), hints: pageSenseHints(matchCount === 0 && candidateSet.size === 0, result.chunks.length > 0 || candidateSet.size > 0) };
  }
  function pageSummary() {
    const frames = pageFrameSummaries({ metadataOnly: true });
    const hints = pageHints();
    return { title: document.title, url: location.href, text: pageShortText(pageAllText()), viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY }, ...(frames.length ? { frames } : {}), ...(hints.length ? { hints } : {}) };
  }
  function pageCollectElements(selector?: string, options?: { scope?: 'page'; limit?: number }) {
    const query = selector ?? pageInteractiveSelector();
    const limit = options?.limit ?? 50;
    const scope = options?.scope ?? 'viewport';
    return pageQuerySelectorAll(query).filter((element) => element instanceof HTMLElement && pageIsVisible(element, scope)).slice(0, limit).map((element, offset) => pageSummarizeElement(element, offset + 1));
  }
  function pageSenseElements(selector: string, options?: { limit?: number }) {
    const limit = pageLimit(options?.limit, 40, 100);
    const elements = pageQuerySelectorAll(selector).filter((element): element is HTMLElement => element instanceof HTMLElement && pageIsVisible(element, 'page')).sort(pageCompareElements);
    const frames = pageFrameSummaries({ includeElements: true, elementSelector: selector, elementLimit: Math.min(limit, 20) });
    return { title: document.title, url: location.href, count: elements.length, truncated: elements.length > limit, limit, elements: elements.slice(0, limit).map((element, offset) => pageSenseElement(element, offset + 1)), ...(frames.length ? { frames } : {}), hints: pageSenseHints(elements.length === 0, elements.length > 0) };
  }
  function pageSenseElement(element: HTMLElement, number: number) {
    const rect = element.getBoundingClientRect(), href = pageHref(element), value = pageValueSummary(pageElementValue(element));
    return { number, kind: pageElementKind(element), tag: element.tagName.toLowerCase(), role: pageElementRole(element), name: pageAccessibleName(element), text: pageShortText(element.innerText || element.textContent || ''), ...(href ? { href } : {}), ...(value ? { value } : {}), disabled: pageIsDisabled(element), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, selector: pageSelectorPath(element).join(' >>> ') };
  }
  function pageBrowserState(options?: BrowserStateOptions) {
    const textResult = pageVisibleTextChunks(120), fullText = textResult.chunks.map((chunk) => chunk.text).join('\n'), text = pageTruncate(fullText, 1_000);
    const limit = pageLimit(options?.limit, 30, 80), scope = options?.scope === 'viewport' ? 'viewport' : 'page', store = pageStartSnapshotStore();
    const allTargets = pageTargetElements('click');
    const elements = allTargets.filter((element) => pageIsVisible(element, scope)).sort(pageCompareElements).slice(0, limit).map((element, offset) => pageBrowserElement(element, offset + 1, store));
    const frames = pageFrameSummaries({ includeText: true, includeElements: true, elementSelector: pageInteractiveSelector(), textLimit: 1_000, elementLimit: 20 });
    pageWatchSnapshotStore(store);
    return { title: document.title, url: location.href, text: text.value, elements, ...(frames.length ? { frames } : {}), truncated: text.truncated || textResult.truncated || allTargets.length > elements.length, limit, hints: pageBrowserHints(fullText.length === 0, fullText.length > 0 || allTargets.length > 0) };
  }
  function pageBrowserElement(element: HTMLElement, number: number, store: BrowserSnapshotStore, confidence?: number) { return { ...pageBrowserSummaryElement(element, number), ref: pageSnapshotRef(store, element, number), ...(confidence !== undefined ? { confidence: pageRound(confidence) } : {}) }; }
  function pageBrowserSummaryElement(element: HTMLElement, number: number) { const rect = element.getBoundingClientRect(), href = pageHref(element), value = pageValueSummary(pageElementValue(element)); return { number, kind: pageElementKind(element), tag: element.tagName.toLowerCase(), role: pageElementRole(element), name: pageAccessibleName(element), text: pageShortText(element.innerText || element.textContent || ''), ...(href ? { href } : {}), ...(value ? { value } : {}), state: pageElementState(element, pageIsDisabled(element)), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } }; }
  function pageBrowserHints(empty: boolean, runtimeContent: boolean) { return [...pageSenseHints(empty, runtimeContent), 'Refs are scoped to this snapshot; if the page changes, call browser.snapshot again and use a new ref.']; }
  function pageElementState(element: HTMLElement, disabled: unknown) {
    const state: Record<string, unknown> = {};
    if (disabled) state.disabled = true;
    if (element.getAttribute('aria-expanded')) state.expanded = element.getAttribute('aria-expanded') === 'true';
    if (element.getAttribute('aria-selected')) state.selected = element.getAttribute('aria-selected') === 'true';
    if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) state.checked = element.checked;
    return state;
  }
  function pageStartSnapshotStore() {
    const global = globalThis as typeof globalThis & { __taberBrowserSnapshotStore?: BrowserSnapshotStore; __taberBrowserSnapshotPageId?: string; __taberBrowserSnapshotSeq?: number };
    global.__taberBrowserSnapshotStore?.observer?.disconnect();
    const pageId = global.__taberBrowserSnapshotPageId ?? (global.__taberBrowserSnapshotPageId = crypto.randomUUID().slice(0, 8));
    const seq = (global.__taberBrowserSnapshotSeq ?? 0) + 1;
    global.__taberBrowserSnapshotSeq = seq;
    return global.__taberBrowserSnapshotStore = { id: `${pageId}.${seq}`, document, url: location.href, dirty: false, refs: new Map() };
  }
  function pageSnapshotRef(store: BrowserSnapshotStore, element: HTMLElement, number: number) { const ref = `r${store.id}.${number}`; store.refs.set(ref, pageElementRef(element)); return ref; }
  function pageWatchSnapshotStore(store: BrowserSnapshotStore) { store.observer = new MutationObserver((records) => { if (pageSnapshotChanged(records)) store.dirty = true; }); pageObserveMutations(store.observer); }
  function pageResolveSnapshotRef(ref: string) {
    const store = (globalThis as typeof globalThis & { __taberBrowserSnapshotStore?: BrowserSnapshotStore }).__taberBrowserSnapshotStore;
    if (!store || store.document !== document || store.url !== location.href || !store.refs.has(ref)) throw new Error('Ref is stale. Use browser.snapshot again and retry with a ref from the latest browser state.');
    if (store.dirty) throw new Error('Ref is stale because the page changed. Use browser.snapshot again and retry with a new ref.');
    const elementRef = store.refs.get(ref) as BrowserReplElementRef, element = elementRef.marker ? pageFindByMarker(elementRef.marker) : undefined;
    if (!element || !pageIsVisible(element, 'page')) throw new Error('Ref is stale because the target changed. Use browser.snapshot again and retry with a new ref.');
    if (element.tagName.toLowerCase() !== elementRef.tagName || elementRef.fingerprint && pageElementFingerprint(element) !== elementRef.fingerprint) throw new Error('Snapshot element changed; call browser.snapshot again and retry with a new ref.');
    return element;
  }
  function pageSnapshotChanged(records: MutationRecord[] | undefined) { return !Array.isArray(records) || records.some((record) => !pageIgnoredSnapshotMutation(record)); }
  function pageIgnoredSnapshotMutation(record: MutationRecord) { return record.type === 'attributes' && record.attributeName === 'data-taber-repl-ref' || pageMutationTouchesVisual(record); }
  function pageMutationTouchesVisual(record: MutationRecord) { const nodes = [record.target, ...Array.from(record.addedNodes ?? []), ...Array.from(record.removedNodes ?? [])]; return nodes.some((node) => node instanceof Element && pageIsVisualElement(node)); }
  function pageTargetCandidate(candidate: { element: HTMLElement; score: number }, number: number) { return { ...pageBrowserSummaryElement(candidate.element, number), confidence: pageRound(candidate.score) }; }
  function pageResolvePageTarget(target: unknown, intent: 'click' | 'fill' | 'press') {
    try { const locator = pageReadPageTarget(target); if ('ref' in locator) return pageResolvedTarget(pageResolveSnapshotRef(locator.ref)); if ('x' in locator) return pageResolvePointTarget(locator.x, locator.y); if ('selector' in locator) return pageResolvedTarget(pageResolveTarget(locator.selector, 'browser')); if ('label' in locator) return pageResolveLabelTarget(locator.label); if ('role' in locator) return pageResolveScoredTarget(`${locator.role} ${locator.name}`, pageTargetCandidates(intent).filter((candidate) => pageNormalizeText(pageElementRole(candidate.element) || '') === pageNormalizeText(locator.role)).map((candidate) => ({ ...candidate, score: pageTextScore(locator.name, pageAccessibleName(candidate.element)) }))); return pageResolveScoredTarget(locator.text, pageTargetCandidates(intent).map((candidate) => ({ ...candidate, score: pageBestElementTextScore(locator.text, candidate.element) }))); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); return pageTargetFailure(/stale|latest browser snapshot|page changed/i.test(message) ? 'STALE_REF' : /Snapshot element changed/i.test(message) ? 'ELEMENT_CHANGED' : /No element|gone|changed/i.test(message) ? 'NO_TARGET' : 'INVALID_TARGET', message); }
  }
  function pageReadPageTarget(value: unknown): BrowserPageTarget {
    if (!pageIsRecord(value)) throw new Error('PageTarget must be an object');
    const hasRole = 'role' in value || 'name' in value, hasPoint = 'x' in value || 'y' in value;
    const locatorCount = ['ref', 'label', 'text', 'selector'].filter((key) => key in value).length + (hasRole ? 1 : 0) + (hasPoint ? 1 : 0);
    if (locatorCount !== 1) throw new Error('PageTarget must contain exactly one locator: ref, role/name, label, text, selector, or x/y');
    if ('ref' in value) return { ref: pageRequiredText(value.ref, 'PageTarget.ref') };
    if (hasPoint) return { x: pageRequiredCoordinate(value.x, 'PageTarget.x'), y: pageRequiredCoordinate(value.y, 'PageTarget.y') };
    if ('selector' in value) return { selector: pageRequiredText(value.selector, 'PageTarget.selector') };
    if ('label' in value) return { label: pageRequiredText(value.label, 'PageTarget.label') };
    if ('text' in value) return { text: pageRequiredText(value.text, 'PageTarget.text') };
    return { role: pageRequiredText(value.role, 'PageTarget.role'), name: pageRequiredText(value.name, 'PageTarget.name') };
  }
  function pageRequiredCoordinate(value: unknown, name: string) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
    return value;
  }
  function pageResolvePointTarget(x: number, y: number) {
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
      return pageTargetFailure('NO_TARGET', `Point (${x}, ${y}) is outside the viewport (${innerWidth}x${innerHeight} CSS px). Coordinates are viewport CSS px; scroll first if the target is off-screen.`);
    }
    let element: Element | null = document.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    if (element instanceof HTMLIFrameElement) {
      return pageTargetFailure('FRAME_NOT_ACCESSIBLE', `Point (${x}, ${y}) lands on an iframe; coordinate targets only reach the top document. Use frames[] refs or selectors instead.`);
    }
    if (!(element instanceof HTMLElement)) return pageTargetFailure('NO_TARGET', `No interactive element at point (${x}, ${y}).`);
    return pageResolvedTarget(element);
  }
  function pageResolveLabelTarget(label: string) {
    const match = pageBestFieldMatch(label, pageFieldCandidates(), new Set(), 0.72);
    if (match.best) return pageResolvedTarget(match.best.element);
    if (match.ambiguous.length) return pageTargetFailure('AMBIGUOUS_TARGET', `Multiple fields match label: ${label}`, match.ambiguous);
    return pageTargetFailure('NO_TARGET', `No fillable field matches label: ${label}`, match.preview ? [match.preview] : []);
  }
  function pageResolveScoredTarget(query: string, candidates: { element: HTMLElement; score: number }[]) {
    const scored = candidates.filter((candidate) => candidate.score >= 0.72).sort((left, right) => right.score - left.score || Number(pageIsDisabled(left.element)) - Number(pageIsDisabled(right.element)) || pageCompareElements(left.element, right.element));
    if (!scored.length) return pageTargetFailure('NO_TARGET', `No visible interactive target matches: ${query}`, []);
    const exact = scored.filter((candidate) => candidate.score === 1), ambiguous = (exact.length ? exact : scored.filter((candidate) => scored[0].score - candidate.score < 0.08)).slice(0, 5);
    return ambiguous.length > 1 ? pageTargetFailure('AMBIGUOUS_TARGET', `Multiple visible targets match: ${query}`, ambiguous.map((candidate, offset) => pageTargetCandidate(candidate, offset + 1))) : pageResolvedTarget(scored[0].element);
  }
  function pageTargetCandidates(intent: 'click' | 'fill' | 'press') { return pageTargetElements(intent).map((element) => ({ element, score: 0 })); }
  function pageTargetElements(intent: 'click' | 'fill' | 'press') { const selector = intent === 'fill' ? pageFillableSelector() : pageInteractiveSelector(); return pageQuerySelectorAll(selector).filter((element): element is HTMLElement => element instanceof HTMLElement && pageIsVisible(element, 'page') && (intent !== 'fill' || pageIsFillable(element))); }
  function pageBestElementTextScore(query: string, element: HTMLElement) {
    return [pageAccessibleName(element), element.innerText || element.textContent || '', pageValueSummary(pageElementValue(element)), pageHref(element), element.getAttribute('placeholder'), element.getAttribute('title')].filter((text): text is string => Boolean(text)).reduce((score, text) => Math.max(score, pageTextScore(query, text)), 0);
  }
  function pageResolvedTarget(element: HTMLElement) { return { ok: true as const, element }; }
  function pageTargetFailure(code: string, message: string, candidates?: unknown[]) {
    const nextMessage = code === 'NO_TARGET' ? `${message}${pageFrameHintSentence()}` : message;
    return { ok: false as const, code, message: pageShortText(nextMessage), ...(candidates && candidates.length ? { candidates } : {}) };
  }
  function pageRequiredText(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value; }
  function pageSummarizeElement(element: Element, index: number) {
    const htmlElement = element as HTMLElement;
    const name = pageAccessibleName(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    const tagName = htmlElement.tagName.toLowerCase();
    return { index, tag: tagName, role: htmlElement.getAttribute('role') ?? pageImplicitRole(htmlElement), name, text: pageShortText(htmlElement.innerText || htmlElement.textContent || ''), value: pageElementValue(htmlElement), disabled: pageIsDisabled(htmlElement), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, ref: pageElementRef(htmlElement) };
  }
  function pageElementEvidence(element: HTMLElement) { const summary = pageSummarizeElement(element, 1) as Record<string, unknown>; delete summary.ref; summary.selector = pageElementRef(element).selector; summary.value = pageValueSummary(pageElementValue(element)); return summary; }
  function pagePickedElement(element: HTMLElement) { return { ...pageElementEvidence(element), xpath: pageElementXPath(element), attributes: pageElementAttributes(element) }; }
  function pageResolveTarget(target: unknown, helperName: string) {
    if (typeof target === 'string') return pageResolveSelector(target);
    if (pageIsElementRef(target)) return pageResolveRef(target);
    throw new Error(`${helperName} target must be a selector string or same-call element index`);
  }
  function pageEvidenceElement(element: HTMLElement | undefined, selector: string, fingerprint?: string, anchor?: HTMLElement, filledValue?: string) { const match = element?.isConnected && pageIsVisible(element, 'page') ? element : fingerprint ? pageFindByFingerprint(fingerprint, anchor) ?? pageFindByFingerprint(fingerprint) ?? pageFindByFilledFingerprint(fingerprint, filledValue) : undefined; if (!match) throw new Error(`Element changed before final value could be confirmed: ${selector}`); return match; }
  function pageEvidenceAnchor(element: HTMLElement) { for (let node = element.parentElement; node; node = node.parentElement) if (node.tagName === 'LABEL') return node; return element.parentElement ?? undefined; }
  function pageResolveSelector(selector: string) {
    const path = selector.split('>>>').map((part) => part.trim()).filter(Boolean);
    const element = path.length > 1 ? pageResolveShadowPath(path, `No element matches selector: ${selector}`) : pageQuerySelectorAll(selector).find((node) => node instanceof HTMLElement && pageIsVisible(node, 'page')) as HTMLElement | undefined;
    if (!element || !pageIsVisible(element, 'page')) throw new Error(`No element matches selector: ${selector}${pageFrameHintSentence()}`);
    return element;
  }
  function pageResolveRef(ref: BrowserReplElementRef) {
    if (ref.marker) { const marked = pageFindByMarker(ref.marker); if (!marked || marked.tagName.toLowerCase() !== ref.tagName) return pageChanged(); if (pageIsVisible(marked, 'page')) return marked; return ref.fingerprint ? pageFindByFingerprint(ref.fingerprint) ?? pageChanged() : pageChanged(); }
    const element = Array.isArray(ref.shadowPath) && ref.shadowPath.length ? pageResolveShadowPath(ref.shadowPath, `Element is gone: ${ref.selector}`) : pageResolveDocumentSelector(ref.selector);
    if (!element) throw new Error(`Element is gone: ${ref.selector}${pageFrameHintSentence()}`);
    if (element.tagName.toLowerCase() !== ref.tagName) throw new Error('Element changed before action');
    if (ref.fingerprint) { const matches = pageElementsByFingerprint(ref.fingerprint); if (ref.fingerprintCount !== undefined && matches.length !== ref.fingerprintCount) return pageChanged(); if (pageElementFingerprint(element) !== ref.fingerprint) return matches.length === 1 ? matches[0] : pageChanged(); }
    else if (pageStableId(element) !== ref.stableId) throw new Error('Element changed before action');
    if (!pageIsVisible(element, 'page')) return ref.fingerprint ? pageFindByFingerprint(ref.fingerprint) ?? pageChanged() : pageChanged();
    return element;
  }
  function pageFindByFingerprint(fingerprint: string, root?: HTMLElement) { const nodes = root ? root.isConnected ? [...root.querySelectorAll('*')] : [] : pageQuerySelectorAll('*'); const matches = nodes.filter((element): element is HTMLElement => element instanceof HTMLElement && element.isConnected && pageIsVisible(element, 'page') && pageElementFingerprint(element) === fingerprint); return matches.length === 1 ? matches[0] : undefined; }
  function pageFindByFilledFingerprint(fingerprint: string, value?: string) { const filled = pageValueSummary(value), normalized = pageNormalizeText(filled || ''); if (!filled) return undefined; const matches = pageElementsByFingerprint(fingerprint).filter((element) => { const current = pageValueSummary(pageElementValue(element)), next = pageNormalizeText(current || ''); return pageIsVisible(element, 'page') && (current === filled || Boolean(next && normalized && (next.includes(normalized) || normalized.includes(next)))); }); const exact = matches.filter((element) => pageValueSummary(pageElementValue(element)) === filled); return exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined; }
  function pageElementsByFingerprint(fingerprint: string) { return pageQuerySelectorAll('*').filter((element): element is HTMLElement => element instanceof HTMLElement && pageElementFingerprint(element) === fingerprint); }
  function pageFindByMarker(marker: string) { const matches = pageQuerySelectorAll('*').filter((element): element is HTMLElement => element instanceof HTMLElement && element.getAttribute('data-taber-repl-ref') === marker); return matches.length === 1 ? matches[0] : undefined; }
  function pageChanged(): never { throw new Error('Element changed before action'); }
  function pageResolveDocumentSelector(selector: string) {
    pageRejectUnsupportedSelector(selector);
    return document.querySelector(selector) as HTMLElement | null;
  }
  function pageResolveShadowPath(path: string[], missingMessage: string) {
    let root: Document | ShadowRoot = document, element: HTMLElement | null = null;
    for (let index = 0; index < path.length; index += 1) {
      pageRejectUnsupportedSelector(path[index]);
      element = root.querySelector(path[index]) as HTMLElement | null;
      if (!element) throw new Error(`${missingMessage}${pageFrameHintSentence()}`);
      if (index < path.length - 1 && !element.shadowRoot) throw new Error(`Open shadow root is gone for selector: ${path[index]}`);
      if (index < path.length - 1) root = element.shadowRoot as ShadowRoot;
    }
    if (!element) throw new Error(`${missingMessage}${pageFrameHintSentence()}`);
    return element;
  }
  function pageMatchesWait(options: { selector?: string; text?: string }) {
    if (options.selector && pageQuerySelectorAll(options.selector).length === 0) return false;
    if (options.text && !pageAllText().includes(options.text)) return false;
    return true;
  }
  function pageQuerySelectorAll(selector: string) { return inspect.querySelectorAll(selector); }
  function pageRejectUnsupportedSelector(selector: string) { return inspect.rejectUnsupportedSelector(selector); }
  function pageVisibleTextChunks(maxChunks: number) { return inspect.visibleTextChunks(maxChunks); }
  function pageFrameSummaries(options?: Parameters<typeof inspect.frameSummaries>[0]) { return inspect.frameSummaries(options); }
  function pageSenseHints(empty: boolean, runtimeContent = false) { return inspect.hints(empty, { runtimeContent: pageLooksLikeSpaShell(runtimeContent) }); }
  function pageCompareElements(left: HTMLElement, right: HTMLElement) {
    const a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    return pageViewportRank(a) - pageViewportRank(b) || a.top - b.top || a.left - b.left;
  }
  function pageViewportRank(rect: DOMRect) { return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth ? 0 : 1; }
  function pageHref(element: HTMLElement) { const href = (element as HTMLAnchorElement).href || element.getAttribute('href'); return href ? pageShortText(href) : undefined; }
  function pageElementSearchText(element: HTMLElement) { return [pageAccessibleName(element), element.innerText || element.textContent || '', pageHref(element), element.getAttribute('placeholder'), element.getAttribute('title')].filter(Boolean).join(' '); }
  function pageClosestInteractive(element: HTMLElement) { for (let node: Element | null = element; node; node = pageComposedParent(node)) if (node instanceof HTMLElement && pageIsKnownInteractive(node) && pageIsVisible(node, 'page')) return node; return undefined; }
  function pageIsKnownInteractive(element: HTMLElement) { const tag = element.tagName.toLowerCase(), role = element.getAttribute('role'); return tag === 'a' && Boolean(element.getAttribute('href')) || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary' || element.isContentEditable || ['button', 'link', 'menuitem', 'checkbox', 'radio', 'tab'].includes(role || '') || Boolean(element.getAttribute('tabindex') && element.getAttribute('tabindex') !== '-1'); }
  function pageElementKind(element: HTMLElement) { const tag = element.tagName.toLowerCase(), role = element.getAttribute('role'); if (tag === 'a' || role === 'link') return 'link'; if (tag === 'button' || role === 'button' || tag === 'input' && ['button', 'submit', 'reset', 'image'].includes((element as HTMLInputElement).type || '')) return 'button'; if (pageIsFillable(element)) return 'field'; return role || tag; }
  function pageElementRole(element: HTMLElement) { return element.getAttribute('role') ?? pageImplicitRole(element); }
  function pageLinksAndButtonsSelector() { return 'a[href],button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],[role="button"],[role="link"]'; }
  function pageContext(text: string, query: string, limit: number) { const index = text.toLowerCase().indexOf(query.toLowerCase()); if (index < 0) return pageShortText(text); const start = Math.max(0, index - Math.floor(limit / 2)), end = Math.min(text.length, index + query.length + Math.floor(limit / 2)); return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`; }
  function pageTruncate(value: string, limit: number) { return value.length > limit ? { value: `${value.slice(0, limit)}…`, truncated: true } : { value, truncated: false }; }
  function pageLimit(value: unknown, fallback: number, max: number) { return Number.isFinite(value) && Number(value) > 0 ? Math.min(max, Math.floor(Number(value))) : fallback; }
  function pageObserveMutations(observer: MutationObserver) { return inspect.observeMutations(observer); }
  function pageAllText() { return inspect.allText(); }
  function pageHints() { return pageFrameSummaries({ metadataOnly: true }).length ? pageSenseHints(false) : []; }
  function pageFrameHintSentence() { return inspect.frameHintSentence(); }
  function pageLooksLikeSpaShell(runtimeContent: boolean) {
    if (!runtimeContent) return false;
    return Boolean(document.querySelector('#root,#app,#__next,[data-reactroot],[ng-version],[data-sveltekit-preload-data]'));
  }
  function pageIsVisible(element: Element, scope: 'viewport' | 'page') {
    for (let node: Element | null = element; node; node = pageComposedParent(node)) { const style = pageComputedStyle(node); if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0)) return false; }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (scope === 'page') return true;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  }
  function pageComposedParent(element: Element) {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode?.();
    return root && root !== document && 'host' in root ? root.host as Element : null;
  }
  function pageComputedStyle(element: Element) { try { return getComputedStyle(element); } catch { return undefined; } }
  function pageAccessibleName(element: HTMLElement) {
    const labels = pageElementLabels(element).join(' ');
    return pageShortText(element.getAttribute('aria-label') || labels || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || element.textContent || '');
  }
  function pageFieldCandidates() {
    return pageQuerySelectorAll(pageFillableSelector()).filter((element): element is HTMLElement => element instanceof HTMLElement && pageIsVisible(element, 'page') && pageIsFillable(element) && !pageIsDisabled(element)).map((element) => ({ element, selector: pageElementRef(element).selector, texts: pageFieldTexts(element) }));
  }
  function pageFieldTexts(element: HTMLElement) {
    const texts: { text: string; weight: number }[] = [];
    const add = (text: string | null | undefined, weight: number) => {
      const short = pageShortText(text || '');
      if (short && !texts.some((item) => item.text === short)) texts.push({ text: short, weight });
    };
    for (const label of pageElementLabels(element)) add(label, 1);
    for (const attr of ['aria-label', 'placeholder', 'name', 'id', 'title']) add(element.getAttribute(attr), attr === 'name' || attr === 'id' ? 0.9 : 1);
    add(pageSiblingText(element, 'previousElementSibling'), 0.9);
    add(pageSiblingText(element, 'nextElementSibling'), 0.75);
    add(element.parentElement?.innerText || element.parentElement?.textContent, 0.75);
    add(pageSectionText(element), 0.65);
    return texts;
  }
  function pageElementLabels(element: HTMLElement) {
    const labeled = (element as HTMLElement & { labels?: Iterable<HTMLElement> | null }).labels;
    return labeled ? [...labeled].map((label) => label.innerText || label.textContent || '').filter(Boolean) : [];
  }
  function pageSiblingText(element: HTMLElement, key: 'previousElementSibling' | 'nextElementSibling') {
    const sibling = element[key] as HTMLElement | null;
    return sibling ? sibling.innerText || sibling.textContent || '' : '';
  }
  function pageSectionText(element: HTMLElement) {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const legend = node.querySelector?.('legend') as HTMLElement | null;
      if (legend?.innerText || legend?.textContent) return legend.innerText || legend.textContent || '';
      const heading = pagePreviousHeading(node);
      if (heading) return heading;
    }
    return '';
  }
  function pagePreviousHeading(element: HTMLElement) {
    for (let sibling = element.previousElementSibling as HTMLElement | null; sibling; sibling = sibling.previousElementSibling as HTMLElement | null) {
      if (/^h[1-6]$/i.test(sibling.tagName)) return sibling.innerText || sibling.textContent || '';
    }
    return '';
  }
  function pageBestFieldMatch(field: string, candidates: { element: HTMLElement; selector: string; texts: { text: string; weight: number }[] }[], used: Set<HTMLElement>, threshold: number) {
    const scored = candidates.filter((candidate) => !used.has(candidate.element)).map((candidate) => ({ ...candidate, score: pageCandidateScore(field, candidate.texts) })).filter((candidate) => candidate.score > 0).sort((left, right) => right.score - left.score);
    const best = scored[0];
    if (!best || best.score < threshold) return { best: undefined, ambiguous: [], preview: best ? pageCandidatePreview(best) : undefined };
    const ambiguous = scored.filter((candidate) => candidate.score >= threshold && best.score - candidate.score < 0.08).slice(0, 5).map(pageCandidatePreview);
    return ambiguous.length > 1 ? { best: undefined, ambiguous, preview: undefined } : { best, ambiguous: [], preview: undefined };
  }
  function pageCandidateScore(field: string, texts: { text: string; weight: number }[]) {
    return texts.reduce((score, text) => Math.max(score, pageTextScore(field, text.text) * text.weight), 0);
  }
  function pageCandidatePreview(candidate: { selector: string; score: number; element: HTMLElement }) {
    return { selector: candidate.selector, name: pageAccessibleName(candidate.element), confidence: pageRound(candidate.score) };
  }
  function pageTextScore(left: string, right: string) {
    const a = pageNormalizeText(left);
    const b = pageNormalizeText(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (b.includes(a)) return Math.min(0.99, 0.86 + 0.13 * (a.length / b.length));
    if (a.includes(b)) return Math.min(0.9, 0.72 + 0.18 * (b.length / a.length));
    return pageDiceScore(a, b);
  }
  function pageDiceScore(left: string, right: string) {
    const a = pageBigrams(left);
    const b = pageBigrams(right);
    const used = new Set<number>();
    let matches = 0;
    for (const gram of a) {
      const index = b.findIndex((next, offset) => next === gram && !used.has(offset));
      if (index >= 0) {
        used.add(index);
        matches += 1;
      }
    }
    return (2 * matches) / (a.length + b.length);
  }
  function pageBigrams(text: string) {
    if (text.length <= 1) return [text];
    return [...text].slice(1).map((_char, index) => text.slice(index, index + 2));
  }
  function pageNormalizeText(text: string) {
    return text.toLowerCase().replace(/[\s:：*＊\-_/()[\]{}【】（）"'“”‘’]+/g, '');
  }
  function pageReadFillFormOptions(value: unknown) {
    if (!pageIsRecord(value) || !pageIsRecord(value.fields)) throw new Error('fillForm requires { fields }');
    const fields: Record<string, string> = {};
    for (const [field, fieldValue] of Object.entries(value.fields)) {
      if (typeof fieldValue !== 'string') throw new Error(`fillForm.fields.${field} must be a string`);
      fields[field] = fieldValue;
    }
    const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? Math.max(0, Math.min(1, value.confidence)) : 0.72;
    return { fields, confidence, dryRun: value.dryRun === true };
  }
  function pageElementRef(element: HTMLElement): BrowserReplElementRef {
    const path = pageSelectorPath(element), fingerprint = pageElementFingerprint(element);
    const ref: BrowserReplElementRef = { stableId: pageStableId(element), selector: path.join(' >>> '), tagName: element.tagName.toLowerCase(), name: pageAccessibleName(element), fingerprint, fingerprintCount: pageElementsByFingerprint(fingerprint).length, marker: pageElementMarker(element) };
    if (path.length > 1) ref.shadowPath = path;
    return ref;
  }
  function pageElementMarker(element: HTMLElement) { const attr = 'data-taber-repl-ref', marker = element.getAttribute(attr) || crypto.randomUUID(); if (!element.getAttribute(attr)) element.setAttribute(attr, marker); return marker; }
  function pageElementAttributes(element: HTMLElement) { const attributes: Record<string, string> = {}; for (const name of ['id', 'name', 'type', 'role', 'aria-label', 'placeholder', 'title', 'href', 'class', 'data-testid', 'data-test', 'autocomplete']) { const value = element.getAttribute(name); if (value) attributes[name] = pageShortText(value); } return attributes; }
  function pageElementXPath(element: HTMLElement) { const parts: string[] = []; for (let node: HTMLElement | null = element; node && node !== document.documentElement; node = node.parentElement) { const siblings = [...(node.parentElement?.children ?? [])].filter((sibling) => sibling.tagName === node.tagName); parts.unshift(`${node.tagName.toLowerCase()}[${siblings.indexOf(node) + 1}]`); } return `/html/${parts.join('/')}`; }
  function pageStableId(element: HTMLElement) { return `${element.tagName.toLowerCase()}|${pageSelectorPath(element).join(' >>> ')}`; }
  function pageElementFingerprint(element: HTMLElement) { return pageShortText([element.tagName.toLowerCase(), element.getAttribute('role') ?? pageImplicitRole(element) ?? '', pageElementLabels(element).join(' '), element.getAttribute('aria-label') ?? '', element.getAttribute('placeholder') ?? '', element.getAttribute('name') ?? '', element.id, element.getAttribute('title') ?? '', pageIsFillable(element) ? '' : element.innerText || element.textContent || ''].map(pageNormalizeText).join('|')); }
  function pageSelectorPath(element: HTMLElement) {
    const path = [pageUniqueSelector(element)];
    let root = element.getRootNode?.() as Document | ShadowRoot | undefined;
    while (root && root !== document && 'host' in root) {
      const host = root.host as HTMLElement;
      path.unshift(pageUniqueSelector(host));
      root = host.getRootNode?.() as Document | ShadowRoot | undefined;
    }
    return path;
  }
  function pageUniqueSelector(element: HTMLElement) {
    const cssEscape = (globalThis.CSS && CSS.escape) || ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts: string[] = [];
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const siblings = [...(node.parentElement?.children ?? (node.getRootNode?.() as ShadowRoot | undefined)?.children ?? [])].filter((sibling) => sibling.tagName === node.tagName);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
      if (!node.parentElement) break;
    }
    return `${element.getRootNode?.() === document ? 'body > ' : ''}${parts.join(' > ')}`;
  }
  function pageElementValue(element: HTMLElement) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
    if (element.isContentEditable) return element.textContent || '';
    return undefined;
  }
  function pageValueSummary(value: unknown) {
    return value === undefined ? undefined : pageShortText(String(value));
  }
  function pageIsFillable(element: HTMLElement) {
    if (element instanceof HTMLInputElement) return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image'].includes(element.type || '');
    return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable;
  }
  function pageIsDisabled(element: HTMLElement) {
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return element.disabled;
    return element.getAttribute('aria-disabled') === 'true';
  }
  function pageImplicitRole(element: HTMLElement) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type || '';
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return undefined;
  }
  function pageInteractiveSelector() {
    return 'a[href],button,input,select,textarea,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="tab"],[tabindex]:not([tabindex="-1"])';
  }
  function pageFillableSelector() {
    return 'input,select,textarea,[contenteditable]:not([contenteditable="false"])';
  }
  function pageVisual() { return (globalThis as typeof globalThis & { __taberBrowserReplVisual?: { isVisualElement?(element: Element): boolean } }).__taberBrowserReplVisual; }
  function pageIsVisualElement(element: Element) { try { return pageVisual()?.isVisualElement?.(element) === true; } catch { return false; } }
  function pageIsElementRef(value: unknown): value is BrowserReplElementRef {
    return pageIsRecord(value) && typeof value.stableId === 'string' && typeof value.selector === 'string' && typeof value.tagName === 'string' && typeof value.name === 'string';
  }
  function pageIsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
  function pageRound(value: number) {
    return Math.round(value * 100) / 100;
  }
  function pageShortText(text: string) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
}
