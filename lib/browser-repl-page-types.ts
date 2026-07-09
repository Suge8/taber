import type { BrowserReplElementRef } from './browser-repl-command.ts';

export type BrowserPageTarget = { ref: string } | { role: string; name: string } | { label: string } | { text: string } | { selector: string } | { x: number; y: number };
export type BrowserStateOptions = { scope?: 'viewport' | 'page'; limit?: number };

export type BrowserReplPageLocator = {
  readVisibleText(options?: { limit?: number }): unknown;
  readLinksAndButtons(options?: { limit?: number }): unknown;
  listInteractiveElements(options?: { limit?: number }): unknown;
  queryText(text: string, options?: { limit?: number; contextChars?: number }): unknown;
  browserState(options?: BrowserStateOptions): unknown;
  resolvePageTarget(target: unknown, intent: 'click' | 'fill' | 'press'): { ok: true; element: HTMLElement } | { ok: false; code: string; message: string; candidates?: unknown[] };
  observe(options?: { scope?: 'page'; limit?: number }): unknown;
  query(selector: string, options?: { scope?: 'page'; limit?: number }): unknown;
  resolveTarget(target: unknown, helperName: string): HTMLElement;
  summarizeElement(element: Element, index: number): Record<string, unknown>;
  elementEvidence(element: HTMLElement): Record<string, unknown>;
  pickedElement(element: HTMLElement): unknown;
  evidenceElement(element: HTMLElement | undefined, selector: string, fingerprint?: string, anchor?: HTMLElement, filledValue?: string): HTMLElement;
  evidenceAnchor(element: HTMLElement): HTMLElement | undefined;
  matchesWait(options: { selector?: string; text?: string }): boolean;
  observeMutations(observer: MutationObserver): number;
  allText(): string;
  fieldCandidates(): { element: HTMLElement; selector: string; texts: { text: string; weight: number }[] }[];
  bestFieldMatch(field: string, candidates: { element: HTMLElement; selector: string; texts: { text: string; weight: number }[] }[], used: Set<HTMLElement>, threshold: number): { best?: { element: HTMLElement; selector: string; texts: { text: string; weight: number }[]; score: number }; ambiguous: unknown[]; preview?: unknown };
  readFillFormOptions(value: unknown): { fields: Record<string, string>; confidence: number; dryRun: boolean };
  elementRef(element: HTMLElement): BrowserReplElementRef;
  elementFingerprint(element: HTMLElement): string;
  elementValue(element: HTMLElement): unknown;
  valueSummary(value: unknown): string | undefined;
  isFillable(element: HTMLElement): boolean;
  isDisabled(element: HTMLElement): boolean;
  shortText(text: string): string;
  round(value: number): number;
};
