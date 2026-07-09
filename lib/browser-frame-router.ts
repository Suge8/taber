import { originPatternForUrl } from './browser-access.ts';
import type { BrowserInput, BrowserResult, PageTarget } from './browser-tool.ts';
import type { BrowserReplPageCommand } from './browser-repl-command.ts';
import type { ChromeApiAction } from './chrome-api-broker.ts';

type RunFrameCommand = (tabId: number, frameId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) => Promise<unknown>;
type CallChromeApi = (action: ChromeApiAction, args: unknown[], abortSignal?: AbortSignal) => Promise<unknown>;

type FrameInfo = { frameId: number; parentFrameId?: number; url: string; errorOccurred?: boolean };
type RoutedRef = { tabId: number; frameId: number; frameUrl: string; snapshotId: string; localRef: string };
type SnapshotTarget = { tabId: number; frameId: number; frameUrl: string; snapshotId: string };
type Candidate = { ref: string; score: number; context: Record<string, unknown>; element: Record<string, unknown> };

const MAIN_FRAME_ID = 0;
const STALE_REF_MESSAGE = 'Ref is stale. Use browser.snapshot again and retry with a ref from the latest browser state.';
const FRAME_HINT = 'Grant Website access for the iframe origin, or open the iframe source page and operate it directly.';

export function createBrowserFrameRouter(options: { runFrameCommand: RunFrameCommand; callChromeApi: CallChromeApi }) {
  return new BrowserFrameRouter(options);
}

class BrowserFrameRouter {
  private readonly runFrameCommand: RunFrameCommand;
  private readonly callChromeApi: CallChromeApi;
  private readonly refs = new Map<string, RoutedRef>();
  private readonly latestSnapshotByTab = new Map<number, string>();
  private readonly tabQueues = new Map<number, Promise<void>>();
  private refSeq = 0;

  constructor(options: { runFrameCommand: RunFrameCommand; callChromeApi: CallChromeApi }) {
    this.runFrameCommand = options.runFrameCommand;
    this.callChromeApi = options.callChromeApi;
  }

  execute(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    return this.runExclusive(tabId, () => this.executeExclusive(tabId, command, abortSignal));
  }

  private async executeExclusive(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal) {
    if (abortSignal?.aborted) throw new Error('Task aborted');
    const input = readBrowserInput(command);
    if (input.action === 'snapshot') return this.snapshot(tabId, pageCommand(command, snapshotInput(input)), abortSignal);
    const target = isRecord(input.target) ? input.target as PageTarget : undefined;
    if (target && 'ref' in target) return this.executeRefAction(tabId, command, input, target.ref, abortSignal);
    if (target && ('text' in target || 'role' in target || 'label' in target)) return this.executeSemanticAction(tabId, command, input, target, abortSignal);
    return this.executeMainAction(tabId, command, input, abortSignal);
  }

  private async runExclusive<T>(tabId: number, run: () => Promise<T>) {
    const previous = this.tabQueues.get(tabId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    this.tabQueues.set(tabId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.tabQueues.get(tabId) === tail) this.tabQueues.delete(tabId);
    }
  }

  private async executeMainAction(tabId: number, command: BrowserReplPageCommand, input: BrowserInput, abortSignal?: AbortSignal) {
    const result = await this.runFrameCommand(tabId, MAIN_FRAME_ID, command, abortSignal) as BrowserResult;
    return shouldResnapshotAfterMainAction(result) ? this.withFreshState(tabId, input, result, abortSignal) : this.withRoutedMainState(tabId, result);
  }

  private async executeRefAction(tabId: number, command: BrowserReplPageCommand, input: BrowserInput, ref: string, abortSignal?: AbortSignal) {
    const routed = this.refs.get(ref);
    if (!routed || routed.tabId !== tabId || this.latestSnapshotByTab.get(tabId) !== routed.snapshotId) return this.staleRef(tabId, input, STALE_REF_MESSAGE, abortSignal);
    const frame = (await this.frames(tabId, abortSignal)).find((item) => item.frameId === routed.frameId);
    if (!frame || frame.url !== routed.frameUrl) return this.staleRef(tabId, input, 'Ref is stale because the target frame changed. Use browser.snapshot again and retry with a new ref.', abortSignal);
    const nextInput = { ...input, target: { ref: routed.localRef } };
    const result = await this.runFrameCommand(tabId, routed.frameId, pageCommand(command, nextInput), abortSignal) as BrowserResult;
    if (routed.frameId !== MAIN_FRAME_ID) return this.withFreshState(tabId, input, result, abortSignal);
    return shouldResnapshotAfterMainAction(result) ? this.withFreshState(tabId, input, result, abortSignal) : this.withRoutedMainState(tabId, result);
  }

  private async executeSemanticAction(tabId: number, command: BrowserReplPageCommand, input: BrowserInput, target: PageTarget, abortSignal?: AbortSignal) {
    const frames = await this.frames(tabId, abortSignal);
    if (!frames.some((frame) => frame.frameId !== MAIN_FRAME_ID)) {
      const result = await this.runFrameCommand(tabId, MAIN_FRAME_ID, command, abortSignal) as BrowserResult;
      return this.withRoutedMainState(tabId, result);
    }

    const snapshot = await this.snapshot(tabId, pageCommand(command, snapshotInput(input)), abortSignal, frames) as BrowserResult;
    const state = isRecord(snapshot.state) ? snapshot.state : undefined;
    if (!snapshot.ok || !state) return snapshot;
    const resolved = resolveSnapshotTarget(state, target, input.action);
    if (!resolved.ok) return { ok: false, action: input.action, code: resolved.code, message: resolved.message, ...(resolved.candidates ? { candidates: resolved.candidates } : {}), state };
    return this.executeRefAction(tabId, command, { ...input, target: { ref: resolved.ref } }, resolved.ref, abortSignal);
  }

  private async snapshot(tabId: number, command: BrowserReplPageCommand, abortSignal?: AbortSignal, knownFrames?: FrameInfo[]) {
    const input = readBrowserInput(command);
    const frames = knownFrames ?? await this.frames(tabId, abortSignal);
    const snapshotId = newSnapshotId();
    this.clearTabRefs(tabId);
    this.latestSnapshotByTab.set(tabId, snapshotId);

    const mainFrame = frames.find((frame) => frame.frameId === MAIN_FRAME_ID) ?? { frameId: MAIN_FRAME_ID, url: '' };
    const main = await this.runFrameCommand(tabId, MAIN_FRAME_ID, command, abortSignal) as BrowserResult;
    if (!main.ok || !isRecord(main.state)) return main;

    const state = { ...main.state };
    const parentFrames = Array.isArray(state.frames) ? state.frames : [];
    state.elements = this.rewriteElements(state.elements, { tabId, frameId: MAIN_FRAME_ID, frameUrl: mainFrame.url || stringValue(state.url), snapshotId });

    const frameStates: Record<string, unknown>[] = [];
    for (const frame of frames.filter((item) => item.frameId !== MAIN_FRAME_ID)) {
      const frameNumber = frameStates.length + 1;
      frameStates.push(await this.frameState(tabId, frame, parentFrames[frameNumber - 1], frameNumber, command, snapshotId, abortSignal));
    }
    if (frameStates.length) state.frames = frameStates;
    else delete state.frames;
    state.hints = snapshotHints(state.hints, frameStates);
    state.truncated = Boolean(state.truncated) || frameStates.some((frame) => frame.truncated === true);
    return { ...main, action: input.action, state };
  }

  private async frameState(tabId: number, frame: FrameInfo, parentFrame: unknown, number: number, command: BrowserReplPageCommand, snapshotId: string, abortSignal?: AbortSignal) {
    const base = frameBase(frame, parentFrame, number);
    if (frame.errorOccurred || !isHttpUrl(frame.url)) return inaccessibleFrame(base, 'Frame is not an accessible http/https document.', frame.url);
    try {
      const result = await this.runFrameCommand(tabId, frame.frameId, command, abortSignal) as BrowserResult;
      if (!result.ok || !isRecord(result.state)) return inaccessibleFrame(base, result.message || 'Frame did not return readable browser state.', frame.url);
      const state = result.state;
      const elements = this.rewriteElements(state.elements, { tabId, frameId: frame.frameId, frameUrl: frame.url, snapshotId });
      return { ...base, title: shortText(stringValue(state.title) || stringValue(base.title)), url: frame.url || stringValue(state.url), accessible: true, readable: true, text: stringValue(state.text), elements, truncated: Boolean(state.truncated) };
    } catch (error) {
      return inaccessibleFrame(base, frameAccessReason(error), frame.url);
    }
  }

  private withRoutedMainState(tabId: number, result: BrowserResult) {
    const state = isRecord(result.state) ? { ...result.state } : undefined;
    if (!state) return result;
    const snapshotId = newSnapshotId();
    this.clearTabRefs(tabId);
    this.latestSnapshotByTab.set(tabId, snapshotId);
    state.elements = this.rewriteElements(state.elements, { tabId, frameId: MAIN_FRAME_ID, frameUrl: stringValue(state.url), snapshotId });
    state.hints = Array.isArray(state.hints) ? state.hints : [];
    state.truncated = state.truncated === true;
    return { ...result, state };
  }

  private async withFreshState(tabId: number, input: BrowserInput, result: BrowserResult, abortSignal?: AbortSignal) {
    const snapshot = await this.snapshot(tabId, { helper: 'browser', args: [snapshotInput(input)], cancelKey: crypto.randomUUID(), timeoutMs: input.timeoutMs }, abortSignal).catch(() => undefined) as BrowserResult | undefined;
    return isRecord(snapshot?.state) ? { ...result, state: snapshot.state } : result;
  }

  private async staleRef(tabId: number, input: BrowserInput, message: string, abortSignal?: AbortSignal) {
    const snapshot = await this.snapshot(tabId, { helper: 'browser', args: [snapshotInput(input)], cancelKey: crypto.randomUUID(), timeoutMs: input.timeoutMs }, abortSignal).catch(() => undefined) as BrowserResult | undefined;
    return { ok: false, action: input.action, code: 'STALE_REF', message, ...(isRecord(snapshot?.state) ? { state: snapshot.state } : {}) };
  }

  private rewriteElements(value: unknown, target: SnapshotTarget) {
    if (!Array.isArray(value)) return [];
    return value.filter(isRecord).map((element) => this.rewriteElement(element, target));
  }

  private rewriteElement(element: Record<string, unknown>, target: SnapshotTarget) {
    const localRef = typeof element.ref === 'string' ? element.ref : undefined;
    const { ref: _ref, selector: _selector, fingerprint: _fingerprint, fingerprintCount: _fingerprintCount, marker: _marker, stableId: _stableId, shadowPath: _shadowPath, ...visible } = element;
    if (!localRef) return visible;
    const ref = this.nextRef(target, localRef);
    return { ...visible, ref };
  }

  private nextRef(target: SnapshotTarget, localRef: string) {
    this.refSeq += 1;
    const ref = `b${target.snapshotId}.${this.refSeq}`;
    this.refs.set(ref, { ...target, localRef });
    return ref;
  }

  private clearTabRefs(tabId: number) {
    for (const [ref, routed] of this.refs) if (routed.tabId === tabId) this.refs.delete(ref);
  }

  private async frames(tabId: number, abortSignal?: AbortSignal) {
    const response = await this.callChromeApi('webNavigation.getAllFrames', [{ tabId }], abortSignal);
    const frames = Array.isArray(response) ? response.map(readFrame).filter((frame) => frame !== undefined) : [];
    if (!frames.some((frame) => frame.frameId === MAIN_FRAME_ID)) frames.unshift({ frameId: MAIN_FRAME_ID, url: '' });
    return frames.sort((left, right) => left.frameId - right.frameId);
  }
}

function readBrowserInput(command: BrowserReplPageCommand): BrowserInput {
  const input = isRecord(command.args[0]) ? command.args[0] as BrowserInput : undefined;
  if (!input || !isBrowserAction(input.action)) throw new Error('browser action is required');
  return input;
}

function snapshotInput(input: BrowserInput): BrowserInput {
  return { action: 'snapshot', ...(input.scope ? { scope: input.scope } : {}), ...(typeof input.limit === 'number' ? { limit: input.limit } : {}), ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}) };
}

function pageCommand(command: BrowserReplPageCommand, input: BrowserInput): BrowserReplPageCommand {
  return { helper: 'browser', args: [input], cancelKey: command.cancelKey, timeoutMs: command.timeoutMs };
}

function resolveSnapshotTarget(state: Record<string, unknown>, target: PageTarget, action: BrowserInput['action']) {
  const candidates = snapshotCandidates(state, action).map((candidate) => ({ ...candidate, score: scoreTarget(target, candidate.element) })).filter((candidate) => candidate.score >= 0.72).sort(compareCandidates);
  const query = targetQuery(target);
  if (!candidates.length) return { ok: false as const, code: 'NO_TARGET', message: noTargetMessage(query, state) };
  const exact = candidates.filter((candidate) => candidate.score === 1);
  const ambiguous = (exact.length ? exact : candidates.filter((candidate) => candidates[0].score - candidate.score < 0.08)).slice(0, 8);
  if (ambiguous.length > 1) return { ok: false as const, code: 'AMBIGUOUS_TARGET', message: `Multiple visible targets match: ${query}`, candidates: groupCandidates(ambiguous) };
  return { ok: true as const, ref: candidates[0].ref };
}

function snapshotCandidates(state: Record<string, unknown>, action: BrowserInput['action']) {
  const mainContext = { context: 'main', title: state.title, url: state.url };
  const result = elementCandidates(state.elements, mainContext, action);
  for (const frame of Array.isArray(state.frames) ? state.frames.filter(isRecord) : []) {
    if (frame.accessible !== true && frame.readable !== true) continue;
    const context = { context: 'frame', number: frame.number, title: frame.title, url: frame.url ?? frame.src };
    result.push(...elementCandidates(frame.elements, context, action));
  }
  return result;
}

function elementCandidates(value: unknown, context: Record<string, unknown>, action: BrowserInput['action']): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).filter((element) => typeof element.ref === 'string' && (action !== 'fill' || isFillCandidate(element))).map((element) => ({ ref: String(element.ref), score: 0, context, element }));
}

function scoreTarget(target: PageTarget, element: Record<string, unknown>) {
  if ('role' in target) return normalizeText(stringValue(element.role)) === normalizeText(target.role) ? textScore(target.name, stringValue(element.name)) : 0;
  if ('label' in target) return textScore(target.label, [element.name, element.text].map(stringValue).filter(Boolean).join(' '));
  if ('text' in target) return [element.name, element.text, element.value, element.href].map(stringValue).reduce((score, text) => Math.max(score, textScore(target.text, text)), 0);
  return 0;
}

function compareCandidates(left: Candidate, right: Candidate) {
  return right.score - left.score || Number(isDisabled(left.element)) - Number(isDisabled(right.element)) || candidateRank(left) - candidateRank(right);
}

function candidateRank(candidate: Candidate) {
  const rect = isRecord(candidate.element.rect) ? candidate.element.rect : {};
  return Number(rect.y ?? rect.top ?? 0) * 10_000 + Number(rect.x ?? rect.left ?? 0);
}

function groupCandidates(candidates: Candidate[]) {
  const groups = new Map<string, { frame: Record<string, unknown>; elements: unknown[] }>();
  for (const candidate of candidates) {
    const key = `${candidate.context.context}:${candidate.context.number ?? 0}`;
    const group = groups.get(key) ?? { frame: candidate.context, elements: [] };
    group.elements.push({ ...candidate.element, confidence: round(candidate.score) });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function noTargetMessage(query: string, state: Record<string, unknown>) {
  const inaccessible = (Array.isArray(state.frames) ? state.frames : []).filter((frame) => isRecord(frame) && frame.code === 'FRAME_NOT_ACCESSIBLE').length;
  return inaccessible ? `No visible interactive target matches: ${query}. ${inaccessible} iframe/frame(s) were not accessible; see frames[] FRAME_NOT_ACCESSIBLE hints.` : `No visible interactive target matches: ${query}`;
}

function frameBase(frame: FrameInfo, parentFrame: unknown, number: number) {
  const parent = isRecord(parentFrame) ? parentFrame : {};
  return { number, ...(parent.title ? { title: parent.title } : {}), url: frame.url || stringValue(parent.src), ...(parent.src ? { src: parent.src } : {}), ...(isRecord(parent.rect) ? { rect: parent.rect } : {}), ...(typeof parent.sameOrigin === 'boolean' ? { sameOrigin: parent.sameOrigin } : {}) };
}

function inaccessibleFrame(base: Record<string, unknown>, reason: string, url: string) {
  const origin = originPatternForUrl(url);
  return { ...base, accessible: false, readable: false, code: 'FRAME_NOT_ACCESSIBLE', reason: shortText(reason), hint: origin ? `Grant Website access for ${origin}, or open the iframe source page and operate it directly.` : FRAME_HINT };
}

function snapshotHints(value: unknown, frames: Record<string, unknown>[]) {
  const hints = Array.isArray(value) ? value.filter((hint): hint is string => typeof hint === 'string' && !hint.includes('iframe/frame(s) detected')) : [];
  if (!frames.length) return hints;
  const accessible = frames.filter((frame) => frame.accessible === true || frame.readable === true).length;
  hints.push(`${frames.length} iframe/frame(s) detected; ${accessible} accessible, ${frames.length - accessible} not accessible. Accessible frame elements are under frames[].elements and refs route automatically; inaccessible frames need Website access or opening the iframe source page.`);
  return hints;
}

function readFrame(value: unknown): FrameInfo | undefined {
  if (!isRecord(value) || !Number.isInteger(value.frameId) || Number(value.frameId) < 0) return undefined;
  return { frameId: Number(value.frameId), parentFrameId: Number.isInteger(value.parentFrameId) ? Number(value.parentFrameId) : undefined, url: typeof value.url === 'string' ? value.url : '', errorOccurred: value.errorOccurred === true };
}

function isBrowserAction(value: unknown): value is BrowserInput['action'] {
  return value === 'snapshot' || value === 'click' || value === 'fill' || value === 'press';
}

function isFillCandidate(element: Record<string, unknown>) {
  const tag = stringValue(element.tag);
  const role = stringValue(element.role);
  return element.kind === 'field' || ['input', 'textarea', 'select'].includes(tag) || ['textbox', 'combobox'].includes(role);
}

function isDisabled(element: Record<string, unknown>) {
  return isRecord(element.state) && element.state.disabled === true;
}

function shouldResnapshotAfterMainAction(result: BrowserResult) {
  return result.ok === false && result.code === 'ACTION_FAILED';
}

function targetQuery(target: PageTarget) {
  if ('role' in target) return `${target.role} ${target.name}`;
  if ('label' in target) return target.label;
  if ('text' in target) return target.text;
  if ('ref' in target) return target.ref;
  if ('x' in target) return `(${target.x}, ${target.y})`;
  return target.selector;
}

function frameAccessReason(error: unknown) {
  const message = stringifyError(error);
  if (/Cannot access|Missing host permission|host permission|permissions|activeTab|not allowed/i.test(message)) return 'Frame is not accessible with current Website access.';
  return message || 'Frame is not accessible.';
}

function textScore(left: string, right: string) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedRight.includes(normalizedLeft)) return Math.min(0.99, 0.86 + 0.13 * (normalizedLeft.length / normalizedRight.length));
  if (normalizedLeft.includes(normalizedRight)) return Math.min(0.9, 0.72 + 0.18 * (normalizedRight.length / normalizedLeft.length));
  return diceScore(normalizedLeft, normalizedRight);
}

function diceScore(left: string, right: string) {
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  const used = new Set<number>();
  let matches = 0;
  for (const gram of leftBigrams) {
    const index = rightBigrams.findIndex((next, offset) => next === gram && !used.has(offset));
    if (index >= 0) {
      used.add(index);
      matches += 1;
    }
  }
  return (2 * matches) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(text: string) {
  if (text.length <= 1) return [text];
  return [...text].slice(1).map((_char, index) => text.slice(index, index + 2));
}

function normalizeText(text: string) {
  return text.toLowerCase().replace(/[\s:：*＊\-_/()[\]{}【】（）"'“”‘’]+/g, '');
}

function isHttpUrl(value: string) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function newSnapshotId() {
  return (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 12);
}

function shortText(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
