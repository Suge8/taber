export type BrowserReplVisualCommand = { action: 'install' | 'show' | 'hide'; message?: string; iconUrl?: string };

export function createBrowserReplVisualScript() {
  return `(${runTaberPageOverlayCommand.toString()})({ action: 'install' });`;
}

export function runTaberPageOverlayCommand(command: BrowserReplVisualCommand) {
  type HighlightState = 'active' | 'success' | 'error';
  type PickOptions = { message?: string; timeoutMs?: number };
  type VisualRuntime = {
    command(command: BrowserReplVisualCommand): unknown;
    highlightElement(element: HTMLElement, state?: HighlightState): void;
    isVisualElement(element: Element): boolean;
    pickUserElement(options: PickOptions, cancelKey: string | undefined, summarize: (element: HTMLElement) => unknown): Promise<unknown>;
  };

  const key = '__taberBrowserReplVisual';
  const rootId = 'taber-page-control-overlay';
  const defaultOverlayMessage = 'Taber 正在控制此页';
  const runtime = ((globalThis as Record<string, unknown>)[key] as VisualRuntime | undefined) ?? createRuntime();
  (globalThis as Record<string, unknown>)[key] = runtime;
  return runtime.command(command);

  function createRuntime(): VisualRuntime {
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let overlayVisible = false;

    function runCommand(nextCommand: BrowserReplVisualCommand) {
      if (nextCommand.action === 'install') return { installed: true };
      if (nextCommand.action === 'hide') return hideOverlay();
      if (nextCommand.action === 'show') return showOverlay(nextCommand.message, nextCommand.iconUrl);
      throw new Error(`Unsupported Taber overlay action: ${String((nextCommand as { action?: unknown }).action)}`);
    }

    function showOverlay(message?: string, iconUrl?: string) {
      overlayVisible = true;
      clearHideTimer();
      const root = ensureRoot();
      const entering = !root.querySelector('[data-taber-part="edge"]');
      const edge = part(root, 'edge');
      const glow = part(root, 'glow');
      const badge = part(root, 'badge');
      setBadgeContent(badge, message || defaultOverlayMessage, iconUrl);
      setOverlayVisible(edge, glow, badge, !entering);
      if (entering) nextFrame(() => { if (overlayVisible && document.getElementById(rootId) === root) setOverlayVisible(edge, glow, badge, true); });
      return { shown: true };
    }

    function hideOverlay() {
      overlayVisible = false;
      const root = document.getElementById(rootId) as HTMLElement | null;
      if (!root) return { hidden: true };
      clearHideTimer();
      const edge = root.querySelector('[data-taber-part="edge"]') as HTMLElement | null;
      const glow = root.querySelector('[data-taber-part="glow"]') as HTMLElement | null;
      const badge = root.querySelector('[data-taber-part="badge"]') as HTMLElement | null;
      if (edge && glow && badge) setOverlayVisible(edge, glow, badge, false);
      hideTimer = setTimeout(() => {
        if (!overlayVisible && document.getElementById(rootId) === root) root.remove();
        hideTimer = undefined;
      }, 240);
      return { hidden: true };
    }

    function clearHideTimer() {
      if (hideTimer === undefined) return;
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }

    function setBadgeContent(badge: HTMLElement, message: string, commandIconUrl?: string) {
      const icon = part(badge, 'badge-icon');
      const text = part(badge, 'badge-text');
      const iconUrl = commandIconUrl || extensionIconUrl();
      icon.setAttribute('style', 'display:inline-flex;width:20px;height:20px;align-items:center;justify-content:center;flex:0 0 auto;border-radius:7px;background:linear-gradient(135deg,rgba(255,255,255,.24),rgba(255,255,255,.08));box-shadow:inset 0 0 0 1px rgba(255,255,255,.2),0 5px 14px rgba(0,0,0,.18);overflow:hidden;color:white;font:700 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;');
      text.textContent = message;
      text.setAttribute('style', 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 1px rgba(0,0,0,.18);');
      if (!iconUrl) {
        icon.textContent = 'T';
        return;
      }
      icon.textContent = '';
      const image = part(icon, 'badge-icon-image', 'img') as HTMLImageElement;
      image.alt = '';
      image.src = iconUrl;
      image.draggable = false;
      image.setAttribute('alt', '');
      image.setAttribute('src', iconUrl);
      image.setAttribute('style', 'width:15px;height:15px;display:block;object-fit:contain;filter:drop-shadow(0 1px 1px rgba(0,0,0,.18));');
    }

    function extensionIconUrl() {
      const getURL = (globalThis as typeof globalThis & { chrome?: { runtime?: { getURL?(path: string): string } } }).chrome?.runtime?.getURL;
      try {
        return getURL?.('/icons/icon-24.png');
      } catch {
        return undefined;
      }
    }

    function setOverlayVisible(edge: HTMLElement, glow: HTMLElement, badge: HTMLElement, visible: boolean) {
      edge.setAttribute('style', `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;box-shadow:inset 0 0 0 2px rgba(125,144,255,.60),inset 0 0 0 5px rgba(103,232,249,.16),inset 0 0 64px rgba(129,140,248,.36),inset 0 0 140px rgba(147,197,253,.18);opacity:${visible ? '1' : '0'};filter:blur(${visible ? '0' : '2px'});transition:opacity 220ms cubic-bezier(.2,0,0,1),filter 220ms cubic-bezier(.2,0,0,1);`);
      glow.setAttribute('style', `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;background:linear-gradient(to bottom,rgba(147,197,253,.34),rgba(191,219,254,.16) 24px,transparent 82px) top left/100vw 92px no-repeat,linear-gradient(to top,rgba(165,180,252,.28),rgba(199,210,254,.13) 24px,transparent 82px) bottom left/100vw 92px no-repeat,linear-gradient(to right,rgba(147,197,253,.30),rgba(191,219,254,.13) 28px,transparent 92px) top left/104px 100vh no-repeat,linear-gradient(to left,rgba(165,180,252,.30),rgba(103,232,249,.12) 28px,transparent 92px) top right/104px 100vh no-repeat;opacity:${visible ? '1' : '0'};filter:blur(${visible ? '0' : '2px'});transition:opacity 240ms cubic-bezier(.2,0,0,1),filter 240ms cubic-bezier(.2,0,0,1);`);
      badge.setAttribute('style', `position:fixed;top:12px;right:12px;display:flex;align-items:center;gap:7px;max-width:min(320px,calc(100vw - 24px));min-height:28px;padding:5px 10px 5px 6px;border-radius:999px;background:linear-gradient(135deg,rgba(26,28,48,.86),rgba(18,19,33,.76));color:white;font:500 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.01em;box-shadow:0 12px 32px rgba(18,18,35,.24),inset 0 0 0 1px rgba(255,255,255,.18);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);opacity:${visible ? '.98' : '0'};transform:translateY(${visible ? '0' : '-6px'}) scale(${visible ? '1' : '.98'});filter:blur(${visible ? '0' : '2px'});transition:opacity 220ms cubic-bezier(.2,0,0,1),transform 220ms cubic-bezier(.2,0,0,1),filter 220ms cubic-bezier(.2,0,0,1);`);
    }

    function nextFrame(callback: () => void) {
      const requestFrame = (globalThis as { requestAnimationFrame?: (callback: () => void) => number }).requestAnimationFrame;
      if (typeof requestFrame === 'function') requestFrame(callback);
      else setTimeout(callback, 16);
    }

    function highlightElement(element: HTMLElement, state: HighlightState = 'active') {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const target = part(ensureRoot(), 'target');
      const color = state === 'error' ? '239,68,68' : state === 'success' ? '34,197,94' : '99,102,241';
      target.setAttribute('style', `position:fixed;left:${Math.round(rect.left)}px;top:${Math.round(rect.top)}px;width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;border-radius:8px;pointer-events:none;opacity:1;transform:scale(1);transition:opacity 220ms cubic-bezier(.2,0,0,1),transform 220ms cubic-bezier(.2,0,0,1),filter 220ms cubic-bezier(.2,0,0,1);box-shadow:0 0 0 2px rgba(${color},.78),0 0 0 7px rgba(${color},.16);filter:drop-shadow(0 8px 22px rgba(${color},.18));`);
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        target.style.opacity = '0';
        target.style.transform = 'scale(.985)';
      }, state === 'active' ? 520 : 900);
    }

    function pickUserElement(options: PickOptions, cancelKey: string | undefined, summarize: (element: HTMLElement) => unknown) {
      const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0 ? Math.min(Number(options.timeoutMs), 120_000) : 30_000;
      return new Promise((resolve, reject) => {
        let settled = false;
        const prompt = part(ensureRoot(), 'picker');
        prompt.textContent = options.message || '点击页面上的元素供 Taber 使用，按 Esc 取消';
        prompt.setAttribute('style', 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:8px 11px;border-radius:12px;background:rgba(20,22,38,.78);color:white;font:500 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 30px rgba(18,18,35,.22),inset 0 0 0 1px rgba(255,255,255,.16);backdrop-filter:blur(10px);opacity:.98;transition:opacity 160ms cubic-bezier(.2,0,0,1),transform 160ms cubic-bezier(.2,0,0,1);');
        const cleanupCancel = onCancel(cancelKey, () => finish(undefined, new Error('pickUserElement cancelled')));
        const timeoutId = setTimeout(() => finish(undefined, new Error(`pickUserElement timed out after ${timeoutMs}ms`)), timeoutMs);
        const move = (event: Event) => { const element = eventElement(event); if (element) highlightElement(element, 'active'); };
        const click = (event: Event) => {
          const element = eventElement(event);
          if (!element) return;
          event.preventDefault();
          event.stopPropagation();
          (event as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation?.();
          highlightElement(element, 'success');
          finish(summarize(element));
        };
        const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(undefined, new Error('pickUserElement cancelled')); };
        document.addEventListener('mousemove', move, true);
        document.addEventListener('mouseover', move, true);
        document.addEventListener('click', click, true);
        document.addEventListener('keydown', keydown, true);

        function finish(value?: unknown, error?: Error) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          cleanupCancel();
          document.removeEventListener('mousemove', move, true);
          document.removeEventListener('mouseover', move, true);
          document.removeEventListener('click', click, true);
          document.removeEventListener('keydown', keydown, true);
          prompt.remove();
          if (error) reject(error); else resolve(value);
        }
      });
    }

    function eventElement(event: Event) {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const target = path.find((item) => item instanceof HTMLElement) ?? event.target;
      return target instanceof HTMLElement && !isVisualElement(target) ? target : undefined;
    }

    function onCancel(cancelKey: string | undefined, cancel: () => void) {
      const runtime = (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage?(message: unknown): Promise<unknown>; onMessage?: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void } } } }).chrome?.runtime;
      if (!cancelKey || !runtime?.onMessage) return () => undefined;
      const listener = (message: unknown) => { if (typeof message === 'object' && message !== null && (message as { type?: unknown; cancelKey?: unknown }).type === 'taber.browserRepl.cancelPageCommand' && (message as { cancelKey?: unknown }).cancelKey === cancelKey) cancel(); };
      runtime.onMessage.addListener(listener);
      runtime.sendMessage?.({ type: 'taber.browserRepl.isPageCommandCancelled', cancelKey }).then((cancelled: unknown) => { if (cancelled) cancel(); }, () => undefined);
      return () => runtime.onMessage?.removeListener(listener);
    }

    function part(root: HTMLElement, name: string, tagName = 'div') {
      const selector = `[data-taber-part="${name}"]`;
      let element = root.querySelector(selector) as HTMLElement | null;
      if (element && element.tagName.toLowerCase() !== tagName) {
        element.remove();
        element = null;
      }
      if (!element) {
        element = document.createElement(tagName);
        element.setAttribute('data-taber-part', name);
        root.append(element);
      }
      return element;
    }

    function ensureRoot() {
      let root = document.getElementById(rootId) as HTMLElement | null;
      if (!root) {
        root = document.createElement('div');
        root.id = rootId;
        root.setAttribute('aria-hidden', 'true');
        root.setAttribute('style', 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;contain:layout style paint;');
        (document.documentElement || document.body).append(root);
      }
      return root;
    }

    function isVisualElement(element: Element) {
      for (let node: Element | null = element; node; node = node.parentElement) if (node.id === rootId) return true;
      return false;
    }

    return { command: runCommand, highlightElement, isVisualElement, pickUserElement };
  }
}
