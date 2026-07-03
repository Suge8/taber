import { connectCdp, connectTarget, evaluate, fetchJson, hasCdpEndpoint, waitForTarget } from '../cdp-client.mjs';
import { prepareRuntimeBrowser } from '../runtime-browser.mjs';

const timeoutMs = Number(process.env.CODEX_DEVICE_TIMEOUT_MS ?? 300000);
const originator = process.env.CODEX_ORIGINATOR ?? 'taber';

let runtime: Awaited<ReturnType<typeof prepareRuntimeBrowser>> | undefined;
let browserCdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
let sidepanelTarget: { targetId: string } | undefined;
let verifyTarget: { targetId: string } | undefined;
let sidepanelCdp: Awaited<ReturnType<typeof connectCdp>> | undefined;

try {
  runtime = await prepareRuntimeBrowser({ required: true, allowLaunch: true });
  if (runtime.skipped) throw new Error(runtime.reason);
  const version = await fetchJson(`${runtime.cdpOrigin}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  sidepanelTarget = await browserCdp.send('Target.createTarget', { url: `chrome-extension://${runtime.extensionId}/sidepanel.html` }) as { targetId: string };
  sidepanelCdp = await connectTarget(await waitForTarget(runtime.cdpOrigin, (target) => target.id === sidepanelTarget?.targetId && hasCdpEndpoint(target)));
  await sidepanelCdp.send('Runtime.enable');
  await evaluate(sidepanelCdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (document.readyState !== 'loading' && chrome?.runtime?.id) {
        clearInterval(timer);
        resolve(true);
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('extension sidepanel did not become ready'));
      }
    }, 50);
  })`);

  const device = await evaluate(sidepanelCdp, `(${requestDeviceCodeInExtension.toString()})()`);
  console.info(`Open ${device.verificationUrl}`);
  console.info(`Enter code: ${device.userCode}`);
  console.info('Waiting for device login. No token will be printed.');
  verifyTarget = await browserCdp.send('Target.createTarget', { url: device.verificationUrl }) as { targetId: string };

  const result = await evaluate(sidepanelCdp, `(${completeAndFetchModelsInExtension.toString()})(${JSON.stringify({ device, timeoutMs, originator })})`);
  console.info(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  sidepanelCdp?.close();
  if (browserCdp && verifyTarget) await browserCdp.send('Target.closeTarget', { targetId: verifyTarget.targetId }).catch(() => undefined);
  if (browserCdp && sidepanelTarget) await browserCdp.send('Target.closeTarget', { targetId: sidepanelTarget.targetId }).catch(() => undefined);
  browserCdp?.close();
  if (runtime && !runtime.skipped) await runtime.close();
}

async function requestDeviceCodeInExtension() {
  const response = await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
  });
  if (!response.ok) throw new Error(`device usercode failed: HTTP ${response.status} ${response.statusText}`);
  const body = await response.json();
  return {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: body.user_code || body.usercode,
    deviceAuthId: body.device_auth_id,
    intervalSeconds: Math.max(1, Number(body.interval) || 1),
  };
}

async function completeAndFetchModelsInExtension(input: { device: { userCode: string; deviceAuthId: string; intervalSeconds: number }; timeoutMs: number; originator: string }) {
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  try {
    const code = await pollAuthorizationCode(input.device, deadline);
    const tokenResponse = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code.authorizationCode,
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        code_verifier: code.codeVerifier,
      }),
    });
    if (!tokenResponse.ok) return { ok: false, stage: 'token_exchange', status: tokenResponse.status, message: tokenResponse.statusText };
    const tokens = await tokenResponse.json();
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
    const idToken = typeof tokens.id_token === 'string' ? tokens.id_token : '';
    const accountId = readAccountId(idToken) || readAccountId(accessToken);
    if (!accessToken || !accountId) return { ok: false, stage: 'token_metadata', message: 'missing access token or account id' };

    const modelsResponse = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=0.124.0', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: input.originator,
        Accept: 'application/json',
      },
    });
    if (!modelsResponse.ok) return { ok: false, stage: 'models', status: modelsResponse.status, message: modelsResponse.statusText };
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
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stage: 'exception', message: message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>').replace(/rt_[A-Za-z0-9_-]+/g, '<redacted-refresh-token>') };
  }

  async function pollAuthorizationCode(device: { userCode: string; deviceAuthId: string; intervalSeconds: number }, deadline: number) {
    while (Date.now() < deadline) {
      const response = await fetch('https://auth.openai.com/api/accounts/deviceauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      });
      if (response.ok) {
        const body = await response.json();
        return { authorizationCode: body.authorization_code, codeVerifier: body.code_verifier };
      }
      if (response.status !== 403 && response.status !== 404) throw new Error(`device poll failed: HTTP ${response.status} ${response.statusText}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(device.intervalSeconds * 1000, Math.max(0, deadline - Date.now()))));
    }
    throw new Error('device auth timed out');
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
}
