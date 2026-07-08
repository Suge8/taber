import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { redactCodexSecrets } from './codex-auth.ts';
import { assertReasoningEffortSupported, type ReasoningEffort } from './reasoning-effort.ts';

export type CodexRuntimeAuth = { accessToken: string; accountId: string };

export type CodexRuntimeOptions = {
  modelId: string;
  providerName: string;
  baseURL: string;
  auth: () => Promise<CodexRuntimeAuth>;
  reasoningEffort: ReasoningEffort;
  supportedReasoningEfforts?: string[];
  fetch?: typeof fetch;
};

const CODEX_BETA_HEADER = 'responses=experimental';
// AI SDK owns Responses parsing; this transport shim only maps ChatGPT Codex terminal SSE events to stream EOF.
const TERMINAL_SSE_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete']);

export function createCodexLanguageModel(options: CodexRuntimeOptions): LanguageModel {
  validateReasoningEffort(options.reasoningEffort, options.supportedReasoningEfforts, options.modelId);
  return createOpenAI({
    name: options.providerName,
    baseURL: options.baseURL,
    apiKey: 'unused',
    fetch: createCodexFetch(options),
  }).responses(options.modelId) as LanguageModel;
}

export function codexProviderOptions(reasoningEffort: ReasoningEffort) {
  return {
    openai: {
      store: false,
      parallelToolCalls: true,
      reasoningSummary: 'auto',
      ...(reasoningEffort === 'default' ? {} : { reasoningEffort }),
    },
  };
}

function createCodexFetch(options: CodexRuntimeOptions): typeof fetch {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const streaming = isStreamingResponsesRequest(input, init);
    const auth = await options.auth();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${auth.accessToken}`);
    headers.set('ChatGPT-Account-Id', auth.accountId);
    headers.set('OpenAI-Beta', CODEX_BETA_HEADER);
    headers.set('originator', 'taber');
    headers.set('Accept', streaming ? 'text/event-stream' : 'application/json');

    const response = await fetcher(input, { ...init, headers });
    const secrets = [auth.accessToken, auth.accountId];
    if (!response.ok) return redactErrorResponse(response, secrets);
    return streaming ? closeAfterTerminalEvent(response, secrets) : response;
  };
}

function validateReasoningEffort(value: ReasoningEffort, supported: string[] | undefined, modelId: string) {
  try {
    assertReasoningEffortSupported(value, supported, modelId);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Model /, 'Codex model ') : String(error);
    throw new Error(message);
  }
}

async function redactErrorResponse(response: Response, secrets: string[]) {
  const text = await response.text().catch(() => '');
  return new Response(redactKnownSecrets(text, secrets), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  });
}

function closeAfterTerminalEvent(response: Response, secrets: string[]) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let released = false;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let boundary = sseBoundary(buffer);
          while (boundary) {
            const block = buffer.slice(0, boundary.index);
            const separator = buffer.slice(boundary.index, boundary.index + boundary.length);
            buffer = buffer.slice(boundary.index + boundary.length);
            controller.enqueue(encoder.encode(redactKnownSecrets(block, secrets) + separator));
            if (isTerminalSseBlock(block)) {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
              released = true;
              controller.close();
              return;
            }
            boundary = sseBoundary(buffer);
          }
          if (done) break;
        }
        if (buffer) controller.enqueue(encoder.encode(redactKnownSecrets(buffer, secrets)));
        controller.close();
      } catch (error) {
        controller.error(new Error(redactKnownSecrets(describe(error), secrets)));
      } finally {
        if (!released) reader.releaseLock();
      }
    },
    cancel() {
      return reader.cancel().catch(() => undefined);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  });
}

function isStreamingResponsesRequest(input: RequestInfo | URL, init: RequestInit | undefined) {
  if (!requestUrl(input).pathname.endsWith('/responses')) return false;
  const body = readRecord(parseJson(typeof init?.body === 'string' ? init.body : undefined));
  return body?.stream === true;
}

function requestUrl(input: RequestInfo | URL) {
  const value = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  return new URL(value);
}

function isTerminalSseBlock(block: string) {
  const type = sseBlockType(block);
  return type ? TERMINAL_SSE_EVENTS.has(type) : false;
}

function sseBlockType(block: string) {
  let event = '';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  const payload = parseJson(data.join('\n').trim());
  return readString(readRecord(payload)?.type) ?? event;
}

function sseBoundary(buffer: string) {
  const matches = ['\r\n\r\n', '\n\n', '\r\r']
    .map((value) => ({ value, index: buffer.indexOf(value) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index);
  return matches[0] ? { index: matches[0].index, length: matches[0].value.length } : undefined;
}

function responseHeaders(headers: Headers) {
  const next = new Headers(headers);
  next.delete('content-length');
  next.delete('content-encoding');
  return next;
}

function redactKnownSecrets(value: string, secrets: string[]) {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('<redacted>') : text, redactCodexSecrets(value));
}

function parseJson(value: string | undefined) {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
