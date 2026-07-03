const cookieError = 'debugger does not expose cookies';
const cdpScriptMethodPattern = /evaluate|call(?:Async)?FunctionOn|compileScript|runScript|addScriptToEvaluateOnNewDocument/i;
const unsafeEvaluationPattern = /(?:^|[^\w$])(?:open|frames|contentWindow|contentDocument|srcdoc|iframe|createElement|write|writeln|innerHTML|outerHTML|insertAdjacentHTML|setTimeout|setInterval|queueMicrotask|requestAnimationFrame|requestIdleCallback|postMessage|addEventListener|removeEventListener|dispatchEvent|eval|Function|constructor|MutationObserver|MessageChannel|MessagePort|BroadcastChannel|Worker|SharedWorker)(?:[^\w$]|$)|\.(?:call|apply|bind)\s*\(|\b\w*cookie\w*\s*\(|\bwindow\s*\[\s*\d/i;

export function assertAllowedCdpMethod(method: string) {
  if (/cookie/i.test(method) || (method !== 'Runtime.evaluate' && cdpScriptMethodPattern.test(method))) throwCookieError();
}

export function prepareCdpParams(method: string, params?: Record<string, unknown>) {
  if (method === 'Runtime.evaluate' && typeof params?.expression === 'string') {
    const { expression, ...otherParams } = params;
    assertNoCookieExposure(expression);
    if (containsCookieExposure(otherParams)) throwCookieError();
    return { ...otherParams, expression: wrapCookieBlockedExpression(expression) };
  }
  if (containsCookieExposure(params)) throwCookieError();
  return params;
}

export function assertNoCookieExposure(expression: string) {
  const source = stripComments(decodeUnicodeEscapes(expression));
  if (hasCookieAccess(source) || unsafeEvaluationPattern.test(source) || containsDocumentAlias(source) || containsUnsafeCallbackArgument(source) || containsUnsafePromiseCallback(source) || containsUnsafeCall(source)) throwCookieError();
}

export function wrapCookieBlockedExpression(expression: string) {
  return `(async()=>{const blocked=()=>{throw new Error('debugger does not expose cookies')};const records=[];const restore=(from=0)=>{for(const [target,key,descriptor] of records.splice(from).reverse()){if(descriptor)Object.defineProperty(target,key,descriptor);else Reflect.deleteProperty(target,key)}};const patch=(target,key,value)=>{if(!target)return;records.push([target,key,Object.getOwnPropertyDescriptor(target,key)]);Object.defineProperty(target,key,value);const next=Object.getOwnPropertyDescriptor(target,key);if(value.value&&next?.value!==value.value)blocked();if(value.get&&next?.get!==value.get)blocked();if(value.set&&next?.set!==value.set)blocked()};const withPatchedDocument=(callback,args,self)=>{const start=records.length;patchDocument(globalThis.document);try{return callback.apply(self,args)}finally{restore(start)}};const guard=(callback)=>typeof callback==='function'?function(...args){return withPatchedDocument(callback,args,this)}:callback;const patchPromise=(key)=>{const original=Promise.prototype[key];patch(Promise.prototype,key,{configurable:true,value:function(...args){return original.call(this,...args.map(guard))}})};const patchHtml=(node)=>{let target=node;while(target&&(typeof target==='object'||typeof target==='function')&&target!==Object.prototype){for(const key of ['innerHTML','outerHTML'])patch(target,key,{configurable:true,get:blocked,set:blocked});patch(target,'insertAdjacentHTML',{configurable:true,value:blocked});target=Object.getPrototypeOf(target)}};const patchDocument=(doc)=>{let target=doc;while(target&&(typeof target==='object'||typeof target==='function')&&target!==Object.prototype){patch(target,'cookie',{configurable:true,get:blocked,set:blocked});for(const key of ['createElement','write','writeln'])patch(target,key,{configurable:true,value:blocked});target=Object.getPrototypeOf(target)};patchHtml(doc?.body);patchHtml(doc?.documentElement)};for(const key of ['open','setTimeout','setInterval','queueMicrotask','requestAnimationFrame','requestIdleCallback','postMessage','addEventListener','removeEventListener','dispatchEvent','MutationObserver','MessageChannel','BroadcastChannel','Worker','SharedWorker','cookieStore'])patch(globalThis,key,{configurable:true,value:blocked});patch(globalThis.navigator,'cookieStore',{configurable:true,get:blocked});patch(globalThis.EventTarget&&EventTarget.prototype,'addEventListener',{configurable:true,value:blocked});if(globalThis.Promise)for(const key of ['then','catch','finally'])patchPromise(key);patchDocument(globalThis.document);for(let index=0;index<(globalThis.frames?.length??0);index+=1){try{patchDocument(globalThis.frames[index].document)}catch{}}try{return await (0,eval)(${JSON.stringify(expression)})}finally{restore()}})()`;
}

function hasCookieAccess(source: string) {
  return directCookieAccessPattern.test(source) || containsDocumentDynamicIndex(source) || containsFoldedDocumentCookie(source) || containsFoldedLiteral(source, 'cookie') || containsFoldedLiteral(source, 'cookieStore') || containsFoldedLiteral(source, 'innerHTML') || containsFoldedLiteral(source, 'outerHTML') || containsFoldedLiteral(source, 'insertAdjacentHTML') || containsFoldedLiteral(source, 'frames') || containsCharCodeCookie(source) || containsAtobCookie(source) || containsFoldedLiteral(source, 'eval');
}

const directCookieAccessPattern = /(?:^|[^\w$])(?:(?:document|window\.document|globalThis\.document)\s*(?:\?\.|\.)\s*cookie|(?:globalThis\.|window\.|navigator\.)?cookieStore)\b/i;
const documentDynamicIndexPattern = /(?:^|[^\w$])(?:document|window\.document|globalThis\.document)\s*\[\s*(?!(['"])[A-Za-z_$][\w$]*\1\s*\])/i;
const allowedCalls = new Set(['JSON.stringify', 'Object.keys', 'Object.values', 'Object.entries', 'String', 'Number', 'Boolean', 'Promise.resolve']);
const allowedMethods = new Set(['then', 'catch', 'finally']);

function containsDocumentAlias(source: string) {
  return /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:document|window\.document|globalThis\.document)\b/.test(source);
}

function containsUnsafeCallbackArgument(source: string) {
  return /JSON\s*\.\s*stringify\s*\([^)]*,|Array\s*\.\s*from\s*\(/.test(source);
}

function containsUnsafePromiseCallback(source: string) {
  return /\.(?:then|catch|finally)\s*\(\s*(?!\(?\s*[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*\)?\s*=>\s*[A-Za-z_$][\w$]*(?:\s*[+\-*/]\s*[\d.]+)?\s*\)?\s*$)/.test(source);
}

function containsUnsafeCall(source: string) {
  if (/\[[^\]]+\]\s*(?:\?\.)?\s*\(|\)\s*\?\.\s*\(|\)\s*\)\s*\(\s*\)|\)\s*\(\s*\)\s*\(|\b[A-Za-z_$][\w$]*\s*\?\.\s*\(|\(\s*[A-Za-z_$][\w$]*\s*\)\s*\(|,\s*[A-Za-z_$][\w$]*\s*\)\s*\(/.test(source)) return true;
  for (const match of source.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
    const callee = match[1].replace(/\s+/g, '');
    const previous = source[Math.max(0, Number(match.index) - 1)];
    if (callee === 'async') continue;
    if (allowedCalls.has(callee)) continue;
    if (previous === '.' && allowedMethods.has(callee)) continue;
    return true;
  }
  return false;
}

function containsDocumentDynamicIndex(source: string) {
  return documentDynamicIndexPattern.test(source);
}

function containsFoldedDocumentCookie(source: string) {
  return containsFoldedLiteral(source, 'document') && /\]\s*(?:\?\.|\.)\s*cookie\b/i.test(source);
}

function containsCookieExposure(value: unknown): boolean {
  if (typeof value === 'string') {
    const source = stripComments(decodeUnicodeEscapes(value));
    return /cookie/i.test(source) || hasCookieAccess(source);
  }
  if (Array.isArray(value)) return value.some(containsCookieExposure);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nextValue]) => /cookie/i.test(key) || containsCookieExposure(nextValue));
}

function containsFoldedLiteral(source: string, target: string) {
  const tokens = readStringTokens(source);
  for (let index = 0; index < tokens.length; index += 1) {
    let value = tokens[index].value;
    let end = tokens[index].end;
    if (equalsFoldedLiteral(value, target)) return true;
    for (let nextIndex = index + 1; nextIndex < tokens.length && onlyPlusBetween(source, end, tokens[nextIndex].start); nextIndex += 1) {
      value += tokens[nextIndex].value;
      if (equalsFoldedLiteral(value, target)) return true;
      end = tokens[nextIndex].end;
    }
  }
  return false;
}

function equalsFoldedLiteral(value: string, target: string) {
  return value.toLowerCase() === target || (target === 'cookie' && /\bdocument\s*\.\s*cookie\b/i.test(value));
}

function containsCharCodeCookie(source: string) {
  return [...source.matchAll(/String\s*\.\s*fromCharCode\s*\(([^)]*)\)/g)].some((match) => {
    const text = match[1].split(',').map((part) => String.fromCharCode(Number(part.trim()))).join('');
    return text.toLowerCase() === 'cookie';
  });
}

function containsAtobCookie(source: string) {
  return [...source.matchAll(/atob\s*\(\s*(['"])(.*?)\1\s*\)/g)].some((match) => {
    try {
      return atob(match[2]).toLowerCase() === 'cookie';
    } catch {
      return false;
    }
  });
}

function readStringTokens(source: string) {
  const tokens: { value: string; start: number; end: number }[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote !== '\'' && quote !== '"') continue;
    const start = index;
    let raw = '';
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') {
        raw += character + (source[index + 1] ?? '');
        index += 2;
      } else if (character === quote) {
        tokens.push({ value: decodeStringLiteral(raw), start, end: index + 1 });
        break;
      } else {
        raw += character;
        index += 1;
      }
    }
  }
  return tokens;
}

function decodeUnicodeEscapes(source: string) {
  return source.replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})/gi, (_match, codePoint, unicode) => String.fromCodePoint(Number.parseInt(codePoint ?? unicode, 16)));
}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

function decodeStringLiteral(raw: string) {
  return raw.replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})|\\(.)/gi, (_match, codePoint, unicode, hex, escaped) => {
    if (codePoint) return String.fromCodePoint(Number.parseInt(codePoint, 16));
    if (unicode || hex) return String.fromCharCode(Number.parseInt(unicode ?? hex, 16));
    return String(escaped);
  });
}

function onlyPlusBetween(source: string, start: number, end: number) {
  return /^\s*\+\s*$/.test(source.slice(start, end));
}

function throwCookieError(): never {
  throw new Error(cookieError);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
