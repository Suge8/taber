export type ActiveTabCandidate = {
  id?: number;
  url?: string;
  pendingUrl?: string;
};

export function selectOperableActiveTab<T extends ActiveTabCandidate>(tabs: T[]) {
  return tabs.find(isOperableTab);
}

export function isOperableTab(tab: ActiveTabCandidate) {
  const url = tab.url ?? tab.pendingUrl ?? '';
  return !/^(chrome|chrome-extension|edge|about):/i.test(url);
}
