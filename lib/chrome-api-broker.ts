export const chromeApiRequestType = 'taber.chromeApi.request';

export type ChromeApiAction =
  | 'tabs.query'
  | 'tabs.get'
  | 'tabs.create'
  | 'tabs.update'
  | 'tabs.remove'
  | 'scripting.executeScript'
  | 'userScripts.execute'
  | 'debugger.attach'
  | 'debugger.detach'
  | 'debugger.sendCommand';

export type ChromeApiRequest = {
  type: typeof chromeApiRequestType;
  action: ChromeApiAction;
  args?: unknown[];
};

type CallableChromeApi = {
  tabs: Record<'query' | 'get' | 'create' | 'update' | 'remove', (...args: never[]) => Promise<unknown>>;
  scripting: { executeScript(...args: never[]): Promise<unknown> };
  userScripts: { execute(...args: never[]): Promise<unknown> };
  debugger: Record<'attach' | 'detach' | 'sendCommand', (...args: never[]) => Promise<unknown>>;
};

export function createChromeApiBroker(chromeApi: CallableChromeApi) {
  return async function handleChromeApiRequest(message: unknown) {
    if (!isChromeApiRequest(message)) return undefined;
    const args = (message.args ?? []) as never[];

    switch (message.action) {
      case 'tabs.query':
        return chromeApi.tabs.query(...args);
      case 'tabs.get':
        return chromeApi.tabs.get(...args);
      case 'tabs.create':
        return chromeApi.tabs.create(...args);
      case 'tabs.update':
        return chromeApi.tabs.update(...args);
      case 'tabs.remove':
        return chromeApi.tabs.remove(...args);
      case 'scripting.executeScript':
        return chromeApi.scripting.executeScript(...args);
      case 'userScripts.execute':
        return chromeApi.userScripts.execute(...args);
      case 'debugger.attach':
        return chromeApi.debugger.attach(...args);
      case 'debugger.detach':
        return chromeApi.debugger.detach(...args);
      case 'debugger.sendCommand':
        return chromeApi.debugger.sendCommand(...args);
      default:
        return assertNever(message.action);
    }
  };
}

export function isChromeApiRequest(message: unknown): message is ChromeApiRequest {
  if (!isRecord(message) || message.type !== chromeApiRequestType || typeof message.action !== 'string') return false;
  if ('args' in message && !Array.isArray(message.args)) return false;
  return chromeApiActions.includes(message.action as ChromeApiAction);
}

export function isTrustedChromeApiSender(sender: unknown, extensionId: string) {
  if (!isRecord(sender) || sender.id !== extensionId) return false;
  const url = typeof sender.url === 'string' ? sender.url : typeof sender.origin === 'string' ? sender.origin : '';
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'chrome-extension:' && parsed.hostname === extensionId;
  } catch {
    return false;
  }
}

const chromeApiActions: ChromeApiAction[] = [
  'tabs.query',
  'tabs.get',
  'tabs.create',
  'tabs.update',
  'tabs.remove',
  'scripting.executeScript',
  'userScripts.execute',
  'debugger.attach',
  'debugger.detach',
  'debugger.sendCommand',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Chrome API action: ${String(value)}`);
}
