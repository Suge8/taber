export const allSitesOrigins = ['http://*/*', 'https://*/*'] as const;
export const browserPageScriptConsentKey = 'browserPageScriptConsent';

export type BrowserControlState = {
  allSites: boolean;
  userScriptsAvailable: boolean;
  pageScriptConsent: boolean;
  ready: boolean;
};

export function originPatternForUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return undefined;
  }
}

export function browserControlReady(input: Pick<BrowserControlState, 'allSites' | 'userScriptsAvailable'>) {
  return input.allSites && input.userScriptsAvailable;
}

export function isPageAccessError(error: unknown) {
  const message = stringifyError(error);
  return /Cannot access|Missing host permission|host permission|permissions|Extensions gallery|Cannot access contents|activeTab|not allowed|userScripts|Browser Control/i.test(message);
}

export function pageAccessErrorMessage() {
  return 'Taber needs Browser Control access before it can inspect or change websites. Complete Browser Control in settings, then retry the task.';
}

export function userScriptsErrorMessage() {
  return 'browserjs requires Chrome User Scripts. Enable Allow User Scripts for Taber in chrome://extensions and retry.';
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
