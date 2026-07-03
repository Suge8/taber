export type RuntimeBrowser =
  | { skipped: true; reason: string }
  | { skipped: false; cdpOrigin: string; extensionId: string; launchedBrowser: boolean; close(): Promise<void> };

export function prepareRuntimeBrowser(options?: { required?: boolean; allowLaunch?: boolean }): Promise<RuntimeBrowser>;
export function findRuntimeBrowserApp(): Promise<string | undefined>;
export function findTaberExtensionId(cdpOrigin: string): Promise<string | undefined>;
