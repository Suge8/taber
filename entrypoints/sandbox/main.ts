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
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const names = [...helperNames, 'sandbox'];
    const values = [...helperNames.map((name) => helpers[name]), runNestedSandbox];
    const result = await new AsyncFunction(...names, `"use strict";\n${message.code}`)(...values);
    window.parent.postMessage({ type: 'taber.sandbox.result', runId: message.runId, value: result }, '*');
  } catch (error) {
    window.parent.postMessage({ type: 'taber.sandbox.error', runId: message.runId, error: stringifyError(error) }, '*');
  }
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

    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'taber.sandbox.helper', runId, helperId, name, args }, '*');
  });
}

async function runNestedSandbox(code: string, args?: unknown) {
  if (typeof code !== 'string') throw new Error('sandbox code must be a string');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('args', `"use strict";\n${code}`)(args);
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
