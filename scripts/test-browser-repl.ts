import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import 'fake-indexeddb/auto';
import { browserReplFallbackFor, createBrowserReplController, DEFAULT_BROWSER_REPL_TIMEOUT_MS, parseBrowserReplInput, type BrowserReplPageCommand } from '../lib/browser-repl.ts';
import { cloneBoundaryError, normalizeBrowserJsCode } from '../lib/browser-repl-code.ts';
import { browserReplExecutionSources } from '../lib/browser-repl-evaluation.ts';
import { canUseCdpFallback, executeBrowserReplCdpFallback } from '../lib/browser-repl-cdp.ts';
import { chromeApiRequestType } from '../lib/chrome-api-broker.ts';
import { createAgentTools } from '../lib/agent-tools.ts';
import { createBrowserReplPageExecutor } from '../lib/browser-repl-executor.ts';
import { createBrowserReplUserScript, runBrowserReplPageRuntime } from '../lib/browser-repl-page.ts';
import { runTaberPageOverlayCommand } from '../lib/browser-repl-visual-page.ts';
import { createSession, database, initializeDatabase } from '../lib/db.ts';
import { parseNavigateInput } from '../lib/navigate.ts';

async function testPageRuntimeHelpersBehaveInFakePage() {
  const page = createFakePage();
  const button = page.addElement(new FakeHTMLButtonElement('button'), { id: 'save', text: 'Save' });
  const input = page.addElement(new FakeHTMLInputElement('input'), { id: 'name', placeholder: 'Name' });
  const editor = page.addElement(new FakeHTMLElement('div'), { id: 'editor', ariaLabel: 'Editor', contentEditable: true });
  const select = page.addElement(new FakeHTMLSelectElement('select'), { id: 'choice', ariaLabel: 'Choice' });

  const observed = await runPageValue(page, { helper: 'observe', args: [{ scope: 'page' }] });
  assert.equal(observed.summary.title, 'BrowserRepl Test');
  assert(observed.elements.some((element: Record<string, unknown>) => element.name === 'Save' && element.role === 'button'));

  const queried = await runPageValue(page, { helper: 'query', args: ['#name', { scope: 'page', limit: 1 }] });
  const inputRef = queried.elements[0].ref;
  const buttonRef = observed.elements.find((element: Record<string, unknown>) => element.name === 'Save').ref;
  const editorRef = observed.elements.find((element: Record<string, unknown>) => element.name === 'Editor').ref;
  const selectRef = observed.elements.find((element: Record<string, unknown>) => element.name === 'Choice').ref;

  assert.equal((await runPageValue(page, { helper: 'fill', args: [inputRef, 'alpha'] })).filled, true);
  assert.equal(input.value, 'alpha');
  assert.deepEqual(input.dispatchedEvents, ['input', 'change']);
  assert.equal((await runPageValue(page, { helper: 'fill', args: [editorRef, 'editable'] })).filled, true);
  assert.equal(editor.textContent, 'editable');
  assert.equal((await runPageValue(page, { helper: 'fill', args: [selectRef, 'b'] })).filled, true);
  assert.equal(select.value, 'b');
  assert.equal((await runPageValue(page, { helper: 'click', args: [buttonRef] })).clicked, true);
  assert.equal(button.clicked, true);
  assert.equal((await runPageValue(page, { helper: 'press', args: [inputRef, 'Enter'] })).pressed, 'Enter');
  assert.deepEqual(input.dispatchedEvents.slice(-2), ['keydown:Enter', 'keyup:Enter']);
  assert.equal((await runPageValue(page, { helper: 'scroll', args: [{ y: 200 }] })).y, 200);
}

async function testCspSafePageSenseHelpersReadVisibleContent() {
  const page = createFakePage();
  page.addElement(new FakeHTMLElement('h1'), { text: '模型广场' });
  page.addElement(new FakeHTMLElement('p'), { text: '精选模型和工作流' });
  const hidden = page.addElement(new FakeHTMLElement('p'), { text: 'Hidden Secret' });
  hidden.style.display = 'none';
  page.addElement(new FakeHTMLElement('script'), { text: 'console.log("secret")' });
  const link = page.addElement(new FakeHTMLElement('a'), { id: 'models', text: '模型广场' });
  link.setAttribute('href', '/models');
  page.addElement(new FakeHTMLButtonElement('button'), { id: 'start', text: '立即体验' });
  page.addElement(new FakeHTMLInputElement('input'), { id: 'search', placeholder: '搜索' });
  const host = page.addElement(new FakeHTMLElement('div'), { id: 'shadow-host' });
  const shadowButton = new FakeHTMLButtonElement('button');
  shadowButton.id = 'shadow-cta';
  shadowButton.textContent = 'Shadow CTA';
  host.attachShadow({ mode: 'open' }).append(shadowButton);
  page.addElement(new FakeHTMLElement('iframe'));
  page.addElement(new FakeHTMLElement('div'), { id: 'taber-page-control-overlay', text: 'Taber overlay text' });

  const visible = await runPageValue(page, { helper: 'readVisibleText', args: [] });
  assert.equal(visible.title, 'BrowserRepl Test');
  assert.match(visible.text, /模型广场/);
  assert.match(visible.text, /Shadow CTA/);
  assert.doesNotMatch(visible.text, /Hidden Secret|console\.log|Taber overlay/);
  assert.equal(visible.truncated, false);
  assert(visible.hints.some((hint: string) => hint.includes('iframe')));
  const limited = await runPageValue(page, { helper: 'readVisibleText', args: [{ limit: 8 }] });
  assert.equal(limited.truncated, true);

  const linksAndButtons = await runPageValue(page, { helper: 'readLinksAndButtons', args: [{ limit: 10 }] });
  assert.equal(linksAndButtons.count, 3);
  assert(linksAndButtons.elements.some((element: Record<string, unknown>) => element.kind === 'link' && element.name === '模型广场' && element.href === '/models'));
  assert(linksAndButtons.elements.some((element: Record<string, unknown>) => element.kind === 'button' && element.name === '立即体验'));
  assert(linksAndButtons.elements.some((element: Record<string, unknown>) => element.name === 'Shadow CTA' && element.selector === '#shadow-host >>> #shadow-cta'));

  const interactive = await runPageValue(page, { helper: 'listInteractiveElements', args: [{ limit: 10 }] });
  assert(interactive.elements.some((element: Record<string, unknown>) => element.kind === 'field' && element.name === '搜索'));

  const queried = await runPageValue(page, { helper: 'queryText', args: ['模型广场'] });
  assert(queried.matches.some((match: Record<string, unknown>) => String(match.context).includes('模型广场')));
  assert(queried.candidates.some((element: Record<string, unknown>) => element.kind === 'link' && element.name === '模型广场'));
}

async function testComplexPageBoundariesExposeFramesAndShadow() {
  const page = createFakePage();
  const app = page.addElement(new FakeHTMLElement('div'), { id: 'app', text: 'SPA runtime shell' });
  const host = page.addElement(new FakeHTMLElement('div'), { id: 'shadow-host' });
  const shadowButton = new FakeHTMLButtonElement('button');
  shadowButton.id = 'shadow-cta';
  shadowButton.textContent = 'Shadow Snapshot CTA';
  host.attachShadow({ mode: 'open' }).append(shadowButton);
  const sameFrame = page.addElement(new FakeHTMLElement('iframe'));
  sameFrame.setAttribute('title', 'Same frame');
  sameFrame.setAttribute('src', 'https://example.test/frame');
  const frameDocument = new FakeDocument();
  frameDocument.title = 'Readable Frame';
  frameDocument.body.append(new FakeHTMLElement('h2'));
  frameDocument.body.children[0].textContent = 'Frame headline';
  frameDocument.body.append(new FakeHTMLButtonElement('button'));
  frameDocument.body.children[1].textContent = 'Frame CTA';
  Object.defineProperty(sameFrame, 'contentDocument', { configurable: true, value: frameDocument });
  Object.defineProperty(sameFrame, 'src', { configurable: true, value: 'https://example.test/frame' });
  const crossFrame = page.addElement(new FakeHTMLElement('iframe'));
  crossFrame.setAttribute('title', 'Cross frame');
  crossFrame.setAttribute('src', 'https://cross.test/frame');
  Object.defineProperty(crossFrame, 'contentDocument', { configurable: true, get() { throw new Error('Blocked a frame with origin'); } });

  const visible = await runPageValue(page, { helper: 'readVisibleText', args: [] });
  assert.match(visible.text, /SPA runtime shell/);
  assert.equal(visible.frames.length, 2);
  assert.equal(visible.frames[0].sameOrigin, true);
  assert.equal(visible.frames[0].readable, true);
  assert.match(visible.frames[0].text, /Frame headline/);
  assert.equal(visible.frames[1].sameOrigin, false);
  assert.match(visible.frames[1].reason, /Cross-origin|inaccessible/);
  assert(visible.hints.some((hint: string) => hint.includes('same-origin readable')));
  assert(visible.hints.some((hint: string) => hint.includes('Dynamic SPA shell')));

  const interactive = await runPageValue(page, { helper: 'listInteractiveElements', args: [{ limit: 10 }] });
  assert(interactive.elements.some((element: Record<string, unknown>) => element.name === 'Shadow Snapshot CTA'));
  assert(interactive.frames[0].elements.some((element: Record<string, unknown>) => element.name === 'Frame CTA'));
  assert.equal('ref' in interactive.frames[0].elements[0], false);

  const snapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot' }] });
  assert(snapshot.state.elements.some((element: Record<string, unknown>) => element.name === 'Shadow Snapshot CTA' && typeof element.ref === 'string'));
  assert.equal(snapshot.state.frames[0].readable, true);
  assert.equal(snapshot.state.frames[1].readable, false);
  const frameTargetClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { text: 'Frame CTA' } }] });
  assert.equal(frameTargetClick.ok, false);
  assert.equal(frameTargetClick.code, 'NO_TARGET');
  assert.match(frameTargetClick.message, /iframe|frame/i);
  assert.equal(frameTargetClick.state.frames[0].readable, true);

  const queried = await runPageValue(page, { helper: 'queryText', args: ['Frame CTA'] });
  assert(queried.frames[0].text.includes('Frame CTA'));
  assert.equal(app.id, 'app');
}

async function testStructuredBrowserActionsUseSemanticLocators() {
  const page = createFakePage();
  const link = page.addElement(new FakeHTMLElement('a'), { id: 'models', text: '模型广场' });
  link.setAttribute('href', '/models');
  const roleButton = page.addElement(new FakeHTMLButtonElement('button'), { id: 'new-window', text: '新窗口打开' });
  const label = page.addElement(new FakeHTMLElement('label'), { text: '邮箱' });
  const email = new FakeHTMLInputElement('input');
  label.append(email);
  const duplicateA = page.addElement(new FakeHTMLButtonElement('button'), { text: '重复' });
  const duplicateB = page.addElement(new FakeHTMLButtonElement('button'), { text: '重复' });
  const disabled = page.addElement(new FakeHTMLButtonElement('button'), { text: '禁用按钮' });
  disabled.disabled = true;
  const hidden = page.addElement(new FakeHTMLButtonElement('button'), { text: '隐藏按钮' });
  hidden.style.display = 'none';

  const snapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot' }] });
  const oldSnapshotRef = snapshot.state.elements.find((element: Record<string, unknown>) => element.name === '模型广场').ref;
  assertBrowserSnapshotShape(snapshot.state);
  assert(snapshot.state.hints.some((hint: string) => hint.includes('Refs remain valid')));
  await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot' }] });
  // A ref from an earlier snapshot keeps resolving while the element itself is unchanged.
  const refClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: oldSnapshotRef } }] });
  assert.equal(refClick.ok, true);
  assert.equal(link.clicked, true);
  // Page mutations alone do not invalidate the ref either.
  const repeatClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: oldSnapshotRef } }] });
  assert.equal(repeatClick.ok, true);
  // Removing the element makes the ref genuinely stale.
  link.remove();
  const staleRefClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: oldSnapshotRef } }] });
  assert.equal(staleRefClick.ok, false);
  assert.equal(staleRefClick.code, 'STALE_REF');
  page.addElement(link, {});

  const textClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { text: '模型广场' } }] });
  assert.equal(textClick.ok, true);
  assert.equal(textClick.action, 'click');
  assert.match(textClick.state.text, /模型广场/);
  const roleClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { role: 'button', name: '新窗口打开' } }] });
  assert.equal(roleClick.ok, true);
  assert.equal(roleButton.clicked, true);
  const filled = await runPageValue(page, { helper: 'browser', args: [{ action: 'fill', target: { label: '邮箱' }, value: 'a@b.com' }] });
  assert.equal(filled.ok, true);
  assert.equal(email.value, 'a@b.com');
  assert.equal(filled.evidence.finalValue, 'a@b.com');

  const ambiguous = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { text: '重复' } }] });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(duplicateA.clicked || duplicateB.clicked, false);
  const disabledClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { text: '禁用按钮' } }] });
  assert.equal(disabledClick.ok, false);
  assert.equal(disabledClick.code, 'DISABLED');
  assert.equal(disabled.clicked, false);
  const hiddenClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { text: '隐藏按钮' } }] });
  assert.equal(hiddenClick.ok, false);
  assert.equal(hiddenClick.code, 'NO_TARGET');

  const semanticSnapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot' }] });
  const semanticRef = semanticSnapshot.state.elements.find((element: Record<string, unknown>) => element.name === '新窗口打开').ref;
  roleButton.attributes.set('aria-label', '按钮语义已变化');
  const semanticChangedClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: semanticRef } }] });
  assert.equal(semanticChangedClick.ok, false);
  assert.equal(semanticChangedClick.code, 'ELEMENT_CHANGED');
  assert.match(semanticChangedClick.message, /Snapshot element changed/);
  roleButton.attributes.delete('aria-label');

  const hideRefSnapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot' }] });
  const hideRef = hideRefSnapshot.state.elements.find((element: Record<string, unknown>) => element.name === '新窗口打开').ref;
  roleButton.style.display = 'none';
  const hiddenRefClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: hideRef } }] });
  assert.equal(hiddenRefClick.ok, false);
  assert.equal(hiddenRefClick.code, 'STALE_REF');
  roleButton.style.display = 'block';

  const replaceSnapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot' }] });
  const replaceRef = replaceSnapshot.state.elements.find((element: Record<string, unknown>) => element.name === '模型广场').ref;
  const replacement = new FakeHTMLElement('a');
  replacement.id = 'models';
  replacement.textContent = '模型广场';
  replacement.setAttribute('href', '/models');
  link.replaceWith(replacement);
  const replacedClick = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: replaceRef } }] });
  assert.equal(replacedClick.ok, false);
  assert.equal(replacedClick.code, 'STALE_REF');
  assert.equal(replacement.clicked, false);

  const secondSnapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'snapshot', limit: 1 }] });
  assert.equal(secondSnapshot.state.elements.length, 1);
  assert.equal(secondSnapshot.state.truncated, true);
  const oldRefAfterSnapshot = await runPageValue(page, { helper: 'browser', args: [{ action: 'click', target: { ref: refClick.state.elements[0].ref } }] });
  assert.equal(oldRefAfterSnapshot.ok, false);
  assert.equal(oldRefAfterSnapshot.code, 'STALE_REF');
}

async function testOverlayScriptAndPickUserElement() {
  const page = createFakePage();
  const button = page.addElement(new FakeHTMLButtonElement('button'), { id: 'save', text: 'Save' });
  await withFakePage(page, async () => {
    assert.deepEqual(runTaberPageOverlayCommand({ action: 'show' }), { shown: true });
    const root = page.document.getElementById('taber-page-control-overlay');
    assert(root);
    assert.equal(root.getAttribute('aria-hidden'), 'true');
    assert.match(root.getAttribute('style') ?? '', /pointer-events:none/);
    assert.match(root.querySelector('[data-taber-part="edge"]')?.getAttribute('style') ?? '', /width:100vw;height:100vh/);
    assert.match(root.querySelector('[data-taber-part="edge"]')?.getAttribute('style') ?? '', /0 0 0 2px rgba\(125,144,255,\.60\)/);
    assert.match(root.querySelector('[data-taber-part="glow"]')?.getAttribute('style') ?? '', /linear-gradient\(to bottom/);
    assert.doesNotMatch(root.querySelector('[data-taber-part="glow"]')?.getAttribute('style') ?? '', /radial-gradient/);
    assert.equal(root.querySelector('[data-taber-part="badge-text"]')?.textContent, 'Taber 正在控制此页');
    assert.equal(root.querySelector('[data-taber-part="badge-icon-image"]')?.getAttribute('src'), 'chrome-extension://taber/icons/icon-24.png');
    assert.deepEqual(runTaberPageOverlayCommand({ action: 'hide' }), { hidden: true });
    assert.match(root.querySelector('[data-taber-part="edge"]')?.getAttribute('style') ?? '', /opacity:0/);
    assert.match(root.querySelector('[data-taber-part="glow"]')?.getAttribute('style') ?? '', /opacity:0/);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.equal(page.document.getElementById('taber-page-control-overlay'), null);
    const scriptResult = await eval(createBrowserReplUserScript({ helper: 'controlOverlay', args: [{ action: 'show' }] }));
    assert.equal(scriptResult.ok, true);
    assert.equal(page.document.getElementById('taber-page-control-overlay')?.querySelector('[data-taber-part="badge-text"]')?.textContent, 'Taber 正在控制此页');
  });

  const pendingPick = runPageValue(page, { helper: 'pickUserElement', args: [{ message: 'Pick target', timeoutMs: 1000 }] });
  await Promise.resolve();
  button.dispatchEvent(new FakeEvent('mousemove', { bubbles: true, cancelable: true }));
  button.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }));
  const picked = await pendingPick;
  assert.equal(picked.selector, '#save');
  assert.equal(picked.tag, 'button');
  assert.deepEqual(picked.attributes, { id: 'save' });
  assert.equal(typeof picked.xpath, 'string');
  assert.equal(page.document.getElementById('taber-page-control-overlay')?.querySelector('[data-taber-part="picker"]'), null);
}

async function testPageRuntimeSelectorBatchFillFormAndShadow() {
  const page = createFakePage();
  const projectLabel = page.addElement(new FakeHTMLElement('label'), { text: '项目名称' });
  const project = new FakeHTMLInputElement('input');
  project.setAttribute('name', 'project');
  projectLabel.append(project);
  const company = page.addElement(new FakeHTMLInputElement('input'), { id: 'company', placeholder: '公司名称' });
  const contactA = page.addElement(new FakeHTMLInputElement('input'), { ariaLabel: '联系人' });
  const contactB = page.addElement(new FakeHTMLInputElement('input'), { ariaLabel: '联系人' });
  const host = page.addElement(new FakeHTMLElement('div'), { id: 'shadow-host' });
  const shadowInput = new FakeHTMLInputElement('input');
  shadowInput.id = 'shadow-name';
  shadowInput.setAttribute('aria-label', 'Shadow Name');
  host.attachShadow({ mode: 'open' }).append(shadowInput);

  const dryRun = await runPageValue(page, { helper: 'fillForm', args: [{ fields: { 项目名称: 'dry' }, dryRun: true }] });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.filled[0].dryRun, true);
  assert.equal(project.value, '');

  const filled = await runPageValue(page, { helper: 'fillForm', args: [{ fields: { 项目名称: 'Alpha', 公司名称: 'Acme', 联系人: 'Ada', 不存在: 'x' } }] });
  assert.equal(filled.ok, false);
  assert.equal(project.value, 'Alpha');
  assert.equal(company.value, 'Acme');
  assert.equal(contactA.value, '');
  assert.equal(contactB.value, '');
  assert.deepEqual(filled.ambiguous.map((item: Record<string, unknown>) => item.field), ['联系人']);
  assert.deepEqual(filled.missing.map((item: Record<string, unknown>) => item.field), ['不存在']);

  const shadowQuery = await runPageValue(page, { helper: 'query', args: ['#shadow-name', { scope: 'page' }] });
  assert.equal(shadowQuery.elements[0].name, 'Shadow Name');
  await runPageValue(page, { helper: 'fill', args: ['#shadow-name', 'from selector'] });
  assert.equal(shadowInput.value, 'from selector');
  await runPageValue(page, { helper: 'fill', args: [shadowQuery.elements[0].ref, 'from ref'] });
  assert.equal(shadowInput.value, 'from ref');

  const status = page.addElement(new FakeHTMLElement('p'), { id: 'status', text: 'idle' });
  const asyncButton = page.addElement(new FakeHTMLButtonElement('button'), { id: 'async', text: 'Async' });
  asyncButton.click = () => {
    asyncButton.clicked = true;
    requestAnimationFrame(() => { status.textContent = 'ready'; });
  };
  const asyncBatch = await runPageValue(page, { helper: 'batch', args: [[{ action: 'click', selector: '#async' }]] });
  assert.equal(asyncBatch.ok, true);
  assert.equal(status.textContent, 'ready');

  const later = page.addElement(new FakeHTMLInputElement('input'), { id: 'later' });
  const originalProjectDispatch = project.dispatchEvent.bind(project);
  project.dispatchEvent = (event) => {
    const result = originalProjectDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => { project.value = 'Batch settled'; });
    return result;
  };
  const batch = await runPageValue(page, { helper: 'batch', args: [[
    { action: 'fill', selector: 'input[name="project"]', value: 'Batch' },
    { action: 'click', selector: '#missing' },
    { action: 'fill', selector: '#later', value: 'should not run' },
  ]] });
  assert.equal(batch.ok, false);
  assert.equal(batch.steps.length, 2);
  assert.equal(batch.steps[0].finalValue, 'Batch settled');
  assert.equal((batch.steps[0].element as Record<string, unknown>).value, 'Batch settled');
  assert.equal(project.value, 'Batch settled');
  assert.equal(later.value, '');

  page.addElement(new FakeHTMLElement('iframe'));
  const missingInFrame = await runRawPageCommand(page, { helper: 'click', args: ['#inside-frame'] }) as { ok: false; error: string };
  assert.equal(missingInFrame.ok, false);
  assert.match(String(missingInFrame.error), /iframe/);
}

async function testShadowHostVisibilityAffectsLocator() {
  const page = createFakePage();
  const visibleHost = page.addElement(new FakeHTMLElement('div'), { id: 'visible-host' });
  const visibleInput = new FakeHTMLInputElement('input');
  visibleInput.id = 'visible-shadow';
  visibleInput.setAttribute('aria-label', 'Visible Shadow');
  visibleHost.attachShadow({ mode: 'open' }).append(visibleInput);
  const hiddenHost = page.addElement(new FakeHTMLElement('div'), { id: 'hidden-host' });
  hiddenHost.style.opacity = '0';
  const hiddenInput = new FakeHTMLInputElement('input');
  hiddenInput.id = 'hidden-shadow';
  hiddenInput.setAttribute('aria-label', 'Hidden Shadow');
  hiddenHost.attachShadow({ mode: 'open' }).append(hiddenInput);

  const queried = await runPageValue(page, { helper: 'query', args: ['input', { scope: 'page' }] });
  assert.deepEqual(queried.elements.map((element: Record<string, unknown>) => element.name), ['Visible Shadow']);
  const observed = await runPageValue(page, { helper: 'observe', args: [{ scope: 'page' }] });
  assert(observed.elements.some((element: Record<string, unknown>) => element.name === 'Visible Shadow'));
  assert(!observed.elements.some((element: Record<string, unknown>) => element.name === 'Hidden Shadow'));
  const dryRun = await runPageValue(page, { helper: 'fillForm', args: [{ fields: { 'Visible Shadow': 'ok', 'Hidden Shadow': 'no' }, dryRun: true }] });
  assert.deepEqual(dryRun.filled.map((item: Record<string, unknown>) => item.field), ['Visible Shadow']);
  assert.deepEqual(dryRun.missing.map((item: Record<string, unknown>) => item.field), ['Hidden Shadow']);

  const hiddenSelector = '#hidden-host >>> #hidden-shadow';
  const hiddenClick = await runRawPageCommand(page, { helper: 'click', args: [hiddenSelector] }) as { ok: false; error: string };
  assert.equal(hiddenClick.ok, false);
  assert.match(hiddenClick.error, /No element matches selector/);
  assert.equal(hiddenInput.clicked, false);
  const hiddenFill = await runRawPageCommand(page, { helper: 'fill', args: [hiddenSelector, 'hidden'] }) as { ok: false; error: string };
  assert.equal(hiddenFill.ok, false);
  assert.equal(hiddenInput.value, '');
  const hiddenPress = await runRawPageCommand(page, { helper: 'press', args: [hiddenSelector, 'Enter'] }) as { ok: false; error: string };
  assert.equal(hiddenPress.ok, false);
  assert.deepEqual(hiddenInput.dispatchedEvents, []);
  const hiddenBatch = await runPageValue(page, { helper: 'batch', args: [[{ action: 'click', selector: hiddenSelector }]] });
  assert.equal(hiddenBatch.ok, false);
  assert.equal(hiddenInput.clicked, false);
}

async function testFillFormRefreshesDynamicFieldsAndEvidence() {
  const page = createFakePage();
  const countryLabel = page.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const country = new FakeHTMLInputElement('input');
  countryLabel.append(country);
  const originalCountryDispatch = country.dispatchEvent.bind(country);
  country.dispatchEvent = (event) => {
    const result = originalCountryDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const provinceLabel = page.addElement(new FakeHTMLElement('label'), { text: '省份' });
      const province = new FakeHTMLInputElement('input');
      provinceLabel.append(province);
      const originalProvinceDispatch = province.dispatchEvent.bind(province);
      province.dispatchEvent = (provinceEvent) => {
        const provinceResult = originalProvinceDispatch(provinceEvent);
        if (provinceEvent.type === 'input') requestAnimationFrame(() => {
          const replacement = new FakeHTMLInputElement('input');
          replacement.value = '浙江-normalized';
          province.replaceWith(replacement);
        });
        return provinceResult;
      };
    });
    return result;
  };

  const filled = await runPageValue(page, { helper: 'fillForm', args: [{ fields: { 国家: '中国', 省份: '浙江' } }] });
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.filled.map((item: Record<string, unknown>) => item.field), ['国家', '省份']);
  assert.equal(filled.filled[1].finalValue, '浙江-normalized');

  const shadowPage = createFakePage();
  const shadowLabel = shadowPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const shadowCountry = new FakeHTMLInputElement('input');
  shadowCountry.id = 'shadow-country';
  shadowLabel.append(shadowCountry);
  const host = shadowPage.addElement(new FakeHTMLElement('div'), { id: 'late-shadow-host' });
  const originalShadowDispatch = shadowCountry.dispatchEvent.bind(shadowCountry);
  shadowCountry.dispatchEvent = (event) => {
    const result = originalShadowDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const root = host.attachShadow({ mode: 'open' });
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        const province = new FakeHTMLInputElement('input');
        province.id = 'province-shadow';
        province.setAttribute('aria-label', '省份');
        root.append(province);
      })));
    });
    return result;
  };
  const shadowFilled = await runPageValue(shadowPage, { helper: 'fillForm', args: [{ fields: { 国家: '中国', 省份: '浙江' } }] });
  assert.equal(shadowFilled.ok, true);

  const batchShadowPage = createFakePage();
  const batchCountry = batchShadowPage.addElement(new FakeHTMLInputElement('input'), { id: 'batch-country', ariaLabel: '国家' });
  const batchHost = batchShadowPage.addElement(new FakeHTMLElement('div'), { id: 'batch-shadow-host' });
  const originalBatchCountryDispatch = batchCountry.dispatchEvent.bind(batchCountry);
  batchCountry.dispatchEvent = (event) => {
    const result = originalBatchCountryDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const root = batchHost.attachShadow({ mode: 'open' });
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => { const province = new FakeHTMLInputElement('input'); province.id = 'batch-province-shadow'; root.append(province); })));
    });
    return result;
  };
  const shadowBatch = await runPageValue(batchShadowPage, { helper: 'batch', args: [[{ action: 'fill', selector: '#batch-country', value: '中国' }, { action: 'waitFor', selector: '#batch-province-shadow' }]] });
  assert.equal(shadowBatch.ok, true);
}

async function testFillEvidenceSurvivesPrependSelectorDrift() {
  const page = createFakePage();
  const label = page.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const input = new FakeHTMLInputElement('input');
  label.append(input);
  const prependInput = () => {
    const insertedLabel = new FakeHTMLElement('label');
    insertedLabel.textContent = '国家';
    insertedLabel.append(new FakeHTMLInputElement('input'));
    page.document.body.prepend(insertedLabel);
    const replacement = new FakeHTMLInputElement('input');
    replacement.value = '中国';
    input.replaceWith(replacement);
  };
  const originalDispatch = input.dispatchEvent.bind(input);
  input.dispatchEvent = (event) => {
    const result = originalDispatch(event);
    if (event.type === 'input') requestAnimationFrame(prependInput);
    return result;
  };

  const filled = await runPageValue(page, { helper: 'fillForm', args: [{ fields: { 国家: '中国' } }] });
  assert.equal(filled.filled[0].finalValue, '中国');

  const batchPage = createFakePage();
  const batchLabel = batchPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const batchInput = new FakeHTMLInputElement('input');
  batchLabel.append(batchInput);
  const originalBatchDispatch = batchInput.dispatchEvent.bind(batchInput);
  batchInput.dispatchEvent = (event) => {
    const result = originalBatchDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const insertedLabel = new FakeHTMLElement('label');
      insertedLabel.textContent = '国家';
      insertedLabel.append(new FakeHTMLInputElement('input'));
      batchPage.document.body.prepend(insertedLabel);
      const replacement = new FakeHTMLInputElement('input');
      replacement.value = '中国';
      batchInput.replaceWith(replacement);
    });
    return result;
  };
  const batch = await runPageValue(batchPage, { helper: 'batch', args: [[{ action: 'fill', selector: 'input', value: '中国' }]] });
  assert.equal(batch.steps[0].finalValue, '中国');

  const wrapperPage = createFakePage();
  const wrapperLabel = wrapperPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const wrapperInput = new FakeHTMLInputElement('input');
  wrapperInput.id = 'country';
  wrapperLabel.append(wrapperInput);
  const originalWrapperDispatch = wrapperInput.dispatchEvent.bind(wrapperInput);
  wrapperInput.dispatchEvent = (event) => {
    const result = originalWrapperDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const nextLabel = new FakeHTMLElement('label');
      nextLabel.textContent = '国家';
      const nextInput = new FakeHTMLInputElement('input');
      nextInput.id = 'country';
      nextInput.value = '中国-normalized';
      nextLabel.append(nextInput);
      wrapperLabel.replaceWith(nextLabel);
    });
    return result;
  };
  const wrapperFilled = await runPageValue(wrapperPage, { helper: 'fillForm', args: [{ fields: { 国家: '中国' } }] });
  assert.equal(wrapperFilled.filled[0].finalValue, '中国-normalized');

  const wrapperBatchPage = createFakePage();
  const wrapperBatchLabel = wrapperBatchPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const wrapperBatchInput = new FakeHTMLInputElement('input');
  wrapperBatchInput.id = 'batch-country';
  wrapperBatchLabel.append(wrapperBatchInput);
  const originalWrapperBatchDispatch = wrapperBatchInput.dispatchEvent.bind(wrapperBatchInput);
  wrapperBatchInput.dispatchEvent = (event) => {
    const result = originalWrapperBatchDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const nextLabel = new FakeHTMLElement('label');
      nextLabel.textContent = '国家';
      const nextInput = new FakeHTMLInputElement('input');
      nextInput.id = 'batch-country';
      nextInput.value = '中国-normalized';
      nextLabel.append(nextInput);
      wrapperBatchLabel.replaceWith(nextLabel);
    });
    return result;
  };
  const wrapperBatch = await runPageValue(wrapperBatchPage, { helper: 'batch', args: [[{ action: 'fill', selector: '#batch-country', value: '中国' }]] });
  assert.equal(wrapperBatch.steps[0].finalValue, '中国-normalized');
  assert.equal((wrapperBatch.steps[0].element as Record<string, unknown>).value, '中国-normalized');

  const labelOnlyPage = createFakePage();
  const labelOnlyLabel = labelOnlyPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const labelOnlyInput = new FakeHTMLInputElement('input');
  labelOnlyLabel.append(labelOnlyInput);
  const originalLabelOnlyDispatch = labelOnlyInput.dispatchEvent.bind(labelOnlyInput);
  labelOnlyInput.dispatchEvent = (event) => {
    const result = originalLabelOnlyDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const insertedLabel = new FakeHTMLElement('label');
      insertedLabel.textContent = '国家';
      insertedLabel.append(new FakeHTMLInputElement('input'));
      labelOnlyPage.document.body.prepend(insertedLabel);
      const nextLabel = new FakeHTMLElement('label');
      nextLabel.textContent = '国家';
      const nextInput = new FakeHTMLInputElement('input');
      nextInput.value = '中国-normalized';
      nextLabel.append(nextInput);
      labelOnlyLabel.replaceWith(nextLabel);
    });
    return result;
  };
  const labelOnlyFilled = await runPageValue(labelOnlyPage, { helper: 'fillForm', args: [{ fields: { 国家: '中国' } }] });
  assert.equal(labelOnlyFilled.filled[0].finalValue, '中国-normalized');

  const labelOnlyBatchPage = createFakePage();
  const labelOnlyBatchLabel = labelOnlyBatchPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const labelOnlyBatchInput = new FakeHTMLInputElement('input');
  labelOnlyBatchLabel.append(labelOnlyBatchInput);
  const originalLabelOnlyBatchDispatch = labelOnlyBatchInput.dispatchEvent.bind(labelOnlyBatchInput);
  labelOnlyBatchInput.dispatchEvent = (event) => {
    const result = originalLabelOnlyBatchDispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      const insertedLabel = new FakeHTMLElement('label');
      insertedLabel.textContent = '国家';
      insertedLabel.append(new FakeHTMLInputElement('input'));
      labelOnlyBatchPage.document.body.prepend(insertedLabel);
      const nextLabel = new FakeHTMLElement('label');
      nextLabel.textContent = '国家';
      const nextInput = new FakeHTMLInputElement('input');
      nextInput.value = '中国-normalized';
      nextLabel.append(nextInput);
      labelOnlyBatchLabel.replaceWith(nextLabel);
    });
    return result;
  };
  const labelOnlyBatch = await runPageValue(labelOnlyBatchPage, { helper: 'batch', args: [[{ action: 'fill', selector: 'input', value: '中国' }]] });
  assert.equal(labelOnlyBatch.steps[0].finalValue, '中国-normalized');
  assert.equal((labelOnlyBatch.steps[0].element as Record<string, unknown>).value, '中国-normalized');

  const hiddenPage = createFakePage();
  const hiddenLabel = hiddenPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const hiddenInput = new FakeHTMLInputElement('input');
  hiddenLabel.append(hiddenInput);
  hiddenInput.dispatchEvent = ((dispatch) => (event: FakeEvent) => {
    const result = dispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      hiddenLabel.style.display = 'none';
      hiddenInput.style.display = 'none';
      const nextLabel = new FakeHTMLElement('label');
      nextLabel.textContent = '国家';
      const nextInput = new FakeHTMLInputElement('input');
      nextInput.value = '中国-normalized';
      nextLabel.append(nextInput);
      hiddenPage.document.body.prepend(nextLabel);
    });
    return result;
  })(hiddenInput.dispatchEvent.bind(hiddenInput));
  const hiddenFilled = await runPageValue(hiddenPage, { helper: 'fillForm', args: [{ fields: { 国家: '中国' } }] });
  assert.equal(hiddenFilled.filled[0].finalValue, '中国-normalized');

  const hiddenBatchPage = createFakePage();
  const hiddenBatchLabel = hiddenBatchPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const hiddenBatchInput = new FakeHTMLInputElement('input');
  hiddenBatchLabel.append(hiddenBatchInput);
  hiddenBatchInput.dispatchEvent = ((dispatch) => (event: FakeEvent) => {
    const result = dispatch(event);
    if (event.type === 'input') requestAnimationFrame(() => {
      hiddenBatchLabel.style.display = 'none';
      hiddenBatchInput.style.display = 'none';
      const nextLabel = new FakeHTMLElement('label');
      nextLabel.textContent = '国家';
      const nextInput = new FakeHTMLInputElement('input');
      nextInput.value = '中国-normalized';
      nextLabel.append(nextInput);
      hiddenBatchPage.document.body.prepend(nextLabel);
    });
    return result;
  })(hiddenBatchInput.dispatchEvent.bind(hiddenBatchInput));
  const hiddenBatch = await runPageValue(hiddenBatchPage, { helper: 'batch', args: [[{ action: 'fill', selector: 'input', value: '中国' }]] });
  assert.equal(hiddenBatch.steps[0].finalValue, '中国-normalized');
  assert.equal((hiddenBatch.steps[0].element as Record<string, unknown>).value, '中国-normalized');
}

async function testSameCallRefSurvivesContentEditableFill() {
  const buttonPage = createFakePage();
  const originalLabel = buttonPage.addElement(new FakeHTMLElement('label'), { text: 'Original' });
  const originalButton = new FakeHTMLButtonElement('button');
  originalButton.textContent = 'Original';
  originalLabel.append(originalButton);
  const buttonQuery = await runPageValue(buttonPage, { helper: 'query', args: ['button', { scope: 'page' }] });
  const insertedLabel = new FakeHTMLElement('label');
  insertedLabel.textContent = 'Original';
  const insertedButton = new FakeHTMLButtonElement('button');
  insertedButton.textContent = 'Original';
  insertedLabel.append(insertedButton);
  buttonPage.document.body.prepend(insertedLabel);
  const clickResult = await runRawPageCommand(buttonPage, { helper: 'click', args: [buttonQuery.elements[0].ref] }) as { ok: boolean; error?: string };
  assert.equal(insertedButton.clicked, false);
  assert(clickResult.ok ? originalButton.clicked : /Element changed/.test(String(clickResult.error)));

  const fillPage = createFakePage();
  const originalInput = fillPage.addElement(new FakeHTMLInputElement('input'));
  const fillQuery = await runPageValue(fillPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  const insertedInput = new FakeHTMLInputElement('input');
  fillPage.document.body.prepend(insertedInput);
  const fillResult = await runRawPageCommand(fillPage, { helper: 'fill', args: [fillQuery.elements[0].ref, 'alpha'] }) as { ok: boolean; error?: string };
  assert.equal(insertedInput.value, '');
  assert(fillResult.ok ? originalInput.value === 'alpha' : /Element changed/.test(String(fillResult.error)));

  const pressPage = createFakePage();
  const pressInput = pressPage.addElement(new FakeHTMLInputElement('input'));
  const pressQuery = await runPageValue(pressPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  const insertedPressInput = new FakeHTMLInputElement('input');
  pressPage.document.body.prepend(insertedPressInput);
  const pressResult = await runRawPageCommand(pressPage, { helper: 'press', args: [pressQuery.elements[0].ref, 'Enter'] }) as { ok: boolean; error?: string };
  assert.deepEqual(insertedPressInput.dispatchedEvents, []);
  assert(pressResult.ok ? pressInput.dispatchedEvents.includes('keydown:Enter') : /Element changed/.test(String(pressResult.error)));

  const batchPage = createFakePage();
  const batchInput = batchPage.addElement(new FakeHTMLInputElement('input'));
  const batchQuery = await runPageValue(batchPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  const insertedBatchInput = new FakeHTMLInputElement('input');
  batchPage.document.body.prepend(insertedBatchInput);
  const batchResult = await runPageValue(batchPage, { helper: 'batch', args: [[{ action: 'fill', target: batchQuery.elements[0].ref, value: 'batch' }]] });
  assert.equal(insertedBatchInput.value, '');
  assert(batchResult.ok ? batchInput.value === 'batch' : /Element changed/.test(String(batchResult.error)));

  const reorderFillPage = createFakePage();
  const firstInput = reorderFillPage.addElement(new FakeHTMLInputElement('input'));
  const secondInput = reorderFillPage.addElement(new FakeHTMLInputElement('input'));
  const reorderFillQuery = await runPageValue(reorderFillPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  reorderFillPage.document.body.children.splice(0, 2, secondInput, firstInput);
  const reorderFill = await runRawPageCommand(reorderFillPage, { helper: 'fill', args: [reorderFillQuery.elements[0].ref, 'alpha'] }) as { ok: boolean; error?: string };
  assert.equal(secondInput.value, '');
  assert(reorderFill.ok ? firstInput.value === 'alpha' : /Element changed/.test(String(reorderFill.error)));

  const reorderClickPage = createFakePage();
  const firstButton = reorderClickPage.addElement(new FakeHTMLButtonElement('button'));
  const secondButton = reorderClickPage.addElement(new FakeHTMLButtonElement('button'));
  const reorderClickQuery = await runPageValue(reorderClickPage, { helper: 'query', args: ['button', { scope: 'page' }] });
  reorderClickPage.document.body.children.splice(0, 2, secondButton, firstButton);
  const reorderClick = await runRawPageCommand(reorderClickPage, { helper: 'click', args: [reorderClickQuery.elements[0].ref] }) as { ok: boolean; error?: string };
  assert.equal(secondButton.clicked, false);
  assert(reorderClick.ok ? firstButton.clicked : /Element changed/.test(String(reorderClick.error)));

  const reorderPressPage = createFakePage();
  const firstPressInput = reorderPressPage.addElement(new FakeHTMLInputElement('input'));
  const secondPressInput = reorderPressPage.addElement(new FakeHTMLInputElement('input'));
  const reorderPressQuery = await runPageValue(reorderPressPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  reorderPressPage.document.body.children.splice(0, 2, secondPressInput, firstPressInput);
  const reorderPress = await runRawPageCommand(reorderPressPage, { helper: 'press', args: [reorderPressQuery.elements[0].ref, 'Enter'] }) as { ok: boolean; error?: string };
  assert.deepEqual(secondPressInput.dispatchedEvents, []);
  assert(reorderPress.ok ? firstPressInput.dispatchedEvents.includes('keydown:Enter') : /Element changed/.test(String(reorderPress.error)));

  const reorderBatchPage = createFakePage();
  const firstBatchInput = reorderBatchPage.addElement(new FakeHTMLInputElement('input'));
  const secondBatchInput = reorderBatchPage.addElement(new FakeHTMLInputElement('input'));
  const reorderBatchQuery = await runPageValue(reorderBatchPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  reorderBatchPage.document.body.children.splice(0, 2, secondBatchInput, firstBatchInput);
  const reorderBatch = await runPageValue(reorderBatchPage, { helper: 'batch', args: [[{ action: 'fill', target: reorderBatchQuery.elements[0].ref, value: 'batch' }]] });
  assert.equal(secondBatchInput.value, '');
  assert(reorderBatch.ok ? firstBatchInput.value === 'batch' : /Element changed/.test(String(reorderBatch.error)));

  const hiddenRefPage = createFakePage();
  const hiddenRefLabel = hiddenRefPage.addElement(new FakeHTMLElement('label'), { text: '国家' });
  const hiddenRefInput = new FakeHTMLInputElement('input');
  hiddenRefLabel.append(hiddenRefInput);
  const hiddenRefQuery = await runPageValue(hiddenRefPage, { helper: 'query', args: ['input', { scope: 'page' }] });
  hiddenRefLabel.style.display = 'none';
  hiddenRefInput.style.display = 'none';
  const visibleRefLabel = new FakeHTMLElement('label');
  visibleRefLabel.textContent = '国家';
  const visibleRefInput = new FakeHTMLInputElement('input');
  visibleRefLabel.append(visibleRefInput);
  hiddenRefPage.document.body.prepend(visibleRefLabel);
  const hiddenRefFill = await runRawPageCommand(hiddenRefPage, { helper: 'fill', args: [hiddenRefQuery.elements[0].ref, '中国'] }) as { ok: boolean; error?: string };
  assert.equal(hiddenRefInput.value, '');
  assert.equal(hiddenRefFill.ok, true);
  assert.equal(visibleRefInput.value, '中国');

  const page = createFakePage();
  page.addElement(new FakeHTMLElement('div'), { id: 'editor', contentEditable: true });
  const queried = await runPageValue(page, { helper: 'query', args: ['#editor', { scope: 'page' }] });
  const ref = queried.elements[0].ref;
  assert.equal((await runPageValue(page, { helper: 'fill', args: [ref, 'hello'] })).filled, true);
  assert.equal((await runPageValue(page, { helper: 'click', args: [ref] })).clicked, true);
}

async function testScriptingScriptUsesSameJsonCommandSemantics() {
  const command: BrowserReplPageCommand = { helper: 'scroll', args: [{ x: Infinity, y: NaN }] };
  const userScriptPage = createFakePage();
  const scriptingPage = createFakePage();
  assert.deepEqual(await runPageValue(userScriptPage, command), await runPageValue(scriptingPage, command));
}

async function testScriptingFallbackResultIsReturned() {
  const messages: unknown[] = [];
  const result = await runBrowserReplTool({ code: 'return observe()', tabId: 5 }, {
    async runSandbox(run) {
      return run.helpers.observe({ scope: 'page' });
    },
    async sendMessage(message) {
      messages.push(message);
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [];
      if (isRecord(message) && message.type === 'taber.browserRepl.scriptingCommand') return { summary: { title: 'fallback' }, elements: [] };
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    },
  });

  assert.deepEqual(result, { value: { summary: { title: 'fallback' }, elements: [] } });
  // Trailing navigate.request is the post-REPL host check for skill announcements.
  assert.deepEqual(messages.filter(isRecord).map((message) => message.type), [chromeApiRequestType, 'taber.browserRepl.scriptingCommand', 'taber.navigate.request']);
}

async function testBrowserJsUsesUserScriptsMainWorld() {
  const messages: unknown[] = [];
  const result = await runBrowserReplTool({ code: 'return browserjs("return args.value", { value: 7 })', tabId: 5 }, {
    async runSandbox(run) {
      return run.helpers.browserjs('return args.value', { value: 7 });
    },
    async sendMessage(message) {
      messages.push(message);
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [{ result: { ok: true, value: 7 } }];
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    },
  });

  assert.deepEqual(result, { value: 7 });
  const injection = ((messages[0] as { args: unknown[] }).args[0]) as { world?: string; js?: Array<{ code?: string }> };
  assert.equal(injection.world, 'MAIN');
  assert.match(String(injection.js?.[0]?.code), /return args.value/);
}

async function testBrowserJsFunctionRunsInPageContext() {
  const messages: unknown[] = [];
  const consoleEntry = { level: 'log', text: 'title BrowserRepl Test' };
  const result = await runBrowserReplTool({ code: 'return browserjs(() => document.title)', tabId: 5 }, {
    async runSandbox(run) {
      return run.helpers.browserjs(() => document.title);
    },
    async sendMessage(message) {
      messages.push(message);
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [{ result: { ok: true, value: 'BrowserRepl Test', console: [consoleEntry] } }];
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    },
  });

  assert.deepEqual(result, { value: 'BrowserRepl Test', browserjs: { console: [consoleEntry] } });
  const injection = ((messages[0] as { args: unknown[] }).args[0]) as { js?: Array<{ code?: string }> };
  assert.match(String(injection.js?.[0]?.code), /return await \(\(\) => document\.title\)\(args\);/);
}

async function testBrowserJsFunctionCodeIsNormalized() {
  const code = normalizeBrowserJsCode((args: { value: number }) => args.value + 1);
  assert.match(code, /^return await \(/);
  assert.match(code, /\)\(args\);$/);
  assert.throws(() => normalizeBrowserJsCode(1), /browserjs code must be a string or function/);
}

async function testBrowserJsRejectsUnserializableReturnClearly() {
  const result = await eval(createBrowserReplUserScript({ helper: 'browserjs', args: ['return () => 1'] }));
  assert.equal(result.ok, false);
  assert.match(result.error, /browserjs return value must be serializable/);

  const dataUrl = await eval(createBrowserReplUserScript({ helper: 'browserjs', args: ['return "data:image/png;base64,AAA="'] }));
  assert.equal(dataUrl.ok, false);
  assert.match(dataUrl.error, /dataUrl\/base64 payloads cannot be returned/);
}

async function testBrowserJsFailureIncludesConsoleAndStackEvidence() {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const result = await eval(createBrowserReplUserScript({
      helper: 'browserjs',
      args: [`for (let index = 0; index < 25; index += 1) console.warn('entry-' + index, { index, long: 'x'.repeat(600) });
        throw new Error('boom');`],
    }));
    assert.equal(result.ok, false);
    assert.match(result.error, /browserjs failed: boom/);
    assert.match(result.error, /stack:/);
    assert.match(result.error, /console:/);
    assert.match(result.error, /\[warn\] entry-24/);
    assert.doesNotMatch(result.error, /\[warn\] entry-0/);
    assert.equal(result.console.length, 20);
    assert(result.console.every((entry: Record<string, unknown>) => entry.level === 'warn' && typeof entry.text === 'string' && entry.text.length <= 500));
  } finally {
    console.warn = originalWarn;
  }
}

function testBrowserJsRejectsDirectNavigationAndBadArgs() {
  for (const code of [
    'location.href = "https://example.test"',
    'document.location.href = "https://example.test"',
    'window.document.location = "/next"',
    'self.location.assign("/next")',
    'top.location.replace("/next")',
    'parent.location = "/next"',
    'location.pathname = "/next"',
    'window.location.search = "?q=1"',
    'document.location.hash = "#step2"',
    'window.document.location.protocol = "https:"',
    'location["href"] = "https://example.test"',
    'window.location["search"] = "?q=1"',
    'document.location["hash"] = "#step2"',
    'window["location"]["href"] = "https://example.test"',
    'location.hash += "more"',
    'window.location.pathname += "/next"',
    'location.reload()',
    'window.location.reload()',
    'window.location["reload"]()',
    'top.location["replace"]("/next")',
    'self.history["back"]()',
    'this.location.href = "https://example.test"',
    'this.history.back()',
    'this.open("https://example.test")',
    'location?.assign("/next")',
    'window.location?.reload()',
    'history?.back()',
    'location.assign?.("/next")',
    'location.reload?.()',
    'history.back?.()',
    'location?.["assign"]("/next")',
    'window.location?.["reload"]()',
    'history?.["back"]()',
    'location[`href`] = "https://example.test"',
    'window.location[`hash`] = "#x"',
    'history[`back`]()',
    'location /*comment*/ . reload()',
    'document.body.ownerDocument.defaultView.location.href = "https://evil.example/"',
    'document.body.ownerDocument.defaultView.history.back()',
    'document.body.ownerDocument.defaultView.open("https://evil.example/")',
    'document.body.contentWindow.location.href = "https://evil.example/"',
    'window.open("https://example.test", "_self")',
    'window["open"]("https://example.test")',
    'window[`open`]("https://example.test")',
    'window?.open("https://example.test")',
    'window?.["open"]("https://example.test")',
    'open?.("https://example.test")',
    'open("https://example.test")',
    'return await import("data:text/javascript,globalThis.location.href=\\"changed\\"")',
  ]) {
    assert.throws(() => normalizeBrowserJsCode(code), /Use navigate\(\) helper or the top-level navigate tool/);
  }
  assert.throws(() => createBrowserReplUserScript({ helper: 'browserjs', args: ['history.back()'] }), /Use navigate\(\) helper or the top-level navigate tool/);
  assert.throws(() => createBrowserReplUserScript({ helper: 'browserjs', args: ['self.history.go(-1)'] }), /Use navigate\(\) helper or the top-level navigate tool/);
  assert.throws(() => createBrowserReplUserScript({ helper: 'browserjs', args: ['return 1', { bad: () => 1 }] }), /browserjs args must be serializable/);
}

async function testBrowserJsRuntimeNavigationGuardBlocksAliases() {
  const page = createFakePage();
  await withFakePage(page, async () => {
    const originalFrame = Object.getOwnPropertyDescriptor(globalThis, '0');
    const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const originalHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
    const originalOpen = Object.getOwnPropertyDescriptor(globalThis, 'open');
    const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    const originalSetInterval = Object.getOwnPropertyDescriptor(globalThis, 'setInterval');
    const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
    const originalAddEventListener = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
    const originalDispatchEvent = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
    const locationState = { href: 'start', assign(url: string) { this.href = String(url); } };
    const historyCalls: string[] = [];
    const openCalls: string[] = [];
    const listeners = new Map<string, Function>();
    (page.document as any).defaultView = globalThis;
    (page.document.body as any).ownerDocument = page.document;
    (page.document.body as any).contentWindow = globalThis;
    (page.document.body as any).contentDocument = page.document;
    Object.defineProperty(globalThis, '0', { configurable: true, writable: true, value: globalThis });
    Object.defineProperty(globalThis, 'location', { configurable: true, get() { return locationState; }, set(value) { locationState.href = String(value); } });
    Object.defineProperty(globalThis, 'history', { configurable: true, writable: true, value: { back() { historyCalls.push('back'); return 'went-back'; } } });
    Object.defineProperty(globalThis, 'open', { configurable: true, writable: true, value: (url: string) => { openCalls.push(url); return 'opened'; } });
    Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value(callback: unknown, _delayMs?: number, ...args: unknown[]) { if (typeof callback === 'function') callback.call(globalThis, ...args); return 1; } });
    Object.defineProperty(globalThis, 'setInterval', { configurable: true, writable: true, value(callback: unknown, _delayMs?: number, ...args: unknown[]) { if (typeof callback === 'function') callback.call(globalThis, ...args); return 1; } });
    Object.defineProperty(globalThis, 'requestIdleCallback', { configurable: true, writable: true, value(callback: unknown, ...args: unknown[]) { if (typeof callback === 'function') callback.call(globalThis, { didTimeout: false, timeRemaining: () => 10 }, ...args); return 1; } });
    Object.defineProperty(globalThis, 'addEventListener', { configurable: true, writable: true, value(type: string, listener: Function | { handleEvent?(event: unknown): void }) { listeners.set(type, listener as Function); } });
    Object.defineProperty(globalThis, 'dispatchEvent', { configurable: true, writable: true, value(event: { type: string; currentTarget?: unknown; target?: unknown }) {
      event.currentTarget = globalThis;
      event.target = globalThis;
      const listener = listeners.get(event.type);
      if (typeof listener === 'function') listener.call(globalThis, event);
      else if (listener && typeof (listener as { handleEvent?: unknown }).handleEvent === 'function') (listener as { handleEvent(event: unknown): void }).handleEvent(event);
      return true;
    } });
    try {
      for (const code of [
        'const target = location; target.href = "https://example.test";',
        'document.defaultView.location.href = "https://example.test";',
        'frames[0].location.href = "https://example.test";',
        'const nav = window["open"]; nav("https://example.test");',
        'const back = history.back; back();',
        'this["loc"+"ation"]["href"] = "https://example.test";',
        'return this["hist"+"ory"]["back"]();',
        'return this["op"+"en"]("https://example.test");',
        'Object.getOwnPropertyDescriptor(globalThis, "location").set.call(globalThis, "https://example.test");',
        'Object.getOwnPropertyDescriptor(globalThis, "location").get.call(globalThis).assign("https://example.test");',
        'globalThis.__lookupSetter__("location").call(globalThis, "https://example.test");',
        'globalThis.__lookupGetter__("location").call(globalThis).assign("https://example.test");',
        'Object.getOwnPropertyDescriptor(globalThis, "history").value.back();',
        'Object.getOwnPropertyDescriptor(globalThis, "open").value("https://example.test");',
        'Reflect.getOwnPropertyDescriptor(globalThis, "open").value("https://example.test");',
        'Object.defineProperty(window, "taberDefined", { configurable: true, get() { const descriptor = Object.getOwnPropertyDescriptor(this, "location"); return descriptor.get.call(this).assign("https://example.test"); } }); return window.taberDefined;',
        'window.__defineGetter__("taberGetter", function(){ const descriptor = Object.getOwnPropertyDescriptor(this, "location"); return descriptor.get.call(this).assign("https://example.test"); }); return window.taberGetter;',
        'window.__defineSetter__("taberSetter", function(){ const descriptor = Object.getOwnPropertyDescriptor(this, "location"); return descriptor.get.call(this).assign("https://example.test"); }); window.taberSetter = 1;',
        'const raw = location.valueOf(); raw.assign("https://example.test");',
        'const raw = location.valueOf(); raw.href = "https://example.test";',
        'const raw = history.valueOf(); raw.back();',
        'navigationGuard.restore(); const body = "globalThis[\\"loc\\"+\\"ation\\"].href=\\"https://example.test\\"; return globalThis[\\"loc\\"+\\"ation\\"].href"; return (()=>{}).constructor(body)();',
        'createNavigationGuard().restore(); const body = "globalThis[\\"loc\\"+\\"ation\\"].href=\\"https://example.test\\"; return globalThis[\\"loc\\"+\\"ation\\"].href"; return (()=>{}).constructor(body)();',
        'const body = ["location", ".href = \\"https://example.test\\""].join(""); return new Function(body)();',
        'const body = ["location", ".href = \\"https://example.test\\""].join(""); return eval(body);',
        'setTimeout(["location", ".href = \\"https://example.test\\""].join(""), 0); return "scheduled";',
        'setTimeout(function(){ this["loc"+"ation"].href = "https://example.test"; }, 0); return location.href;',
        'setInterval(function(){ this["loc"+"ation"].href = "https://example.test"; }, 0); return location.href;',
        'requestIdleCallback(function(){ this["loc"+"ation"].href = "https://example.test"; }); return location.href;',
        'new MutationObserver((records) => { records[0].target.ownerDocument.defaultView.location.href = "https://example.test"; }).observe(document.body); return "scheduled";',
        'window.addEventListener("taber-test", function(){ this["loc"+"ation"].href = "https://example.test"; }, { once: true }); window.dispatchEvent({ type: "taber-test" }); return location.href;',
        'addEventListener("taber-test-2", function(){ this["loc"+"ation"].href = "https://example.test"; }, { once: true }); dispatchEvent({ type: "taber-test-2" }); return location.href;',
        'window.addEventListener("taber-test-3", { handleEvent(event) { event.currentTarget["loc"+"ation"].href = "https://example.test"; } }); window.dispatchEvent({ type: "taber-test-3" }); return location.href;',
        'const event = { type: "taber-test-4" }; dispatchEvent(event); event.target["loc"+"ation"].href = "https://example.test"; return location.href;',
        'const event = { type: "taber-test-5" }; dispatchEvent(event); event.currentTarget["loc"+"ation"].href = "https://example.test"; return location.href;',
        'const event = { type: "taber-test-6" }; try { dispatchEvent(event); } catch (_error) {} event.target["loc"+"ation"].href = "https://example.test"; return location.href;',
        'const event = { type: "taber-test-7" }; try { dispatchEvent(event); } catch (_error) {} event.currentTarget["loc"+"ation"].href = "https://example.test"; return location.href;',
        'try { Object.defineProperty(Object.prototype, "taberLeak", { configurable: true, get() { return this.ownerDocument.defaultView.location; } }); const loc = document.body.taberLeak; loc.href = "https://example.test"; } finally { delete Object.prototype.taberLeak; } return location.href;',
        'try { Object.defineProperty(Object.prototype, "taberLeak", { configurable: true, value: function () { this.ownerDocument.defaultView.location.href = "https://example.test"; } }); document.body.taberLeak(); } finally { delete Object.prototype.taberLeak; } return location.href;',
        'try { Object.defineProperty(Object.prototype, "bypass", { configurable: true, set() { this["loc"+"ation"].href = "https://example.test"; } }); window.bypass = 1; } finally { delete Object.prototype.bypass; } return location.href;',
        'document.__proto__ = { leak() { this.defaultView.location.href = "https://example.test"; } }; document.leak(); return location.href;',
        'try { Object.defineProperty(HTMLElement.prototype, "taberLeak", { configurable: true, get() { return this.ownerDocument.defaultView.location.assign.bind(this.ownerDocument.defaultView.location); } }); const go = document.body.taberLeak; go("https://example.test/path"); } finally { delete HTMLElement.prototype.taberLeak; } return location.href;',
        'try { Object.defineProperty(HTMLElement.prototype, "taberLeak", { configurable: true, get() { return this.ownerDocument.defaultView.open.bind(this.ownerDocument.defaultView); } }); const openTab = document.body.taberLeak; openTab("https://example.test/open"); } finally { delete HTMLElement.prototype.taberLeak; } return location.href;',
        'const form = document.createElement("form"); form.action = "https://example.test/form"; form.submit(); return location.href;',
        'const form = document.createElement("form"); form.action = "https://example.test/form"; form.requestSubmit(); return location.href;',
        'const link = document.createElement("a"); link.href = "https://example.test/link"; link.click(); return location.href;',
        'const link = document.createElement("a"); link.href = "https://example.test/open"; link.target = "_blank"; link.click(); return location.href;',
        'await Promise.resolve().then(function(){ this["loc"+"ation"].href = "https://example.test"; }); return location.href;',
        'await Promise.resolve().finally(function(){ this["loc"+"ation"].href = "https://example.test"; }); return location.href;',
        'return (() => {}).constructor(["location", ".href = \\"https://example.test\\""].join(""))();',
        'const nextWindow = document.body.ownerDocument.defaultView; nextWindow["loc"+"ation"]["href"] = "https://example.test";',
        'const nextHistory = document.body.ownerDocument.defaultView["hist"+"ory"]; nextHistory["ba"+"ck"]();',
        'const nextOpen = document.body.ownerDocument.defaultView["op"+"en"]; nextOpen("https://example.test");',
        'document.body.contentWindow["loc"+"ation"]["href"] = "https://example.test";',
        'document.body.contentDocument.defaultView["op"+"en"]("https://example.test");',
      ]) {
        locationState.href = 'start';
        historyCalls.length = 0;
        openCalls.length = 0;
        listeners.clear();
        Reflect.deleteProperty(globalThis, 'taberDefined');
        Reflect.deleteProperty(globalThis, 'taberGetter');
        Reflect.deleteProperty(globalThis, 'taberSetter');
        const result = await runBrowserJsClassic(code);
        assert.equal(result.ok, false, code);
        assert.match(result.error, /Use navigate\(\) helper or the top-level navigate tool instead/, code);
        assert.equal(locationState.href, 'start', code);
        assert.deepEqual(historyCalls, [], code);
        assert.deepEqual(openCalls, [], code);
      }
    } finally {
      Reflect.deleteProperty(globalThis, 'taberDefined');
      Reflect.deleteProperty(globalThis, 'taberGetter');
      Reflect.deleteProperty(globalThis, 'taberSetter');
      if (originalDispatchEvent) Object.defineProperty(globalThis, 'dispatchEvent', originalDispatchEvent);
      else Reflect.deleteProperty(globalThis, 'dispatchEvent');
      if (originalAddEventListener) Object.defineProperty(globalThis, 'addEventListener', originalAddEventListener);
      else Reflect.deleteProperty(globalThis, 'addEventListener');
      if (originalRequestIdleCallback) Object.defineProperty(globalThis, 'requestIdleCallback', originalRequestIdleCallback);
      else Reflect.deleteProperty(globalThis, 'requestIdleCallback');
      if (originalSetInterval) Object.defineProperty(globalThis, 'setInterval', originalSetInterval);
      else Reflect.deleteProperty(globalThis, 'setInterval');
      if (originalSetTimeout) Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout);
      else Reflect.deleteProperty(globalThis, 'setTimeout');
      if (originalFrame) Object.defineProperty(globalThis, '0', originalFrame);
      else Reflect.deleteProperty(globalThis, '0');
      if (originalHistory) Object.defineProperty(globalThis, 'history', originalHistory);
      else Reflect.deleteProperty(globalThis, 'history');
      if (originalOpen) Object.defineProperty(globalThis, 'open', originalOpen);
      else Reflect.deleteProperty(globalThis, 'open');
      if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
      else Reflect.deleteProperty(globalThis, 'location');
    }
  });
}

async function testBrowserJsAllowsSafeDomWrites() {
  const page = createFakePage();
  const input = new FakeHTMLInputElement('input');
  (page.document as any).safeInput = input;
  (page.document.body as any).dataset = {};
  await withFakePage(page, async () => {
    const result = await runBrowserJsClassic(`document.body.dataset.browserjsFetch = String(typeof fetch);
      document.safeInput.value = "Ada";
      return { dataset: document.body.dataset.browserjsFetch, value: document.safeInput.value };`);
    assert.deepEqual(result, { ok: true, value: { dataset: 'function', value: 'Ada' }, console: [] });
  });
}

async function testBrowserJsDelayedTimerCallbacksStayGuarded() {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
  const locationState = { href: 'start' };
  const callbacks: Array<() => void> = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, get() { return locationState; }, set(value) { locationState.href = String(value); } });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value(callback: unknown, _delayMs?: number, ...args: unknown[]) { if (typeof callback === 'function') callbacks.push(() => callback.call(globalThis, ...args)); return 1; } });
  try {
    const result = await runBrowserJsClassic('setTimeout(function(){ setTimeout.constructor(["loc"+"ation", ".href=\\"changed\\""].join(""))(); }, 0); return "scheduled";');
    assert.deepEqual(result, { ok: true, value: 'scheduled', console: [] });
    assert.equal(locationState.href, 'start');
    assert.equal(callbacks.length, 1);
    assert.throws(callbacks[0], /Use navigate\(\) helper or the top-level navigate tool instead/);
    assert.equal(locationState.href, 'start');
  } finally {
    if (originalSetTimeout) Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout);
    else Reflect.deleteProperty(globalThis, 'setTimeout');
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
}

function runBrowserJsClassic(code: string) {
  return Function(`return ${createBrowserReplUserScript({ helper: 'browserjs', args: [code] })}`)();
}

function testCloneBoundaryErrorIsActionable() {
  assert.match(
    cloneBoundaryError('browserRepl return value', new DOMException('HTMLBodyElement object could not be cloned.', 'DataCloneError')),
    /browserRepl return value must be serializable/,
  );
}

async function testBrowserJsUnavailableFailsClearlyWithoutProductionFallback() {
  await assert.rejects(
    runBrowserReplTool({ code: 'return browserjs("return document.title")', tabId: 5 }, {
      async runSandbox(run) {
        return run.helpers.browserjs('return document.title');
      },
      async sendMessage(message) {
        if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [];
        throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
      },
    }),
    /browserjs requires Chrome User Scripts/,
  );
}

async function testBrowserJsSharesPageGlobalsButNotExtensionLexicals() {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { sendMessage() { throw new Error('should not call extension runtime'); } } } });
  try {
    const result = await eval(createBrowserReplUserScript({
      helper: 'browserjs',
      args: [`return {
        chromeType: typeof chrome,
        browserType: typeof browser,
        runtimeType: typeof runtime,
        extensionRuntimeType: typeof extensionRuntime,
        globalChromeType: typeof globalThis.chrome,
        fetchType: typeof fetch,
        constructorText: '(() => {}).constructor',
      };`],
    }));
    assert.deepEqual(result, {
      ok: true,
      value: {
        chromeType: 'undefined',
        browserType: 'undefined',
        runtimeType: 'undefined',
        extensionRuntimeType: 'undefined',
        globalChromeType: 'object',
        fetchType: 'function',
        constructorText: '(() => {}).constructor',
      },
      console: [],
    });
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
}

async function testBrowserJsCanBeDisabledForAgentConsent() {
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { throw new Error('should not execute page command'); },
    async runSandbox(run) { return Object.keys(run.helpers).sort(); },
    browserJsEnabled: false,
  });

  assert.deepEqual(await controller.run({ code: 'return Object.keys(arguments[0] ?? {})' }), { value: ['batch', 'click', 'fill', 'fillForm', 'listInteractiveElements', 'observe', 'pickElement', 'pickUserElement', 'press', 'query', 'queryText', 'readLinksAndButtons', 'readVisibleText', 'sandbox', 'scroll', 'waitFor'] });
}

async function testCspSafeHelpersDoNotRequireBrowserJsConsent() {
  const pageCommands: BrowserReplPageCommand[] = [];
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand(_tabId, command) {
      pageCommands.push(command);
      if (command.helper === 'readVisibleText') return { title: 'CSP', url: 'https://example.test', text: '模型广场' };
      if (command.helper === 'queryText') return { query: command.args[0], matches: [{ context: '模型广场' }], candidates: [] };
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async runSandbox(run) {
      assert(!('browserjs' in run.helpers));
      return { visible: await run.helpers.readVisibleText(), queried: await run.helpers.queryText('模型广场') };
    },
    browserJsEnabled: false,
  });

  assert.deepEqual(await controller.run({ code: 'return readVisibleText()' }), { value: { visible: { title: 'CSP', url: 'https://example.test', text: '模型广场' }, queried: { query: '模型广场', matches: [{ context: '模型广场' }], candidates: [] } } });
  assert.deepEqual(pageCommands.map((command) => command.helper), ['readVisibleText', 'queryText']);
  assert.doesNotMatch(createBrowserReplUserScript({ helper: 'readVisibleText', args: [] }), /AsyncFunction|browserjs/);
}

function testParsesInput() {
  assert.deepEqual(parseBrowserReplInput({ code: 'return 1', tabId: 7, timeoutMs: 120_000 }), { code: 'return 1' });
  assert.throws(() => parseBrowserReplInput({ code: '' }), /browserRepl.code is required/);
}

async function testBrowserReplEvaluatesExpressionsAndBodies() {
  const helper = async () => 'visible text';
  assert.equal(await evaluateBrowserReplCode('readVisibleText()', { readVisibleText: helper }), 'visible text');
  assert.equal(await evaluateBrowserReplCode('await readVisibleText();', { readVisibleText: helper }), 'visible text');
  assert.equal(await evaluateBrowserReplCode('const text = await readVisibleText(); return text;', { readVisibleText: helper }), 'visible text');
}

async function testBrowserReplNeverReturnsSilentUndefined() {
  const evidence = { title: 'Live page', text: 'Visible content' };
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { return evidence; },
    async runSandbox(run) {
      await run.helpers.readVisibleText();
      return undefined;
    },
  });
  assert.deepEqual(await controller.run({ code: 'await readVisibleText();' }), { value: evidence });

  const emptyController = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { throw new Error('should not run'); },
    async runSandbox() { return undefined; },
  });
  assert.deepEqual(await emptyController.run({ code: 'const value = 1;' }), {
    ok: false,
    code: 'NO_EVIDENCE',
    message: 'browserRepl completed without returning evidence.',
    retryHint: 'Do not repeat possible side effects. Inspect fresh state with browser.snapshot, or return the result from multi-statement code.',
  });
}

async function evaluateBrowserReplCode(code: string, helpers: Record<string, (...args: unknown[]) => unknown>) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let syntaxError: unknown;
  for (const source of browserReplExecutionSources(code)) {
    let run: (...args: unknown[]) => Promise<unknown>;
    try {
      run = new AsyncFunction(...Object.keys(helpers), source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      syntaxError = error;
      continue;
    }
    return run(...Object.values(helpers));
  }
  throw syntaxError;
}

function testRoutesFallbacks() {
  assert.equal(browserReplFallbackFor({ helper: 'browserjs', args: ['return 1'] }), 'browserjsCdp');
  assert.equal(browserReplFallbackFor({ helper: 'press', args: [undefined, 'Enter'] }), 'pressCdp');
  assert.equal(browserReplFallbackFor({ helper: 'click', args: [] }), 'scripting');
}

async function testRunsSandboxWithHelpersAndElementRefs() {
  const pageCommands: BrowserReplPageCommand[] = [];
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 3; },
    async executePageCommand(tabId, command) {
      assert.equal(tabId, 3);
      pageCommands.push(command);
      if (command.helper === 'observe') return { summary: { title: 'Test' }, elements: [{ index: 1, tag: 'button', name: 'Save', ref: { stableId: 'button|#save|Save', selector: '#save', tagName: 'button', name: 'Save' } }] };
      if (command.helper === 'click') return { clicked: true };
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async runSandbox(run) {
      assert.equal(run.timeoutMs, DEFAULT_BROWSER_REPL_TIMEOUT_MS);
      assert.deepEqual(Object.keys(run.helpers).sort(), ['batch', 'browserjs', 'click', 'fill', 'fillForm', 'listInteractiveElements', 'observe', 'pickElement', 'pickUserElement', 'press', 'query', 'queryText', 'readLinksAndButtons', 'readVisibleText', 'sandbox', 'scroll', 'waitFor']);
      assert.equal(await run.helpers.sandbox('return args.value + 1', { value: 1 }), 2);
      const observed = await run.helpers.observe();
      assert.deepEqual(observed, { summary: { title: 'Test' }, elements: [{ index: 1, tag: 'button', name: 'Save' }] });
      return run.helpers.click(1);
    },
  });

  assert.deepEqual(await controller.run({ code: 'return click(1)' }), { value: { clicked: true } });
  assert.equal(pageCommands[1].helper, 'click');
  assert.equal(pageCommands[1].timeoutMs, 5_000);
  assert.equal(typeof pageCommands[1].cancelKey, 'string');
}

async function testRunsSandboxWithSelectorBatchAndFillFormHelpers() {
  const ref = { stableId: 'input|#name|Name', selector: '#name', tagName: 'input', name: 'Name' };
  const pageCommands: BrowserReplPageCommand[] = [];
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 3; },
    async executePageCommand(_tabId, command) {
      pageCommands.push(command);
      if (command.helper === 'observe') return { elements: [{ index: 1, ref }] };
      if (command.helper === 'fill') return { filled: true, target: command.args[0] };
      if (command.helper === 'batch') return { ok: true, actions: command.args[0] };
      if (command.helper === 'fillForm') return { ok: true, dryRun: true };
      if (command.helper === 'pickUserElement') return { selector: '#picked', attributes: { id: 'picked' }, args: command.args };
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async runSandbox(run) {
      await assert.rejects(run.helpers.click(9), /one browserRepl call/);
      const selectorFill = await run.helpers.fill('#name', 'alpha');
      await run.helpers.observe();
      const batchResult = await run.helpers.batch([{ action: 'click', index: 1 }, { action: 'fill', selector: '#name', value: 'beta' }]);
      const formResult = await run.helpers.fillForm({ fields: { Name: 'alpha' }, dryRun: true });
      const picked = await run.helpers.pickUserElement('Pick one');
      return { selectorFill, batchResult, formResult, picked };
    },
  });

  const result = await controller.run({ code: 'return 1' });
  assert.ok('value' in result);
  assert.deepEqual(result.value, {
    selectorFill: { filled: true, target: '#name' },
    batchResult: { ok: true, actions: [{ action: 'click', index: 1, target: ref }, { action: 'fill', selector: '#name', value: 'beta', target: '#name' }] },
    formResult: { ok: true, dryRun: true },
    picked: { selector: '#picked', attributes: { id: 'picked' }, args: [{ message: 'Pick one' }] },
  });
  assert.deepEqual(pageCommands.map((command) => command.helper), ['fill', 'observe', 'batch', 'fillForm', 'pickUserElement']);
}

async function testCommonToolMisuseFallbacks() {
  const page = createFakePage();
  page.addElement(new FakeHTMLElement('main'), { text: '欢迎来到模型广场' });
  const link = page.addElement(new FakeHTMLElement('a'), { text: '新窗口打开' });
  link.setAttribute('href', '#new-window');
  const pageCommands: BrowserReplPageCommand[] = [];
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 3; },
    async executePageCommand(_tabId, command) {
      pageCommands.push(command);
      return runPageValue(page, command);
    },
    async runSandbox(run) {
      const textWait = await run.helpers.waitFor('模型广场');
      const bodyWait = await run.helpers.waitFor('body');
      await assert.rejects(() => run.helpers.observe('模型广场'), /observe\(\) does not search text/);
      return { textWait, bodyWait };
    },
  });

  assert.deepEqual(await controller.run({ code: 'return common misuse fallbacks' }), { value: { textWait: { matched: true }, bodyWait: { matched: true } } });
  assert.deepEqual(pageCommands.filter((command) => command.helper === 'waitFor').map((command) => command.args[0]), [{ text: '模型广场' }, { selector: 'body' }]);

  const hasText = await runRawPageCommand(page, { helper: 'query', args: ['a:has-text("新窗口打开")'] }) as { ok: false; error: string };
  assert.equal(hasText.ok, false);
  assert.match(hasText.error, /Native CSS does not support :has-text\(\)/);
  assert.match(hasText.error, /waitFor\(\{ text/);

  const host = page.addElement(new FakeHTMLElement('div'), { id: 'shadow-host' });
  const shadowLink = new FakeHTMLElement('a');
  shadowLink.setAttribute('href', '#shadow-new-window');
  shadowLink.textContent = '新窗口打开';
  host.attachShadow({ mode: 'open' }).append(shadowLink);
  const shadowHasText = await runRawPageCommand(page, { helper: 'click', args: ['#shadow-host >>> a:has-text("新窗口打开")'] }) as { ok: false; error: string };
  assert.equal(shadowHasText.ok, false);
  assert.match(shadowHasText.error, /Native CSS does not support :has-text\(\)/);
  assert.match(shadowHasText.error, /text\/role locator/);
}

async function testIndexesCannotBeReusedAcrossBrowserReplCalls() {
  const ref = { stableId: 'button|#save', selector: '#save', tagName: 'button', name: 'Save' };
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 3; },
    async executePageCommand(_tabId, command) {
      if (command.helper === 'observe') return { elements: [{ index: 1, ref }] };
      if (command.helper === 'click') throw new Error('stale index should not reach the page');
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async runSandbox(run) {
      if (run.code === 'observe') {
        const observed = await run.helpers.observe() as { elements: Array<{ index: number }> };
        return observed.elements[0].index;
      }
      return run.helpers.click(1);
    },
  });

  assert.deepEqual(await controller.run({ code: 'observe' }), { value: 1 });
  await assert.rejects(() => controller.run({ code: 'reuse old index' }), /one browserRepl call/);
}

async function testRunsSandboxWithNavigateHelper() {
  let currentTabId = 3;
  const navigations: unknown[] = [];
  const pageTabIds: number[] = [];
  const controller = createBrowserReplController({
    async getCurrentTabId() { return currentTabId; },
    async executePageCommand(tabId, command) {
      pageTabIds.push(tabId);
      if (command.helper === 'observe') return { summary: { title: 'New page' }, elements: [] };
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async navigate(input, signal) {
      assert.equal(signal?.aborted, false);
      const parsed = parseNavigateInput(input);
      navigations.push(parsed);
      currentTabId = 4;
      return { action: parsed.action, tab: { id: 4, ...(parsed.action === 'open' ? { url: parsed.url } : {}) } };
    },
    async runSandbox(run) {
      assert(Object.keys(run.helpers).includes('navigate'));
      const opened = await run.helpers.navigate({ action: 'open', url: 'https://example.test' });
      const observed = await run.helpers.observe();
      await assert.rejects(() => run.helpers.navigate({ action: 'open' }), /navigate.open requires url/);
      return { opened, observed };
    },
  });

  assert.deepEqual(await controller.run({ code: 'return navigate({ action:"open", url:"https://example.test" })' }, new AbortController().signal), { value: { opened: { action: 'open', tab: { id: 4, url: 'https://example.test' } }, observed: { summary: { title: 'New page' }, elements: [] } } });
  assert.deepEqual(navigations, [{ action: 'open', url: 'https://example.test' }]);
  assert.deepEqual(pageTabIds, [4]);
}

async function testIndexesSurviveLaterQueriesInSameBrowserReplCall() {
  const refA = { stableId: 'button|#a', selector: '#a', tagName: 'button', name: 'A', marker: 'a' };
  const refB = { stableId: 'button|#b', selector: '#b', tagName: 'button', name: 'B', marker: 'b' };
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 3; },
    async executePageCommand(_tabId, command) {
      if (command.helper === 'observe') return { elements: [{ index: 1, ref: refA }] };
      if (command.helper === 'query') return { elements: [{ index: 1, ref: refB }] };
      if (command.helper === 'click') return { clicked: (command.args[0] as { selector?: string }).selector };
      throw new Error(`unexpected command: ${command.helper}`);
    },
    async runSandbox(run) {
      const observed = await run.helpers.observe() as { elements: Array<{ index: number }> };
      await run.helpers.query('#b');
      return run.helpers.click(observed.elements[0].index);
    },
  });
  assert.deepEqual(await controller.run({ code: 'return 1' }), { value: { clicked: '#a' } });
}

async function testCdpFallbackDispatchesNativeInput() {
  const command: BrowserReplPageCommand = { helper: 'click', args: [{ stableId: 'button|#save|Save', selector: '#save', tagName: 'button', name: 'Save' }] };

  assert.equal(canUseCdpFallback(command, new Error('DOM click failed')), true);
  assert.equal(canUseCdpFallback(command, new Error('Element is disabled')), false);
  assert.equal(canUseCdpFallback(command, new Error('No element matches selector')), false);

  const calls: { action: string; args: unknown[] }[] = [];
  const run = (nextCommand: BrowserReplPageCommand) => executeBrowserReplCdpFallback({
    tabId: 9,
    command: nextCommand,
    async runPageCommand(pageCommand) {
      assert.equal(pageCommand.helper, 'pickElement');
      return { tag: 'input', rect: { x: 10, y: 20, width: 30, height: 40 } };
    },
    async callChromeApi(action, args) {
      calls.push({ action, args });
      return undefined;
    },
  });

  assert.deepEqual(await run(command), { clicked: true, fallback: 'cdp' });
  assert.deepEqual(await run({ helper: 'fill', args: [command.args[0], 'hello'] }), { filled: true, fallback: 'cdp' });
  assert.deepEqual(await run({ helper: 'press', args: [command.args[0], 'Enter'] }), { pressed: 'Enter', fallback: 'cdp' });
  const methods = calls.filter((call) => call.action === 'debugger.sendCommand').map((call) => (call.args[1] as string));
  assert(methods.includes('Input.dispatchMouseEvent'));
  assert(methods.includes('Input.insertText'));
  assert(methods.includes('Input.dispatchKeyEvent'));
}

async function testFrameAwareBrowserRouterCoversIframeRequirements() {
  let frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://main.test/page' },
    { frameId: 1, parentFrameId: 0, url: 'https://main.test/frame' },
    { frameId: 2, parentFrameId: 0, url: 'https://cross.test/frame' },
    { frameId: 3, parentFrameId: 0, url: 'https://blocked.test/frame' },
  ];
  const pages = new Map([
    [0, new FrameRouterFakePage('Main', 'https://main.test/page', [frameButton('Duplicate')])],
    [1, new FrameRouterFakePage('Same Frame', 'https://main.test/frame', [frameButton('Frame CTA'), frameInput('Frame Name')])],
    [2, new FrameRouterFakePage('Cross Frame', 'https://cross.test/frame', [frameButton('Cross CTA'), frameButton('Duplicate')])],
  ]);
  const executor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') return frames;
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') {
        const injection = (message.args as unknown[])[0] as Record<string, any>;
        const frameId = Number(injection.target?.frameIds?.[0] ?? 0);
        if (frameId === 3) throw new Error('Missing host permission for https://blocked.test/*');
        const page = pages.get(frameId);
        if (!page) throw new Error(`Missing fake frame page: ${frameId}`);
        return [{ result: { ok: true, value: page.browser(readInjectedPageCommand(injection).args[0] as Record<string, unknown>) } }];
      }
      throw new Error(`Unexpected frame router message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 1,
    async errorFromResponse(message) { return new Error(message); },
  });

  const snapshot = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }) as Record<string, any>;
  assert.equal(snapshot.ok, true);
  const sameOriginFrame = findFrame(snapshot.state, 'https://main.test/frame');
  const crossOriginWithPermissionFrame = findFrame(snapshot.state, 'https://cross.test/frame');
  const noPermissionFrame = findFrame(snapshot.state, 'https://blocked.test/frame');
  assert.equal(sameOriginFrame.accessible, true, 'same-origin iframe snapshot/read must be accessible');
  assert.match(String(sameOriginFrame.text), /Frame CTA/, 'same-origin iframe readable text must stay under frames[]');
  assert.equal(typeof findFrameElement(snapshot.state, 'https://main.test/frame', 'Frame CTA').ref, 'string', 'same-origin iframe element needs an actionable opaque ref');
  assert.equal(crossOriginWithPermissionFrame.accessible, true, 'cross-origin iframe with host permission must be accessible');
  assert.equal(typeof findFrameElement(snapshot.state, 'https://cross.test/frame', 'Cross CTA').ref, 'string', 'cross-origin permitted iframe element needs an actionable opaque ref');
  assert.equal(noPermissionFrame.code, 'FRAME_NOT_ACCESSIBLE');
  assert.match(String(noPermissionFrame.hint), /Website access|blocked\.test/);
  assert.doesNotMatch(JSON.stringify(snapshot.state), /selector|fingerprint|marker|stableId|shadowPath|data-taber-repl-ref/);
  assertBrowserSnapshotShape(snapshot.state);
  for (const frame of snapshot.state.frames) assertBrowserSnapshotShape({ elements: frame.elements ?? [] });

  const sameButtonRef = findFrameElement(snapshot.state, 'https://main.test/frame', 'Frame CTA').ref;
  const sameClicked = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { ref: sameButtonRef } }] }) as Record<string, any>;
  assert.equal(sameClicked.ok, true);
  assert.equal(pages.get(1)?.clicked, 'Frame CTA', 'same-origin iframe click(ref) must route to the iframe');

  const blockedSearch = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Blocked CTA' } }] }) as Record<string, any>;
  assert.equal(blockedSearch.ok, false, 'no-permission iframe content must not be silently matched');
  assert.equal(blockedSearch.code, 'NO_TARGET');
  assert.match(blockedSearch.message, /FRAME_NOT_ACCESSIBLE/);
  assert(findFrame(blockedSearch.state, 'https://blocked.test/frame').hint.includes('Website access'));

  const filled = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'fill', target: { label: 'Frame Name' }, value: 'Ada' }] }) as Record<string, any>;
  assert.equal(filled.ok, true);
  assert.equal(pages.get(1)?.value('Frame Name'), 'Ada');
  const pressRef = findFrameElement(filled.state, 'https://main.test/frame', 'Frame Name').ref;
  const pressed = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'press', target: { ref: pressRef }, key: 'Enter' }] }) as Record<string, any>;
  assert.equal(pressed.ok, true);
  assert.deepEqual(pages.get(1)?.pressed, ['Enter']);

  const crossClicked = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Cross CTA' } }] }) as Record<string, any>;
  assert.equal(crossClicked.ok, true);
  assert.equal(pages.get(2)?.clicked, 'Cross CTA', 'cross-origin iframe with permission must support text action routing');

  const staleRef = findFrameElement(crossClicked.state, 'https://main.test/frame', 'Frame CTA').ref;
  frames = frames.map((frame) => frame.frameId === 1 ? { ...frame, url: 'https://main.test/reloaded-frame' } : frame);
  const stale = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { ref: staleRef } }] }) as Record<string, any>;
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_REF');
  assert.equal(pages.get(1)?.clicked, 'Frame CTA');

  const ambiguous = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Duplicate' } }] }) as Record<string, any>;
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert(ambiguous.candidates.some((group: Record<string, any>) => group.frame.context === 'main'), 'ambiguous candidates must include main document group');
  assert(ambiguous.candidates.some((group: Record<string, any>) => group.frame.context === 'frame'), 'ambiguous candidates must include iframe group');
}

async function testFrameRouterMainDocumentActionUsesSinglePageCommand() {
  const calls: string[] = [];
  const executor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') {
        calls.push('frames');
        return [{ frameId: 0, parentFrameId: -1, url: 'https://main.test/page' }];
      }
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') {
        const command = readInjectedPageCommand((message.args as unknown[])[0] as Record<string, any>);
        const input = command.args[0] as Record<string, unknown>;
        calls.push(String(input.action));
        assert.equal(input.action, 'click');
        return [{ result: { ok: true, value: { ok: true, action: 'click', evidence: { selector: '#save' }, state: { title: 'After', url: 'https://main.test/page', elements: [{ ref: 'local-ref', number: 1, kind: 'button', tag: 'button', role: 'button', name: 'Next', text: 'Next', rect: { x: 1, y: 2, width: 3, height: 4 } }] } } } }];
      }
      throw new Error(`Unexpected main document fast-path message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 1,
    async errorFromResponse(message) { return new Error(message); },
  });

  const result = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Save' } }] }) as Record<string, any>;
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['frames', 'click']);
  assert.equal(result.state.elements.length, 1);
  assert.notEqual(result.state.elements[0].ref, 'local-ref');
  assert.match(result.state.elements[0].ref, /^b/);
}

async function testFrameRouterSameOriginIframeEndToEnd() {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://main.test/page' },
    { frameId: 1, parentFrameId: 0, url: 'https://main.test/frame' },
  ];
  const pages = new Map([
    [0, new FrameRouterFakePage('Main', 'https://main.test/page', [frameButton('Main CTA')])],
    [1, new FrameRouterFakePage('Same Frame', 'https://main.test/frame', [frameButton('Same CTA'), frameInput('Same Name')])],
  ]);
  const executor = createFrameRouterTestExecutor({ frames: () => frames, pages });

  const snapshot = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }) as Record<string, any>;
  const frame = findFrame(snapshot.state, 'https://main.test/frame');
  assert.equal(frame.accessible, true);
  assert.match(String(frame.text), /Same CTA/);
  const ref = findFrameElement(snapshot.state, 'https://main.test/frame', 'Same CTA').ref;
  const clicked = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { ref } }] }) as Record<string, any>;
  assert.equal(clicked.ok, true);
  assert.equal(pages.get(1)?.clicked, 'Same CTA');
  const filled = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'fill', target: { label: 'Same Name' }, value: 'same-origin' }] }) as Record<string, any>;
  assert.equal(filled.ok, true);
  assert.equal(pages.get(1)?.value('Same Name'), 'same-origin');
}

async function testFrameRouterCrossOriginPermissionAndBlockedBoundary() {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://main.test/page' },
    { frameId: 2, parentFrameId: 0, url: 'https://cross.test/frame' },
    { frameId: 3, parentFrameId: 0, url: 'https://blocked.test/frame' },
  ];
  const pages = new Map([
    [0, new FrameRouterFakePage('Main', 'https://main.test/page', [frameButton('Main CTA')])],
    [2, new FrameRouterFakePage('Cross Frame', 'https://cross.test/frame', [frameButton('Cross CTA')])],
  ]);
  const executor = createFrameRouterTestExecutor({ frames: () => frames, pages, blockedFrameIds: new Set([3]) });

  const crossClicked = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Cross CTA' } }] }) as Record<string, any>;
  assert.equal(crossClicked.ok, true);
  assert.equal(pages.get(2)?.clicked, 'Cross CTA');
  assert.equal(findFrame(crossClicked.state, 'https://cross.test/frame').accessible, true);

  const blockedSearch = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Blocked CTA' } }] }) as Record<string, any>;
  assert.equal(blockedSearch.ok, false);
  assert.equal(blockedSearch.code, 'NO_TARGET');
  assert.match(blockedSearch.message, /FRAME_NOT_ACCESSIBLE/);
  const blockedFrame = findFrame(blockedSearch.state, 'https://blocked.test/frame');
  assert.equal(blockedFrame.code, 'FRAME_NOT_ACCESSIBLE');
  assert.match(String(blockedFrame.hint), /Website access|blocked\.test/);
}

async function testFrameRouterAmbiguousAndSnapshotPrivacy() {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://main.test/page' },
    { frameId: 1, parentFrameId: 0, url: 'https://main.test/frame' },
    { frameId: 2, parentFrameId: 0, url: 'https://cross.test/frame' },
  ];
  const pages = new Map([
    [0, new FrameRouterFakePage('Main', 'https://main.test/page', [frameButton('Duplicate')])],
    [1, new FrameRouterFakePage('Same Frame', 'https://main.test/frame', [frameButton('Duplicate')])],
    [2, new FrameRouterFakePage('Cross Frame', 'https://cross.test/frame', [frameButton('Cross CTA')])],
  ]);
  const executor = createFrameRouterTestExecutor({ frames: () => frames, pages });

  const snapshot = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }) as Record<string, any>;
  assert.doesNotMatch(JSON.stringify(snapshot.state), /selector|fingerprint|marker|stableId|shadowPath|data-taber-repl-ref/);
  assertBrowserSnapshotShape(snapshot.state);
  for (const frame of snapshot.state.frames) assertBrowserSnapshotShape({ elements: frame.elements ?? [] });

  const ambiguous = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Duplicate' } }] }) as Record<string, any>;
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
  assert(ambiguous.candidates.some((group: Record<string, any>) => group.frame.context === 'main'));
  assert(ambiguous.candidates.some((group: Record<string, any>) => group.frame.context === 'frame'));
}

async function testFrameRouterSerializesSameTabSnapshots() {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://main.test/page' },
    { frameId: 1, parentFrameId: 0, url: 'https://main.test/frame' },
  ];
  const pages = new Map([
    [0, new FrameRouterFakePage('Main', 'https://main.test/page', [frameButton('Main')])],
    [1, new FrameRouterFakePage('Frame', 'https://main.test/frame', [frameButton('Frame')])],
  ]);
  const starts: string[] = [];
  let active = 0;
  let maxActive = 0;
  const executor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') return frames;
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') {
        const injection = (message.args as unknown[])[0] as Record<string, any>;
        const frameId = Number(injection.target?.frameIds?.[0] ?? 0);
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(`snapshot:${frameId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return [{ result: { ok: true, value: pages.get(frameId)?.browser(readInjectedPageCommand(injection).args[0] as Record<string, unknown>) } }];
      }
      throw new Error(`Unexpected serialized router message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 1,
    async errorFromResponse(message) { return new Error(message); },
  });

  const [first, second] = await Promise.all([
    executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }),
    executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }),
  ]) as Record<string, any>[];
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(maxActive, 1, 'same-tab browser snapshots must not overlap and corrupt latest refs');
  assert.deepEqual(starts, ['snapshot:0', 'snapshot:1', 'snapshot:0', 'snapshot:1']);
}

async function testFrameRouterConcurrentSnapshotDoesNotStaleRefOrSemanticAction() {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: 'https://main.test/page' },
    { frameId: 1, parentFrameId: 0, url: 'https://main.test/frame' },
  ];
  const pages = new Map([
    [0, new FrameRouterFakePage('Main', 'https://main.test/page', [frameButton('Main')])],
    [1, new FrameRouterFakePage('Frame', 'https://main.test/frame', [frameButton('Ref Frame'), frameButton('Semantic Frame')])],
  ]);
  let active = 0;
  let maxActive = 0;
  const executor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') return frames;
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') {
        const injection = (message.args as unknown[])[0] as Record<string, any>;
        const frameId = Number(injection.target?.frameIds?.[0] ?? 0);
        const input = readInjectedPageCommand(injection).args[0] as Record<string, unknown>;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (frameId === 1 && input.action !== 'snapshot') await new Promise((resolve) => setTimeout(resolve, 10));
          return [{ result: { ok: true, value: pages.get(frameId)?.browser(input) } }];
        } finally {
          active -= 1;
        }
      }
      throw new Error(`Unexpected concurrent router message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 1,
    async errorFromResponse(message) { return new Error(message); },
  });

  const initial = await executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }) as Record<string, any>;
  const ref = findFrameElement(initial.state, 'https://main.test/frame', 'Ref Frame').ref;
  const [refClick, refRaceSnapshot] = await Promise.all([
    executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { ref } }] }),
    executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }),
  ]) as Record<string, any>[];
  assert.equal(refClick.ok, true, 'concurrent snapshot must not clear refs before an earlier ref action routes');
  assert.notEqual(refClick.code, 'STALE_REF');
  assert.equal(refRaceSnapshot.ok, true);
  assert.equal(pages.get(1)?.clicked, 'Ref Frame');

  pages.get(1)!.clicked = '';
  const [semanticClick, semanticRaceSnapshot] = await Promise.all([
    executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'click', target: { text: 'Semantic Frame' } }] }),
    executor.executePageCommand(1, { helper: 'browser', args: [{ action: 'snapshot' }] }),
  ]) as Record<string, any>[];
  assert.equal(semanticClick.ok, true, 'concurrent snapshot must not clear refs between semantic snapshot and semantic action');
  assert.notEqual(semanticClick.code, 'STALE_REF');
  assert.equal(semanticRaceSnapshot.ok, true);
  assert.equal(pages.get(1)?.clicked, 'Semantic Frame');
  assert.equal(maxActive, 1, 'same-tab snapshot/ref/semantic browser commands must be serialized');
}

async function testStructuredBrowserNativeFallbackBoundary() {
  const productionMessages: unknown[] = [];
  const productionExecutor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      productionMessages.push(message);
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') return [{ frameId: 0, parentFrameId: -1, url: 'https://example.test' }];
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') {
        const code = String((((message.args as unknown[])[0] as Record<string, any>).js?.[0] as Record<string, unknown>)?.code ?? '');
        if (code.includes('"action":"snapshot"')) return [{ result: { ok: true, value: { ok: true, action: 'snapshot', state: { title: 'fresh', elements: [] } } } }];
        return [{ result: { ok: true, value: { ok: false, action: 'click', code: 'ACTION_FAILED', message: 'DOM click failed', evidence: { selector: '#save' }, state: { title: 'old' } } } }];
      }
      throw new Error(`Unexpected production message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 5,
    async errorFromResponse(message) { return new Error(message); },
  });
  const productionResult = await productionExecutor.executePageCommand(5, { helper: 'browser', args: [{ action: 'click', target: { selector: '#save' } }] });
  assert.deepEqual(productionResult, { ok: false, action: 'click', code: 'ACTION_FAILED', message: 'DOM click failed', evidence: { selector: '#save' }, state: { title: 'fresh', elements: [], hints: [], truncated: false } });
  assert.equal(productionMessages.some((message) => isRecord(message) && message.action === 'debugger.attach'), false);

  const executorModuleUrl = new URL('../lib/browser-repl-executor.ts', import.meta.url).href;
  const chromeApiBrokerModuleUrl = new URL('../lib/chrome-api-broker.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    globalThis.__TABER_ENABLE_DEBUGGER__ = true;
    const { createBrowserReplPageExecutor } = await import(${JSON.stringify(executorModuleUrl)});
    const { chromeApiRequestType } = await import(${JSON.stringify(chromeApiBrokerModuleUrl)});
    const calls = [];
    const executor = createBrowserReplPageExecutor({
      async sendMessage(message) {
        calls.push(message);
        if (message?.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') return [{ frameId: 0, parentFrameId: -1, url: 'https://example.test' }];
        if (message?.type === chromeApiRequestType && message.action === 'userScripts.execute') {
          const code = message.args?.[0]?.js?.[0]?.code ?? '';
          if (code.includes('"helper":"pickElement"')) return [{ result: { ok: true, value: { tag: 'button', rect: { x: 10, y: 20, width: 30, height: 40 } } } }];
          if (code.includes('"action":"snapshot"')) return [{ result: { ok: true, value: { ok: true, action: 'snapshot', state: { title: 'fresh' } } } }];
          return [{ result: { ok: true, value: { ok: false, action: 'click', code: 'ACTION_FAILED', message: 'DOM click failed', evidence: { selector: '#save' }, state: { title: 'old' } } } }];
        }
        return undefined;
      },
      readTargetTabId: () => 7,
      async errorFromResponse(message) { return new Error(message); },
    });
    const result = await executor.executePageCommand(7, { helper: 'browser', args: [{ action: 'click', target: { selector: '#save' } }] });
    assert.equal(result.ok, true);
    assert.equal(result.evidence.fallback, 'cdp/native');
    assert.equal(result.evidence.original.message, 'DOM click failed');
    assert.deepEqual(result.state, { title: 'fresh', elements: [], hints: [], truncated: false });
    assert(calls.some((message) => message?.type === chromeApiRequestType && message.action === 'debugger.attach'));
    assert(calls.some((message) => message?.type === chromeApiRequestType && message.action === 'debugger.sendCommand'));
  `], { stdio: 'pipe' });
}

async function testCdpFallbackErrorContracts() {
  const executor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') return [];
      throw new Error(`Unexpected message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 5,
    async errorFromResponse(message) { return new Error(message); },
  });
  await assert.rejects(
    () => executor.executePageCommand(5, { helper: 'press', args: [undefined, 'Enter'] }),
    /press native fallback requires the Taber debug build/,
  );

  const executorModuleUrl = new URL('../lib/browser-repl-executor.ts', import.meta.url).href;
  const chromeApiBrokerModuleUrl = new URL('../lib/chrome-api-broker.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    globalThis.__TABER_ENABLE_DEBUGGER__ = true;
    const { createBrowserReplPageExecutor } = await import(${JSON.stringify(executorModuleUrl)});
    const { chromeApiRequestType } = await import(${JSON.stringify(chromeApiBrokerModuleUrl)});
    const abortMessages = [];
    const abortedExecutor = createBrowserReplPageExecutor({
      async sendMessage(message) { abortMessages.push(message); throw new Error('sendMessage should not run after abort'); },
      readTargetTabId: () => 7,
      async errorFromResponse(message) { return new Error(message); },
    });
    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      () => abortedExecutor.executePageCommand(7, { helper: 'click', args: ['#save'] }, abortController.signal),
      { message: 'Task aborted' },
    );
    assert.deepEqual(abortMessages, []);

    const executor = createBrowserReplPageExecutor({
      async sendMessage(message) {
        if (message?.type === chromeApiRequestType && message.action === 'userScripts.execute') return { error: 'DOM click failed' };
        if (message?.type === chromeApiRequestType && message.action === 'debugger.attach') return { error: 'attach denied' };
        throw new Error('Unexpected message: ' + JSON.stringify(message));
      },
      readTargetTabId: () => 7,
      async errorFromResponse(message) { return new Error(message); },
    });
    await assert.rejects(
      () => executor.executePageCommand(7, { helper: 'click', args: ['#save'] }),
      /browserRepl click failed; CDP fallback failed: attach denied; original: DOM click failed/,
    );
  `], { stdio: 'pipe' });
}

async function testHelperTimeoutUsesScheduler() {
  const scheduler = createScheduler();
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { return new Promise(() => undefined); },
    async runSandbox(run) { return run.helpers.observe(); },
    scheduler,
  });
  const pending = controller.run({ code: 'return observe()' });
  await Promise.resolve();
  assert.equal(scheduler.delayMs, 5_000);
  scheduler.fire();
  await assert.rejects(pending, /observe timed out after 5000ms/);
}

async function testRunTimeoutCancelsEveryLongPageHelper() {
  const cases: Array<{ name: string; run(helper: Record<string, (...args: unknown[]) => Promise<unknown>>): Promise<unknown> }> = [
    { name: 'waitFor', run: (helper) => helper.waitFor({ text: 'never', timeoutMs: 120_000 }) },
    { name: 'batch', run: (helper) => helper.batch([], { timeoutMs: 120_000 }) },
    { name: 'fillForm', run: (helper) => helper.fillForm({ fields: {}, timeoutMs: 120_000 }) },
    { name: 'pickUserElement', run: (helper) => helper.pickUserElement({ message: 'Pick', timeoutMs: 120_000 }) },
  ];

  for (const scenario of cases) {
    const scheduler = createScheduler();
    let command: BrowserReplPageCommand | undefined;
    let commandAborted = false;
    let sideEffect = false;
    let complete = () => undefined;
    const controller = createBrowserReplController({
      async getCurrentTabId() { return 1; },
      async executePageCommand(_tabId, nextCommand, signal) {
        command = nextCommand;
        return new Promise((resolve, reject) => {
          complete = () => { if (!signal?.aborted) { sideEffect = true; resolve({ completed: true }); } };
          signal?.addEventListener('abort', () => { commandAborted = true; reject(new Error('Task aborted')); }, { once: true });
        });
      },
      async runSandbox(run) { return scenario.run(run.helpers); },
      scheduler,
    });

    const pending = controller.run({ code: `return ${scenario.name}()` });
    for (let index = 0; index < 5 && !command; index += 1) await Promise.resolve();
    assert.equal(command?.helper, scenario.name);
    assert.equal(command?.timeoutMs, DEFAULT_BROWSER_REPL_TIMEOUT_MS, `${scenario.name} must be capped by the remaining run budget`);
    scheduler.fire();
    await assert.rejects(pending, new RegExp(`browserRepl timed out after ${DEFAULT_BROWSER_REPL_TIMEOUT_MS}ms`));
    assert.equal(commandAborted, true, `${scenario.name} must receive abort when the REPL run times out`);
    complete();
    assert.equal(sideEffect, false, `${scenario.name} must not continue side effects after timeout`);
  }
}

async function testRunTimeoutPreservesConcurrentHelperError() {
  const scheduler = createScheduler();
  const helperError = new Error('page detached during wait');
  let sandboxStarted = false;
  let failSandbox: () => void = () => undefined;
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { throw new Error('page command must not start'); },
    async runSandbox() {
      sandboxStarted = true;
      return new Promise((_resolve, reject) => { failSandbox = () => reject(helperError); });
    },
    scheduler,
  });

  const pending = controller.run({ code: 'return waitFor({ text: "never" })' });
  for (let index = 0; index < 5 && !sandboxStarted; index += 1) await Promise.resolve();
  failSandbox();
  scheduler.fire();
  await assert.rejects(pending, (error: Error) => error.message === 'browserRepl timed out after 30000ms' && error.cause === helperError);
}

async function testExhaustedRunBudgetFailsBeforePageCommand() {
  const scheduler = createScheduler();
  let pageCommandStarted = false;
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand() { pageCommandStarted = true; return {}; },
    async runSandbox(run) {
      scheduler.advance(DEFAULT_BROWSER_REPL_TIMEOUT_MS);
      return run.helpers.observe();
    },
    scheduler,
  });

  await assert.rejects(controller.run({ code: 'return observe()' }), /browserRepl timed out after 30000ms/);
  assert.equal(pageCommandStarted, false);
}

async function testRunTimeoutSendsPageCancellation() {
  const scheduler = createScheduler();
  const messages: Record<string, unknown>[] = [];
  const executor = createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (!isRecord(message)) throw new Error('Expected message object');
      messages.push(message);
      if (message.type === 'taber.browserRepl.scriptingCommand') return new Promise(() => undefined);
      if (message.type === 'taber.browserRepl.cancelPageCommand') return true;
      throw new Error(`Unexpected cancellation message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 1,
    async errorFromResponse(message) { return new Error(message); },
  });
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    executePageCommand: (tabId, command, signal) => executor.executePageCommand(tabId, command, signal),
    async runSandbox(run) { return run.helpers.waitFor({ text: 'never', timeoutMs: 120_000 }); },
    scheduler,
  });

  const pending = controller.run({ code: 'return waitFor({ text: "never" })' });
  for (let index = 0; index < 5 && messages.length === 0; index += 1) await Promise.resolve();
  const started = messages.find((message) => message.type === 'taber.browserRepl.scriptingCommand');
  assert(started && isRecord(started.command));
  scheduler.fire();
  await assert.rejects(pending, /browserRepl timed out after 30000ms/);
  await Promise.resolve();
  const cancelled = messages.find((message) => message.type === 'taber.browserRepl.cancelPageCommand');
  assert(cancelled);
  assert.equal(cancelled.cancelKey, started.command.cancelKey);
  assert.equal(cancelled.tabId, 1);
  assert.equal(cancelled.targetTabId, 1);
}

async function testTaskAbortCancelsPageHelper() {
  const taskAbortController = new AbortController();
  let commandStarted = false;
  let commandAborted = false;
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand(_tabId, _command, signal) {
      commandStarted = true;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { commandAborted = true; reject(new Error('Task aborted')); }, { once: true });
      });
    },
    async runSandbox(run) { return run.helpers.waitFor({ text: 'never' }); },
  });

  const pending = controller.run({ code: 'return waitFor({ text: "never" })' }, taskAbortController.signal);
  for (let index = 0; index < 5 && !commandStarted; index += 1) await Promise.resolve();
  taskAbortController.abort();
  await assert.rejects(pending, /Task aborted/);
  assert.equal(commandAborted, true);
}

async function testRunCleanupCancelsUnawaitedHelper() {
  let commandAborted = false;
  let complete = () => undefined;
  let sideEffect = false;
  const controller = createBrowserReplController({
    async getCurrentTabId() { return 1; },
    async executePageCommand(_tabId, _command, signal) {
      return new Promise((resolve, reject) => {
        complete = () => { if (!signal?.aborted) { sideEffect = true; resolve({ completed: true }); } };
        signal?.addEventListener('abort', () => { commandAborted = true; reject(new Error('Task aborted')); }, { once: true });
      });
    },
    async runSandbox(run) {
      void run.helpers.waitFor({ text: 'never', timeoutMs: 120_000 }).catch(() => undefined);
      await Promise.resolve();
      return 'done';
    },
  });

  assert.deepEqual(await controller.run({ code: 'waitFor(); return "done"' }), { value: 'done' });
  assert.equal(commandAborted, true);
  complete();
  assert.equal(sideEffect, false);
}

async function runBrowserReplTool(input: unknown, options: { runSandbox(run: Parameters<Parameters<typeof createBrowserReplController>[0]['runSandbox']>[0]): Promise<unknown>; sendMessage(message: unknown): Promise<unknown> }) {
  await initializeDatabase();
  if (!(await database.sessions.get(1))) await createSession({ now: 1 });
  const tools = createAgentTools({
    sessionId: 1,
    foregroundMode: false,
    targetTabId: 5,
    async emitEvent() {},
    sendMessage: options.sendMessage,
    runSandbox: options.runSandbox,
  });
  return (tools.browserRepl.execute as (input: unknown, options: { abortSignal?: AbortSignal }) => Promise<unknown>)(input, { abortSignal: new AbortController().signal });
}

async function runRawPageCommand(page: FakePage, command: BrowserReplPageCommand) {
  return withFakePage(page, () => { runTaberPageOverlayCommand({ action: 'install' }); return runBrowserReplPageRuntime(command); });
}

async function runPageValue(page: FakePage, command: BrowserReplPageCommand) {
  const result = await runRawPageCommand(page, command) as { ok: true; value: Record<string, any> } | { ok: false; error: string };
  if (!result.ok) throw new Error(String(result.error));
  return result.value;
}

function assertBrowserSnapshotShape(state: Record<string, any>) {
  const allowedKeys = new Set(['number', 'kind', 'tag', 'role', 'name', 'text', 'href', 'value', 'state', 'rect', 'ref']);
  const rectKeys = new Set(['x', 'y', 'width', 'height']);
  const stateKeys = new Set(['disabled', 'expanded', 'selected', 'checked']);
  assert(Array.isArray(state.elements));
  for (const element of state.elements as Record<string, any>[]) {
    assert.equal(typeof element.ref, 'string');
    assert.deepEqual(Object.keys(element).filter((key) => !allowedKeys.has(key)).sort(), [], 'browser snapshot leaked internal field');
    assert.deepEqual(Object.keys(element.rect ?? {}).filter((key) => !rectKeys.has(key)).sort(), [], 'browser snapshot leaked rect field');
    assert.deepEqual(Object.keys(element.state ?? {}).filter((key) => !stateKeys.has(key)).sort(), [], 'browser snapshot leaked state field');
  }
}

function createFrameRouterTestExecutor(options: { frames(): Array<{ frameId: number; parentFrameId: number; url: string }>; pages: Map<number, FrameRouterFakePage>; blockedFrameIds?: Set<number> }) {
  return createBrowserReplPageExecutor({
    async sendMessage(message) {
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'webNavigation.getAllFrames') return options.frames();
      if (isRecord(message) && message.type === chromeApiRequestType && message.action === 'userScripts.execute') {
        const injection = (message.args as unknown[])[0] as Record<string, any>;
        const frameId = Number(injection.target?.frameIds?.[0] ?? 0);
        if (options.blockedFrameIds?.has(frameId)) throw new Error('Missing host permission for blocked frame');
        const page = options.pages.get(frameId);
        if (!page) throw new Error(`Missing fake frame page: ${frameId}`);
        return [{ result: { ok: true, value: page.browser(readInjectedPageCommand(injection).args[0] as Record<string, unknown>) } }];
      }
      throw new Error(`Unexpected frame router message: ${JSON.stringify(message)}`);
    },
    readTargetTabId: () => 1,
    async errorFromResponse(message) { return new Error(message); },
  });
}

function readInjectedPageCommand(injection: Record<string, any>) {
  const code = String(injection.js?.[0]?.code ?? '');
  const start = code.lastIndexOf('})({');
  if (start < 0 || !code.endsWith(')')) throw new Error('Injected page command was not found');
  return JSON.parse(code.slice(start + 3, -1)) as BrowserReplPageCommand;
}

function findFrame(state: Record<string, any>, url: string) {
  const frame = state.frames.find((nextFrame: Record<string, unknown>) => nextFrame.url === url);
  if (!frame) throw new Error(`Missing frame: ${url}`);
  return frame;
}

function findFrameElement(state: Record<string, any>, url: string, name: string) {
  const frame = findFrame(state, url);
  const element = frame.elements?.find((nextElement: Record<string, unknown>) => nextElement.name === name);
  if (!element?.ref) throw new Error(`Missing frame element: ${url} ${name}`);
  return element;
}

type FrameRouterElement = { tag: 'button' | 'input'; name: string; role: string; kind: 'button' | 'field'; value?: string };

function frameButton(name: string): FrameRouterElement {
  return { tag: 'button', name, role: 'button', kind: 'button' };
}

function frameInput(name: string): FrameRouterElement {
  return { tag: 'input', name, role: 'textbox', kind: 'field', value: '' };
}

class FrameRouterFakePage {
  readonly title: string;
  readonly url: string;
  clicked = '';
  pressed: string[] = [];
  private readonly items: FrameRouterElement[];
  private snapshotSeq = 0;
  private refs = new Map<string, number>();

  constructor(title: string, url: string, items: FrameRouterElement[]) {
    this.title = title;
    this.url = url;
    this.items = items;
  }

  browser(input: Record<string, unknown>) {
    const action = String(input.action ?? '');
    if (action === 'snapshot') return { ok: true, action, state: this.state() };
    const target = isRecord(input.target) ? input.target : {};
    const index = typeof target.ref === 'string' ? this.refs.get(target.ref) : undefined;
    if (index === undefined) return { ok: false, action, code: 'STALE_REF', message: 'Ref is stale', state: this.state() };
    const item = this.items[index];
    if (action === 'click') this.clicked = item.name;
    else if (action === 'fill') item.value = String(input.value ?? '');
    else if (action === 'press') this.pressed.push(String(input.key ?? ''));
    return { ok: true, action, evidence: { element: { name: item.name } }, state: this.state() };
  }

  value(name: string) {
    return this.items.find((item) => item.name === name)?.value;
  }

  private state() {
    this.snapshotSeq += 1;
    this.refs = new Map();
    return {
      title: this.title,
      url: this.url,
      text: this.items.map((item) => item.name).join(' '),
      elements: this.items.map((item, index) => {
        const ref = `r${this.snapshotSeq}.${index + 1}`;
        this.refs.set(ref, index);
        return { number: index + 1, kind: item.kind, tag: item.tag, role: item.role, name: item.name, text: item.name, ...(item.value ? { value: item.value } : {}), state: {}, rect: { x: 10, y: 20 + index * 30, width: 100, height: 24 }, ref };
      }),
      truncated: false,
      hints: [],
    };
  }
}

function createFakePage() {
  return new FakePage();
}

class FakePage {
  readonly document = new FakeDocument();
  readonly runtime = createFakeRuntime();
  readonly windowState = { innerWidth: 1024, innerHeight: 768, scrollX: 0, scrollY: 0 };

  addElement<T extends FakeHTMLElement>(element: T, options: { id?: string; text?: string; placeholder?: string; ariaLabel?: string; contentEditable?: boolean } = {}) {
    if (options.id) element.id = options.id;
    if (options.text) element.textContent = options.text;
    if (options.placeholder) element.setAttribute('placeholder', options.placeholder);
    if (options.ariaLabel) element.setAttribute('aria-label', options.ariaLabel);
    if (options.contentEditable) element.setAttribute('contenteditable', 'true');
    this.document.body.append(element);
    return element;
  }
}

async function withFakePage<T>(page: FakePage, run: () => Promise<T>): Promise<T> {
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const define = (key: PropertyKey, value: unknown) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const setScroll = (next: { x?: number; y?: number }) => {
    if (Number.isFinite(next.x)) page.windowState.scrollX = Number(next.x);
    if (Number.isFinite(next.y)) page.windowState.scrollY = Number(next.y);
    Object.defineProperty(globalThis, 'scrollX', { configurable: true, writable: true, value: page.windowState.scrollX });
    Object.defineProperty(globalThis, 'scrollY', { configurable: true, writable: true, value: page.windowState.scrollY });
  };

  define('document', page.document);
  define('location', { href: 'https://example.test/page' });
  define('innerWidth', page.windowState.innerWidth);
  define('innerHeight', page.windowState.innerHeight);
  define('scrollX', page.windowState.scrollX);
  define('scrollY', page.windowState.scrollY);
  define('window', globalThis);
  define('chrome', { runtime: page.runtime.api });
  define('Element', FakeElement);
  define('HTMLElement', FakeHTMLElement);
  define('HTMLInputElement', FakeHTMLInputElement);
  define('HTMLTextAreaElement', FakeHTMLTextAreaElement);
  define('HTMLSelectElement', FakeHTMLSelectElement);
  define('HTMLButtonElement', FakeHTMLButtonElement);
  define('Event', FakeEvent);
  define('KeyboardEvent', FakeKeyboardEvent);
  define('MutationObserver', FakeMutationObserver);
  define('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(Date.now())); return 1; });
  define('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') });
  define('getComputedStyle', (element: FakeElement) => element.style);
  define('scrollBy', (options: { left?: number; top?: number }) => setScroll({ x: page.windowState.scrollX + Number(options.left ?? 0), y: page.windowState.scrollY + Number(options.top ?? 0) }));
  define('scrollTo', (options: { left?: number; top?: number }) => setScroll({ x: Number(options.left ?? page.windowState.scrollX), y: Number(options.top ?? page.windowState.scrollY) }));

  try {
    return await run();
  } finally {
    for (const [key, descriptor] of [...descriptors].reverse()) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

class FakeDocument {
  title = 'BrowserRepl Test';
  activeElement: FakeHTMLElement | null = null;
  body = new FakeHTMLElement('body');
  documentElement = new FakeHTMLElement('html');
  private listeners = new Map<string, Set<(event: FakeEvent) => void>>();

  constructor() {
    this.documentElement.append(this.body);
  }

  createElement(tagName: string) { return new FakeHTMLElement(tagName); }
  getElementById(id: string) { return this.elements().find((element) => element.id === id) ?? null; }
  addEventListener(type: string, listener: (event: FakeEvent) => void) { const listeners = this.listeners.get(type) ?? new Set(); listeners.add(listener); this.listeners.set(type, listeners); }
  removeEventListener(type: string, listener: (event: FakeEvent) => void) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: FakeEvent) { for (const listener of [...this.listeners.get(event.type) ?? []]) listener(event); return !event.defaultPrevented; }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    return this.elements().filter((element) => matchesSelector(element, selector));
  }

  elements() {
    const result: FakeHTMLElement[] = [];
    const visit = (element: FakeHTMLElement) => {
      for (const child of element.children) {
        result.push(child as FakeHTMLElement);
        visit(child as FakeHTMLElement);
      }
    };
    visit(this.documentElement);
    return result;
  }
}

class FakeShadowRoot {
  readonly children: FakeElement[] = [];
  readonly host: FakeHTMLElement;
  constructor(host: FakeHTMLElement) { this.host = host; }
  get textContent() { return this.children.map((child) => child.textContent).filter(Boolean).join(' '); }
  append(child: FakeElement) { child.parentElement = null; child.parentRoot = this; this.children.push(child); FakeMutationObserver.notify(); return child; }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string) { return shadowElements(this).filter((element) => matchesSelector(element, selector)); }
}

class FakeElement {
  readonly tagName: string;
  parentElement: FakeHTMLElement | null = null;
  parentRoot: FakeShadowRoot | null = null;
  shadowRoot: FakeShadowRoot | null = null;
  children: FakeElement[] = [];
  attributes = new Map<string, string>();
  style = { display: 'block', visibility: 'visible', opacity: '1' };
  rect = { x: 10, y: 20, width: 100, height: 24, top: 20, left: 10, right: 110, bottom: 44 };
  dispatchedEvents: string[] = [];
  clicked = false;
  private text = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get id() { return this.getAttribute('id') ?? ''; }
  set id(value: string) { this.setAttribute('id', value); }
  get textContent(): string { return [this.text, ...this.children.map((child) => child.textContent), this.shadowRoot?.textContent].filter(Boolean).join(' '); }
  set textContent(value: string) { this.text = String(value); FakeMutationObserver.notify(); }
  get innerText() { return this.textContent; }
  set innerText(value: string) { this.textContent = value; }
  get isContentEditable() { return this.attributes.has('contenteditable') && this.getAttribute('contenteditable') !== 'false'; }
  get previousElementSibling(): FakeElement | null { const siblings = this.parentElement?.children ?? this.parentRoot?.children ?? []; const index = siblings.indexOf(this); return index > 0 ? siblings[index - 1] : null; }
  get nextElementSibling(): FakeElement | null { const siblings = this.parentElement?.children ?? this.parentRoot?.children ?? []; const index = siblings.indexOf(this); return index >= 0 ? siblings[index + 1] ?? null : null; }
  get isConnected(): boolean { let current: FakeElement | null = this; while (current) { if (current === (globalThis as any).document?.documentElement) return true; current = current.parentElement; } return Boolean(this.parentRoot?.host.isConnected); }
  append(child: FakeElement) { child.parentElement = this as unknown as FakeHTMLElement; child.parentRoot = this.parentRoot; this.children.push(child); FakeMutationObserver.notify(); return child; }
  prepend(child: FakeElement) { child.parentElement = this as unknown as FakeHTMLElement; child.parentRoot = this.parentRoot; this.children.unshift(child); FakeMutationObserver.notify(); return child; }
  replaceWith(next: FakeElement) { const siblings = this.parentElement?.children ?? this.parentRoot?.children; const index = siblings?.indexOf(this) ?? -1; if (!siblings || index < 0) return; next.parentElement = this.parentElement; next.parentRoot = this.parentRoot; siblings.splice(index, 1, next); this.parentElement = null; this.parentRoot = null; FakeMutationObserver.notify(); }
  remove() { const siblings = this.parentElement?.children ?? this.parentRoot?.children; const index = siblings?.indexOf(this) ?? -1; if (!siblings || index < 0) return; siblings.splice(index, 1); this.parentElement = null; this.parentRoot = null; FakeMutationObserver.notify(); }
  attachShadow(options: { mode: 'open' | 'closed' }) { if (options.mode !== 'open') throw new Error('fake page only supports open shadow roots'); this.shadowRoot = new FakeShadowRoot(this as unknown as FakeHTMLElement); return this.shadowRoot; }
  getRootNode() { let current: FakeElement = this; while (current.parentElement) current = current.parentElement; return current.parentRoot ?? (globalThis as any).document; }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string) { return elementDescendants(this as unknown as FakeHTMLElement).filter((element) => matchesSelector(element, selector)); }
  getAttribute(name: string) { return this.attributes.has(name) ? this.attributes.get(name)! : null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); FakeMutationObserver.notify(); }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView() {}
  click() { this.clicked = true; }
  focus() { const document = (globalThis as any).document as FakeDocument | undefined; if (document) document.activeElement = this as unknown as FakeHTMLElement; }
  dispatchEvent(event: FakeEvent) { event.target ??= this; this.dispatchedEvents.push(event instanceof FakeKeyboardEvent ? `${event.type}:${event.key}` : event.type); ((globalThis as any).document as FakeDocument | undefined)?.dispatchEvent(event); return !event.defaultPrevented; }
}

class FakeHTMLElement extends FakeElement {
  private assignedLabels: FakeHTMLElement[] = [];
  get labels() {
    const labels = [...this.assignedLabels];
    for (let node = this.parentElement; node; node = node.parentElement) if (node.tagName === 'LABEL') labels.push(node);
    return labels;
  }
  set labels(value: FakeHTMLElement[]) { this.assignedLabels = value; }
}
class FakeHTMLTextAreaElement extends FakeHTMLElement { value = ''; }
class FakeHTMLSelectElement extends FakeHTMLElement { value = ''; }
class FakeHTMLButtonElement extends FakeHTMLElement { disabled = false; }
class FakeHTMLInputElement extends FakeHTMLElement { value = ''; disabled = false; type = ''; }

class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  target?: unknown;
  defaultPrevented = false;
  private stopped = false;
  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) { this.type = type; this.bubbles = Boolean(init.bubbles); this.cancelable = Boolean(init.cancelable); }
  composedPath() { return this.target ? [this.target] : []; }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

class FakeKeyboardEvent extends FakeEvent {
  readonly key: string;
  constructor(type: string, init: { key?: string; bubbles?: boolean; cancelable?: boolean } = {}) { super(type, init); this.key = init.key ?? ''; }
}

class FakeMutationObserver {
  private static observers = new Set<FakeMutationObserver>();
  private readonly callback: () => void;
  constructor(callback: () => void) { this.callback = callback; }
  observe() { FakeMutationObserver.observers.add(this); }
  disconnect() { FakeMutationObserver.observers.delete(this); }
  static notify() { for (const observer of FakeMutationObserver.observers) queueMicrotask(observer.callback); }
}

function createFakeRuntime() {
  const listeners = new Set<(message: unknown) => void>();
  const sentMessages: unknown[] = [];
  return {
    sentMessages,
    api: {
      onMessage: {
        addListener(listener: (message: unknown) => void) { listeners.add(listener); },
        removeListener(listener: (message: unknown) => void) { listeners.delete(listener); },
      },
      sendMessage(message: unknown) { sentMessages.push(message); return Promise.resolve(false); },
      getURL(path: string) { return `chrome-extension://taber/${path.replace(/^\/+/, '')}`; },
    },
    dispatch(message: unknown) { for (const listener of [...listeners]) listener(message); },
  };
}

function elementDescendants(root: FakeHTMLElement) {
  const result: FakeHTMLElement[] = [];
  const visit = (element: FakeHTMLElement) => {
    for (const child of element.children) {
      result.push(child as FakeHTMLElement);
      visit(child as FakeHTMLElement);
    }
  };
  visit(root);
  return result;
}

function shadowElements(root: FakeShadowRoot) {
  const result: FakeHTMLElement[] = [];
  for (const child of root.children) {
    result.push(child as FakeHTMLElement);
    result.push(...elementDescendants(child as FakeHTMLElement));
  }
  return result;
}

function matchesSelector(element: FakeHTMLElement, selector: string): boolean {
  return selector.split(',').map((part) => part.trim()).some((part) => matchesSelectorPart(element, part));
}

function matchesSelectorPart(element: FakeHTMLElement, selector: string): boolean {
  if (selector === '*') return true;
  if (selector.startsWith('body > ')) return matchesSelectorPath(element, selector);
  if (selector.startsWith('#')) return element.id === unescapeCss(selector.slice(1));
  if (selector.endsWith(']') || selector.includes(']:not')) return matchesAttributeSelector(element, selector);
  const nth = selector.match(/^(\w+):nth-of-type\((\d+)\)$/);
  if (nth) return element.tagName.toLowerCase() === nth[1] && nthOfType(element) === Number(nth[2]);
  return element.tagName.toLowerCase() === selector;
}

function matchesSelectorPath(element: FakeHTMLElement, selector: string) {
  const parts = selector.split('>').map((part) => part.trim());
  if (parts.shift() !== 'body') return false;
  let current: FakeHTMLElement | null = element;
  for (const part of parts.reverse()) {
    if (!current || !matchesSelectorPart(current, part)) return false;
    current = current.parentElement;
  }
  return current?.tagName.toLowerCase() === 'body';
}

function matchesAttributeSelector(element: FakeHTMLElement, selector: string) {
  if (selector === 'a[href]') return element.tagName === 'A' && element.getAttribute('href') !== null;
  if (selector === '[contenteditable]:not([contenteditable="false"])') return element.isContentEditable;
  if (selector === '[tabindex]:not([tabindex="-1"])') return element.getAttribute('tabindex') !== null && element.getAttribute('tabindex') !== '-1';
  const attr = selector.match(/^(\w+)?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
  if (!attr) return false;
  const [, tag, name, expected] = attr;
  if (tag && element.tagName.toLowerCase() !== tag) return false;
  const actual = element.getAttribute(name);
  return expected === undefined ? actual !== null : actual === expected;
}

function nthOfType(element: FakeHTMLElement) {
  const siblings = (element.parentElement?.children ?? element.parentRoot?.children ?? []).filter((sibling) => sibling.tagName === element.tagName);
  return siblings.indexOf(element) + 1;
}

function unescapeCss(value: string) {
  return value.replace(/\\([^a-zA-Z0-9])/g, '$1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createScheduler() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { callback(): void; dueMs: number }>();
  return {
    delayMs: 0,
    now() { return nowMs; },
    setTimeout(callback: () => void, delayMs: number) {
      const id = nextId++;
      timers.set(id, { callback, dueMs: nowMs + delayMs });
      this.delayMs = delayMs;
      return id;
    },
    clearTimeout(id: unknown) { timers.delete(Number(id)); },
    advance(delayMs: number) { nowMs += delayMs; },
    fire() {
      const next = [...timers].sort((left, right) => left[1].dueMs - right[1].dueMs || left[0] - right[0])[0];
      if (!next) return;
      timers.delete(next[0]);
      nowMs = next[1].dueMs;
      next[1].callback();
    },
  };
}

assert.equal(DEFAULT_BROWSER_REPL_TIMEOUT_MS, 30_000);

await testPageRuntimeHelpersBehaveInFakePage();
await testCspSafePageSenseHelpersReadVisibleContent();
await testComplexPageBoundariesExposeFramesAndShadow();
await testStructuredBrowserActionsUseSemanticLocators();
await testOverlayScriptAndPickUserElement();
await testPageRuntimeSelectorBatchFillFormAndShadow();
await testShadowHostVisibilityAffectsLocator();
await testFillFormRefreshesDynamicFieldsAndEvidence();
await testFillEvidenceSurvivesPrependSelectorDrift();
await testSameCallRefSurvivesContentEditableFill();
await testScriptingScriptUsesSameJsonCommandSemantics();
await testScriptingFallbackResultIsReturned();
await testBrowserJsUsesUserScriptsMainWorld();
await testBrowserJsFunctionRunsInPageContext();
await testBrowserJsFunctionCodeIsNormalized();
await testBrowserJsRejectsUnserializableReturnClearly();
await testBrowserJsFailureIncludesConsoleAndStackEvidence();
testBrowserJsRejectsDirectNavigationAndBadArgs();
await testBrowserJsRuntimeNavigationGuardBlocksAliases();
await testBrowserJsAllowsSafeDomWrites();
await testBrowserJsDelayedTimerCallbacksStayGuarded();
testCloneBoundaryErrorIsActionable();
await testBrowserJsUnavailableFailsClearlyWithoutProductionFallback();
await testBrowserJsSharesPageGlobalsButNotExtensionLexicals();
await testBrowserJsCanBeDisabledForAgentConsent();
await testCspSafeHelpersDoNotRequireBrowserJsConsent();
testParsesInput();
await testBrowserReplEvaluatesExpressionsAndBodies();
await testBrowserReplNeverReturnsSilentUndefined();
testRoutesFallbacks();
await testRunsSandboxWithHelpersAndElementRefs();
await testRunsSandboxWithSelectorBatchAndFillFormHelpers();
await testCommonToolMisuseFallbacks();
await testRunsSandboxWithNavigateHelper();
await testIndexesSurviveLaterQueriesInSameBrowserReplCall();
await testIndexesCannotBeReusedAcrossBrowserReplCalls();
await testCdpFallbackDispatchesNativeInput();
await testFrameRouterMainDocumentActionUsesSinglePageCommand();
await testFrameRouterSameOriginIframeEndToEnd();
await testFrameRouterCrossOriginPermissionAndBlockedBoundary();
await testFrameRouterAmbiguousAndSnapshotPrivacy();
await testFrameAwareBrowserRouterCoversIframeRequirements();
await testFrameRouterSerializesSameTabSnapshots();
await testFrameRouterConcurrentSnapshotDoesNotStaleRefOrSemanticAction();
await testStructuredBrowserNativeFallbackBoundary();
await testCdpFallbackErrorContracts();
await testHelperTimeoutUsesScheduler();
await testRunTimeoutCancelsEveryLongPageHelper();
await testRunTimeoutPreservesConcurrentHelperError();
await testExhaustedRunBudgetFailsBeforePageCommand();
await testRunTimeoutSendsPageCancellation();
await testTaskAbortCancelsPageHelper();
await testRunCleanupCancelsUnawaitedHelper();
database.close();

console.info('browser repl tests passed');
