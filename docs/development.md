# Development

## Verification

Primary static/local command:

```bash
pnpm run test:ci
```

Full runtime command:

```bash
pnpm run test:ci:full
```

Do not use `pnpm run test` or bare `pnpm test`; they are not supported verification entrypoints in this environment and intentionally fail when routed through package scripts.

Checks:

```bash
pnpm exec tsc --noEmit
pnpm run test:unit
pnpm run test:database-integration
pnpm run test:extension:dry
pnpm run test:ci
```

`pnpm run test:ci` runs Chrome/Edge builds, unit tests, database integration tests, and artifact verification. It does not run runtime browser smoke.

`pnpm run test:ci:full` runs `test:ci` plus strict runtime smoke. It fails unless `TABER_CDP_ORIGIN`/`TABER_EXTENSION_ID` is set or a launchable browser exists.

`pnpm run test:extension:dry` builds Chrome MV3 and checks extension artifacts. It does not prove runtime behavior.

## Release packaging

Build and zip the Chrome MV3 release artifact:

```bash
pnpm run zip:chrome
```

This writes `.output/taber-v0.2.1-chrome-mv3.zip` and verifies `.output/chrome-mv3/manifest.json`. Upload the zip to GitHub Releases. Users must unzip it, then load the extracted folder through Chrome **Developer mode** → **Load unpacked**.

## Runtime browser smoke

`pnpm dev` is for manual WXT development and loads `.output/chrome-mv3-dev`. Runtime smoke tests package `.output/chrome-mv3`, so they match the installable extension artifact.

Debug release artifacts are explicit: `pnpm run build:chrome:debug` builds `.output/chrome-mv3` with `debugger`, then mirrors that verified production-mode debug artifact to `.output/chrome-mv3-dev` so it cannot be confused with a stale WXT dev-server output. Re-run `pnpm build:chrome` before packaging the store build.

Run runtime smoke only through the shared launcher:

```bash
pnpm run test:ci:runtime
```

It builds Chrome MV3 once, serializes runtime smoke with owner-token lockfile `/tmp/taber-runtime-smoke.lock`, launches or reuses one headless Google Chrome CDP browser on `http://127.0.0.1:9258`, loads the extension through CDP `Extensions.loadUnpacked`, opens smoke pages as tabs in that browser, closes its own tabs, and only closes the browser when it launched it. Child smoke scripts attach to this shared browser; they do not launch browsers themselves.

Default launch target is `/Applications/Google Chrome.app`, headless. Chrome 137+ no longer honors `--load-extension`; the launcher uses CDP instead. For local visual debugging only:

```bash
TABER_HEADED=1 pnpm run test:ci:runtime
TABER_BROWSER_APP="/Applications/Google Chrome.app" TABER_HEADED=1 pnpm run test:ci:runtime
```

If `http://127.0.0.1:9258` is already used by a browser without Taber, the launcher fails instead of silently opening another browser on a fallback port.

To reuse an already loaded browser:

```bash
TABER_CDP_ORIGIN=http://127.0.0.1:9258 TABER_EXTENSION_ID=<extension-id> pnpm run test:ci:runtime
```

Default side panel command shortcuts:

- macOS: `Command+E`
- Windows/Linux/ChromeOS: `Alt+E`

Chrome owns extension shortcut remapping at `chrome://extensions/shortcuts`.

`test:extension` verifies:

- sidepanel page runtime loads.
- background `sidePanel` API options point to `sidepanel.html`.
- offscreen state is reset before the test.
- offscreen document is created, reports ready, hosts `sandbox.html`, then closes in cleanup.

If Taber is loaded but its service worker is idle, pass the extension id:

```bash
TABER_EXTENSION_ID=<extension-id> pnpm run test:extension
```

Single-smoke entrypoints use the same shared launcher:

```bash
pnpm run test:extension
pnpm run test:browser-repl:runtime
pnpm run test:sidepanel:smoke
```
