import { browser } from 'wxt/browser';
import {
  allSitesOrigins,
  browserPageScriptConsentKey,
  type BrowserControlState,
} from '$lib/browser-access.ts';
import { database } from '$lib/db.ts';

export type { BrowserControlState } from '$lib/browser-access.ts';

export async function readBrowserControlState(): Promise<BrowserControlState> {
  const [allSites, consent] = await Promise.all([
    browser.permissions.contains({ origins: [...allSitesOrigins] }),
    database.settings.get(browserPageScriptConsentKey),
  ]);
  const userScriptsAvailable = browserUserScriptsAvailable();
  const ready = allSites && userScriptsAvailable;
  if (ready && consent?.value !== true) await setPageScriptConsent(true);
  return {
    allSites,
    userScriptsAvailable,
    ready,
    pageScriptConsent: ready || consent?.value === true,
  };
}

export function requestAllSitesAccess() {
  return browser.permissions.request({ origins: [...allSitesOrigins] });
}

async function setPageScriptConsent(value: boolean) {
  await database.settings.put({ key: browserPageScriptConsentKey, value });
}

function browserUserScriptsAvailable() {
  const smoke = globalThis as typeof globalThis & { __taberSmokeUserScriptsAvailable?: boolean };
  if (typeof location !== 'undefined' && location.search.includes('taber-smoke=1') && smoke.__taberSmokeUserScriptsAvailable === true) return true;
  return Boolean(browser.userScripts?.execute);
}
