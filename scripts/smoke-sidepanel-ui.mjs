import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectCdp, connectTarget, delay, evaluate, evaluateStable, fetchJson, hasCdpEndpoint, waitForTarget } from './cdp-client.mjs';
import { prepareRuntimeBrowser } from './runtime-browser.mjs';

const extensionPath = resolve('.output/chrome-mv3');
const manifest = JSON.parse(readFileSync(resolve(extensionPath, 'manifest.json'), 'utf8'));
const sidepanelPath = manifest.side_panel?.default_path || 'sidepanel.html';
let runtime;
let sidepanelUrl;
let browserCdp;
let pageTarget;
let pageCdp;
let localeInitScriptId;

try {
  runtime = await prepareRuntimeBrowser({ required: true, allowLaunch: false });
  if (runtime.skipped) throw new Error(runtime.reason);

  sidepanelUrl = `chrome-extension://${runtime.extensionId}/${sidepanelPath}${sidepanelPath.includes('?') ? '&' : '?'}taber-smoke=1`;
  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  pageTarget = await browserCdp.send('Target.createTarget', { url: sidepanelUrl });
  const sidePanelOpenAttempt = await trySidePanelOpen();
  const page = await waitForTarget(runtime.cdpOrigin, (target) => target.id === pageTarget.targetId && hasCdpEndpoint(target), 15_000);
  pageCdp = await connectTarget(page);
  await pageCdp.send('Runtime.enable');
  await pageCdp.send('Page.enable');
  await pageCdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
  await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await pageCdp.send('Emulation.setLocaleOverride', { locale: 'en-US' }).catch(() => undefined);
  await installSendMessageStub(pageCdp);

  if (process.env.TABER_SMOKE_PHASE === 'history') {
    await evaluate(pageCdp, clearDatabaseExpression());
    await evaluate(pageCdp, seedDatabaseExpression());
    await evaluate(pageCdp, seedActivityStatusExpression());
    await reloadSidepanel(pageCdp);
    await waitForReady(pageCdp);
    await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const historyReport = await runHistoryPhase(pageCdp);
    const activityStatusReport = await runActivityStatusPhase(pageCdp);
    console.log(JSON.stringify({ sidePanelOpenAttempt, sidepanelUrl, history: historyReport, activityStatus: activityStatusReport }, null, 2));
    assertAll('history', historyReport);
    assertAll('activityStatus', activityStatusReport);
  } else {
    await evaluate(pageCdp, clearDatabaseExpression());
    await reloadSidepanel(pageCdp);
    const onboardingReport = await runOnboardingPhase(pageCdp);

    await evaluate(pageCdp, clearDatabaseExpression());
    await evaluate(pageCdp, seedDatabaseExpression({ browserControlReady: false }));
    await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await reloadSidepanel(pageCdp);
    const browserControlExistingModelReport = await runBrowserControlExistingModelPhase(pageCdp);
    await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    await evaluate(pageCdp, clearDatabaseExpression());
    await evaluate(pageCdp, seedOpenAIApiProviderExpression());
    await reloadSidepanel(pageCdp);
    const providerSettingsReport = await runProviderSettingsPhase(pageCdp);

    await evaluate(pageCdp, clearDatabaseExpression());
    await evaluate(pageCdp, seedDatabaseExpression());
    await evaluate(pageCdp, seedTargetSwitchExpression());
    await reloadSidepanel(pageCdp);
    const targetSwitchReport = await runTargetSwitchPhase(pageCdp);

    await evaluate(pageCdp, clearDatabaseExpression());
    await evaluate(pageCdp, seedDatabaseExpression());
    await reloadSidepanel(pageCdp);
    await waitForReady(pageCdp);
    await evaluateStable(pageCdp, waitForTextExpression('Summarize this page'));
    await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const idleSourcesReport = await runIdleSourcesPhase(pageCdp);
    await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const recoveryReport = await evaluateStable(pageCdp, recoveryReportExpression());
    const i18nReport = await runI18nPhase(pageCdp);
    await pageCdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const historyReport = await runHistoryPhase(pageCdp);
    const multiTurnReport = await runMultiTurnPhase(pageCdp);

    const output = { sidePanelOpenAttempt, sidepanelUrl, onboarding: onboardingReport, browserControlExistingModel: browserControlExistingModelReport, providerSettings: providerSettingsReport, targetSwitch: targetSwitchReport, idleSources: idleSourcesReport, recovery: recoveryReport, i18n: i18nReport, history: historyReport, multiTurn: multiTurnReport };
    console.log(JSON.stringify(output, null, 2));
    assertAll('onboarding', onboardingReport);
    assertAll('browserControlExistingModel', browserControlExistingModelReport);
    assertAll('providerSettings', providerSettingsReport);
    assertAll('targetSwitch', targetSwitchReport);
    assertAll('idleSources', idleSourcesReport);
    assertAll('recovery', recoveryReport);
    assertAll('i18n', i18nReport);
    assertAll('history', historyReport);
    assertAll('multiTurn', multiTurnReport);
  }
} finally {
  pageCdp?.close();
  if (browserCdp && pageTarget) await browserCdp.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => undefined);
  browserCdp?.close();
  if (runtime && !runtime.skipped) await runtime.close();
}

async function trySidePanelOpen() {
  const worker = await waitForTarget(
    runtime.cdpOrigin,
    (target) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${runtime.extensionId}/`) && hasCdpEndpoint(target),
    3_000,
  ).catch(() => undefined);
  if (!worker) return 'service worker target not available; verified sidepanel document directly';
  const workerCdp = await connectTarget(worker);
  try {
    return await evaluate(workerCdp, `new Promise(resolve => chrome.windows.getCurrent(window => chrome.sidePanel.open({ windowId: window.id }, () => resolve(chrome.runtime.lastError?.message || 'opened'))))`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    workerCdp.close();
  }
}

async function runOnboardingPhase(cdp) {
  await evaluateStable(cdp, waitForTextExpression('Permissions'));
  const browserAccessPosition = await readBrowserAccessPosition(cdp);
  const browserControlFirst = await evaluate(cdp, `(() => {
    const text = document.body.textContent || '';
    return text.includes('Permissions') && text.includes('Website access') && text.includes('Allow User Scripts') && !document.querySelector('[data-smoke="add-api-provider"]');
  })()`);

  await completeBrowserControl(cdp, 'provider');
  await evaluateStable(cdp, waitForTextExpression('API provider'));
  const providerAfterBrowserControl = await evaluate(cdp, `(() => document.body.innerText.includes('API provider'))()`);
  const browserAccessReturnedToTop = await waitForSettingsScrollTop(cdp);

  await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-smoke="add-api-provider"]') || [...document.querySelectorAll('button')].find((node) => node.textContent.includes('API provider'));
    if (!button) throw new Error('Add API provider button not found');
    button.click();
    return true;
  })()`);

  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (document.getElementById('onboarding-api-key') || document.getElementById('provider-api-key')) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('provider form did not render: ' + document.body.innerText.slice(0, 200))); }
    }, 50);
  })`);

  const onboardingVisible = await evaluate(cdp, `(() => Boolean(document.getElementById('onboarding-api-key') || document.getElementById('provider-api-key')))()`);
  await evaluate(cdp, fillOnboardingExpression({ apiKey: 'sk-smoke-TEST-1234' }));
  await evaluate(cdp, `(() => {
    const button = document.querySelector('button[aria-label="Load account models"]');
    if (!button) throw new Error('Load account models button not found');
    button.click();
    return true;
  })()`);
  await evaluateStable(cdp, waitForTextExpression('gpt-5.5'));

  await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-smoke="save-provider"]');
    if (!button) throw new Error('Save provider button not found');
    button.click();
    return true;
  })()`);

  await completeBrowserControl(cdp);

  return evaluate(cdp, `(() => {
    const text = document.body.innerText;
    const composer = document.querySelector('textarea[name="message"]');
    return {
      browserControlFirst: ${JSON.stringify(browserControlFirst)},
      browserAccessCentered: ${browserAccessPosition.centered},
      browserAccessFullyVisible: ${browserAccessPosition.fullyVisible},
      browserAccessReturnedToTop: ${browserAccessReturnedToTop},
      providerAfterBrowserControl: ${JSON.stringify(providerAfterBrowserControl)},
      onboardingVisibleBeforeSave: ${onboardingVisible},
      mainUiAfterBrowserControl: Boolean(composer) && !composer.disabled,
      showsConfiguredModel: text.includes('gpt-5.5'),
      composerPlaceholder: Boolean(composer && composer.placeholder.includes('Taber')),
      noHorizontalOverflow: !(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth),
    };
  })()`);
}

async function runBrowserControlExistingModelPhase(cdp) {
  await evaluateStable(cdp, waitForTextExpression('Permissions'));
  const browserAccessPosition = await readBrowserAccessPosition(cdp);
  const beforeDone = await evaluate(cdp, `(() => {
    const text = document.body.textContent || '';
    return {
      existingModelStillSeesBrowserControl: text.includes('Permissions') && text.includes('Website access') && text.includes('Allow User Scripts'),
      smoothMotionEnabled: !matchMedia('(prefers-reduced-motion: reduce)').matches,
      browserAccessCentered: ${browserAccessPosition.centered},
      browserAccessFullyVisible: ${browserAccessPosition.fullyVisible},
      providerOnboardingHidden: !document.querySelector('[data-smoke="add-api-provider"]') && !document.getElementById('onboarding-api-key'),
      mainUiHiddenBeforeBrowserControl: !document.querySelector('textarea[name="message"]'),
      noCurrentSiteChoice: !text.includes('Current site') && !text.includes('Allow this site'),
      noPageScriptsChoice: !text.includes('Page scripts') && !text.includes('Enable page scripts'),
      userScriptsGuidanceVisible: text.includes('Allow User Scripts') && (text.includes('Open extension details') || text.includes('Website access')),
      noHorizontalOverflowBeforeDone: !(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth),
    };
  })()`);

  await completeBrowserControl(cdp);
  const browserAccessReturnedToTop = await waitForSettingsScrollTop(cdp);

  const afterDone = await evaluate(cdp, `new Promise((resolve, reject) => {
    const readSetting = (key) => new Promise((resolveSetting, rejectSetting) => {
      const open = indexedDB.open('taber');
      open.onerror = () => rejectSetting(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['settings'], 'readonly');
        const req = tx.objectStore('settings').get(key);
        req.onsuccess = () => { const value = req.result?.value; db.close(); resolveSetting(value); };
        req.onerror = () => { db.close(); rejectSetting(req.error); };
      };
    });
    const containsAllSites = () => new Promise((resolveContains) => {
      chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }, (allowed) => resolveContains(Boolean(allowed)));
    });
    Promise.all([readSetting('browserPageScriptConsent'), containsAllSites()])
      .then(([pageScriptConsent, allSites]) => {
        const text = document.body.innerText;
        const composer = document.querySelector('textarea[name="message"]');
        resolve({
          mainUiAfterBrowserControl: Boolean(composer) && !composer.disabled,
          showsConfiguredModelAfterBrowserControl: text.includes('demo-model'),
          pageScriptConsentEnabled: pageScriptConsent === true,
          allSitesGranted: allSites === true,
          browserControlHiddenAfterDone: !text.includes('Website access') || Boolean(composer),
          noHorizontalOverflowAfterDone: !(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth),
        });
      }, reject);
  })`);

  return { ...beforeDone, browserAccessReturnedToTop, ...afterDone };
}

async function readBrowserAccessPosition(cdp) {
  return evaluateStable(cdp, `new Promise((resolve) => {
    const deadline = Date.now() + 5000;
    const read = () => {
      const target = document.querySelector('.fx-spotlight');
      let scroller = target?.parentElement;
      while (scroller && getComputedStyle(scroller).overflowY !== 'auto') scroller = scroller.parentElement;
      if (!target || !scroller) { resolve({ centered: false, fullyVisible: false }); return; }
      const targetRect = target.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const centerOffset = (targetRect.top + targetRect.bottom - scrollerRect.top - scrollerRect.bottom) / 2;
      const result = {
        centered: Math.abs(centerOffset) <= 3,
        fullyVisible: targetRect.top >= scrollerRect.top - 1 && targetRect.bottom <= scrollerRect.bottom + 1,
      };
      if ((result.centered && result.fullyVisible) || Date.now() > deadline) { resolve(result); return; }
      requestAnimationFrame(read);
    };
    read();
  })`);
}

async function waitForSettingsScrollTop(cdp) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      const dialog = document.querySelector('[data-slot="dialog-content"]');
      const scroller = [...(dialog?.querySelectorAll('div') || [])].find((node) => getComputedStyle(node).overflowY === 'auto');
      if (!dialog || (scroller && scroller.scrollTop <= 1)) { resolve(true); return; }
      if (Date.now() > deadline) { reject(new Error('settings did not return to the top')); return; }
      requestAnimationFrame(check);
    };
    check();
  })`);
}

async function runProviderSettingsPhase(cdp) {
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (document.querySelector('textarea[name="message"]')) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('main UI did not render for provider settings smoke: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === 'Settings');
    if (!button) throw new Error('settings button not found');
    button.click();
    return true;
  })()`);
  await evaluateStable(cdp, waitForTextExpression('Preferences'));
  await evaluate(cdp, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"], button')].find((node) => node.textContent.trim() === 'Models');
    if (!tab) throw new Error('models settings tab not found');
    tab.click();
    return true;
  })()`);
  await evaluateStable(cdp, waitForTextExpression('Saved (1)'));
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === 'Edit');
    if (!button) throw new Error('provider edit button not found');
    button.click();
    return true;
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (document.querySelector('button[aria-label="Load account models"]')) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('OpenAI provider edit controls did not render')); }
    }, 50);
  })`);
  return evaluate(cdp, `(() => {
    const visible = (node) => Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    const contextInputs = [...document.querySelectorAll('input[aria-label="Context"], input#provider-advanced-context, input#onboarding-provider-advanced-context')].filter(visible);
    const text = document.body.innerText;
    return {
      openAIProviderEditOpen: Boolean(document.querySelector('button[aria-label="Load account models"]')) && text.includes('gpt-unknown'),
      openAIEditHasNoContextInput: contextInputs.length === 0,
    };
  })()`);
}

async function completeBrowserControl(cdp, next = 'main') {
  const state = await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const expected = ${JSON.stringify(next)};
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (expected === 'provider' && document.body.innerText.includes('API provider')) { clearInterval(timer); resolve('ready'); return; }
      if (expected === 'main' && document.querySelector('textarea[name="message"]')) { clearInterval(timer); resolve('ready'); return; }
      if (document.body.textContent?.includes('Permissions')) { clearInterval(timer); resolve('permissions'); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('browser control state did not appear: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
  if (state === 'ready') return;
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => ['Grant', 'Allow all websites'].includes(node.textContent.trim()));
    if (!button) throw new Error('Grant browser access button not found');
    button.click();
    return true;
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const expected = ${JSON.stringify(next)};
      if (expected === 'provider' && document.body.innerText.includes('API provider')) { clearInterval(timer); resolve(true); return; }
      if (expected === 'main' && document.querySelector('textarea[name="message"]')) { clearInterval(timer); resolve(true); return; }
      const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Continue');
      if (button && !button.disabled) { button.click(); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('next UI did not appear after browser control: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
}

async function runTargetSwitchPhase(cdp) {
  await evaluateStable(cdp, waitForTextExpression('Taber is controlling this page'));
  const before = await evaluate(cdp, `(() => ({
    showsInitialTarget: document.body.innerText.includes('Initial target') && document.body.innerText.includes('Tab 41'),
    switchMessageNotSentYet: (window.__taberSwitchMessages || []).length === 0,
  }))()`);
  await evaluate(cdp, `(() => {
    const trigger = document.querySelector('[data-smoke="controlled-target"]');
    if (!trigger) throw new Error('controlled target trigger not found');
    trigger.click();
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const item = document.querySelector('[data-smoke="switch-target-current-tab"]');
      if (item) { item.click(); clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('switch target menu item not found: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
  await evaluateStable(cdp, waitForTextExpression('Change controlled page?'));
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Change page');
    if (!button) throw new Error('confirm switch button not found');
    button.click();
  })()`);
  await evaluateStable(cdp, waitForTextExpression('Selected tab'));
  await evaluate(cdp, `(() => {
    window.__taberSmokeActiveTab = { id: 53, windowId: 4, active: true, title: 'Chrome settings', url: 'chrome://settings' };
    const trigger = document.querySelector('[data-smoke="controlled-target"]');
    if (!trigger) throw new Error('controlled target trigger not found for unsupported active tab');
    trigger.click();
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const item = document.querySelector('[data-smoke="switch-target-current-tab"]');
      if (item) { item.click(); clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('switch target menu item not found for unsupported active tab: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
  await evaluateStable(cdp, waitForTextExpression('Change controlled page?'));
  await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === 'Change page');
    if (!button) throw new Error('confirm switch button not found for unsupported active tab');
    button.click();
  })()`);
  await evaluateStable(cdp, waitForTextExpression('Select an http/https page first'));
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const open = indexedDB.open('taber');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['agentEvents'], 'readonly');
      const req = tx.objectStore('agentEvents').getAll();
      req.onsuccess = () => {
        const text = document.body.innerText;
        const switchMessages = window.__taberSwitchMessages || [];
        const targetChanged = req.result.find((event) => event.type === 'task.targetChanged' && event.payload?.reason === 'userCurrentTab');
        db.close();
        resolve({
          ...${JSON.stringify(before)},
          menuSentSwitchTarget: switchMessages.length === 1 && switchMessages[0].type === 'taber.agent.switchTarget' && switchMessages[0].targetTabId === 52,
          wroteTargetChanged: Boolean(targetChanged && targetChanged.payload?.toTabId === 52),
          sourcesBarShowsNewTarget: text.includes('Taber is controlling this page') && text.includes('Selected tab') && text.includes('selected.example') && text.includes('Tab 52'),
          timelineHidesTargetChanged: !text.includes('Controlled page changed to Selected tab'),
          unsupportedActiveTabError: text.includes('Select an http/https page first') && text.includes('chrome://') && text.includes('file://'),
          noTechnicalDetailsAfterSwitch: !text.includes('Technical details'),
        });
      };
      req.onerror = () => { db.close(); reject(req.error); };
    };
  })`);
}

async function runIdleSourcesPhase(cdp) {
  await evaluateStable(cdp, waitForTextExpression('Last page'));
  const initial = await readSourceBarStyle(cdp);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: initial.triggerCenterX, y: initial.triggerCenterY });
  await waitForSourceBarMotion(cdp);
  const hovered = await readSourceBarStyle(cdp);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await waitForSourceBarMotion(cdp);
  const exited = await readSourceBarStyle(cdp);

  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const trigger = document.querySelector('[data-smoke="controlled-target"]');
    if (!trigger) {
      resolve({ idleSourcesTriggerVisible: false });
      return;
    }
    const triggerText = trigger.innerText || trigger.textContent || '';
    trigger.click();
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const text = document.body.innerText;
      if (!text.includes('Open last page') && Date.now() <= deadline) return;
      clearInterval(timer);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      resolve({
        idleSourcesTriggerVisible: true,
        idleShowsLastPage: triggerText.includes('Last page') && !triggerText.includes('Controlled page'),
        idleSwitchHidden: !document.querySelector('[data-smoke="switch-target-current-tab"]') && !text.includes('Use current tab'),
        idleSourcesLabelHidden: !text.includes('Sources') && !text.includes('View sources'),
        idleOpenLastPage: text.includes('Open last page'),
        sourceHoverFillsCard: ${JSON.stringify(initial.cardBackground)} !== ${JSON.stringify(hovered.cardBackground)} && ${JSON.stringify(hovered.triggerBackground)} === 'rgba(0, 0, 0, 0)',
        sourceHoverAnimatesIcon: ${JSON.stringify(hovered.iconMotion)} !== ${JSON.stringify(initial.iconMotion)},
        sourceHoverTransitionIsSmooth: ${JSON.stringify(initial.cardTransitionProperties)}.includes('background-color') && ${initial.cardTransitionMs} >= 180,
        sourceHoverExitRestoresCard: ${JSON.stringify(exited.cardBackground)} === ${JSON.stringify(initial.cardBackground)},
      });
    }, 50);
  })`);
}

async function readSourceBarStyle(cdp) {
  return evaluate(cdp, `(() => {
    const card = document.querySelector('[data-source-card]');
    const trigger = document.querySelector('[data-smoke="controlled-target"]');
    const icon = trigger?.querySelector('[data-source-icon]');
    if (!card || !trigger || !icon) throw new Error('source bar styling hooks not found');
    const cardStyle = getComputedStyle(card);
    const triggerStyle = getComputedStyle(trigger);
    const iconStyle = getComputedStyle(icon);
    const triggerRect = trigger.getBoundingClientRect();
    return {
      cardBackground: cardStyle.backgroundColor,
      cardTransitionProperties: cardStyle.transitionProperty,
      cardTransitionMs: Math.max(...cardStyle.transitionDuration.split(',').map((value) => Number.parseFloat(value) * (value.includes('ms') ? 1 : 1000))),
      triggerBackground: triggerStyle.backgroundColor,
      triggerCenterX: triggerRect.left + triggerRect.width / 2,
      triggerCenterY: triggerRect.top + triggerRect.height / 2,
      iconMotion: [iconStyle.transform, iconStyle.translate, iconStyle.scale].join('|'),
    };
  })()`);
}

async function waitForSourceBarMotion(cdp) {
  return evaluateStable(cdp, `new Promise((resolve) => requestAnimationFrame(() => {
    const card = document.querySelector('[data-source-card]');
    Promise.allSettled(card ? card.getAnimations({ subtree: true }).map((animation) => animation.finished) : []).then(() => resolve(true));
  }))`);
}

async function runI18nPhase(cdp) {
  const englishReport = await evaluate(cdp, `(() => {
    const composer = document.querySelector('textarea[name="message"]');
    return {
      defaultEnglish: document.body.innerText.includes('Last page') && composer?.placeholder.includes('Ask Taber'),
      hasSettingsButton: Boolean(document.querySelector('button[aria-label="Settings"]')),
    };
  })()`);
  await submitPrompt(cdp, 'Locale en prompt');
  await evaluateStable(cdp, waitForCapturedStartExpression(1));
  await evaluateStable(cdp, waitForTextExpression('Locale en prompt done.'));
  const englishStartReport = await evaluate(cdp, `(() => {
    const message = window.__taberStartMessages?.at(-1);
    return { sidepanelSentEnglishLocale: message?.locale === 'en' && message?.prompt === 'Locale en prompt' };
  })()`);

  await setLocaleInPage(cdp, 'zh');
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const composer = document.querySelector('textarea[name="message"]');
      const settings = document.querySelector('button[aria-label="设置"]');
      if (composer?.placeholder.includes('让 Taber') && settings) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Chinese UI did not apply')); }
    }, 50);
  })`);
  const chineseReport = await evaluate(cdp, `(() => {
    const composer = document.querySelector('textarea[name="message"]');
    return {
      switchedToChinese: composer?.placeholder.includes('让 Taber') && Boolean(document.querySelector('button[aria-label="设置"]')),
      storedChinese: localStorage.getItem('taber.locale') === 'zh',
      agentTextUntranslated: document.body.innerText.includes('Summary ready.'),
      dataUntranslated: document.body.innerText.includes('demo-model') && document.body.innerText.includes('Summary ready.'),
    };
  })()`);
  await submitPrompt(cdp, 'Locale zh prompt');
  await evaluateStable(cdp, waitForCapturedStartExpression(2));
  await evaluateStable(cdp, waitForTextExpression('Locale zh prompt done.'));
  const chineseStartReport = await evaluate(cdp, `(() => {
    const message = window.__taberStartMessages?.at(-1);
    return { sidepanelSentChineseLocale: message?.locale === 'zh' && message?.prompt === 'Locale zh prompt' };
  })()`);

  await pageReload(cdp);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const composer = document.querySelector('textarea[name="message"]');
      if (composer?.placeholder.includes('让 Taber')) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Chinese locale did not persist: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
  const persistedReport = await evaluate(cdp, `(() => {
    const composer = document.querySelector('textarea[name="message"]');
    return {
      persistedChinese: composer?.placeholder.includes('让 Taber'),
    };
  })()`);

  await setLocaleInPage(cdp, 'en');
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const composer = document.querySelector('textarea[name="message"]');
      if (composer?.placeholder.includes('Ask Taber')) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('English locale did not apply: ' + document.body.innerText.slice(0, 300))); }
    }, 50);
  })`);
  const englishAgainReport = await evaluate(cdp, `(() => {
    const composer = document.querySelector('textarea[name="message"]');
    return {
      switchedBackEnglish: composer?.placeholder.includes('Ask Taber'),
      storedEnglish: localStorage.getItem('taber.locale') === 'en',
    };
  })()`);

  return { ...englishReport, ...englishStartReport, ...chineseReport, ...chineseStartReport, ...persistedReport, ...englishAgainReport };
}

async function runHistoryPhase(cdp) {
  await openHistory(cdp);
  const listReport = await evaluate(cdp, `(() => ({
    listShowsOlder: document.body.innerText.includes('Older session'),
    listShowsLatest: document.body.innerText.includes('Latest markdown session'),
  }))()`);

  const oldTransition = await selectHistoryItem(cdp, 'Older session', ['2', '1']);
  await waitForSessionView(cdp, '1');

  await evaluate(cdp, `(() => {
    const style = document.createElement('style');
    style.id = 'history-overflow-smoke';
    style.textContent = '[data-smoke="session-history"] { max-height: 112px !important; }';
    document.head.append(style);
  })()`);
  await openHistory(cdp);
  const currentSessionPositioned = await evaluateStable(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const content = document.querySelector('[data-smoke="session-history"]');
    const actions = content?.querySelector('[data-history-actions]');
    const current = content?.querySelector('[data-current-session]');
    if (!content || !actions || !current) { resolve(false); return; }
    const contentRect = content.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const currentRect = current.getBoundingClientRect();
    resolve(content.scrollTop > 0 && currentRect.top >= actionsRect.bottom - 3 && currentRect.bottom <= contentRect.bottom + 3);
  })))`);
  await evaluate(cdp, `document.getElementById('history-overflow-smoke')?.remove()`);
  const newTransition = await selectHistoryItem(cdp, 'New session', ['1', 'new']);
  await waitForSessionView(cdp, 'new');

  await openHistory(cdp);
  const returnTransition = await selectHistoryItem(cdp, 'Older session', ['new', '1']);
  await waitForSessionView(cdp, '1');

  await openHistory(cdp);
  const rapidLatestThenNewKeepsNew = await selectHistoryThenNewRapidly(cdp);

  await openHistory(cdp);
  await selectHistoryItem(cdp, 'Older session', ['new', '1']);
  await waitForSessionView(cdp, '1');

  return evaluate(cdp, `(() => ({
    ...${JSON.stringify(listReport)},
    historyExitEnterOverlap: ${oldTransition},
    currentSessionPositioned: ${currentSessionPositioned},
    newSessionExitEnterOverlap: ${newTransition},
    returnHistoryExitEnterOverlap: ${returnTransition},
    rapidLatestThenNewKeepsNew: ${rapidLatestThenNewKeepsNew},
    switchedToOldTimeline: document.body.innerText.includes('Old answer only.') && !document.body.innerText.includes('Summary ready.'),
  }))()`);
}

async function runActivityStatusPhase(cdp) {
  const cases = [
    { title: 'Successful activity', from: '1', to: '3', expected: 'Completed 1 step', status: 'completed', tone: 'text-success' },
    { title: 'Failed activity', from: '3', to: '4', expected: 'Failed after 1 step', status: 'failed', tone: 'text-danger' },
    { title: 'Stopped activity', from: '4', to: '5', expected: 'Stopped after 1 step', status: 'stopped', tone: 'text-muted-foreground' },
    { title: 'Recovered activity', from: '5', to: '7', expected: 'Completed 2 steps', status: 'completed', tone: 'text-success' },
    { title: 'Streaming text activity', from: '7', to: '6', expected: 'Completed 1 step', status: 'completed', tone: 'text-success' },
  ];
  const report = {};
  for (const item of cases) {
    await openHistory(cdp);
    await selectHistoryItem(cdp, item.title, [item.from, item.to]);
    await waitForSessionView(cdp, item.to);
    report[item.to] = await evaluate(cdp, `(() => {
      const group = document.querySelector('[data-activity-status]');
      const label = group?.querySelector('[data-activity-label]');
      const probe = document.createElement('span');
      probe.className = ${JSON.stringify(item.tone)};
      document.body.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      return document.body.innerText.includes(${JSON.stringify(item.expected)})
        && group?.getAttribute('data-activity-status') === ${JSON.stringify(item.status)}
        && Boolean(label)
        && getComputedStyle(label).color === expectedColor;
    })()`);
  }
  const streamingTextState = await evaluate(cdp, `(() => {
    const group = document.querySelector('[data-activity-status]');
    return group?.getAttribute('data-activity-status') === 'completed' && !group.classList.contains('fx-beam');
  })()`);
  const activityIconHoverScoped = await verifyActivityIconHoverScope(cdp);
  return {
    completedGroupSummary: report['3'],
    failedGroupSummary: report['4'],
    stoppedGroupSummary: report['5'],
    recoveredGroupCompleted: report['7'],
    streamingTextGroupCompleted: report['6'],
    streamingTextGroupNoRunningEffect: streamingTextState,
    activityIconHoverScoped,
  };
}

async function verifyActivityIconHoverScope(cdp) {
  const points = await evaluate(cdp, `(() => {
    const trigger = document.querySelector('[data-activity-trigger]');
    const text = [...document.querySelectorAll('[data-role="assistant"] *')]
      .find((element) => element.children.length === 0 && element.textContent.includes('Writing answer'));
    if (!trigger || !text || !document.querySelector('.fx-fan')) return undefined;
    const triggerRect = trigger.getBoundingClientRect();
    const textRect = text.getBoundingClientRect();
    return {
      trigger: { x: triggerRect.left + triggerRect.width / 2, y: triggerRect.top + triggerRect.height / 2 },
      text: { x: textRect.left + textRect.width / 2, y: textRect.top + textRect.height / 2 },
    };
  })()`);
  if (!points) return false;

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  await delay(360);
  const baseTransform = await evaluate(cdp, `getComputedStyle(document.querySelector('.fx-fan')).transform`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.text });
  await delay(360);
  const textTransform = await evaluate(cdp, `getComputedStyle(document.querySelector('.fx-fan')).transform`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points.trigger });
  await delay(360);
  const triggerTransform = await evaluate(cdp, `getComputedStyle(document.querySelector('.fx-fan')).transform`);
  return textTransform === baseTransform && triggerTransform !== baseTransform;
}

async function openHistory(cdp) {
  await evaluate(cdp, `(() => {
    const button = document.querySelector('button[aria-label="Session history"]');
    if (!button) throw new Error('history button not found');
    button.click();
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const text = document.body.innerText;
      if (text.includes('Older session') && text.includes('Latest markdown session')) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('history list did not render: ' + text.slice(0, 400))); }
    }, 20);
  })`);
}

async function selectHistoryItem(cdp, label, expectedViews) {
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes(${JSON.stringify(label)}));
    if (!item) { reject(new Error('history item not found: ' + ${JSON.stringify(label)})); return; }
    item.click();
    const expected = ${JSON.stringify(expectedViews)};
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const views = [...document.querySelectorAll('[data-session-view]')].map((node) => node.getAttribute('data-session-view'));
      if (expected.every((value) => views.includes(value))) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('session transition did not overlap: ' + JSON.stringify({ label: ${JSON.stringify(label)}, expected, views }))); }
    }, 10);
  })`);
}

async function waitForSessionView(cdp, expected) {
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const views = [...document.querySelectorAll('[data-session-view]')].map((node) => node.getAttribute('data-session-view'));
      if (views.length === 1 && views[0] === ${JSON.stringify(expected)}) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('session view did not settle: ' + JSON.stringify({ expected: ${JSON.stringify(expected)}, views }))); }
    }, 20);
  })`);
}

async function selectHistoryThenNewRapidly(cdp) {
  await evaluate(cdp, `(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const latest = items.find((node) => node.textContent.includes('Latest markdown session'));
    const fresh = items.find((node) => node.textContent.includes('New session'));
    if (!latest || !fresh) throw new Error('rapid session switch items not found');
    latest.click();
    fresh.click();
  })()`);
  return evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    let stableSince;
    const timer = setInterval(() => {
      const views = [...document.querySelectorAll('[data-session-view]')].map((node) => node.getAttribute('data-session-view'));
      if (views.length === 1 && views[0] === 'new') {
        stableSince ??= performance.now();
        if (performance.now() - stableSince >= 400) { clearInterval(timer); resolve(true); }
        return;
      }
      stableSince = undefined;
      if (performance.now() > deadline) { clearInterval(timer); reject(new Error('stale session request replaced latest selection: ' + JSON.stringify({ views }))); }
    }, 20);
  })`);
}

async function runMultiTurnPhase(cdp) {
  await installSendMessageStub(cdp);
  await submitPrompt(cdp, 'Follow up one');
  await evaluateStable(cdp, waitForCapturedStartExpression(1));
  await evaluateStable(cdp, waitForTextExpression('Follow up one done.'));
  await submitPrompt(cdp, 'Follow up two');
  await evaluateStable(cdp, waitForCapturedStartExpression(2));
  await evaluateStable(cdp, waitForTextExpression('Follow up two done.'));
  return evaluate(cdp, `new Promise((resolve, reject) => {
    const open = indexedDB.open('taber');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['sessions', 'agentEvents'], 'readonly');
      const sessionReq = tx.objectStore('sessions').getAll();
      const eventReq = tx.objectStore('agentEvents').getAll();
      tx.oncomplete = () => {
        const starts = eventReq.result.filter((event) => event.sessionId === 1 && event.type === 'task.started' && String(event.payload.prompt).startsWith('Follow up'));
        const captured = window.__taberStartMessages || [];
        resolve({
          sentTwoStarts: captured.length === 2,
          bothPassedCurrentSessionId: captured.every((message) => message.sessionId === 1),
          eventsAccumulatedInSameSession: starts.length === 2,
          didNotCreateSession: sessionReq.result.length === 2,
          timelineContinues: document.body.innerText.includes('Follow up one done.') && document.body.innerText.includes('Follow up two done.'),
        });
      };
      tx.onerror = () => reject(tx.error);
    };
  })`);
}

async function setLocaleInPage(cdp, locale) {
  const source = `localStorage.setItem('taber.locale', ${JSON.stringify(locale)}); localStorage.setItem('taber.locale.manual', 'true'); globalThis.chrome?.storage?.local?.set({ 'taber.locale': ${JSON.stringify(locale)}, 'taber.locale.manual': true });`;
  if (localeInitScriptId) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: localeInitScriptId });
  localeInitScriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
  await persistLocale(cdp, locale);
  await evaluate(cdp, `window.dispatchEvent(new Event('taber.localechange'))`);
}

async function installSendMessageStub(cdp) {
  const source = installSendMessageStubExpression();
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await evaluate(cdp, source).catch(() => undefined);
}

async function persistLocale(cdp, locale) {
  await evaluate(cdp, `new Promise((resolve, reject) => {
    localStorage.setItem('taber.locale', ${JSON.stringify(locale)});
    localStorage.setItem('taber.locale.manual', 'true');
    if (!globalThis.chrome?.storage?.local) { resolve(localStorage.getItem('taber.locale')); return; }
    chrome.storage.local.set({ 'taber.locale': ${JSON.stringify(locale)}, 'taber.locale.manual': true }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(localStorage.getItem('taber.locale'));
    });
  })`);
}

async function submitPrompt(cdp, text) {
  await evaluate(cdp, `(() => {
    const textarea = document.querySelector('textarea[name="message"]');
    if (!textarea) throw new Error('composer textarea not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluateStable(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const textarea = document.querySelector('textarea[name="message"]');
      const form = textarea?.closest('form');
      const button = form?.querySelector('[data-prompt-input-submit], button[aria-label="Submit"]');
      if (button && !button.disabled) { clearInterval(timer); button.click(); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('submit button did not become enabled')); }
    }, 50);
  })`);
}

async function waitForReady(cdp) {
  await evaluateStable(cdp, waitForTextExpression('Summary ready.'));
}

async function pageReload(cdp) {
  await reloadSidepanel(cdp);
}

async function reloadSidepanel(cdp) {
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stopListening();
      reject(new Error('sidepanel reload timed out'));
    }, 5000);
    const stopListening = cdp.on('Page.loadEventFired', () => {
      clearTimeout(timeout);
      stopListening();
      resolve(true);
    });
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  await loaded;
  await evaluateStable(cdp, installSendMessageStubExpression());
  await evaluate(cdp, `window.dispatchEvent(new Event('focus'))`);
}

function waitForCapturedStartExpression(count) {
  return `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      const captured = window.__taberStartMessages || [];
      if (captured.length >= ${count}) { clearInterval(timer); resolve(true); return; }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('startTask stub did not capture submit: ' + JSON.stringify({ count: captured.length, hook: Boolean(window.__taberSmokeStartTask), search: location.search, href: location.href, text: document.body.innerText.slice(0, 300) }))); }
    }, 50);
  })`;
}

function waitForTextExpression(text) {
  return `new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (document.body.textContent?.includes(${JSON.stringify(text)})) {
        clearInterval(timer); resolve(true); return;
      }
      if (Date.now() > deadline) { clearInterval(timer); reject(new Error('sidepanel did not render expected text (locale=' + localStorage.getItem('taber.locale') + '): ' + document.body.innerText.slice(0, 400))); }
    }, 50);
  })`;
}

function fillOnboardingExpression({ apiKey }) {
  return `(() => {
    const el = document.getElementById('onboarding-api-key') || document.getElementById('provider-api-key');
    if (!el) throw new Error('input not found: onboarding-api-key/provider-api-key');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(apiKey)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function clearDatabaseExpression() {
  return `(async () => {
    const createTaberStores = (db) => {
      if (!db.objectStoreNames.contains('providers')) { const store = db.createObjectStore('providers', { keyPath: 'id', autoIncrement: true }); store.createIndex('kind', 'kind'); store.createIndex('name', 'name'); }
      if (!db.objectStoreNames.contains('providerCredentials')) { const store = db.createObjectStore('providerCredentials', { keyPath: 'providerId' }); store.createIndex('kind', 'kind'); }
      if (!db.objectStoreNames.contains('models')) { const store = db.createObjectStore('models', { keyPath: 'id', autoIncrement: true }); store.createIndex('providerId', 'providerId'); store.createIndex('name', 'name'); }
      if (!db.objectStoreNames.contains('sessions')) { const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true }); store.createIndex('updatedAt', 'updatedAt'); store.createIndex('pinned', 'pinned'); }
      if (!db.objectStoreNames.contains('toolRuns')) { const store = db.createObjectStore('toolRuns', { keyPath: 'id', autoIncrement: true }); store.createIndex('sessionId', 'sessionId'); store.createIndex('createdAt', 'createdAt'); store.createIndex('toolName', 'toolName'); }
      if (!db.objectStoreNames.contains('agentEvents')) { const store = db.createObjectStore('agentEvents', { keyPath: 'id', autoIncrement: true }); store.createIndex('sessionId', 'sessionId'); store.createIndex('createdAt', 'createdAt'); store.createIndex('type', 'type'); }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    localStorage.setItem('taber.locale', 'en');
    localStorage.setItem('__taberSmokeAllSitesGranted', 'false');
    await chrome.storage.local.set({ 'taber.locale': 'en' });
    if (chrome.permissions?.remove) await new Promise((resolve) => {
      chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }, () => resolve(true));
    });
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('taber');
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve(true);
    });
    const open = indexedDB.open('taber');
    open.onupgradeneeded = () => createTaberStores(open.result);
    const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const stores = ['providers', 'providerCredentials', 'models', 'sessions', 'toolRuns', 'agentEvents', 'settings'].filter((store) => db.objectStoreNames.contains(store));
    if (stores.length > 0) await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      for (const store of stores) tx.objectStore(store).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  })()`;
}

function seedOpenAIApiProviderExpression() {
  return `
(async () => {
  localStorage.setItem('__taberSmokeAllSitesGranted', 'true');
  const open = indexedDB.open('taber');
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const stores = ['providers', 'providerCredentials', 'models', 'sessions', 'agentEvents', 'settings'];
  await new Promise((resolve, reject) => {
    const clearTx = db.transaction(stores, 'readwrite');
    for (const store of stores) clearTx.objectStore(store).clear();
    clearTx.oncomplete = resolve;
    clearTx.onerror = () => reject(clearTx.error);
  });
  const tx = db.transaction(stores, 'readwrite');
  const put = (store, value) => tx.objectStore(store).put(value);
  const now = Date.now();
  put('providers', { id: 1, kind: 'openaiApiKey', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', createdAt: now, updatedAt: now });
  put('providerCredentials', { providerId: 1, kind: 'apiKey', value: { apiKey: 'sk-openai-smoke' }, updatedAt: now });
  put('models', { id: 1, providerId: 1, name: 'gpt-unknown', contextWindowTokens: 128000, supportedReasoningEfforts: [] });
  put('settings', { key: 'selectedModelId', value: 1 });
  put('settings', { key: 'browserPageScriptConsent', value: true });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
})()`;
}

function seedDatabaseExpression({ browserControlReady = true } = {}) {
  return `
(async () => {
  localStorage.setItem('__taberSmokeAllSitesGranted', ${JSON.stringify(browserControlReady ? 'true' : 'false')});
  const open = indexedDB.open('taber');
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('providers')) {
      const store = db.createObjectStore('providers', { keyPath: 'id', autoIncrement: true });
      store.createIndex('kind', 'kind'); store.createIndex('name', 'name');
    }
    if (!db.objectStoreNames.contains('providerCredentials')) {
      const store = db.createObjectStore('providerCredentials', { keyPath: 'providerId' });
      store.createIndex('kind', 'kind');
    }
    if (!db.objectStoreNames.contains('models')) {
      const store = db.createObjectStore('models', { keyPath: 'id', autoIncrement: true });
      store.createIndex('providerId', 'providerId'); store.createIndex('name', 'name');
    }
    if (!db.objectStoreNames.contains('sessions')) {
      const store = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
      store.createIndex('updatedAt', 'updatedAt'); store.createIndex('pinned', 'pinned');
    }
    if (!db.objectStoreNames.contains('toolRuns')) {
      const store = db.createObjectStore('toolRuns', { keyPath: 'id', autoIncrement: true });
      store.createIndex('sessionId', 'sessionId'); store.createIndex('createdAt', 'createdAt'); store.createIndex('toolName', 'toolName');
    }
    if (!db.objectStoreNames.contains('agentEvents')) {
      const store = db.createObjectStore('agentEvents', { keyPath: 'id', autoIncrement: true });
      store.createIndex('sessionId', 'sessionId'); store.createIndex('createdAt', 'createdAt'); store.createIndex('type', 'type');
    }
    if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
  };
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const stores = ['providers', 'providerCredentials', 'models', 'sessions', 'agentEvents', 'settings'];
  await new Promise((resolve, reject) => {
    const clearTx = db.transaction(stores, 'readwrite');
    for (const store of stores) clearTx.objectStore(store).clear();
    clearTx.oncomplete = resolve;
    clearTx.onerror = () => reject(clearTx.error);
  });
  const tx = db.transaction(stores, 'readwrite');
  const put = (store, value) => tx.objectStore(store).put(value);
  const now = Date.now();
  put('providers', { id: 1, kind: 'openaiCompatible', name: 'Demo', baseURL: 'https://api.example.test', createdAt: now, updatedAt: now });
  put('providerCredentials', { providerId: 1, kind: 'apiKey', value: { apiKey: 'sk-demoTEST' }, updatedAt: now });
  put('models', { id: 1, providerId: 1, name: 'demo-model', contextWindowTokens: 128000 });
  put('settings', { key: 'selectedModelId', value: 1 });
  put('settings', { key: 'browserPageScriptConsent', value: ${JSON.stringify(browserControlReady)} });
  put('sessions', { id: 1, title: 'Older session', pinned: true, createdAt: now - 20000, updatedAt: now - 10000 });
  put('sessions', { id: 2, title: 'Latest markdown session', pinned: false, createdAt: now - 6000, updatedAt: now });
  put('agentEvents', { id: 1, sessionId: 1, type: 'task.started', payload: { taskId: 'old-task', prompt: 'Older prompt', context: { title: 'Old', url: 'https://example.com/old' } }, createdAt: now - 19000 });
  put('agentEvents', { id: 2, sessionId: 1, type: 'task.completed', payload: { taskId: 'old-task', text: 'Old answer only.' }, createdAt: now - 18000 });
  put('agentEvents', { id: 3, sessionId: 2, type: 'task.started', payload: { taskId: 'task-1', prompt: 'Summarize this page', context: { id: 31, windowId: 4, title: 'Example', url: 'https://example.com/article', favIconUrl: 'https://example.com/favicon.ico' } }, createdAt: now - 5000 });
  put('agentEvents', { id: 4, sessionId: 2, type: 'tool.started', payload: { taskId: 'task-1', toolName: 'getDocument', input: { source: 'currentPage', mode: 'article', chainOfThought: 'secret-cot', nested: { note: '<think>nested-input-secret</think>Visible' } } }, createdAt: now - 4500 });
  put('agentEvents', { id: 5, sessionId: 2, type: 'tool.completed', payload: { taskId: 'task-1', toolName: 'getDocument', output: { ok: true, source: 'currentPage', mode: 'article', url: 'https://example.com/article', content: 'Summary ready.', contentChars: 14, truncated: false, reasoning: 'secret-reasoning', reasoningSummary: 'safe-summary', nested: { note: '<think attr="x">nested-output-secret</think>Visible' } } }, createdAt: now - 3500 });
  put('agentEvents', { id: 6, sessionId: 2, type: 'tool.completed', payload: { taskId: 'task-1', toolName: 'extractImage', output: { ok: true, source: 'viewport', dataUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', mediaType: 'image/gif', width: 1, height: 1 } }, createdAt: now - 3000 });
  put('agentEvents', { id: 7, sessionId: 2, type: 'tool.started', payload: { taskId: 'task-1', toolName: 'debugger', input: { action: 'failedRequests' } }, createdAt: now - 2500 });
  put('agentEvents', { id: 8, sessionId: 2, type: 'tool.failed', payload: { taskId: 'task-1', toolName: 'debugger', error: 'debugger attach failed' }, createdAt: now - 2000 });
  put('agentEvents', { id: 9, sessionId: 2, type: 'task.targetChanged', payload: { taskId: 'task-1', fromTabId: 31, toTabId: 32, reason: 'switchTab', tab: { id: 32, windowId: 4, title: 'Target article', url: 'https://target.example/article', favIconUrl: 'https://target.example/favicon.ico' } }, createdAt: now - 1500 });
  put('agentEvents', { id: 10, sessionId: 2, type: 'message.created', payload: { taskId: 'task-1', role: 'assistant', text: '<think>private reasoning</think>**Summary ready.**\\n\\n- First item\\n- Second item\\n\\n~~~js\\nconsole.log(1)\\n~~~\\n\\n<img src=x onerror="window.__taberXss=1">\\n\\n<think>unterminated-think' }, createdAt: now - 1000 });
  put('agentEvents', { id: 11, sessionId: 2, type: 'message.created', payload: { taskId: 'task-1', role: 'assistant', text: '<think >space-secret</think><think attr="x">attr-secret</think><think\\n>newline-secret</think>Fence visible.\\n~~~ reasoning\\nspace-fence-secret\\n~~~\\n~~~reasoning\\nunterminated-fence\\n~~~cot\\ncot-fence-secret\\n~~~\\n~~~raw-reasoning\\nraw-fence-secret\\n~~~' }, createdAt: now - 900 });
  put('agentEvents', { id: 12, sessionId: 2, type: 'task.completed', payload: { taskId: 'task-1', text: 'Summary ready.' }, createdAt: now - 800 });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
})()`;
}

function seedActivityStatusExpression() {
  return `new Promise((resolve, reject) => {
    const open = indexedDB.open('taber');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const now = Date.now();
      const tx = db.transaction(['sessions', 'agentEvents'], 'readwrite');
      const sessions = tx.objectStore('sessions');
      const events = tx.objectStore('agentEvents');
      sessions.put({ id: 3, title: 'Successful activity', pinned: false, createdAt: now - 60000, updatedAt: now - 50000 });
      sessions.put({ id: 4, title: 'Failed activity', pinned: false, createdAt: now - 70000, updatedAt: now - 60000 });
      sessions.put({ id: 5, title: 'Stopped activity', pinned: false, createdAt: now - 80000, updatedAt: now - 70000 });
      sessions.put({ id: 6, title: 'Streaming text activity', pinned: false, createdAt: now - 90000, updatedAt: now - 80000 });
      sessions.put({ id: 7, title: 'Recovered activity', pinned: false, createdAt: now - 100000, updatedAt: now - 90000 });
      events.put({ id: 30, sessionId: 3, type: 'task.started', payload: { taskId: 'success-status', prompt: 'success' }, createdAt: now - 59000 });
      events.put({ id: 31, sessionId: 3, type: 'tool.completed', payload: { taskId: 'success-status', toolCallId: 'success-call', toolName: 'getDocument', output: { ok: true } }, createdAt: now - 58000 });
      events.put({ id: 32, sessionId: 3, type: 'task.completed', payload: { taskId: 'success-status', text: '' }, createdAt: now - 57000 });
      events.put({ id: 40, sessionId: 4, type: 'task.started', payload: { taskId: 'failed-status', prompt: 'fail' }, createdAt: now - 69000 });
      events.put({ id: 41, sessionId: 4, type: 'tool.failed', payload: { taskId: 'failed-status', toolCallId: 'failed-call', toolName: 'navigate', error: 'boom' }, createdAt: now - 68000 });
      events.put({ id: 42, sessionId: 4, type: 'task.failed', payload: { taskId: 'failed-status', error: 'boom' }, createdAt: now - 67000 });
      events.put({ id: 50, sessionId: 5, type: 'task.started', payload: { taskId: 'stopped-status', prompt: 'stop' }, createdAt: now - 79000 });
      events.put({ id: 51, sessionId: 5, type: 'tool.started', payload: { taskId: 'stopped-status', toolCallId: 'stopped-call', toolName: 'browserRepl', input: {} }, createdAt: now - 78000 });
      events.put({ id: 52, sessionId: 5, type: 'task.cancelled', payload: { taskId: 'stopped-status' }, createdAt: now - 77000 });
      events.put({ id: 60, sessionId: 6, type: 'task.started', payload: { taskId: 'streaming-text-status', prompt: 'stream' }, createdAt: now - 89000 });
      events.put({ id: 61, sessionId: 6, type: 'tool.completed', payload: { taskId: 'streaming-text-status', toolCallId: 'streaming-call', toolName: 'getDocument', output: { ok: true } }, createdAt: now - 88000 });
      events.put({ id: 62, sessionId: 6, type: 'message.appended', payload: { taskId: 'streaming-text-status', messageId: 'streaming-answer', role: 'assistant', delta: 'Writing answer…' }, createdAt: now - 87000 });
      events.put({ id: 70, sessionId: 7, type: 'task.started', payload: { taskId: 'recovered-status', prompt: 'recover' }, createdAt: now - 99000 });
      events.put({ id: 71, sessionId: 7, type: 'tool.failed', payload: { taskId: 'recovered-status', toolCallId: 'recovered-failed', toolName: 'navigate', error: 'wrong tab' }, createdAt: now - 98000 });
      events.put({ id: 72, sessionId: 7, type: 'tool.completed', payload: { taskId: 'recovered-status', toolCallId: 'recovered-done', toolName: 'navigate', output: { action: 'open' } }, createdAt: now - 97000 });
      events.put({ id: 73, sessionId: 7, type: 'message.created', payload: { taskId: 'recovered-status', messageId: 'recovered-answer', role: 'assistant', text: 'Recovered answer' }, createdAt: now - 96000 });
      events.put({ id: 74, sessionId: 7, type: 'task.completed', payload: { taskId: 'recovered-status', text: 'Recovered answer' }, createdAt: now - 95000 });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  })`;
}

function seedTargetSwitchExpression() {
  return `new Promise((resolve, reject) => {
    const open = indexedDB.open('taber');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const now = Date.now();
      const tx = db.transaction(['sessions', 'agentEvents'], 'readwrite');
      tx.objectStore('sessions').put({ id: 3, title: 'Running target switch', pinned: false, createdAt: now - 1000, updatedAt: now });
      tx.objectStore('agentEvents').put({ id: 20, sessionId: 3, type: 'task.started', payload: { taskId: 'switch-task', prompt: 'Switch target smoke', context: { id: 41, windowId: 4, title: 'Initial target', url: 'https://initial.example/page', favIconUrl: 'https://initial.example/favicon.ico' } }, createdAt: now - 900 });
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  })`;
}

function installSendMessageStubExpression() {
  return `(() => {
    window.__taberStartMessages = [];
    window.__taberSwitchMessages = [];
    window.__taberSmokeUserScriptsAvailable = true;
    window.__taberSmokeActiveTab = { id: 52, windowId: 4, active: true, title: 'Selected tab', url: 'https://selected.example/page', favIconUrl: 'https://selected.example/favicon.ico' };
    Object.defineProperty(window, '__taberSmokeAllSitesGranted', {
      configurable: true,
      get: () => localStorage.getItem('__taberSmokeAllSitesGranted') === 'true',
      set: (value) => localStorage.setItem('__taberSmokeAllSitesGranted', value ? 'true' : 'false'),
    });
    const isAllSitesRequest = (input) => {
      const origins = input && Array.isArray(input.origins) ? input.origins : [];
      return origins.includes('http://*/*') && origins.includes('https://*/*');
    };
    try {
      if (!window.__taberSmokeOriginalFetch) window.__taberSmokeOriginalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = String(input);
        if (url === 'https://api.openai.com/v1/models') {
          return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url === 'https://models.dev/api.json') {
          return Promise.resolve(new Response(JSON.stringify({
            openai: {
              name: 'OpenAI',
              baseURL: 'https://api.openai.com/v1',
              models: { 'gpt-5.5': { name: 'GPT-5.5', limit: { context: 1000000 } } },
            },
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return window.__taberSmokeOriginalFetch(input, init);
      };
      const patchPermissions = (api) => {
        if (!api?.permissions || api.permissions.__taberSidepanelSmoke) return;
        const permissions = api.permissions;
        const originalContains = permissions.contains?.bind(permissions);
        const originalRequest = permissions.request?.bind(permissions);
        const originalRemove = permissions.remove?.bind(permissions);
        Object.defineProperty(permissions, 'contains', { configurable: true, value: (input, callback) => {
          if (isAllSitesRequest(input)) {
            const allowed = Boolean(window.__taberSmokeAllSitesGranted);
            if (callback) { callback(allowed); return; }
            return Promise.resolve(allowed);
          }
          return callback ? originalContains(input, callback) : originalContains(input);
        } });
        Object.defineProperty(permissions, 'request', { configurable: true, value: (input, callback) => {
          if (isAllSitesRequest(input)) {
            window.__taberSmokeAllSitesGranted = true;
            if (callback) { callback(true); return; }
            return Promise.resolve(true);
          }
          return callback ? originalRequest(input, callback) : originalRequest(input);
        } });
        Object.defineProperty(permissions, 'remove', { configurable: true, value: (input, callback) => {
          if (isAllSitesRequest(input)) {
            window.__taberSmokeAllSitesGranted = false;
            if (callback) { callback(true); return; }
            return Promise.resolve(true);
          }
          return callback ? originalRemove(input, callback) : originalRemove(input);
        } });
        Object.defineProperty(permissions, '__taberSidepanelSmoke', { configurable: true, value: true });
      };
      patchPermissions(globalThis.chrome);
      if (globalThis.browser !== globalThis.chrome) patchPermissions(globalThis.browser);
      if (!chrome.userScripts) chrome.userScripts = {};
      if (!chrome.userScripts.execute) chrome.userScripts.execute = () => Promise.resolve([]);
    } catch {}
    window.__taberSmokeChromeApiRequest = (action, args = []) => {
      if (action === 'tabs.query') return Promise.resolve([window.__taberSmokeActiveTab]);
      if (action === 'tabs.update') return Promise.resolve({ id: args[0], active: true });
      if (action === 'tabs.create') return Promise.resolve({ id: 90, ...(args[0] || {}) });
      return Promise.resolve(undefined);
    };
    window.__taberSmokeSwitchTarget = (message) => new Promise((resolve, reject) => {
      window.__taberSwitchMessages.push(JSON.parse(JSON.stringify(message)));
      const open = indexedDB.open('taber');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['sessions', 'agentEvents'], 'readwrite');
        const store = tx.objectStore('agentEvents');
        const allReq = store.getAll();
        allReq.onsuccess = () => {
          const events = allReq.result;
          const started = [...events].reverse().find((event) => event.type === 'task.started');
          const taskId = started?.payload?.taskId || 'switch-task';
          const sessionId = started?.sessionId || 3;
          const fromTabId = started?.payload?.context?.id;
          const targetTab = message.targetTab || window.__taberSmokeActiveTab;
          const now = Date.now();
          const id = Math.max(0, ...events.map((event) => Number(event.id) || 0)) + 1;
          store.add({ id, sessionId, type: 'task.targetChanged', payload: { taskId, fromTabId, toTabId: targetTab.id, reason: message.reason || 'userCurrentTab', tab: targetTab }, createdAt: now });
          tx.objectStore('sessions').get(sessionId).onsuccess = (event) => {
            const session = event.target.result;
            if (session) tx.objectStore('sessions').put({ ...session, updatedAt: now });
          };
        };
        tx.oncomplete = () => { db.close(); resolve({ changed: true, taskId: 'switch-task', targetTab: message.targetTab || window.__taberSmokeActiveTab }); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    let offset = 0;
    window.__taberSmokeStartTask = (message) => new Promise((resolve, reject) => {
      window.__taberStartMessages.push(JSON.parse(JSON.stringify(message)));
      const open = indexedDB.open('taber');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const sessionId = message.sessionId || 999;
        const taskId = 'stub-' + (++offset);
        const now = Date.now() + offset * 10;
        const tx = db.transaction(['sessions', 'agentEvents'], 'readwrite');
        tx.objectStore('sessions').get(sessionId).onsuccess = (event) => {
          const session = event.target.result;
          if (!session) { reject(new Error('session not found: ' + sessionId)); return; }
          session.updatedAt = now;
          tx.objectStore('sessions').put(session);
          tx.objectStore('agentEvents').add({ sessionId, type: 'task.started', payload: { taskId, prompt: message.prompt }, createdAt: now });
          tx.objectStore('agentEvents').add({ sessionId, type: 'task.completed', payload: { taskId, text: message.prompt + ' done.' }, createdAt: now + 1 });
        };
        tx.oncomplete = () => resolve({ sessionId, taskId });
        tx.onerror = () => reject(tx.error);
      };
    });
  })()`;
}

function recoveryReportExpression() {
  return `
(() => {
  const text = document.body.innerText;
  const html = document.documentElement.outerHTML;
  const submit = document.querySelector('[data-prompt-input-submit], button[aria-label="Stop"], button[aria-label="Submit"]');
  const composer = document.querySelector('textarea[name="message"]');
  const markdown = [...document.querySelectorAll('.taber-markdown')].find((node) => node.textContent.includes('Summary ready.'));
  const reducedFxEnter = (() => {
    const node = document.querySelector('.fx-enter');
    if (!node) return true;
    const style = getComputedStyle(node);
    const duration = parseFloat(style.animationDuration);
    const delay = parseFloat(style.animationDelay);
    return (Number.isNaN(duration) || duration < 0.01) && (Number.isNaN(delay) || delay < 0.01);
  })();
  return {
    hasUserPrompt: text.includes('Summarize this page'),
    hasAssistantText: text.includes('Summary ready.'),
    rendersBold: Boolean(markdown?.querySelector('strong')),
    rendersList: Boolean(markdown?.querySelector('ul li')),
    rendersCodeBlock: Boolean(markdown?.querySelector('pre code')),
    stripsXss: window.__taberXss !== 1 && !html.includes('onerror=') && !markdown?.querySelector('img'),
    hasFailedActivity: Boolean(document.querySelector('[data-activity-status="failed"]')),
    collapsedActivityHidesTechnicalError: !text.includes('Could not read debug data') && !text.includes('Step failed'),
    noTopRunningPill: !document.querySelector('[data-task-status]'),
    hidesReasoning: !text.includes('private reasoning') && !text.includes('secret-cot') && !text.includes('secret-reasoning') && !text.includes('unterminated-think') && !text.includes('unterminated-fence') && !text.includes('space-secret') && !text.includes('attr-secret') && !text.includes('newline-secret') && !text.includes('space-fence-secret') && !text.includes('cot-fence-secret') && !text.includes('raw-fence-secret') && !text.includes('nested-input-secret') && !text.includes('nested-output-secret') && !html.includes('secret-cot') && !html.includes('secret-reasoning') && !html.includes('unterminated-think') && !html.includes('unterminated-fence') && !html.includes('space-secret') && !html.includes('attr-secret') && !html.includes('newline-secret') && !html.includes('space-fence-secret') && !html.includes('cot-fence-secret') && !html.includes('raw-fence-secret') && !html.includes('nested-input-secret') && !html.includes('nested-output-secret'),
    keepsReasoningSummary: !text.includes('secret-reasoning') && !html.includes('secret-reasoning'),
    hasModelLabel: text.includes('demo-model'),
    hasSources: text.includes('Last page') && text.includes('target.example') && text.includes('Tab 32'),
    hidesTargetChangedCard: !text.includes('Controlled page changed to Target article'),
    noTechnicalDetails: !text.includes('Technical details'),
    hasSourceFavicon: html.includes('https://target.example/favicon.ico') && Boolean(document.querySelector('img[alt$="favicon"]')),
    hasImagePreview: Boolean(document.querySelector('img[alt][src^="data:image"]')),
    reducedMotionApplied: matchMedia('(prefers-reduced-motion: reduce)').matches && reducedFxEnter,
    submitInteractive: Boolean(submit) && Boolean(composer) && !composer.disabled,
    noHorizontalOverflow: !(document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth),
    width: innerWidth === 360,
  };
})()`;
}

function assertAll(label, report) {
  const failed = Object.entries(report).filter(([, value]) => value !== true);
  if (failed.length > 0) throw new Error(`${label} smoke failed: ${failed.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')}`);
}
