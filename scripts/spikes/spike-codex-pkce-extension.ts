import crypto from 'node:crypto';
import { connectCdp, connectTarget, evaluate, fetchJson, hasCdpEndpoint, readTargets, waitForTarget } from '../cdp-client.mjs';
import { prepareRuntimeBrowser } from '../runtime-browser.mjs';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.124.0';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const LOGIN_TIMEOUT_MS = Number(process.env.CODEX_PKCE_TIMEOUT_MS ?? 300000);
const ORIGINATOR = process.env.CODEX_ORIGINATOR ?? 'taber';
const SCOPES = process.env.CODEX_PKCE_SCOPES ?? 'openid profile email offline_access api.connectors.read api.connectors.invoke';

type Cdp = Awaited<ReturnType<typeof connectCdp>>;
type TargetRef = { targetId: string };

let runtime: Awaited<ReturnType<typeof prepareRuntimeBrowser>> | undefined;
let browserCdp: Cdp | undefined;
let sidepanelTarget: TargetRef | undefined;
let authTarget: TargetRef | undefined;
let sidepanelCdp: Cdp | undefined;

try {
  runtime = await prepareRuntimeBrowser({ required: true, allowLaunch: true });
  if (runtime.skipped) throw new Error(runtime.reason);

  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  sidepanelTarget = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${runtime.extensionId}/sidepanel.html` }) as TargetRef;
  sidepanelCdp = await connectTarget(await waitForTarget(runtime.cdpOrigin, (target) => target.id === sidepanelTarget?.targetId && hasCdpEndpoint(target)));
  await sidepanelCdp.send('Runtime.enable');
  await waitForExtensionPage(sidepanelCdp, runtime.extensionId);

  const pkce = createPkce();
  const state = base64Url(crypto.randomBytes(32));
  const authUrl = buildAuthorizeUrl(pkce.challenge, state);

  console.info('Open OpenAI Codex OAuth login tab. No token will be printed.');
  authTarget = await browserCdp.send('Target.createTarget', { url: authUrl }) as TargetRef;

  const redirectUrl = await waitForOAuthRedirect(runtime.cdpOrigin, authTarget.targetId, LOGIN_TIMEOUT_MS);
  await browserCdp.send('Target.closeTarget', { targetId: authTarget.targetId }).catch(() => undefined);
  authTarget = undefined;

  const error = redirectUrl.searchParams.get('error');
  if (error) {
    console.info(JSON.stringify({ ok: false, stage: 'authorize', message: redirectUrl.searchParams.get('error_description') ?? error }, null, 2));
    process.exitCode = 1;
  } else if (redirectUrl.searchParams.get('state') !== state) {
    console.info(JSON.stringify({ ok: false, stage: 'authorize', message: 'OAuth state mismatch' }, null, 2));
    process.exitCode = 1;
  } else {
    const code = redirectUrl.searchParams.get('code');
    if (!code) throw new Error('Missing authorization code in redirect');
    const result = await evaluate(sidepanelCdp, `(${exchangeAndFetchModelsInExtension.toString()})(${JSON.stringify({ code, codeVerifier: pkce.verifier, redirectUri: REDIRECT_URI, tokenUrl: TOKEN_URL, modelsUrl: CODEX_MODELS_URL, originator: ORIGINATOR })})`);
    console.info(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.info(JSON.stringify({ ok: false, stage: 'exception', message: redactForLog(error instanceof Error ? error.message : String(error)) }, null, 2));
  process.exitCode = 1;
} finally {
  sidepanelCdp?.close();
  if (browserCdp && authTarget) await browserCdp.send('Target.closeTarget', { targetId: authTarget.targetId }).catch(() => undefined);
  if (browserCdp && sidepanelTarget) await browserCdp.send('Target.closeTarget', { targetId: sidepanelTarget.targetId }).catch(() => undefined);
  browserCdp?.close();
  if (runtime && !runtime.skipped) await runtime.close();
}

async function waitForExtensionPage(cdp: Cdp, extensionId: string) {
  await evaluate(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (document.readyState !== 'loading' && chrome?.runtime?.id === ${JSON.stringify(extensionId)}) {
        clearInterval(timer);
        resolve(true);
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('extension sidepanel did not become ready'));
      }
    }, 50);
  })`);
}

async function waitForOAuthRedirect(cdpOrigin: string, targetId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await readTargets(cdpOrigin);
    const target = targets.find((item) => item.id === targetId);
    if (!target) throw new Error('OAuth tab was closed before completing login');
    const url = safeUrl(target.url);
    if (url && url.hostname === 'localhost' && url.host === 'localhost:1455') return url;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('OAuth login timed out');
}

function buildAuthorizeUrl(codeChallenge: string, state: string) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('originator', ORIGINATOR);
  return url.toString();
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function base64Url(bytes: Buffer) {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function redactForLog(value: string) {
  return value
    .replace(/([?&](?:code|state|code_challenge)=)[^&]+/giu, '$1<redacted>')
    .replace(/(access_token|refresh_token|id_token|code_verifier|authorization_code)(["'=:\s]+)([^"'\s,&}]+)/giu, '$1$2<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/rt_[A-Za-z0-9_-]+/g, '<redacted-refresh-token>');
}

async function exchangeAndFetchModelsInExtension(input: { code: string; codeVerifier: string; redirectUri: string; tokenUrl: string; modelsUrl: string; originator: string }) {
  const startedAt = Date.now();
  try {
    const tokenResponse = await fetch(input.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        code_verifier: input.codeVerifier,
      }),
    });
    if (!tokenResponse.ok) return await httpFailure('token_exchange', tokenResponse);

    const tokens = await tokenResponse.json();
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : '';
    const accountId = readAccountId(idToken) || readAccountId(accessToken);
    if (!accessToken || !accountId) return { ok: false, stage: 'token_metadata', message: 'missing access token or account id' };

    const modelsResponse = await fetch(input.modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: input.originator,
        Accept: 'application/json',
      },
    });
    if (!modelsResponse.ok) return await httpFailure('models', modelsResponse);

    const modelsBody = await modelsResponse.json();
    const models = Array.isArray(modelsBody.models) ? modelsBody.models : Array.isArray(modelsBody.data) ? modelsBody.data : [];
    return {
      ok: true,
      stage: 'models',
      elapsedMs: Date.now() - startedAt,
      modelCount: models.length,
      sample: models.slice(0, 5).map((model: Record<string, unknown>) => ({
        slug: model.slug || model.id,
        displayName: model.display_name,
        contextWindow: model.context_window,
        defaultReasoningLevel: model.default_reasoning_level,
        supportedReasoningLevels: model.supported_reasoning_levels,
        priority: model.priority,
        visibility: model.visibility,
        supportedInApi: model.supported_in_api,
      })),
      topLevelKeys: Object.keys(modelsBody),
    };
  } catch (error) {
    return { ok: false, stage: 'exception', message: redact(error instanceof Error ? error.message : String(error)) };
  }

  async function httpFailure(stage: string, response: Response) {
    const text = await response.text().catch(() => '');
    return { ok: false, stage, status: response.status, message: redact(text.trim() ? text.slice(0, 300) : response.statusText) };
  }

  function readAccountId(jwt: string) {
    const claims = decodeJwt(jwt);
    const auth = claims && typeof claims['https://api.openai.com/auth'] === 'object' ? claims['https://api.openai.com/auth'] as Record<string, unknown> : undefined;
    const accountId = auth?.chatgpt_account_id || claims?.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : undefined;
  }

  function decodeJwt(jwt: string) {
    const payload = jwt.split('.')[1];
    if (!payload) return undefined;
    try {
      const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const value = JSON.parse(new TextDecoder().decode(bytes));
      return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }

  function redact(value: string) {
    return value
      .replace(/(access_token|refresh_token|id_token|code_verifier|authorization_code)(["'=:\s]+)([^"'\s,&}]+)/giu, '$1$2<redacted>')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
      .replace(/rt_[A-Za-z0-9_-]+/g, '<redacted-refresh-token>');
  }
}
