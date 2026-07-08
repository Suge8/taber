import { installBrowserReplPageLocator } from './browser-repl-page-locator.ts';
import type { BrowserReplPageCommand } from './browser-repl-command.ts';
import type { BrowserReplPageLocator, BrowserStateOptions } from './browser-repl-page-types.ts';

export function runBrowserReplPageRuntime(command: BrowserReplPageCommand, requestId?: string) {
  installBrowserReplPageLocator();
  return runBrowserReplPageRuntimeInjected(command, requestId);
}

export function runBrowserReplPageRuntimeInjected(command: BrowserReplPageCommand, requestId?: string) {
  const page = readInjectedLocator();
  const pageCommand = normalizePageCommand(command);
  if (requestId === undefined) return browserReplPageMain(pageCommand);
  const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage?(message: unknown): Promise<unknown> } } }).chrome?.runtime;
  if (!runtime?.sendMessage) throw new Error('chrome.runtime is unavailable');
  return browserReplPageMain(pageCommand).then((nextResult) => {
    const message = nextResult.ok
      ? { type: 'taber.scripting.result', requestId, ok: true, value: nextResult.value }
      : { type: 'taber.scripting.result', requestId, ok: false, error: nextResult.error };
    return runtime.sendMessage?.(message);
  });

  function readInjectedLocator() {
    const locator = (globalThis as typeof globalThis & { __taberBrowserReplPageLocator?: BrowserReplPageLocator }).__taberBrowserReplPageLocator;
    if (!locator) throw new Error('Taber page locator runtime is unavailable');
    return locator;
  }
  function normalizePageCommand(nextCommand: BrowserReplPageCommand) {
    return JSON.parse(JSON.stringify(nextCommand));
  }
  function browserReplPageMain(nextCommand: BrowserReplPageCommand) {
    const helpers = { readVisibleText: page.readVisibleText, readLinksAndButtons: page.readLinksAndButtons, listInteractiveElements: page.listInteractiveElements, queryText: page.queryText, browser: pageBrowser, observe: page.observe, query: page.query, click: pageClick, fill: pageFill, press: pagePress, scroll: pageScroll, waitFor: pageWaitFor, batch: pageBatch, fillForm: pageFillForm, pickElement: pagePickElement, pickUserElement: pagePickUserElement, controlOverlay: pageControlOverlay };
    const helper = helpers[nextCommand.helper as keyof typeof helpers] as ((...args: unknown[]) => unknown) | undefined;
    const args = nextCommand.helper === 'waitFor' || nextCommand.helper === 'batch' || nextCommand.helper === 'pickUserElement' ? [...nextCommand.args, nextCommand.cancelKey] : nextCommand.args;
    return Promise.resolve().then(() => {
      if (!helper) throw new Error(`Unsupported browserRepl helper: ${nextCommand.helper}`);
      return helper(...args);
    }).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
    );
  }
  function pageClick(target: unknown) { const element = page.resolveTarget(target, 'click'); pageClickElement(element); return { clicked: true, element: page.summarizeElement(element, 1) }; }
  function pageFill(target: unknown, text: string) { const element = page.resolveTarget(target, 'fill'); pageFillElement(element, text); return { filled: true, element: page.summarizeElement(element, 1) }; }
  function pagePress(target: unknown, key: string) {
    const element = target ? page.resolveTarget(target, 'press') : (document.activeElement as HTMLElement | null);
    if (!element) throw new Error('No focused element for press()');
    pagePressElement(element, key);
    return { pressed: key, element: page.summarizeElement(element, 1) };
  }
  async function pageBrowser(input: unknown) {
    const action = pageBrowserAction(input);
    const stateOptions = pageBrowserStateOptions(input);
    if (action === 'snapshot') return { ok: true, action, state: page.browserState(stateOptions) };
    const target = pageIsRecord(input) ? input.target : undefined;
    const resolved = action === 'press' && target === undefined ? pageActiveElement() : page.resolvePageTarget(target, action);
    if (!resolved.ok) return { action, ...resolved, state: page.browserState(stateOptions) };
    const element = resolved.element, selector = page.elementRef(element).selector;
    try {
      if (action === 'click') pageClickElement(element);
      else if (action === 'fill') pageFillElement(element, pageReadText(pageIsRecord(input) ? input.value : undefined, 'fill value'));
      else pagePressElementOrFail(element, pageReadText(pageIsRecord(input) ? input.key : undefined, 'press key'));
      await pageWaitForStableDom();
      return { ok: true, action, evidence: pageBrowserEvidence(action, element, selector, input), state: page.browserState(stateOptions) };
    } catch (error) {
      const message = page.shortText(error instanceof Error ? error.message : String(error));
      return { ok: false, action, code: pageBrowserErrorCode(message), message, evidence: { selector, element: page.elementEvidence(element) }, state: page.browserState(stateOptions) };
    }
  }
  function pageBrowserStateOptions(input: unknown): BrowserStateOptions | undefined {
    if (!pageIsRecord(input)) return undefined;
    return { scope: input.scope === 'viewport' ? 'viewport' : 'page', limit: typeof input.limit === 'number' ? input.limit : undefined };
  }
  function pageActiveElement() {
    const element = document.activeElement as HTMLElement | null;
    return element ? { ok: true as const, element } : { ok: false as const, code: 'NO_TARGET', message: 'No focused element for press()' };
  }
  function pagePressElementOrFail(element: HTMLElement, key: string) { if (page.isDisabled(element)) return pageActionError(element, 'Element is disabled'); pagePressElement(element, key); }
  function pageBrowserEvidence(action: string, element: HTMLElement, selector: string, input: unknown) {
    const value = action === 'fill' && pageIsRecord(input) && typeof input.value === 'string' ? page.valueSummary(input.value) : undefined;
    return { selector, element: page.elementEvidence(element), ...(value ? { value, finalValue: page.valueSummary(page.elementValue(element)) } : {}) };
  }
  function pageBrowserAction(input: unknown): 'snapshot' | 'click' | 'fill' | 'press' {
    if (!pageIsRecord(input)) throw new Error('browser action is required');
    if (input.action === 'snapshot' || input.action === 'click' || input.action === 'fill' || input.action === 'press') return input.action;
    throw new Error('browser action must be snapshot, click, fill, or press');
  }
  function pageBrowserErrorCode(message: string) { if (/stale|latest browser snapshot|page changed/i.test(message)) return 'STALE_REF'; if (/disabled/i.test(message)) return 'DISABLED'; if (/not fillable/i.test(message)) return 'NOT_FILLABLE'; if (/No focused|No visible|No fillable|No element/i.test(message)) return 'NO_TARGET'; return 'ACTION_FAILED'; }
  function pageClickElement(element: HTMLElement) { if (page.isDisabled(element)) return pageActionError(element, 'Element is disabled'); try { element.scrollIntoView({ block: 'center', inline: 'center' }); pageVisualHighlight(element, 'active'); element.click(); pageVisualHighlight(element, 'success'); } catch (error) { pageVisualHighlight(element, 'error'); throw error; } }
  function pageFillElement(element: HTMLElement, text: string) { if (page.isDisabled(element)) return pageActionError(element, 'Element is disabled'); if (!page.isFillable(element)) return pageActionError(element, `Element is not fillable: ${element.tagName.toLowerCase()}`); try { element.scrollIntoView({ block: 'center', inline: 'center' }); element.focus(); pageVisualHighlight(element, 'active'); if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) pageSetValue(element, text); else element.textContent = text; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); pageVisualHighlight(element, 'success'); } catch (error) { pageVisualHighlight(element, 'error'); throw error; } }
  function pagePressElement(element: HTMLElement, key: string) { pageVisualHighlight(element, 'active'); try { element.focus(); element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true })); pageVisualHighlight(element, 'success'); } catch (error) { pageVisualHighlight(element, 'error'); throw error; } }
  function pageActionError(element: HTMLElement, message: string): never { pageVisualHighlight(element, 'error'); throw new Error(message); }
  function pageScroll(options?: { x?: number; y?: number; top?: number; left?: number; behavior?: ScrollBehavior }) {
    const behavior = options?.behavior ?? 'auto';
    if (Number.isFinite(options?.top) || Number.isFinite(options?.left)) window.scrollTo({ top: options?.top, left: options?.left, behavior });
    else window.scrollBy({ left: options?.x ?? 0, top: options?.y ?? 600, behavior });
    return { scrolled: true, x: window.scrollX, y: window.scrollY };
  }
  function pageWaitFor(options?: { selector?: string; text?: string; timeoutMs?: number }, cancelKey?: string) {
    if (!options?.selector && !options?.text) throw new Error('waitFor requires selector or text');
    const timeoutMs = options.timeoutMs ?? 8_000;
    return new Promise((resolve, reject) => {
      let timeoutId: number;
      let cleanupCancel: () => void = () => undefined;
      const observer = new MutationObserver(() => {
        if (page.matchesWait(options)) complete();
      });
      const cleanup = () => {
        clearTimeout(timeoutId);
        observer.disconnect();
        cleanupCancel();
      };
      const complete = () => {
        cleanup();
        resolve({ matched: true });
      };
      const cancel = () => {
        cleanup();
        reject(new Error('Task aborted'));
      };
      cleanupCancel = pageOnCancel(cancelKey, cancel);
      if (page.matchesWait(options)) return complete();
      page.observeMutations(observer);
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }
  async function pageBatch(actions: unknown, options?: { continueOnError?: boolean; stopOnError?: boolean }, cancelKey?: string) {
    if (!Array.isArray(actions)) throw new Error('batch actions must be an array');
    const steps: unknown[] = [];
    const continueOnError = options?.continueOnError === true || options?.stopOnError === false;
    let failed = false;
    for (let offset = 0; offset < actions.length; offset += 1) {
      try {
        const rawStep = await pageBatchStep(actions[offset], cancelKey);
        await pageWaitForStableDom();
        const step = pageBatchEvidenceAfterWait(rawStep);
        steps.push({ index: offset + 1, ok: true, ...step });
      } catch (error) {
        failed = true;
        const message = page.shortText(error instanceof Error ? error.message : String(error));
        steps.push({ index: offset + 1, ok: false, action: pageActionName(actions[offset]), error: message });
        if (!continueOnError) return { ok: false, steps, error: message };
      }
    }
    return failed ? { ok: false, steps, error: 'One or more batch steps failed' } : { ok: true, steps };
  }
  function pageBatchEvidenceAfterWait(step: Record<string, unknown>) {
    const sourceElement = step.sourceElement instanceof HTMLElement ? step.sourceElement : undefined;
    const anchorElement = step.anchorElement instanceof HTMLElement ? step.anchorElement : undefined;
    const { sourceElement: _sourceElement, anchorElement: _anchorElement, fingerprint: _fingerprint, ...visibleStep } = step;
    if (visibleStep.action !== 'fill' || typeof visibleStep.selector !== 'string') return visibleStep;
    const element = page.evidenceElement(sourceElement, visibleStep.selector, typeof step.fingerprint === 'string' ? step.fingerprint : undefined, anchorElement, typeof visibleStep.value === 'string' ? visibleStep.value : undefined);
    return { ...visibleStep, finalValue: page.valueSummary(page.elementValue(element)), element: page.elementEvidence(element) };
  }
  async function pageBatchStep(action: unknown, cancelKey?: string) {
    if (!pageIsRecord(action)) throw new Error('batch action must be an object');
    const name = pageActionName(action);
    if (name === 'click') {
      const element = page.resolveTarget(pageActionTarget(action, name), name);
      pageClickElement(element);
      return { action: name, selector: page.elementRef(element).selector, element: page.elementEvidence(element) };
    }
    if (name === 'fill') {
      const element = page.resolveTarget(pageActionTarget(action, name), name);
      const text = pageReadText(action.value ?? action.text, 'fill value');
      pageFillElement(element, text);
      return { action: name, selector: page.elementRef(element).selector, value: page.valueSummary(text), sourceElement: element, anchorElement: page.evidenceAnchor(element), fingerprint: page.elementFingerprint(element) };
    }
    if (name === 'press') {
      const element = action.target || action.selector ? page.resolveTarget(pageActionTarget(action, name), name) : (document.activeElement as HTMLElement | null);
      if (!element) throw new Error('No focused element for press()');
      const key = pageReadText(action.key, 'press key');
      pagePressElement(element, key);
      return { action: name, key, selector: page.elementRef(element).selector, element: page.elementEvidence(element) };
    }
    if (name === 'scroll') return { action: name, ...pageScroll(action as { x?: number; y?: number; top?: number; left?: number; behavior?: ScrollBehavior }) };
    if (name === 'waitFor') return { action: name, ...await pageWaitFor(action as { selector?: string; text?: string; timeoutMs?: number }, cancelKey) as Record<string, unknown> };
    throw new Error(`Unsupported batch action: ${name || 'missing'}`);
  }
  async function pageFillForm(value: unknown) {
    const options = page.readFillFormOptions(value);
    const used = new Set<HTMLElement>(), filled: unknown[] = [], missing: unknown[] = [], ambiguous: unknown[] = [];
    for (const [field, text] of Object.entries(options.fields)) {
      const match = page.bestFieldMatch(field, page.fieldCandidates(), used, options.confidence);
      if (match.ambiguous.length) {
        ambiguous.push({ field, candidates: match.ambiguous });
        continue;
      }
      if (!match.best) {
        missing.push({ field, best: match.preview });
        continue;
      }
      const { element, score } = match.best;
      const selector = page.elementRef(element).selector;
      const fingerprint = page.elementFingerprint(element);
      const anchor = page.evidenceAnchor(element);
      used.add(element);
      if (!options.dryRun) {
        pageFillElement(element, text);
        await pageWaitForStableDom();
      }
      const evidenceElement = options.dryRun ? element : page.evidenceElement(element, selector, fingerprint, anchor, text);
      filled.push({ field, selector, value: page.valueSummary(text), finalValue: page.valueSummary(page.elementValue(evidenceElement)), confidence: page.round(score), dryRun: options.dryRun });
    }
    return { ok: missing.length === 0 && ambiguous.length === 0, filled, missing, ambiguous, dryRun: options.dryRun };
  }
  function pageOnCancel(cancelKey: string | undefined, cancel: () => void) {
    const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage?(message: unknown): Promise<unknown>; onMessage?: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void } } } }).chrome?.runtime;
    if (!cancelKey || !runtime?.onMessage) return () => undefined;
    const listener = (message: unknown) => { if (isCancelMessage(message, cancelKey)) cancel(); };
    runtime.onMessage.addListener(listener);
    runtime.sendMessage?.({ type: 'taber.browserRepl.isPageCommandCancelled', cancelKey }).then((cancelled: unknown) => { if (cancelled) cancel(); }, () => undefined);
    return () => runtime.onMessage?.removeListener(listener);
  }
  function isCancelMessage(message: unknown, cancelKey: string) {
    return typeof message === 'object' && message !== null && (message as { type?: unknown; cancelKey?: unknown }).type === 'taber.browserRepl.cancelPageCommand' && (message as { cancelKey?: unknown }).cancelKey === cancelKey;
  }
  function pagePickElement(target: unknown) { const element = page.resolveTarget(target, 'pickElement'); pageVisualHighlight(element, 'active'); pageVisualHighlight(element, 'success'); return page.summarizeElement(element, 1); }
  function pagePickUserElement(options?: unknown, cancelKey?: string) { const visual = pageVisual(); if (!visual?.pickUserElement) throw new Error('Taber visual runtime is unavailable'); return visual.pickUserElement(pagePickUserElementOptions(options), cancelKey, page.pickedElement); }
  function pageControlOverlay(command: unknown) { const visual = pageVisual(); if (!visual?.command) throw new Error('Taber visual runtime is unavailable'); return visual.command(command); }
  function pageWaitForStableDom() {
    return new Promise((resolve) => {
      let stableFrames = 0, attempts = 0, scheduled = false, rootCount = 0;
      const observer = new MutationObserver(() => { stableFrames = 0; schedule(); });
      const done = () => { observer.disconnect(); resolve({ stable: true }); };
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => pageNextFrame(() => { scheduled = false; const nextRootCount = page.observeMutations(observer); if (nextRootCount !== rootCount) { rootCount = nextRootCount; stableFrames = 0; } stableFrames += 1; attempts += 1; if (stableFrames >= 4 || attempts >= 12) done(); else schedule(); }));
      };
      rootCount = page.observeMutations(observer); schedule();
    });
  }
  function pageNextFrame(callback: () => void) {
    let called = false;
    let channel: MessageChannel | undefined;
    const run = () => { if (!called) { called = true; channel?.port1.close(); channel?.port2.close(); callback(); } };
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') requestAnimationFrame(run);
    else if (typeof MessageChannel === 'function') { channel = new MessageChannel(); channel.port1.onmessage = run; channel.port2.postMessage(undefined); }
    else queueMicrotask(run);
  }
  function pagePickUserElementOptions(value: unknown) { if (value === undefined) return {}; if (typeof value === 'string') return { message: value }; if (pageIsRecord(value)) return value; throw new Error('pickUserElement message must be a string or options object'); }
  function pageVisual() { return (globalThis as typeof globalThis & { __taberBrowserReplVisual?: { command?(command: unknown): unknown; highlightElement?(element: HTMLElement, state?: 'active' | 'success' | 'error'): void; pickUserElement?(options: unknown, cancelKey: string | undefined, summarize: (element: HTMLElement) => unknown): Promise<unknown> } }).__taberBrowserReplVisual; }
  function pageVisualHighlight(element: HTMLElement, state: 'active' | 'success' | 'error') { try { pageVisual()?.highlightElement?.(element, state); } catch { /* visual feedback must not block page actions */ } }
  function pageActionName(action: unknown) { if (!pageIsRecord(action)) return ''; const name = action.action ?? action.type; return typeof name === 'string' ? name : ''; }
  function pageActionTarget(action: Record<string, unknown>, name: string) {
    const target = action.target ?? action.selector;
    if (target === undefined) throw new Error(`${name} action requires selector or target`);
    return target;
  }
  function pageReadText(value: unknown, name: string) {
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
  }
  function pageSetValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }
  function pageIsRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
