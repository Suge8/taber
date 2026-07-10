/**
 * Subscription login UI adapters + shared OAuth error mapping.
 * Vendor protocol stays in codex-* / xai-*; this file only binds UI.
 */

import { browser } from 'wxt/browser';
import { loginOpenAICodex } from './codex-oauth.ts';
import {
  connectOpenAICodex,
  readCodexTokens,
  readFreshCodexTokens,
  refreshCodexModels,
} from './codex-provider.ts';
import { signOutOpenAICodex, signOutXaiSub } from './provider-config-flow.ts';
import { sortModelsForDisplay, type ProviderWithModels } from './provider-store.ts';
import type { Locale } from './sidepanel-i18n.ts';
import { messages } from './sidepanel-i18n.ts';
import { loginXaiSub } from './xai-oauth.ts';
import { connectXaiSub, readFreshXaiTokens, readXaiTokens } from './xai-provider.ts';

export type { ProviderWithModels };

export const SUBSCRIPTION_MODEL_PREVIEW = 4;

export type SubscriptionVendorId = 'chatgpt' | 'xai';

export type SubscriptionCopy = {
  title: string;
  description: string;
  login: string;
  loggingIn: string;
  loginStatus: string;
  connected: string;
  disconnected: string;
  refresh: string;
  signOut: string;
  noModels: string;
  saved: string;
  signedOut: string;
  pastePlaceholder: string;
  pasteSubmit: string;
  fallbackAccount: string;
  loginCancelled: string;
  loginTimedOut: string;
  loginInteractionRequired: string;
};

export function subscriptionCopy(locale: Locale, vendor: SubscriptionVendorId): SubscriptionCopy {
  const t = messages[locale].provider;
  if (vendor === 'chatgpt') {
    return {
      title: t.codexTitle,
      description: t.codexDescription,
      login: t.codexLogin,
      loggingIn: t.codexLoggingIn,
      loginStatus: t.loginStatus,
      connected: t.codexConnected,
      disconnected: t.codexDisconnected,
      refresh: t.codexRefresh,
      signOut: t.codexSignOut,
      noModels: t.codexNoModels,
      saved: t.codexSaved,
      signedOut: t.codexSignedOut,
      pastePlaceholder: '',
      pasteSubmit: '',
      fallbackAccount: t.codexProviderName,
      loginCancelled: t.codexLoginCancelled,
      loginTimedOut: t.codexLoginTimedOut,
      loginInteractionRequired: t.codexLoginInteractionRequired,
    };
  }
  return {
    title: t.xaiTitle,
    description: t.xaiDescription,
    login: t.xaiLogin,
    loggingIn: t.xaiLoggingIn,
    loginStatus: t.loginStatus,
    connected: t.xaiConnected,
    disconnected: t.xaiDisconnected,
    refresh: t.xaiRefresh,
    signOut: t.xaiSignOut,
    noModels: t.xaiNoModels,
    saved: t.xaiSaved,
    signedOut: t.xaiSignedOut,
    pastePlaceholder: t.xaiPastePlaceholder,
    pasteSubmit: t.xaiPasteSubmit,
    fallbackAccount: t.xaiFallbackAccount,
    loginCancelled: t.xaiLoginCancelled,
    loginTimedOut: t.xaiLoginTimedOut,
    loginInteractionRequired: t.xaiLoginTimedOut,
  };
}

export function mapOAuthLoginError(error: unknown, copy: SubscriptionCopy) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'OAuth tab was closed before completing login.' || message === 'OAuth login was cancelled.') {
    return { cancelled: true as const, message: copy.loginCancelled };
  }
  if (message === 'OAuth login timed out.') {
    return { cancelled: false as const, message: copy.loginTimedOut };
  }
  if (/user interaction required|interaction required|requires user interaction/i.test(message)) {
    return { cancelled: false as const, message: copy.loginInteractionRequired };
  }
  return { cancelled: false as const, message };
}

export function visibleSubscriptionModels(provider?: ProviderWithModels) {
  const models = sortModelsForDisplay((provider?.models ?? []).filter((model) => !model.unavailable && model.visibility !== 'hide'));
  return {
    all: models,
    preview: models.slice(0, SUBSCRIPTION_MODEL_PREVIEW),
  };
}

export type SubscriptionVendorAdapter = {
  id: SubscriptionVendorId;
  supportsPaste: boolean;
  login: (input: {
    waitForManualCode?: (ctx: { signal: AbortSignal }) => Promise<string>;
  }) => Promise<{ detail: string }>;
  refresh: (providerId: number) => Promise<{ detail?: string }>;
  signOut: (providerId: number) => Promise<void>;
  loadDetail: (providerId: number) => Promise<string>;
};

export function createChatgptAdapter(): SubscriptionVendorAdapter {
  return {
    id: 'chatgpt',
    supportsPaste: false,
    async login() {
      const tokens = await loginOpenAICodex({
        tabs: browser.tabs,
        identity: browser.identity,
        webNavigation: browser.webNavigation,
      });
      await connectOpenAICodex(tokens);
      return { detail: tokens.email ?? '' };
    },
    async refresh(providerId) {
      const tokens = await readFreshCodexTokens(providerId);
      await refreshCodexModels(providerId, tokens);
      return { detail: tokens.email ?? '' };
    },
    async signOut(providerId) {
      await signOutOpenAICodex(providerId);
    },
    async loadDetail(providerId) {
      return (await readCodexTokens(providerId))?.email ?? '';
    },
  };
}

export function createXaiAdapter(): SubscriptionVendorAdapter {
  return {
    id: 'xai',
    supportsPaste: true,
    async login({ waitForManualCode }) {
      const tokens = await loginXaiSub({
        tabs: browser.tabs,
        webNavigation: browser.webNavigation,
        waitForManualCode,
      });
      await connectXaiSub(tokens);
      return { detail: tokens.email || tokens.name || '' };
    },
    async refresh(providerId) {
      const tokens = await readFreshXaiTokens(providerId);
      return { detail: tokens.email || tokens.name || '' };
    },
    async signOut(providerId) {
      await signOutXaiSub(providerId);
    },
    async loadDetail(providerId) {
      const tokens = await readXaiTokens(providerId);
      return tokens?.email || tokens?.name || '';
    },
  };
}
