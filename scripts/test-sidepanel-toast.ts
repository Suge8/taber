import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';

const sidepanelDir = 'entrypoints/sidepanel';
const svelteFiles = readdirSync(sidepanelDir)
  .filter((name) => name.endsWith('.svelte'))
  .map((name) => join(sidepanelDir, name));

for (const file of svelteFiles) {
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /role="alert"/, `${file} should route transient errors through ToastStack`);
}

for (const file of [
  'entrypoints/sidepanel/BrowserAccessPanel.svelte',
  'entrypoints/sidepanel/SubscriptionLoginCard.svelte',
  'entrypoints/sidepanel/SubscriptionHub.svelte',
  'entrypoints/sidepanel/ProviderSettings.svelte',
  'entrypoints/sidepanel/Composer.svelte',
]) {
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\{#if\s+(?:error|saveError|loadError|intentError)\}/, `${file} should not render inline error notices`);
}

const app = readFileSync('entrypoints/sidepanel/App.svelte', 'utf8');
assert.doesNotMatch(app, /loadingDatabase/, 'database loading should not be a toast or inline notice');
assert.match(app, /<ToastStack items=\{toasts\}/, 'App should render the global toast stack');

for (const file of [
  'entrypoints/sidepanel/App.svelte',
  'entrypoints/sidepanel/SettingsDialog.svelte',
  'entrypoints/sidepanel/BrowserAccessPanel.svelte',
  'entrypoints/sidepanel/SubscriptionLoginCard.svelte',
  'entrypoints/sidepanel/SubscriptionHub.svelte',
  'entrypoints/sidepanel/ProviderSettings.svelte',
  'entrypoints/sidepanel/Composer.svelte',
]) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/notify(?:\?\.)?\(\{[^\n;]*\}\)/g)) {
    assert.match(match[0], /(?:\bicon\s*:|[,\{]\s*icon[,\}])/, `${file} toast call needs a semantic icon: ${match[0]}`);
  }
}

const providerSettings = readFileSync('entrypoints/sidepanel/ProviderSettings.svelte', 'utf8');
assert.match(providerSettings, /notify\?\.\(\{\s*tone,\s*icon:\s*'model',\s*text\s*\}\)/, 'provider notices should use the model icon');

const toastStack = readFileSync('entrypoints/sidepanel/ToastStack.svelte', 'utf8');
for (const icon of ['browser', 'database', 'model', 'task']) {
  assert.match(toastStack, new RegExp(`icon === '${icon}'`), `ToastStack should support ${icon} icon`);
}

const browserWarning = await renderToastStack([{ id: 1, tone: 'warning', icon: 'browser', text: 'Select an http/https page first' }]);
assert.match(browserWarning, /fixed inset-x-3 top-3/, 'toast stack should render at the top of the viewport');
assert.match(browserWarning, /role="alert"/, 'warning toast should use alert semantics');
assert.match(browserWarning, /data-icon="Globe"/, 'browser toast should render the browser icon');
assert.match(browserWarning, /Select an http\/https page first/, 'toast should render the notice text');

const taskError = await renderToastStack([{ id: 2, tone: 'error', icon: 'task', text: 'Task failed' }]);
assert.match(taskError, /role="alert"/, 'error toast should use alert semantics');
assert.match(taskError, /data-icon="Sparkles"/, 'task toast should render the task icon');
assert.match(taskError, /Task failed/, 'task toast should render the notice text');

async function renderToastStack(items: Array<{ id: number; tone: string; text: string; icon?: string }>) {
  mkdirSync('.tmp', { recursive: true });
  const source = toastStack
    .replace(/^\s*import (Bot|CircleCheckBig|CircleX|Database|Globe|Info|Sparkles|TriangleAlert) from '@lucide\/svelte\/icons\/[^']+';\n/gm, '')
    .replace("  import type { ToastNotice, ToastTone } from './toast.ts';\n", [
      "  type ToastTone = 'success' | 'error' | 'warning' | 'info';",
      "  type ToastNotice = { id: number; tone: ToastTone; text: string; icon?: ToastTone | 'browser' | 'database' | 'model' | 'task' };",
      "  const Bot = icon('Bot');",
      "  const CircleCheckBig = icon('CircleCheckBig');",
      "  const CircleX = icon('CircleX');",
      "  const Database = icon('Database');",
      "  const Globe = icon('Globe');",
      "  const Info = icon('Info');",
      "  const Sparkles = icon('Sparkles');",
      "  const TriangleAlert = icon('TriangleAlert');",
      "  function icon(name: string) { return ($$renderer: { push: (html: string) => void }, props: { class?: string }) => { $$renderer.push(`<svg data-icon=\"${name}\" class=\"${props.class ?? ''}\"></svg>`); }; }",
      '',
    ].join('\n'));
  const compiled = compile(source, { generate: 'server', dev: false, filename: 'ToastStack.svelte' });
  const file = `.tmp/test-sidepanel-toast-stack-${process.pid}.mjs`;
  writeFileSync(file, compiled.js.code);
  try {
    const component = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    return render(component.default, { props: { items } }).html;
  } finally {
    rmSync(file, { force: true });
  }
}

console.log('sidepanel toast tests passed');
