import { MAX_BROWSER_REPL_TIMEOUT_MS } from './browser-repl-command.ts';

export const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 5_000;
export const MAX_BROWSER_SNAPSHOT_ELEMENTS = 80;

export type PageTarget =
  | { ref: string }
  | { role: string; name: string }
  | { label: string }
  | { text: string }
  | { selector: string }
  | { x: number; y: number };

export type BrowserInput = {
  action: 'snapshot' | 'click' | 'fill' | 'press';
  target?: PageTarget;
  value?: string;
  key?: string;
  scope?: 'viewport' | 'page';
  limit?: number;
  tabId?: number;
  timeoutMs?: number;
};

export type BrowserResult = {
  ok: boolean;
  action: BrowserInput['action'];
  code?: string;
  message?: string;
  evidence?: unknown;
  candidates?: unknown[];
  state?: unknown;
};

export const browserDescription = 'Structured page interaction with human-readable locators. Use for clicks, fills, keypresses, and reading page state. Actions: snapshot reads state and ignores target; click, fill, and press operate one target. Locators: prefer { text }, { role, name }, { label }, or { ref } from the latest snapshot; { selector } is fallback; { x, y } is the visual fallback for canvas/visual UIs where semantic locators fail — coordinates are viewport CSS px (state.viewport gives width/height; from a screenshot, scale pixel coords by viewport.width/imageWidth). Refs are opaque handles valid only until the next snapshot, page change, or DOM update. Actions auto-wait for DOM stability and return fresh state. Returns ok:false with code/message/candidates for ambiguous, stale, invisible, disabled, or non-fillable targets. Snapshot reports open shadow roots and frames[]; same-origin iframe content includes frames[].elements refs, cross-origin shows FRAME_NOT_ACCESSIBLE with hints.';

const targetDescription = 'Exactly one PageTarget locator: { ref } from the latest browser state, { role, name }, { label }, { text }, { selector }, or { x, y } viewport CSS px. Prefer text/role/label/ref; selector is fallback; x/y is the last resort for visual-only targets.';

export const browserInputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['snapshot', 'click', 'fill', 'press'], description: 'snapshot reads lightweight page state; click/fill/press operate one target.' },
    target: {
      type: 'object',
      additionalProperties: false,
      description: targetDescription,
      properties: {
        ref: { type: 'string', description: 'Opaque ref string returned by the latest browser state; not a selector and not valid across new snapshots or page changes.' },
        role: { type: 'string', description: 'Accessible or implicit role, for example button, link, tab, menuitem, textbox.' },
        name: { type: 'string', description: 'Accessible name paired with role.' },
        label: { type: 'string', description: 'Visible form label, placeholder, aria-label, name/id, or nearby field label.' },
        text: { type: 'string', description: 'Visible human text on a clickable or focusable element.' },
        selector: { type: 'string', description: 'Native CSS selector fallback only; no Playwright pseudo-selectors.' },
        x: { type: 'number', description: 'Viewport CSS px from the left, paired with y. Visual fallback for canvas or visually obvious targets with no semantic locator.' },
        y: { type: 'number', description: 'Viewport CSS px from the top, paired with x.' },
      },
    },
    value: { type: 'string', description: 'Text value for action:"fill".' },
    key: { type: 'string', description: 'Keyboard key for action:"press", for example Enter.' },
    scope: { type: 'string', enum: ['viewport', 'page'], description: 'Snapshot element scope. Defaults to page; viewport returns currently visible elements first.' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_BROWSER_SNAPSHOT_ELEMENTS, description: 'Maximum elements in returned state. Defaults to 30.' },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_BROWSER_REPL_TIMEOUT_MS },
  },
} as const;

export function parseBrowserInput(value: unknown): BrowserInput {
  if (!isRecord(value)) throw new Error('browser input must be an object');
  const action = readAction(value.action);
  const input: BrowserInput = { action };
  if ('tabId' in value) input.tabId = readPositiveInteger(value.tabId, 'tabId');
  if ('timeoutMs' in value) input.timeoutMs = readTimeout(value.timeoutMs);
  if ('scope' in value) input.scope = readScope(value.scope);
  if ('limit' in value) input.limit = readLimit(value.limit);

  if (action === 'snapshot') return input;
  if (action === 'click') input.target = readPageTarget(value.target, 'target');
  if (action === 'fill') {
    input.target = readPageTarget(value.target, 'target');
    input.value = readNonEmptyString(value.value, 'value');
  }
  if (action === 'press') {
    if ('target' in value && value.target !== undefined) input.target = readPageTarget(value.target, 'target');
    input.key = readNonEmptyString(value.key, 'key');
  }
  return input;
}

function readAction(value: unknown): BrowserInput['action'] {
  if (value === 'snapshot' || value === 'click' || value === 'fill' || value === 'press') return value;
  throw new Error('browser.action must be snapshot, click, fill, or press');
}

function readPageTarget(value: unknown, name: string): PageTarget {
  if (!isRecord(value)) throw new Error(`${name} must be a PageTarget object`);
  const hasRole = 'role' in value || 'name' in value;
  const hasPoint = 'x' in value || 'y' in value;
  const locatorCount = ['ref', 'label', 'text', 'selector'].filter((key) => key in value).length + (hasRole ? 1 : 0) + (hasPoint ? 1 : 0);
  if (locatorCount !== 1) throw new Error(`${name} must contain exactly one locator: ref, role/name, label, text, selector, or x/y`);
  if ('ref' in value) return { ref: readNonEmptyString(value.ref, 'target.ref') };
  if (hasPoint) return { x: readFiniteNumber(value.x, 'target.x'), y: readFiniteNumber(value.y, 'target.y') };
  if (hasRole) return { role: readNonEmptyString(value.role, 'target.role'), name: readNonEmptyString(value.name, 'target.name') };
  if ('label' in value) return { label: readNonEmptyString(value.label, 'target.label') };
  if ('text' in value) return { text: readNonEmptyString(value.text, 'target.text') };
  return { selector: readNonEmptyString(value.selector, 'target.selector') };
}

function readFiniteNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function readTimeout(value: unknown) {
  const timeout = readPositiveInteger(value, 'timeoutMs');
  if (timeout > MAX_BROWSER_REPL_TIMEOUT_MS) throw new Error(`timeoutMs must be <= ${MAX_BROWSER_REPL_TIMEOUT_MS}`);
  return timeout;
}

function readLimit(value: unknown) {
  const limit = readPositiveInteger(value, 'limit');
  if (limit > MAX_BROWSER_SNAPSHOT_ELEMENTS) throw new Error(`limit must be <= ${MAX_BROWSER_SNAPSHOT_ELEMENTS}`);
  return limit;
}

function readScope(value: unknown): BrowserInput['scope'] {
  if (value === 'viewport' || value === 'page') return value;
  throw new Error('scope must be viewport or page');
}

function readNonEmptyString(value: unknown, name: string) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  return value;
}

function readPositiveInteger(value: unknown, name: string) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error(`${name} must be a positive integer`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
