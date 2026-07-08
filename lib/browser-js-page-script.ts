import { jsonLiteralForInjectedCode, normalizeBrowserJsCode } from './browser-repl-code.ts';

export function createBrowserJsScript(code: unknown, args: unknown) {
  const normalizedCode = normalizeBrowserJsCode(code);
  const argsJson = jsonLiteralForInjectedCode(args, 'browserjs args');
  const userCodeJson = jsonLiteralForInjectedCode(`'use strict';\n${normalizedCode}`, 'browserjs code');
  return `(async () => {
    const consoleCapture = captureConsole();
    try {
      const runUserCode = createBrowserJsUserFunction(${userCodeJson});
      const navigationGuard = createNavigationGuard();
      try {
        const args = ${argsJson};
        const value = await runUserCode.call(navigationGuard.window, args, undefined, undefined, undefined, undefined, navigationGuard.location, navigationGuard.history, navigationGuard.open, navigationGuard.window, navigationGuard.window, navigationGuard.window, navigationGuard.window, navigationGuard.window, navigationGuard.document, navigationGuard.window, navigationGuard.Function, navigationGuard.setTimeout, navigationGuard.setInterval, navigationGuard.addEventListener, navigationGuard.removeEventListener, navigationGuard.dispatchEvent, navigationGuard.requestAnimationFrame, navigationGuard.cancelAnimationFrame, navigationGuard.requestIdleCallback, navigationGuard.cancelIdleCallback, navigationGuard.queueMicrotask, navigationGuard.Promise, navigationGuard.blockNavigation, navigationGuard.domConstructor, navigationGuard.domConstructor, navigationGuard.domConstructor, navigationGuard.domConstructor, navigationGuard.blockNavigation, navigationGuard.blockNavigation, { restore: navigationGuard.blockNavigation }, navigationGuard.blockNavigation, { restore: navigationGuard.blockNavigation });
        assertSerializable(value);
        return { ok: true, value, console: consoleCapture.entries };
      } finally {
        navigationGuard.restore();
      }
    } catch (error) {
      return { ok: false, error: formatBrowserJsError(error, consoleCapture.entries), console: consoleCapture.entries };
    } finally {
      consoleCapture.restore();
    }
    function createBrowserJsUserFunction(body) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return AsyncFunction('args', 'chrome', 'browser', 'runtime', 'extensionRuntime', 'location', 'history', 'open', 'window', 'self', 'top', 'parent', 'frames', 'document', 'globalThis', 'Function', 'setTimeout', 'setInterval', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask', 'Promise', 'MutationObserver', 'Node', 'Element', 'HTMLElement', 'HTMLBodyElement', '__defineGetter__', '__defineSetter__', 'navigationGuard', 'createNavigationGuard', 'consoleCapture', body);
    }
    function createNavigationGuard() {
      const root = typeof window === 'undefined' ? globalThis : window;
      const windowCache = new WeakMap();
      const documentCache = new WeakMap();
      const objectCache = new WeakMap();
      const callbackCache = new WeakMap();
      const listenerCache = new WeakMap();
      const nativeFunctionToString = Function.prototype.toString;
      let windowProxy;
      let documentProxy;
      let promiseProxy;
      const locationProxy = new Proxy({}, {
        get(_target, prop) {
          if (isLocationMethod(prop)) return blockNavigation;
          if (prop === Symbol.toPrimitive || prop === 'toString') return () => String(root.location?.href ?? '');
          if (isObjectEscapeProperty(prop)) return blockNavigation;
          if (prop === 'valueOf') return () => locationProxy;
          return guardValue(safeGetProperty(root.location, prop), root.location);
        },
        set() { throw navigationError(); },
        defineProperty() { throw navigationError(); },
        deleteProperty() { throw navigationError(); },
        getPrototypeOf() { return Object.prototype; },
      });
      const historyProxy = new Proxy({}, {
        get(_target, prop) {
          if (isHistoryMethod(prop)) return blockNavigation;
          if (isObjectEscapeProperty(prop)) return blockNavigation;
          if (prop === 'valueOf') return () => historyProxy;
          return guardValue(safeGetProperty(root.history, prop), root.history);
        },
        set() { throw navigationError(); },
        defineProperty() { throw navigationError(); },
        deleteProperty() { throw navigationError(); },
        getPrototypeOf() { return Object.prototype; },
      });
      windowProxy = wrapWindow(root);
      documentProxy = root.document ? wrapDocument(root.document) : undefined;
      promiseProxy = wrapPromise(root.Promise);
      const domConstructor = new Proxy(function () {}, { get: blockNavigation, apply: blockNavigation, construct: blockNavigation });
      const dynamicCodeGuard = installDynamicCodeGuard();
      return { location: locationProxy, history: historyProxy, open: blockNavigation, window: windowProxy, document: documentProxy, Function: blockDynamicCode, setTimeout: guardedTimer(root.setTimeout), setInterval: guardedTimer(root.setInterval), addEventListener: guardedWindowProperty(root, 'addEventListener', windowProxy), removeEventListener: guardedWindowProperty(root, 'removeEventListener', windowProxy), dispatchEvent: guardedDispatchEvent(root.dispatchEvent, root), requestAnimationFrame: guardedWindowProperty(root, 'requestAnimationFrame', windowProxy), cancelAnimationFrame: guardedWindowProperty(root, 'cancelAnimationFrame', windowProxy), requestIdleCallback: guardedIdleCallback(root.requestIdleCallback), cancelIdleCallback: guardedWindowProperty(root, 'cancelIdleCallback', windowProxy), queueMicrotask: guardedMicrotask(root.queueMicrotask), Promise: promiseProxy, blockNavigation, domConstructor, restore: dynamicCodeGuard.restore };

      function wrapWindow(value) {
        if (!value || typeof value !== 'object') return value;
        if (windowCache.has(value)) return windowCache.get(value);
        const proxy = new Proxy({}, {
          get(_target, prop) {
            return guardedWindowProperty(value, prop, proxy);
          },
          set(_target, prop, nextValue) {
            if (prop === 'location' || isPrototypeMutationProperty(prop)) throw navigationError();
            return safeSetProperty(value, prop, nextValue);
          },
          defineProperty(_target, prop, descriptor) {
            if (prop === 'location' || prop === 'history' || prop === 'open' || isPrototypeMutationProperty(prop)) throw navigationError();
            return Reflect.defineProperty(value, prop, safeDescriptor(descriptor));
          },
          setPrototypeOf() { throw navigationError(); },
          deleteProperty(_target, prop) {
            if (prop === 'location' || prop === 'history' || prop === 'open') throw navigationError();
            return Reflect.deleteProperty(value, prop);
          },
          getOwnPropertyDescriptor(_target, prop) {
            return guardedDescriptor(prop, Reflect.getOwnPropertyDescriptor(value, prop), value, proxy);
          },
          ownKeys() {
            return uniqueKeys([...Reflect.ownKeys(value), 'location', 'history', 'open', 'document', 'frames', 'eval', 'Function', 'setTimeout', 'setInterval', 'requestIdleCallback', 'cancelIdleCallback', 'queueMicrotask', 'Promise', 'MutationObserver']);
          },
          getPrototypeOf() { return Object.prototype; },
          has(_target, prop) { return isGuardedWindowProp(prop) || prop in value; },
        });
        windowCache.set(value, proxy);
        return proxy;
      }
      function wrapDocument(value) {
        if (!value || typeof value !== 'object') return value;
        if (documentCache.has(value)) return documentCache.get(value);
        const proxy = new Proxy({}, {
          get(_target, prop) {
            if (prop === 'defaultView') return windowProxy;
            if (prop === 'location') return locationProxy;
            if (prop === 'dispatchEvent') return guardedDispatchEvent(value.dispatchEvent, value);
            if (isDefineAccessorProperty(prop) || prop === 'constructor' || prop === '__proto__') return blockNavigation;
            if (prop === '__lookupGetter__') return (name) => guardedDescriptor(name, Reflect.getOwnPropertyDescriptor(value, name), value, proxy)?.get;
            if (prop === '__lookupSetter__') return (name) => guardedDescriptor(name, Reflect.getOwnPropertyDescriptor(value, name), value, proxy)?.set;
            return guardValue(safeGetProperty(value, prop), value);
          },
          set(_target, prop, nextValue) {
            if (prop === 'location' || isPrototypeMutationProperty(prop)) throw navigationError();
            return safeSetProperty(value, prop, nextValue);
          },
          defineProperty(_target, prop, descriptor) {
            if (prop === 'location' || isPrototypeMutationProperty(prop)) throw navigationError();
            return Reflect.defineProperty(value, prop, safeDescriptor(descriptor));
          },
          setPrototypeOf() { throw navigationError(); },
          getOwnPropertyDescriptor(_target, prop) {
            if (prop === 'defaultView') return valueDescriptor(windowProxy);
            if (prop === 'location') return valueDescriptor(locationProxy);
            return guardedDescriptor(prop, Reflect.getOwnPropertyDescriptor(value, prop), value, proxy);
          },
          ownKeys() { return uniqueKeys([...Reflect.ownKeys(value), 'defaultView', 'location']); },
          getPrototypeOf() { return Object.prototype; },
          has(_target, prop) { return prop === 'defaultView' || prop === 'location' || prop in value; },
        });
        documentCache.set(value, proxy);
        return proxy;
      }
      function wrapObject(value) {
        if (!value || typeof value !== 'object') return value;
        if (objectCache.has(value)) return objectCache.get(value);
        const proxy = new Proxy({}, {
          get(_target, prop) {
            if (prop === 'ownerDocument' || prop === 'contentDocument') return documentProxy ?? guardValue(value[prop], value);
            if (prop === 'defaultView' || prop === 'contentWindow') return windowProxy;
            if (prop === 'dispatchEvent') return guardedDispatchEvent(value.dispatchEvent, value);
            if (isDefineAccessorProperty(prop) || prop === 'constructor' || prop === '__proto__') return blockNavigation;
            if (prop === '__lookupGetter__') return (name) => guardedDescriptor(name, Reflect.getOwnPropertyDescriptor(value, name), value, proxy)?.get;
            if (prop === '__lookupSetter__') return (name) => guardedDescriptor(name, Reflect.getOwnPropertyDescriptor(value, name), value, proxy)?.set;
            return guardValue(safeGetProperty(value, prop), value);
          },
          set(_target, prop, nextValue) {
            if (isPrototypeMutationProperty(prop)) throw navigationError();
            return safeSetProperty(value, prop, nextValue);
          },
          defineProperty(_target, prop, descriptor) {
            if (isPrototypeMutationProperty(prop)) throw navigationError();
            return Reflect.defineProperty(value, prop, safeDescriptor(descriptor));
          },
          setPrototypeOf() { throw navigationError(); },
          getOwnPropertyDescriptor(_target, prop) {
            if (prop === 'ownerDocument' || prop === 'contentDocument') return valueDescriptor(documentProxy ?? guardValue(value[prop], value));
            if (prop === 'defaultView' || prop === 'contentWindow') return valueDescriptor(windowProxy);
            return guardedDescriptor(prop, Reflect.getOwnPropertyDescriptor(value, prop), value, proxy);
          },
          ownKeys() { return uniqueKeys([...Reflect.ownKeys(value), 'ownerDocument', 'contentDocument', 'defaultView', 'contentWindow']); },
          getPrototypeOf() { return Object.prototype; },
          has(_target, prop) { return prop === 'ownerDocument' || prop === 'contentDocument' || prop === 'defaultView' || prop === 'contentWindow' || prop in value; },
        });
        objectCache.set(value, proxy);
        return proxy;
      }
      function wrapPromise(value) {
        if (typeof value !== 'function') return value;
        return new Proxy(value, {
          apply(target, thisArg, args) {
            return guardValue(Reflect.apply(target, thisArg, guardFunctionArgs(args)), target);
          },
          construct(target, args, newTarget) {
            return guardValue(Reflect.construct(target, guardFunctionArgs(args), newTarget), target);
          },
          get(target, prop) {
            if (prop === 'prototype') return target.prototype;
            return guardValue(safeGetProperty(target, prop), target);
          },
          getOwnPropertyDescriptor(target, prop) {
            if (prop === 'prototype') return Reflect.getOwnPropertyDescriptor(target, prop);
            return guardedDescriptor(prop, Reflect.getOwnPropertyDescriptor(target, prop), target, windowProxy);
          },
          setPrototypeOf() { throw navigationError(); },
        });
      }
      function guardedWindowProperty(target, prop, proxy) {
        if (prop === 'location') return locationProxy;
        if (prop === 'history') return historyProxy;
        if (prop === 'open') return blockNavigation;
        if (prop === 'eval' || prop === 'Function') return blockDynamicCode;
        if (prop === 'setTimeout') return guardedTimer(root.setTimeout);
        if (prop === 'setInterval') return guardedTimer(root.setInterval);
        if (prop === 'dispatchEvent') return guardedDispatchEvent(root.dispatchEvent, root);
        if (prop === 'requestIdleCallback') return guardedIdleCallback(root.requestIdleCallback);
        if (prop === 'queueMicrotask') return guardedMicrotask(root.queueMicrotask);
        if (prop === 'Promise') return promiseProxy;
        if (prop === 'MutationObserver') return blockNavigation;
        if (isDomConstructorProperty(prop)) return domConstructor;
        if (prop === 'document') return documentProxy ?? target.document;
        if (prop === 'frames') return proxy;
        if (isDefineAccessorProperty(prop) || prop === 'constructor' || prop === '__proto__') return blockNavigation;
        if (prop === '__lookupGetter__') return (name) => guardedDescriptor(name, Reflect.getOwnPropertyDescriptor(target, name), target, proxy)?.get;
        if (prop === '__lookupSetter__') return (name) => guardedDescriptor(name, Reflect.getOwnPropertyDescriptor(target, name), target, proxy)?.set;
        const next = safeGetProperty(target, prop);
        if (next === root || next === target) return proxy;
        return guardValue(next, target);
      }
      function guardedDescriptor(prop, descriptor, owner, proxy) {
        if (prop === 'location') return { configurable: true, enumerable: true, get: () => locationProxy, set: blockNavigation };
        if (prop === 'history') return valueDescriptor(historyProxy, descriptor?.enumerable);
        if (prop === 'open') return valueDescriptor(blockNavigation, descriptor?.enumerable);
        if (prop === 'document') return valueDescriptor(documentProxy ?? owner.document, descriptor?.enumerable);
        if (prop === 'frames' || prop === 'window' || prop === 'self' || prop === 'top' || prop === 'parent' || prop === 'globalThis') return valueDescriptor(proxy, descriptor?.enumerable);
        if (prop === 'eval' || prop === 'Function') return valueDescriptor(blockDynamicCode, descriptor?.enumerable);
        if (prop === 'setTimeout') return valueDescriptor(guardedTimer(root.setTimeout), descriptor?.enumerable);
        if (prop === 'setInterval') return valueDescriptor(guardedTimer(root.setInterval), descriptor?.enumerable);
        if (prop === 'dispatchEvent') return valueDescriptor(guardedDispatchEvent(owner.dispatchEvent, owner), descriptor?.enumerable);
        if (prop === 'requestIdleCallback') return valueDescriptor(guardedIdleCallback(root.requestIdleCallback), descriptor?.enumerable);
        if (prop === 'queueMicrotask') return valueDescriptor(guardedMicrotask(root.queueMicrotask), descriptor?.enumerable);
        if (prop === 'Promise') return valueDescriptor(promiseProxy, descriptor?.enumerable);
        if (prop === 'MutationObserver') return valueDescriptor(blockNavigation, descriptor?.enumerable);
        if (isDomConstructorProperty(prop)) return valueDescriptor(domConstructor, descriptor?.enumerable);
        if (isDefineAccessorProperty(prop) || prop === 'constructor' || prop === '__proto__') return valueDescriptor(blockNavigation, descriptor?.enumerable);
        if (!descriptor) return undefined;
        if ('value' in descriptor) return valueDescriptor(guardValue(descriptor.value, owner), descriptor.enumerable, descriptor.writable);
        return {
          configurable: true,
          enumerable: Boolean(descriptor.enumerable),
          ...(descriptor.get ? { get: () => guardValue(descriptor.get.call(owner), owner) } : {}),
          ...(descriptor.set ? { set: (nextValue) => descriptor.set.call(owner, safeAssignedValue(nextValue)) } : {}),
        };
      }
      function safeDescriptor(descriptor) {
        if (descriptor.get || descriptor.set) throw navigationError();
        return { ...descriptor, ...('value' in descriptor ? { value: safeAssignedValue(descriptor.value) } : {}) };
      }
      function safeAssignedValue(value) { return typeof value === 'function' ? guardCallback(value) : value; }
      function safeSetProperty(target, prop, nextValue) {
        const found = findPropertyDescriptor(target, prop); const descriptor = found?.descriptor;
        if (descriptor && (descriptor.get || descriptor.set)) { if (!descriptor.set || found.owner === Object.prototype || !isNativeFunction(descriptor.set)) throw navigationError(); descriptor.set.call(target, safeAssignedValue(nextValue)); return true; }
        target[prop] = safeAssignedValue(nextValue); return true;
      }
      function safeGetProperty(target, prop) {
        if (!target) return undefined;
        if (prop === 'click' || prop === 'submit' || prop === 'requestSubmit') throw navigationError();
        const found = findPropertyDescriptor(target, prop);
        if (!found) return undefined;
        const descriptor = found.descriptor;
        if (descriptor.get || descriptor.set) {
          if (found.owner === Object.prototype || !isNativeFunction(descriptor.get)) throw navigationError();
          return descriptor.get.call(target);
        }
        if (typeof descriptor.value === 'function' && found.owner !== target && !isNativeFunction(descriptor.value)) throw navigationError();
        return descriptor.value;
      }
      function findPropertyDescriptor(target, prop) {
        let owner = target;
        while (owner) {
          const descriptor = Reflect.getOwnPropertyDescriptor(owner, prop);
          if (descriptor) return { descriptor, owner };
          owner = Reflect.getPrototypeOf(owner);
        }
        return undefined;
      }
      function isNativeFunction(value) { return typeof value === 'function' && /\\[native code\\]/.test(nativeFunctionToString.call(value)); }
      function valueDescriptor(value, enumerable = true, writable = true) {
        return { configurable: true, enumerable: Boolean(enumerable), writable: Boolean(writable), value };
      }
      function uniqueKeys(keys) {
        return [...new Set(keys)];
      }
      function isGuardedWindowProp(prop) {
        return prop === 'location' || prop === 'history' || prop === 'open' || prop === 'document' || prop === 'frames' || prop === 'eval' || prop === 'Function' || prop === 'setTimeout' || prop === 'setInterval' || prop === 'dispatchEvent' || prop === 'requestIdleCallback' || prop === 'queueMicrotask' || prop === 'Promise' || prop === 'MutationObserver' || isDomConstructorProperty(prop);
      }
      function guardValue(value, owner) {
        if (typeof value === 'function') return (...args) => guardValue(value.apply(owner, guardFunctionArgs(args)), owner);
        if (!value || typeof value !== 'object') return value;
        if (value === root) return windowProxy;
        if (value === root.document) return documentProxy ?? value;
        if (value === root.location) return locationProxy;
        if (value === root.history) return historyProxy;
        if (typeof Error === 'function' && value instanceof Error) return value;
        if (typeof Window === 'function' && value instanceof Window) return wrapWindow(value);
        if (typeof Document === 'function' && value instanceof Document) return wrapDocument(value);
        return wrapObject(value);
      }
      function guardFunctionArgs(args) {
        return args.map(guardCallbackArgument);
      }
      function guardCallbackArgument(arg) {
        if (typeof arg === 'function') return guardCallback(arg);
        if (arg && typeof arg === 'object' && typeof arg.handleEvent === 'function') return guardEventListener(arg);
        return arg;
      }
      function guardCallback(callback) {
        if (callbackCache.has(callback)) return callbackCache.get(callback);
        const guarded = function (...args) { return runGuardedCallback(callback, this, args); };
        callbackCache.set(callback, guarded);
        return guarded;
      }
      function guardEventListener(listener) {
        if (listenerCache.has(listener)) return listenerCache.get(listener);
        const guarded = { handleEvent(event) { return runGuardedCallback(listener.handleEvent, guardValue(listener, listener), [event]); } };
        listenerCache.set(listener, guarded);
        return guarded;
      }
      function installDynamicCodeGuard() {
        const restores = [];
        const OriginalFunction = Function;
        const OriginalPromise = root.Promise;
        replace(root, 'eval', blockDynamicCode);
        replace(root, 'Function', blockDynamicCode);
        replace(root, 'setTimeout', guardedTimer(root.setTimeout));
        replace(root, 'setInterval', guardedTimer(root.setInterval));
        replace(root, 'requestIdleCallback', guardedIdleCallback(root.requestIdleCallback));
        replace(root, 'queueMicrotask', guardedMicrotask(root.queueMicrotask));
        replace(root, 'MutationObserver', blockNavigation);
        if (OriginalPromise) {
          replace(root, 'Promise', promiseProxy);
          patchPromiseCallbacks(OriginalPromise.prototype, replace);
        }
        replace(OriginalFunction.prototype, 'constructor', blockDynamicCode);
        replace(Object.getPrototypeOf(async function () {}), 'constructor', blockDynamicCode);
        replace(Object.getPrototypeOf(function* () {}), 'constructor', blockDynamicCode);
        replace(Object.getPrototypeOf(async function* () {}), 'constructor', blockDynamicCode);
        return { restore() { for (const restore of restores.reverse()) restore(); } };
        function replace(target, prop, value) {
          if (!target) return;
          const descriptor = Object.getOwnPropertyDescriptor(target, prop);
          try {
            Object.defineProperty(target, prop, { configurable: true, writable: true, value });
            restores.push(() => descriptor ? Object.defineProperty(target, prop, descriptor) : Reflect.deleteProperty(target, prop));
          } catch (_error) {
            // Some browser objects are non-configurable. The local scope/window proxy still guards normal access.
          }
        }
      }
      function guardedTimer(timer) {
        return (callback, ...args) => {
          if (typeof callback === 'string') throw navigationError();
          if (typeof callback !== 'function') return blockDynamicCode();
          return timer?.call(root, guardCallback(callback), ...args);
        };
      }
      function guardedIdleCallback(scheduler) {
        return (callback, ...args) => {
          if (typeof callback !== 'function') return blockDynamicCode();
          return scheduler?.call(root, guardCallback(callback), ...args);
        };
      }
      function guardedDispatchEvent(_dispatcher, _target) {
        return (event, ..._args) => {
          guardDispatchedEvent(event);
          throw navigationError();
        };
      }
      function guardDispatchedEvent(event) {
        if (!event || typeof event !== 'object') return;
        for (const prop of ['target', 'currentTarget', 'srcElement', 'view']) {
          const value = event[prop];
          try {
            Object.defineProperty(event, prop, { configurable: true, enumerable: true, writable: true, value: value && typeof value === 'object' ? guardValue(value, value) : windowProxy });
          } catch (_error) {
            throw navigationError();
          }
        }
      }
      function guardedMicrotask(scheduler) {
        return (callback, ..._args) => {
          if (typeof callback !== 'function') return blockDynamicCode();
          throw navigationError();
        };
      }
      function patchPromiseCallbacks(prototype, replace) {
        if (!prototype) return;
        const then = prototype.then;
        const catchMethod = prototype.catch;
        const finallyMethod = prototype.finally;
        if (typeof then === 'function') replace(prototype, 'then', function (onFulfilled, onRejected) { return then.call(this, guardOptionalCallback(onFulfilled), guardOptionalCallback(onRejected)); });
        if (typeof catchMethod === 'function') replace(prototype, 'catch', function (onRejected) { return catchMethod.call(this, guardOptionalCallback(onRejected)); });
        if (typeof finallyMethod === 'function') replace(prototype, 'finally', function (onFinally) { return finallyMethod.call(this, guardOptionalCallback(onFinally)); });
      }
      function guardOptionalCallback(callback) {
        return typeof callback === 'function' ? guardCallback(callback) : callback;
      }
      function runGuardedCallback(callback, thisArg, args) {
        const callbackGuard = installDynamicCodeGuard();
        const guardedThis = thisArg === undefined || thisArg === null ? windowProxy : guardValue(thisArg, thisArg);
        try {
          const result = callback.apply(guardedThis, args.map((arg) => guardValue(arg, arg)));
          if (result && typeof result.finally === 'function') return result.finally(() => callbackGuard.restore());
          callbackGuard.restore();
          return result;
        } catch (error) {
          callbackGuard.restore();
          throw error;
        }
      }
      function navigationError() {
        return new Error('browserjs cannot use direct page navigation. Use navigate() helper or the top-level navigate tool instead.');
      }
      function blockNavigation() { throw navigationError(); }
      function blockDynamicCode() { throw new Error('browserjs cannot use dynamic code execution. Use navigate() helper or the top-level navigate tool instead.'); }
      function isLocationMethod(prop) { return prop === 'assign' || prop === 'replace' || prop === 'reload'; }
      function isHistoryMethod(prop) { return prop === 'back' || prop === 'forward' || prop === 'go' || prop === 'pushState' || prop === 'replaceState'; }
      function isDefineAccessorProperty(prop) { return prop === '__defineGetter__' || prop === '__defineSetter__'; }
      function isDomConstructorProperty(prop) { return prop === 'Node' || prop === 'Element' || prop === 'HTMLElement' || prop === 'HTMLBodyElement'; }
      function isPrototypeMutationProperty(prop) { return prop === '__proto__' || prop === 'prototype' || prop === 'constructor'; }
      function isObjectEscapeProperty(prop) { return isPrototypeMutationProperty(prop) || isDefineAccessorProperty(prop) || prop === '__lookupGetter__' || prop === '__lookupSetter__'; }
    }
    function assertSerializable(value) { assertJsonLike(value, new WeakSet()); try { structuredClone(value); } catch (error) { throw serializableError(error instanceof Error ? error.message : String(error)); } }
    function assertJsonLike(value, seen, key) {
      if (value === null || value === undefined) return;
      const type = typeof value;
      if (type === 'function' || type === 'symbol' || type === 'bigint') throw serializableError(type + ' cannot be returned');
      if (type === 'string') { if (isDisallowedPayloadKey(key) || isDisallowedPayloadString(value)) throw serializableError('dataUrl/base64 payloads cannot be returned'); return; }
      if (isDisallowedPayloadKey(key)) throw serializableError('dataUrl/base64 payloads cannot be returned');
      if (type !== 'object') return;
      if ((typeof Node === 'function' && value instanceof Node) || (typeof Window === 'function' && value instanceof Window) || (typeof Event === 'function' && value instanceof Event)) throw serializableError('DOM/Event/Window objects cannot be returned');
      if (seen.has(value)) throw serializableError('cyclic object cannot be returned');
      seen.add(value);
      const entries = Array.isArray(value) ? value.map((item) => ['', item]) : Object.entries(value);
      for (const entry of entries) assertJsonLike(entry[1], seen, entry[0]);
      seen.delete(value);
    }
    function isDisallowedPayloadKey(key) { return typeof key === 'string' && /^(?:dataUrl|base64)$/i.test(key); }
    function isDisallowedPayloadString(value) { const text = value.trim(); const compact = text.replace(/\s+/g, ''); return /^data:/i.test(text) || (compact.length > 512 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)); }
    function serializableError(message) { return new Error('browserjs return value must be serializable. DOM nodes, functions, Window, Event, cyclic objects and dataUrl/base64 payloads cannot be returned. Original: ' + message); }
    function captureConsole() {
      const entries = [];
      const originals = {};
      for (const level of ['log', 'info', 'warn', 'error']) {
        originals[level] = console[level];
        console[level] = (...values) => {
          entries.push({ level, text: truncate(values.map(formatConsoleValue).join(' '), 500) });
          if (entries.length > 20) entries.shift();
          return originals[level]?.apply(console, values);
        };
      }
      return {
        entries,
        restore() {
          for (const level of Object.keys(originals)) console[level] = originals[level];
        },
      };
    }
    function formatConsoleValue(value) {
      if (typeof value === 'string') return value;
      if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
      if (typeof value === 'bigint') return String(value) + 'n';
      if (value instanceof Error) return value.stack || value.message;
      if (typeof window !== 'undefined' && value === window) return '[Window]';
      if (typeof Element === 'function' && value instanceof Element) return '<' + value.tagName.toLowerCase() + (value.id ? '#' + value.id : '') + '>';
      if (typeof Event === 'function' && value instanceof Event) return '[Event ' + value.type + ']';
      try {
        const json = JSON.stringify(value, consoleJsonReplacer());
        return json === undefined ? String(value) : json;
      } catch (_error) {
        return String(value);
      }
    }
    function consoleJsonReplacer() {
      const seen = new WeakSet();
      return (_key, value) => {
        if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
        if (typeof value === 'bigint') return String(value) + 'n';
        if (!value || typeof value !== 'object') return value;
        if (typeof window !== 'undefined' && value === window) return '[Window]';
        if (typeof Element === 'function' && value instanceof Element) return '<' + value.tagName.toLowerCase() + (value.id ? '#' + value.id : '') + '>';
        if (typeof Event === 'function' && value instanceof Event) return '[Event ' + value.type + ']';
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        return value;
      };
    }
    function formatBrowserJsError(error, entries) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? error.stack.split('\\n').slice(0, 6).join('\\n') : '';
      const lines = ['browserjs failed: ' + truncate(message, 1000)];
      if (stack) lines.push('stack:\\n' + truncate(stack, 2000));
      if (entries.length) lines.push('console:\\n' + entries.map((entry) => '[' + entry.level + '] ' + entry.text).join('\\n'));
      return lines.join('\\n');
    }
    function truncate(text, maxLength) {
      return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
    }
  })()`;
}
