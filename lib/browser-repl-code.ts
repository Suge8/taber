const SERIALIZABLE_HINT = 'DOM nodes, functions, Window, Event and cyclic objects cannot cross the sandbox boundary. Return plain JSON-like data instead.';
const DIRECT_NAVIGATION_HINT = 'Use navigate() helper or the top-level navigate tool instead.';
const URL_MUTATING_PROPERTIES = String.raw`(?:href|pathname|search|hash|protocol|host|hostname|port)`;
const LOCATION_METHODS = String.raw`(?:assign|replace|reload)`;
const HISTORY_METHODS = String.raw`(?:back|forward|go|pushState|replaceState)`;
const ASSIGNMENT_OPERATOR = String.raw`(?:=|\+=|-=|\*=|/=|%=|\*\*=|<<=|>>=|>>>=|&=|\^=|\|=|&&=|\|\|=|\?\?=)`;
const LOCATION_TARGET = String.raw`(?:location|(?:(?:(?:window|globalThis)\s*(?:\.\s*document|\[\s*["']document["']\s*\])|window|globalThis|document|self|top|parent|this)\s*(?:\.\s*location|\[\s*["']location["']\s*\])))`;
const HISTORY_TARGET = String.raw`(?:history|(?:window|globalThis|self|top|parent|this)\s*(?:\.\s*history|\[\s*["']history["']\s*\]))`;
const OPEN_TARGET = String.raw`(?:open|(?:window|globalThis|self|top|parent|this)\s*(?:\.\s*open|\[\s*["']open["']\s*\]))`;
const DOM_WINDOW_TARGET = String.raw`(?:document(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*ownerDocument\s*\.\s*defaultView|document(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*contentWindow)`;
const LOCATION_PROPERTY_ACCESS = String.raw`(?:\.\s*${URL_MUTATING_PROPERTIES}|\[\s*["']${URL_MUTATING_PROPERTIES}["']\s*\])`;
const LOCATION_METHOD_ACCESS = String.raw`(?:\.\s*${LOCATION_METHODS}|\[\s*["']${LOCATION_METHODS}["']\s*\])`;
const HISTORY_METHOD_ACCESS = String.raw`(?:\.\s*${HISTORY_METHODS}|\[\s*["']${HISTORY_METHODS}["']\s*\])`;
const DYNAMIC_IMPORT_PATTERN = /(^|[^\w$.])import\s*\(/i;
const DIRECT_NAVIGATION_PATTERNS = [
  { pattern: directNavigationPattern(String.raw`${DOM_WINDOW_TARGET}\s*\.\s*location\s*(?:=|${LOCATION_PROPERTY_ACCESS}\s*${ASSIGNMENT_OPERATOR}|${LOCATION_METHOD_ACCESS}\s*\()`), name: 'location navigation' },
  { pattern: directNavigationPattern(String.raw`${DOM_WINDOW_TARGET}\s*\.\s*history\s*${HISTORY_METHOD_ACCESS}\s*\(`), name: 'history navigation' },
  { pattern: directNavigationPattern(String.raw`${DOM_WINDOW_TARGET}\s*\.\s*open\s*\(`), name: 'window.open navigation' },
  { pattern: directNavigationPattern(String.raw`${LOCATION_TARGET}\s*(?:=|${LOCATION_PROPERTY_ACCESS}\s*${ASSIGNMENT_OPERATOR}|${LOCATION_METHOD_ACCESS}\s*\()`), name: 'location navigation' },
  { pattern: directNavigationPattern(String.raw`${HISTORY_TARGET}\s*${HISTORY_METHOD_ACCESS}\s*\(`), name: 'history navigation' },
  { pattern: directNavigationPattern(String.raw`${OPEN_TARGET}\s*\(`), name: 'window.open navigation' },
];

export function normalizeBrowserJsCode(value: unknown) {
  if (typeof value === 'string') return rejectDirectBrowserJsNavigation(value);
  if (typeof value === 'function') return rejectDirectBrowserJsNavigation(`return await (${Function.prototype.toString.call(value)})(args);`);
  throw new Error('browserjs code must be a string or function');
}

export function jsonLiteralForInjectedCode(value: unknown, label: string) {
  try {
    assertJsonSerializable(value);
    const json = JSON.stringify(value);
    return json === undefined ? 'undefined' : json.replace(/</g, '\\u003c');
  } catch (error) {
    throw new Error(cloneBoundaryError(label, error));
  }
}

export function cloneBoundaryError(label: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/must be serializable/i.test(message)) return message;
  if (!isCloneError(error, message) && !isSerializationError(message)) return message;
  return `${label} must be serializable. ${SERIALIZABLE_HINT} Original: ${message}`;
}

function rejectDirectBrowserJsNavigation(code: string) {
  const normalizedCode = normalizeNavigationSyntax(code);
  if (DYNAMIC_IMPORT_PATTERN.test(normalizedCode)) throw new Error(`browserjs cannot use dynamic import. ${DIRECT_NAVIGATION_HINT}`);
  const match = DIRECT_NAVIGATION_PATTERNS.find(({ pattern }) => pattern.test(normalizedCode));
  if (match) throw new Error(`browserjs cannot use direct ${match.name}. ${DIRECT_NAVIGATION_HINT}`);
  return code;
}

function normalizeNavigationSyntax(code: string) {
  return code
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, ' ')
    .replace(/\?\s*\.\s*(?=\()/g, '')
    .replace(/\?\s*\.\s*(?=\[)/g, '')
    .replace(/\?\s*\./g, '.')
    .replace(/\[\s*(["'`])\s*([A-Za-z_$][\w$]*)\s*\1\s*\]/g, '.$2');
}

function directNavigationPattern(source: string) {
  return new RegExp(String.raw`(^|[^\w$.])${source}`, 'i');
}

function assertJsonSerializable(value: unknown, seen = new WeakSet<object>()) {
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === 'function' || type === 'symbol' || type === 'bigint') throw new TypeError(`${type} cannot be serialized`);
  if (type !== 'object') return;
  if (isDomBoundaryValue(value)) throw new TypeError('DOM/Event/Window objects cannot be serialized');
  if (seen.has(value)) throw new TypeError('cyclic object cannot be serialized');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSerializable(item, seen);
  } else {
    for (const item of Object.values(value)) assertJsonSerializable(item, seen);
  }
  seen.delete(value);
}

function isDomBoundaryValue(value: object) {
  return (typeof Node === 'function' && value instanceof Node)
    || (typeof Window === 'function' && value instanceof Window)
    || (typeof Event === 'function' && value instanceof Event);
}

function isCloneError(error: unknown, message: string) {
  return (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'DataCloneError') || /DataCloneError|could not be cloned|structured clone/i.test(message);
}

function isSerializationError(message: string) {
  return /cannot be serialized|cyclic object|circular structure|serialize a BigInt/i.test(message);
}
