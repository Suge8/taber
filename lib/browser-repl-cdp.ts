import type { BrowserReplPageCommand } from './browser-repl';
import type { ChromeApiAction } from './chrome-api-broker';

type CallChromeApi = (action: ChromeApiAction, args: unknown[]) => Promise<unknown>;
type RunPageCommand = (command: BrowserReplPageCommand) => Promise<unknown>;

type Debuggee = { tabId: number };
type Point = { x: number; y: number };

export function canUseCdpFallback(command: BrowserReplPageCommand, error: unknown) {
  if (command.helper !== 'click' && command.helper !== 'fill' && command.helper !== 'press') return false;
  const message = error instanceof Error ? error.message : String(error);
  return !/disabled|gone|changed|not fillable/i.test(message);
}

export async function executeBrowserReplCdpFallback(options: {
  tabId: number;
  command: BrowserReplPageCommand;
  runPageCommand: RunPageCommand;
  callChromeApi: CallChromeApi;
  abortSignal?: AbortSignal;
}) {
  const debuggee = { tabId: options.tabId };
  const callChromeApi = (action: ChromeApiAction, args: unknown[]) => abortable(() => options.callChromeApi(action, args), options.abortSignal);
  await attachDebugger(debuggee, options.callChromeApi, options.abortSignal);
  try {
    if (options.command.helper === 'click') return await click(debuggee, options.command, { ...options, callChromeApi });
    if (options.command.helper === 'fill') return await fill(debuggee, options.command, { ...options, callChromeApi });
    if (options.command.helper === 'press') return await press(debuggee, options.command, { ...options, callChromeApi });
    throw new Error(`Unsupported CDP fallback: ${options.command.helper}`);
  } finally {
    await options.callChromeApi('debugger.detach', [debuggee]).catch(() => undefined);
  }
}

async function attachDebugger(debuggee: Debuggee, callChromeApi: CallChromeApi, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) throw new Error('Task aborted');
  let aborted = false;
  const abort = () => {
    aborted = true;
  };
  abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    await callChromeApi('debugger.attach', [debuggee, '1.3']);
    if (aborted || abortSignal?.aborted) {
      await callChromeApi('debugger.detach', [debuggee]).catch(() => undefined);
      throw new Error('Task aborted');
    }
  } finally {
    abortSignal?.removeEventListener('abort', abort);
  }
}

async function click(debuggee: Debuggee, command: BrowserReplPageCommand, options: { runPageCommand: RunPageCommand; callChromeApi: CallChromeApi }) {
  const point = await elementCenter(command.args[0], options.runPageCommand);
  await mouseClick(debuggee, point, options.callChromeApi);
  return { clicked: true, fallback: 'cdp' };
}

async function fill(debuggee: Debuggee, command: BrowserReplPageCommand, options: { runPageCommand: RunPageCommand; callChromeApi: CallChromeApi }) {
  const element = await readElement(command.args[0], options.runPageCommand);
  if (element.tag === 'select') {
    await options.runPageCommand({ helper: 'fill', args: command.args });
    return { filled: true, fallback: 'cdp' };
  }

  const point = pointFromElement(element);
  await mouseClick(debuggee, point, options.callChromeApi);
  await selectAll(debuggee, options.callChromeApi);
  await options.callChromeApi('debugger.sendCommand', [debuggee, 'Input.insertText', { text: String(command.args[1] ?? '') }]);
  return { filled: true, fallback: 'cdp' };
}

async function press(debuggee: Debuggee, command: BrowserReplPageCommand, options: { runPageCommand: RunPageCommand; callChromeApi: CallChromeApi }) {
  if (command.args[0]) await mouseClick(debuggee, await elementCenter(command.args[0], options.runPageCommand), options.callChromeApi);
  const key = String(command.args[1] ?? '');
  await keyEvent(debuggee, 'keyDown', key, options.callChromeApi);
  await keyEvent(debuggee, 'keyUp', key, options.callChromeApi);
  return { pressed: key, fallback: 'cdp' };
}

async function elementCenter(ref: unknown, runPageCommand: RunPageCommand): Promise<Point> {
  return pointFromElement(await readElement(ref, runPageCommand));
}

async function readElement(ref: unknown, runPageCommand: RunPageCommand) {
  const element = await runPageCommand({ helper: 'pickElement', args: [ref] });
  if (!isRecord(element) || !isRecord(element.rect)) throw new Error('CDP fallback could not read element rect');
  return element;
}

function pointFromElement(element: Record<string, unknown>): Point {
  const rect = element.rect as Record<string, unknown>;
  const x = Number(rect.x) + Number(rect.width) / 2;
  const y = Number(rect.y) + Number(rect.height) / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('CDP fallback received invalid element rect');
  return { x, y };
}

async function mouseClick(debuggee: Debuggee, point: Point, callChromeApi: CallChromeApi) {
  const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
  await callChromeApi('debugger.sendCommand', [debuggee, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }]);
  await callChromeApi('debugger.sendCommand', [debuggee, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }]);
}

async function selectAll(debuggee: Debuggee, callChromeApi: CallChromeApi) {
  const event = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
  await callChromeApi('debugger.sendCommand', [debuggee, 'Input.dispatchKeyEvent', { ...event, type: 'keyDown' }]);
  await callChromeApi('debugger.sendCommand', [debuggee, 'Input.dispatchKeyEvent', { ...event, type: 'keyUp' }]);
}

function keyEvent(debuggee: Debuggee, type: 'keyDown' | 'keyUp', key: string, callChromeApi: CallChromeApi) {
  return callChromeApi('debugger.sendCommand', [debuggee, 'Input.dispatchKeyEvent', { type, key }]);
}

function abortable<T>(run: () => Promise<T>, abortSignal?: AbortSignal) {
  if (abortSignal?.aborted) return Promise.reject(new Error('Task aborted'));
  const promise = run();
  if (!abortSignal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Task aborted'));
    abortSignal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => abortSignal.removeEventListener('abort', abort));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
