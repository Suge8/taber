# Chrome Web Store disclosure draft

This is a project facts draft for Chrome Web Store review and privacy-policy writing. It is not a final legal policy.

## Browser access

Taber is a browser agent side panel. It reads and acts on pages only to complete user requests shown in the side panel.

The store build uses least-privilege defaults:

- no default `<all_urls>` host permission;
- no default `debugger` permission;
- `activeTab` for the current user-selected tab;
- optional `http://*/*` and `https://*/*` host permissions requested in Browser Control onboarding;
- fixed auth host permissions for ChatGPT/Codex login (`auth.openai.com`, `chatgpt.com`) and xAI/Grok login (`auth.x.ai`, `api.x.ai`);
- Chrome `userScripts` for user-approved page script execution.

Current store builds require Browser Control website access plus User Scripts before browser-agent tasks start. Users can decline the optional all-sites grant, but the side panel must keep browser-agent tasks blocked rather than imply browser tasks can continue without that access. If permissions are missing or a task reaches an unsupported page such as `chrome://` or `file://`, Taber should fail clearly and ask the user to grant supported `http/https` access before retrying.

## Page scripts

`browserjs` runs in the page `MAIN` runtime only after the user consents in Browser Access onboarding/settings. It is used for complex pages where DOM-only helpers are insufficient. Fixed tools such as observe, click, fill, press, scroll, waitFor, document extraction, image extraction, and navigation remain available without page-script consent where browser permissions allow.

Chrome may require the user to enable Allow User Scripts on the Taber extension details page before `browserjs` can run.

## Data used to complete user requests

Depending on the requested task, Taber may process:

- current or authorized page text and DOM-derived page summaries;
- selected text;
- page tables and document text;
- viewport screenshots or extracted page images/canvas/background images;
- URLs, titles, and tool results for authorized/current tabs;
- user prompts and conversation history stored locally for the task timeline.

Taber does not collect this data for advertising and does not sell it.

## Model providers

To answer user requests, Taber may send relevant prompt, page, screenshot/image, document, and tool-result content to the model provider configured by the user. The provider can be an OpenAI API key account, a third-party OpenAI-compatible API endpoint, a user-authenticated ChatGPT/Codex provider, or a user-authenticated xAI/Grok provider.

Users are responsible for choosing a provider they trust. Taber should disclose this data flow in onboarding, store listing, and the final privacy policy.

## Cookies and credentials

The store build does not request `debugger` permission and does not provide cookie-reading tools. The debug build contains a debugger tool for local development and keeps cookie access blocked by policy and tests.

Taber stores model provider credentials locally in the extension database. Credentials are used to call the selected model provider and are not sold or used for advertising.
