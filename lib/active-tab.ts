export type ActiveTabCandidate = {
  id?: number;
  url?: string;
  pendingUrl?: string;
};

export function selectOperableActiveTab<T extends ActiveTabCandidate>(tabs: T[]) {
  return tabs.find(isOperableTab);
}

export function isOperableTab(tab: ActiveTabCandidate) {
  return Number.isInteger(tab.id) && Number(tab.id) > 0 && /^https?:\/\//i.test(effectiveTabUrl(tab));
}

export function effectiveTabUrl(tab: ActiveTabCandidate) {
  return tab.pendingUrl || tab.url || '';
}

export function readRequiredWindowId(value: unknown) {
  if (Number.isInteger(value) && Number(value) > 0) return Number(value);
  throw new Error('Task windowId is required');
}
