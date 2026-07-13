import { browser } from 'wxt/browser';
import { cloneBoundaryError } from './browser-repl-code.ts';
import type { BrowserReplHelper, BrowserReplSandboxRun } from './browser-repl';

type SandboxMessage =
  | { type: 'taber.sandbox.result'; runId: string; value: unknown }
  | { type: 'taber.sandbox.error'; runId: string; error: string }
  | { type: 'taber.sandbox.helper'; runId: string; helperId: string; name: string; args: unknown[] };

export function runBrowserReplInSandbox(run: BrowserReplSandboxRun) {
  if (run.abortSignal?.aborted) return Promise.reject(new Error('Task aborted'));

  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';

  return new Promise<unknown>((resolve, reject) => {
    const runId = crypto.randomUUID();

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      run.abortSignal?.removeEventListener('abort', onAbort);
      iframe.remove();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(new Error('Task aborted'));
    const onMessage = (event: MessageEvent<SandboxMessage>) => {
      if (event.source !== iframe.contentWindow || event.data?.runId !== runId) return;
      if (event.data.type === 'taber.sandbox.result') {
        cleanup();
        resolve(event.data.value);
        return;
      }
      if (event.data.type === 'taber.sandbox.error') {
        fail(new Error(event.data.error));
        return;
      }
      if (event.data.type === 'taber.sandbox.helper') {
        void answerHelper(iframe.contentWindow, run.helpers, event.data);
      }
    };

    window.addEventListener('message', onMessage);
    run.abortSignal?.addEventListener('abort', onAbort, { once: true });
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage({ type: 'taber.sandbox.run', runId, code: run.code, helperNames: Object.keys(run.helpers) }, '*');
    }, { once: true });
    iframe.src = browser.runtime.getURL('/sandbox.html');
    document.body.append(iframe);
  });
}

async function answerHelper(target: Window | null, helpers: Record<string, BrowserReplHelper>, message: Extract<SandboxMessage, { type: 'taber.sandbox.helper' }>) {
  if (!target) return;
  const helper = helpers[message.name];
  if (!helper) {
    target.postMessage({ type: 'taber.sandbox.helperResult', runId: message.runId, helperId: message.helperId, ok: false, error: `Unknown helper: ${message.name}` }, '*');
    return;
  }

  try {
    const value = await helper(...message.args);
    postHelperResult(target, message, { ok: true, value });
  } catch (error) {
    postHelperResult(target, message, { ok: false, error: cloneBoundaryError(`browserRepl helper ${message.name} result`, error) });
  }
}

function postHelperResult(target: Window, message: Extract<SandboxMessage, { type: 'taber.sandbox.helper' }>, result: { ok: true; value: unknown } | { ok: false; error: string }) {
  try {
    target.postMessage({ type: 'taber.sandbox.helperResult', runId: message.runId, helperId: message.helperId, ...result }, '*');
  } catch (error) {
    target.postMessage({ type: 'taber.sandbox.helperResult', runId: message.runId, helperId: message.helperId, ok: false, error: cloneBoundaryError(`browserRepl helper ${message.name} result`, error) }, '*');
  }
}
