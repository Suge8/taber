import type { BrowserReplPageCommand } from './browser-repl';

type ElementRef = { stableId: string; selector: string; tagName: string; name: string };

export function createBrowserReplUserScript(command: BrowserReplPageCommand) {
  if (command.helper === 'browserjs') return createBrowserJsScript(command.args[0], command.args[1]);
  return `(${runBrowserReplPageRuntime.toString()})(${safeJson(command)})`;
}

export function runBrowserReplPageRuntime(command: BrowserReplPageCommand, requestId?: string) {
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

  function normalizePageCommand(nextCommand: BrowserReplPageCommand) {
    return JSON.parse(JSON.stringify(nextCommand));
  }

  function browserReplPageMain(command: BrowserReplPageCommand) {
    const helpers = {
      observe: pageObserve,
      query: pageQuery,
      click: pageClick,
      fill: pageFill,
      press: pagePress,
      scroll: pageScroll,
      waitFor: pageWaitFor,
      pickElement: pagePickElement,
    };
    const helper = helpers[command.helper as keyof typeof helpers] as ((...args: unknown[]) => unknown) | undefined;
    const args = command.helper === 'waitFor' ? [...command.args, command.cancelKey] : command.args;
    return Promise.resolve().then(() => {
      if (!helper) throw new Error(`Unsupported browserRepl helper: ${command.helper}`);
      return helper(...args);
    }).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
    );
  }

  function pageObserve(options?: { scope?: 'page'; limit?: number }) {
    return { summary: pageSummary(), elements: pageCollectElements(undefined, options) };
  }

  function pageQuery(selector: string, options?: { scope?: 'page'; limit?: number }) {
    return { summary: pageSummary(), elements: pageCollectElements(selector, options) };
  }

  function pageSummary() {
    return {
      title: document.title,
      url: location.href,
      text: pageShortText(document.body?.innerText || ''),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    };
  }

  function pageClick(ref: ElementRef) {
    const element = pageResolveRef(ref) as HTMLElement;
    if (pageIsDisabled(element)) throw new Error('Element is disabled');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return { clicked: true, element: pageSummarizeElement(element, 1) };
  }

  function pageFill(ref: ElementRef, text: string) {
    const element = pageResolveRef(ref) as HTMLElement;
    if (pageIsDisabled(element)) throw new Error('Element is disabled');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) pageSetValue(element, text);
    else if (element instanceof HTMLSelectElement) pageSetValue(element, text);
    else if (element.isContentEditable) element.textContent = text;
    else throw new Error(`Element is not fillable: ${element.tagName.toLowerCase()}`);

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true, element: pageSummarizeElement(element, 1) };
  }

  function pagePress(ref: ElementRef | undefined, key: string) {
    const target = ref ? (pageResolveRef(ref) as HTMLElement) : (document.activeElement as HTMLElement | null);
    if (!target) throw new Error('No focused element for press()');
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    return { pressed: key, element: pageSummarizeElement(target, 1) };
  }

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
        if (pageMatchesWait(options)) complete();
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
      if (pageMatchesWait(options)) return complete();
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  function pageOnCancel(cancelKey: string | undefined, cancel: () => void) {
    const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage?(message: unknown): Promise<unknown>; onMessage?: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void } } } }).chrome?.runtime;
    if (!cancelKey || !runtime?.onMessage) return () => undefined;
    const listener = (message: unknown) => {
      if (isCancelMessage(message, cancelKey)) cancel();
    };
    runtime.onMessage.addListener(listener);
    runtime.sendMessage?.({ type: 'taber.browserRepl.isPageCommandCancelled', cancelKey }).then((cancelled: unknown) => {
      if (cancelled) cancel();
    }, () => undefined);
    return () => runtime.onMessage?.removeListener(listener);
  }

  function isCancelMessage(message: unknown, cancelKey: string) {
    return typeof message === 'object' && message !== null && (message as { type?: unknown; cancelKey?: unknown }).type === 'taber.browserRepl.cancelPageCommand' && (message as { cancelKey?: unknown }).cancelKey === cancelKey;
  }

  function pagePickElement(ref: ElementRef) {
    return pageSummarizeElement(pageResolveRef(ref), 1);
  }

  function pageCollectElements(selector?: string, options?: { scope?: 'page'; limit?: number }) {
    const query = selector ?? pageInteractiveSelector();
    const nodes = [...document.querySelectorAll(query)];
    const limit = options?.limit ?? 50;
    const scope = options?.scope ?? 'viewport';
    return nodes.filter((element) => element instanceof HTMLElement && pageIsVisible(element, scope)).slice(0, limit).map((element, offset) => pageSummarizeElement(element, offset + 1));
  }

  function pageSummarizeElement(element: Element, index: number) {
    const htmlElement = element as HTMLElement;
    const name = pageAccessibleName(htmlElement);
    const rect = htmlElement.getBoundingClientRect();
    const tagName = htmlElement.tagName.toLowerCase();
    return {
      index,
      tag: tagName,
      role: htmlElement.getAttribute('role') ?? pageImplicitRole(htmlElement),
      name,
      text: pageShortText(htmlElement.innerText || htmlElement.textContent || ''),
      value: pageElementValue(htmlElement),
      disabled: pageIsDisabled(htmlElement),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      ref: { stableId: pageStableId(htmlElement), selector: pageUniqueSelector(htmlElement), tagName, name },
    };
  }

  function pageResolveRef(ref: ElementRef) {
    const element = document.querySelector(ref.selector) as HTMLElement | null;
    if (!element) throw new Error(`Element is gone: ${ref.selector}`);
    if (element.tagName.toLowerCase() !== ref.tagName) throw new Error('Element changed before action');
    if (pageStableId(element) !== ref.stableId) throw new Error('Element changed before action');
    const currentName = pageAccessibleName(element);
    if (ref.name && currentName && ref.name !== currentName) throw new Error('Element changed before action');
    return element;
  }

  function pageMatchesWait(options: { selector?: string; text?: string }) {
    if (options.selector && !document.querySelector(options.selector)) return false;
    if (options.text && !document.body?.innerText.includes(options.text)) return false;
    return true;
  }

  function pageIsVisible(element: Element, scope: 'viewport' | 'page') {
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (scope === 'page') return true;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
  }

  function pageAccessibleName(element: HTMLElement) {
    const labels = element instanceof HTMLInputElement ? [...element.labels ?? []].map((label) => label.innerText).join(' ') : '';
    return pageShortText(element.getAttribute('aria-label') || labels || element.getAttribute('title') || element.getAttribute('placeholder') || element.innerText || element.textContent || '');
  }

  function pageStableId(element: HTMLElement) {
    return `${element.tagName.toLowerCase()}|${pageUniqueSelector(element)}|${pageAccessibleName(element)}`;
  }

  function pageUniqueSelector(element: HTMLElement) {
    const cssEscape = (globalThis.CSS && CSS.escape) || ((value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    if (element.id) return `#${cssEscape(element.id)}`;
    const parts: string[] = [];
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const tag = node.tagName.toLowerCase();
      const sameTagSiblings = [...(node.parentElement?.children ?? [])].filter((sibling) => sibling.tagName === node.tagName);
      parts.unshift(`${tag}:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`);
    }
    return `body > ${parts.join(' > ')}`;
  }

  function pageSetValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function pageElementValue(element: HTMLElement) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
    return undefined;
  }

  function pageIsDisabled(element: HTMLElement) {
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return element.disabled;
    return element.getAttribute('aria-disabled') === 'true';
  }

  function pageImplicitRole(element: HTMLElement) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return undefined;
  }

  function pageInteractiveSelector() {
    return 'a[href],button,input,select,textarea,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="tab"],[tabindex]:not([tabindex="-1"])';
  }

  function pageShortText(text: string) {
    return text.replace(/\s+/g, ' ').trim().slice(0, 120);
  }
}

function createBrowserJsScript(code: unknown, args: unknown) {
  if (typeof code !== 'string') throw new Error('browserjs code must be a string');
  return `(async () => {
    try {
      const args = ${safeJson(args)};
      const value = await (async (args, chrome, browser, runtime, extensionRuntime) => {
${code}
      })(args, undefined, undefined, undefined, undefined);
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  })()`;
}

function safeJson(value: unknown) {
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : json.replace(/</g, '\\u003c');
}
