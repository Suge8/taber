import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const enableDebugger = process.env.TABER_ENABLE_DEBUGGER === '1';
const debugArtifact = process.env.TABER_DEBUG_ARTIFACT === '1';
const outDirTemplate = process.env.TABER_OUT_DIR_TEMPLATE ?? (debugArtifact ? '{{browser}}-mv{{manifestVersion}}-dev' : undefined);

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  outDirTemplate,
  zip: {
    artifactTemplate: 'taber-v{{version}}-{{browser}}-{{manifestVersion}}.zip',
    zipSources: false,
  },
  vite: () => ({
    define: {
      __TABER_ENABLE_DEBUGGER__: JSON.stringify(enableDebugger),
    },
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        $lib: path.resolve(rootDir, 'lib'),
      },
    },
  }),
  manifest: {
    name: 'Taber',
    description: '__MSG_extensionDescription__',
    default_locale: 'en',
    minimum_chrome_version: '135',
    permissions: [
      'storage',
      'sidePanel',
      'scripting',
      'userScripts',
      'webNavigation',
      'activeTab',
      'offscreen',
      'identity',
      ...(enableDebugger ? ['debugger'] : []),
    ],
    host_permissions: [
      'https://auth.openai.com/*',
      'https://chatgpt.com/*',
      'https://auth.x.ai/*',
      'https://api.x.ai/*',
    ],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    icons: {
      16: '/icons/icon-16.png',
      24: '/icons/icon-24.png',
      32: '/icons/icon-32.png',
      48: '/icons/icon-48.png',
      96: '/icons/icon-96.png',
      128: '/icons/icon-128.png',
    },
    action: {
      default_title: 'Taber',
      default_icon: {
        16: '/icons/icon-16.png',
        24: '/icons/icon-24.png',
        32: '/icons/icon-32.png',
      },
    },
    web_accessible_resources: [
      { resources: ['icons/icon-24.png'], matches: ['http://*/*', 'https://*/*'] },
    ],
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Ctrl+Shift+Y',
          mac: 'Command+Shift+Y',
          windows: 'Ctrl+Shift+Y',
          linux: 'Ctrl+Shift+Y',
          chromeos: 'Ctrl+Shift+Y',
        },
      },
    },
    side_panel: { default_path: 'sidepanel.html' },
    sandbox: { pages: ['sandbox.html'] },
  },
});
