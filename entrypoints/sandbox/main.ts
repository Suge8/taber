import { cloneBoundaryError, normalizeBrowserJsCode } from '../../lib/browser-repl-code.ts';
import { browserReplExecutionSources } from '../../lib/browser-repl-evaluation.ts';

type AsyncFunctionConstructor = (...parameters: string[]) => (...args: unknown[]) => Promise<unknown>;
type RunMessage = { type: 'taber.sandbox.run'; runId: string; code: string; helperNames: string[] };
type HelperResult = {
  type: 'taber.sandbox.helperResult';
  runId: string;
  helperId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

document.body.dataset.ready = 'true';
console.info('Taber sandbox ready');

window.addEventListener('message', (event: MessageEvent<RunMessage>) => {
  if (event.source !== window.parent || event.data?.type !== 'taber.sandbox.run') return;
  void runCode(event.data);
});

async function runCode(message: RunMessage) {
  try {
    const helperNames = message.helperNames.filter((name) => name !== 'sandbox');
    const helpers = Object.fromEntries(helperNames.map((name) => [name, createRemoteHelper(message.runId, name)]));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as AsyncFunctionConstructor;
    const names = [...helperNames, 'sandbox'];
    const values = [...helperNames.map((name) => helpers[name]), runNestedSandbox];
    const result = await compileBrowserRepl(AsyncFunction, names, message.code)(...values);
    postResult(message.runId, result);
  } catch (error) {
    postError(message.runId, stringifyError(error));
  }
}

function compileBrowserRepl(AsyncFunction: AsyncFunctionConstructor, names: string[], code: string) {
  let syntaxError: unknown;
  for (const source of browserReplExecutionSources(code)) {
    try {
      return AsyncFunction(...names, source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      syntaxError = error;
    }
  }
  throw syntaxError;
}

function createRemoteHelper(runId: string, name: string) {
  return (...args: unknown[]) => new Promise((resolve, reject) => {
    const helperId = crypto.randomUUID();
    const onMessage = (event: MessageEvent<HelperResult>) => {
      if (event.source !== window.parent || event.data?.type !== 'taber.sandbox.helperResult') return;
      if (event.data.runId !== runId || event.data.helperId !== helperId) return;
      window.removeEventListener('message', onMessage);
      if (event.data.ok) resolve(event.data.value);
      else reject(new Error(event.data.error ?? `Helper failed: ${name}`));
    };

    const helperArgs = normalizeHelperArgs(name, args);
    window.addEventListener('message', onMessage);
    try {
      window.parent.postMessage({ type: 'taber.sandbox.helper', runId, helperId, name, args: helperArgs }, '*');
    } catch (error) {
      window.removeEventListener('message', onMessage);
      reject(new Error(cloneBoundaryError(`browserRepl helper ${name} arguments`, error)));
    }
  });
}

function normalizeHelperArgs(name: string, args: unknown[]) {
  if (name !== 'browserjs') return args;
  return [normalizeBrowserJsCode(args[0]), args[1]];
}

function postResult(runId: string, value: unknown) {
  try {
    window.parent.postMessage({ type: 'taber.sandbox.result', runId, value }, '*');
  } catch (error) {
    postError(runId, cloneBoundaryError('browserRepl return value', error));
  }
}

function postError(runId: string, error: string) {
  window.parent.postMessage({ type: 'taber.sandbox.error', runId, error }, '*');
}

async function runNestedSandbox(code: string, args?: unknown) {
  if (typeof code !== 'string') throw new Error('sandbox code must be a string');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', `"use strict";\n${code}`)(args);
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
