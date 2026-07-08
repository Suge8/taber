import { jsonLiteralForInjectedCode } from './browser-repl-code.ts';
import { createBrowserJsScript } from './browser-js-page-script.ts';
import { createBrowserReplPageIntrospection } from './browser-repl-page-introspection.ts';
import { createBrowserReplVisualScript } from './browser-repl-visual-page.ts';
import { installBrowserReplPageLocator } from './browser-repl-page-locator.ts';
import { runBrowserReplPageRuntimeInjected } from './browser-repl-page-runtime.ts';
import type { BrowserReplPageCommand } from './browser-repl-command.ts';

export { installBrowserReplPageLocator } from './browser-repl-page-locator.ts';
export { runBrowserReplPageRuntime, runBrowserReplPageRuntimeInjected } from './browser-repl-page-runtime.ts';

export function createBrowserReplUserScript(command: BrowserReplPageCommand) {
  if (command.helper === 'browserjs') return createBrowserJsScript(command.args[0], command.args[1]);
  return `${createBrowserReplVisualScript()}(${createBrowserReplPageIntrospection.toString()})();(${installBrowserReplPageLocator.toString()})();(${runBrowserReplPageRuntimeInjected.toString()})(${safeJson(command)})`;
}

function safeJson(value: unknown) {
  return jsonLiteralForInjectedCode(value, 'browserRepl page command');
}
