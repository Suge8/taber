export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

export function hasCdpEndpoint(target) {
  return typeof target.webSocketDebuggerUrl === 'string' && target.webSocketDebuggerUrl.length > 0;
}

export function connectTarget(target) {
  if (!hasCdpEndpoint(target)) {
    throw new Error(`Missing CDP websocket URL for target ${target.id ?? '<unknown>'} (${target.type ?? '<unknown>'})`);
  }
  return connectCdp(target.webSocketDebuggerUrl);
}

export async function connectCdp(webSocketUrl) {
  if (typeof webSocketUrl !== 'string' || webSocketUrl.length === 0) throw new Error('Missing CDP websocket URL');

  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  let closed = false;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('CDP websocket failed to open'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('CDP websocket closed before open'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) {
      const methodListeners = listeners.get(message.method);
      if (methodListeners) for (const listener of [...methodListeners]) listener(message.params ?? {});
      return;
    }
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('error', () => rejectPending(new Error('CDP websocket error')));
  socket.addEventListener('close', () => rejectPending(new Error('CDP websocket closed')));

  return {
    send(method, params = {}) {
      if (closed || socket.readyState !== 1) return Promise.reject(new Error('CDP websocket is not open'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? new Set();
      methodListeners.add(listener);
      listeners.set(method, methodListeners);
      return () => {
        methodListeners.delete(listener);
        if (methodListeners.size === 0) listeners.delete(method);
      };
    },
    close() {
      rejectPending(new Error('CDP websocket closed by client'));
      socket.close();
    },
  };

  function rejectPending(error) {
    closed = true;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
}

export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime.evaluate failed');
  }
  return result.result.value;
}

export async function evaluateStable(cdp, expression) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await evaluate(cdp, expression);
    } catch (error) {
      if (!String(error).includes('Execution context was destroyed')) throw error;
      await delay(100);
    }
  }
  throw new Error('Runtime.evaluate kept losing its execution context');
}

export function readTargets(cdpOrigin) {
  return fetchJson(`${cdpOrigin}/json/list`);
}

export async function waitForTarget(cdpOrigin, match, timeoutMs = 10000) {
  return waitFor(async () => (await readTargets(cdpOrigin)).find(match), timeoutMs, 'Timed out waiting for target');
}

export async function waitFor(read, timeoutMs = 10000, errorMessage = 'Timed out waiting for value') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(errorMessage);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
