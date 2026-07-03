import type { LanguageModel } from 'ai';
import { redactCodexSecrets } from './codex-auth.ts';
import type { ReasoningEffort } from './provider-store.ts';

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

type CodexCallOptions = {
  prompt: PromptMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  abortSignal?: AbortSignal;
  includeRawChunks?: boolean;
  headers?: Record<string, string | undefined>;
};

type PromptMessage =
  | { role: 'system'; content: string }
  | { role: 'user' | 'assistant' | 'tool'; content: PromptPart[] };

type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; output: ToolOutput }
  | { type: string; [key: string]: unknown };

type ToolOutput =
  | { type: 'text' | 'error-text'; value: string }
  | { type: 'json' | 'error-json'; value: unknown }
  | { type: 'execution-denied'; reason?: string }
  | { type: 'content'; value: unknown };

type ToolDefinition = {
  type: 'function' | 'provider';
  name: string;
  description?: string;
  inputSchema?: unknown;
  strict?: boolean;
  id?: string;
};

type ToolChoice = { type: 'auto' | 'none' | 'required' } | { type: 'tool'; toolName: string };
type StreamPart = { type: string; [key: string]: unknown };
type ResponseItem = Record<string, unknown>;

type RequestBuild = { body: Record<string, unknown>; warnings: Array<Record<string, string>> };

const CODEX_BETA_HEADER = 'responses=experimental';
const TEXT_ID = 'txt-0';

export function createCodexLanguageModel(options: CodexRuntimeOptions): LanguageModel {
  validateReasoningEffort(options.reasoningEffort, options.supportedReasoningEfforts, options.modelId);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    specificationVersion: 'v3',
    provider: `${options.providerName}.codex`,
    modelId: options.modelId,
    supportedUrls: {},
    async doGenerate(callOptions: CodexCallOptions) {
      const request = buildCodexRequest(options, callOptions, false);
      const response = await postCodexResponses({ options, callOptions, fetcher, body: request.body, accept: 'application/json' });
      const json = await readJson(response, options);
      const content = contentFromItems(extractOutputItems(json));
      return {
        content,
        finishReason: finishReason(content.some((part) => part.type === 'tool-call'), readString(readRecord(json)?.status)),
        usage: codexUsage(readRecord(json)?.usage),
        request: { body: JSON.stringify(request.body) },
        response: { body: json, headers: headersObject(response.headers), id: readString(readRecord(json)?.id), modelId: readString(readRecord(json)?.model) },
        warnings: request.warnings,
      };
    },
    async doStream(callOptions: CodexCallOptions) {
      const request = buildCodexRequest(options, callOptions, true);
      const response = await postCodexResponses({ options, callOptions, fetcher, body: request.body, accept: 'text/event-stream' });
      return {
        stream: streamCodexResponse(response, request.warnings, callOptions.includeRawChunks),
        request: { body: request.body },
        response: { headers: headersObject(response.headers) },
      };
    },
  } as unknown as LanguageModel;
}

function validateReasoningEffort(value: ReasoningEffort, supported: string[] | undefined, modelId: string) {
  if (value === 'default') return;
  const efforts = (supported ?? []).map((effort) => effort.toLowerCase());
  if (efforts.includes(value)) return;
  const label = efforts.length > 0 ? efforts.join(', ') : 'none reported';
  throw new Error(`Codex model ${modelId} does not support reasoning effort "${value}". Supported: ${label}. Choose Default or a supported effort.`);
}

function buildCodexRequest(options: CodexRuntimeOptions, callOptions: CodexCallOptions, stream: boolean): RequestBuild {
  const { instructions, input } = codexInput(callOptions.prompt);
  const { tools, toolChoice, warnings } = codexTools(callOptions.tools, callOptions.toolChoice);
  return {
    warnings,
    body: {
      model: options.modelId,
      instructions,
      input,
      ...(tools.length > 0 ? { tools } : {}),
      tool_choice: toolChoice,
      parallel_tool_calls: true,
      ...(options.reasoningEffort === 'default' ? {} : { reasoning: { effort: options.reasoningEffort } }),
      store: false,
      stream,
      include: [],
    },
  };
}

function codexInput(prompt: PromptMessage[]) {
  const instructions: string[] = [];
  const input: ResponseItem[] = [];
  for (const message of prompt) {
    if (message.role === 'system') {
      if (message.content.trim()) instructions.push(message.content.trim());
      continue;
    }
    if (message.role === 'user') input.push({ type: 'message', role: 'user', content: textContent(message.content, 'input_text') });
    if (message.role === 'assistant') input.push(...assistantItems(message.content));
    if (message.role === 'tool') input.push(...toolOutputItems(message.content));
  }
  return { instructions: instructions.join('\n\n'), input };
}

function assistantItems(content: PromptPart[]): ResponseItem[] {
  const items: ResponseItem[] = [];
  const text = content.filter(isTextPart).map((part) => part.text).join('');
  if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  for (const part of content) {
    if (part.type !== 'tool-call') continue;
    items.push({ type: 'function_call', call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.input ?? {}) });
  }
  return items;
}

function toolOutputItems(content: PromptPart[]): ResponseItem[] {
  return content
    .filter(isToolResultPart)
    .map((part) => ({ type: 'function_call_output', call_id: part.toolCallId, output: stringifyToolOutput(part.output) }));
}

function textContent(content: PromptPart[], type: 'input_text' | 'output_text') {
  const text = content.filter(isTextPart).map((part) => part.text).join('\n');
  return text ? [{ type, text }] : [];
}

function codexTools(tools: ToolDefinition[] | undefined, toolChoice: ToolChoice | undefined) {
  const warnings: Array<Record<string, string>> = [];
  const codexTools = (tools ?? []).flatMap((tool) => {
    if (tool.type !== 'function') {
      warnings.push({ type: 'unsupported', feature: `provider-defined tool ${tool.id ?? tool.name}` });
      return [];
    }
    return [{ type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema ?? {}, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) }];
  });
  return { tools: codexTools, toolChoice: codexToolChoice(toolChoice), warnings };
}

function codexToolChoice(choice: ToolChoice | undefined) {
  if (!choice) return 'auto';
  return choice.type === 'tool' ? choice.toolName : choice.type;
}

async function postCodexResponses(args: {
  options: CodexRuntimeOptions;
  callOptions: CodexCallOptions;
  fetcher: typeof fetch;
  body: Record<string, unknown>;
  accept: string;
}) {
  const auth = await args.options.auth();
  const response = await args.fetcher(joinUrl(args.options.baseURL, 'responses'), {
    method: 'POST',
    headers: {
      ...definedHeaders(args.callOptions.headers),
      Authorization: `Bearer ${auth.accessToken}`,
      'ChatGPT-Account-Id': auth.accountId,
      'OpenAI-Beta': CODEX_BETA_HEADER,
      originator: 'taber',
      Accept: args.accept,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args.body),
    signal: args.callOptions.abortSignal,
  });
  if (!response.ok) throw await runtimeHttpError(response, [auth.accessToken, auth.accountId]);
  return response;
}

function streamCodexResponse(response: Response, warnings: Array<Record<string, string>>, includeRawChunks = false) {
  if (!response.body) return errorStream(new Error('Codex response body is empty.'));
  let activeText = false;
  let completed = false;
  let sawToolCall = false;
  let usage: unknown;
  return new ReadableStream<StreamPart>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings });
      try {
        for await (const event of readSseJson(response.body!)) {
          if (includeRawChunks) controller.enqueue({ type: 'raw', rawValue: event });
          activeText = handleStreamEvent(event, controller, activeText);
          if (event.type === 'response.output_item.done' && isFunctionCallItem(readRecord(event.item))) sawToolCall = true;
          if (event.type === 'response.completed') {
            completed = true;
            usage = readRecord(event.response)?.usage;
          }
        }
        if (!completed) throw new Error('Codex stream closed before response.completed.');
        if (activeText) controller.enqueue({ type: 'text-end', id: TEXT_ID });
        controller.enqueue({ type: 'finish', finishReason: finishReason(sawToolCall, 'completed'), usage: codexUsage(usage) });
      } catch (error) {
        controller.enqueue({ type: 'error', error: sanitizedError(error) });
      } finally {
        controller.close();
      }
    },
  });
}

function handleStreamEvent(event: Record<string, unknown>, controller: ReadableStreamDefaultController<StreamPart>, activeText: boolean) {
  if (event.type === 'response.created') {
    const response = readRecord(event.response);
    controller.enqueue({ type: 'response-metadata', id: readString(response?.id), modelId: readString(response?.model) });
  }
  if (event.type === 'response.output_text.delta') return enqueueText(controller, activeText, readString(event.delta) ?? '');
  if (event.type === 'response.output_item.done') enqueueDoneItem(controller, readRecord(event.item));
  if (event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error(responseErrorMessage(event));
  return activeText;
}

function enqueueText(controller: ReadableStreamDefaultController<StreamPart>, activeText: boolean, delta: string) {
  if (!delta) return activeText;
  if (!activeText) controller.enqueue({ type: 'text-start', id: TEXT_ID });
  controller.enqueue({ type: 'text-delta', id: TEXT_ID, delta });
  return true;
}

function enqueueDoneItem(controller: ReadableStreamDefaultController<StreamPart>, item: Record<string, unknown> | undefined) {
  if (!isFunctionCallItem(item)) return;
  const id = readString(item.call_id) ?? readString(item.id) ?? crypto.randomUUID();
  const name = readString(item.name) ?? 'unknown_tool';
  const input = readString(item.arguments) ?? '{}';
  controller.enqueue({ type: 'tool-input-start', id, toolName: name });
  if (input) controller.enqueue({ type: 'tool-input-delta', id, delta: input });
  controller.enqueue({ type: 'tool-input-end', id });
  controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: name, input });
}

function contentFromItems(items: ResponseItem[]) {
  const content: StreamPart[] = [];
  const text = items.flatMap(readOutputText).join('');
  if (text) content.push({ type: 'text', text });
  for (const item of items) {
    if (!isFunctionCallItem(item)) continue;
    content.push({ type: 'tool-call', toolCallId: readString(item.call_id) ?? readString(item.id) ?? crypto.randomUUID(), toolName: readString(item.name) ?? 'unknown_tool', input: readString(item.arguments) ?? '{}' });
  }
  return content;
}

function readOutputText(item: ResponseItem) {
  if (item.type !== 'message' || !Array.isArray(item.content)) return [];
  return item.content.flatMap((part) => readRecord(part)?.type === 'output_text' ? [readString(readRecord(part)?.text) ?? ''] : []);
}

function extractOutputItems(body: unknown): ResponseItem[] {
  const record = readRecord(body);
  const output = record?.output ?? readRecord(record?.response)?.output;
  return Array.isArray(output) ? output.filter(isRecord) : [];
}

async function* readSseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = sseBoundary(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseSseBlock(block);
        if (parsed) yield parsed;
        boundary = sseBoundary(buffer);
      }
      if (done) break;
    }
    const parsed = parseSseBlock(buffer);
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): Record<string, unknown> | undefined {
  let event = '';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  const raw = data.join('\n').trim();
  if (!raw || raw === '[DONE]') return undefined;
  const parsed = JSON.parse(raw);
  return isRecord(parsed) ? { type: readString(parsed.type) ?? event, ...parsed } : { type: event, value: parsed };
}

function sseBoundary(buffer: string) {
  const matches = ['\r\n\r\n', '\n\n', '\r\r'].map((value) => ({ value, index: buffer.indexOf(value) })).filter((match) => match.index >= 0).sort((a, b) => a.index - b.index);
  return matches[0] ? { index: matches[0].index, length: matches[0].value.length } : undefined;
}

async function readJson(response: Response, options: CodexRuntimeOptions) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(redactKnownSecrets(`Invalid Codex JSON response: ${describe(error)}`, [options.modelId]));
  }
}

async function runtimeHttpError(response: Response, secrets: string[]) {
  const text = await response.text().catch(() => '');
  const suffix = text.trim() ? `: ${text.slice(0, 300)}` : '';
  return new Error(redactKnownSecrets(`Codex Responses request failed: HTTP ${response.status} ${response.statusText}${suffix}`, secrets));
}

function responseErrorMessage(event: Record<string, unknown>) {
  const error = readRecord(readRecord(event.response)?.error);
  return readString(error?.message) ?? `Codex stream ${String(event.type)}`;
}

function codexUsage(value: unknown) {
  const usage = readRecord(value);
  const input = readNumber(usage?.input_tokens);
  const cached = readNumber(readRecord(usage?.input_tokens_details)?.cached_tokens);
  const output = readNumber(usage?.output_tokens);
  const reasoning = readNumber(readRecord(usage?.output_tokens_details)?.reasoning_tokens);
  return {
    inputTokens: { total: input, noCache: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)), cacheRead: cached, cacheWrite: undefined },
    outputTokens: { total: output, text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)), reasoning },
    ...(usage ? { raw: usage } : {}),
  };
}

function finishReason(hasToolCall: boolean, raw: string | undefined) {
  return { unified: hasToolCall ? 'tool-calls' : raw === 'incomplete' ? 'length' : 'stop', raw };
}

function stringifyToolOutput(output: ToolOutput | undefined) {
  if (!output) return '';
  if (output.type === 'text' || output.type === 'error-text') return output.value;
  if (output.type === 'execution-denied') return output.reason ?? 'Tool execution denied.';
  return JSON.stringify(output.value);
}

function isTextPart(part: PromptPart): part is { type: 'text'; text: string } {
  return part.type === 'text';
}

function isToolResultPart(part: PromptPart): part is { type: 'tool-result'; toolCallId: string; output: ToolOutput } {
  return part.type === 'tool-result';
}

function isFunctionCallItem(item: Record<string, unknown> | undefined): item is ResponseItem {
  return item?.type === 'function_call';
}

function errorStream(error: Error) {
  return new ReadableStream<StreamPart>({
    start(controller) {
      controller.enqueue({ type: 'error', error });
      controller.close();
    },
  });
}

function sanitizedError(error: unknown) {
  return new Error(redactCodexSecrets(describe(error)));
}

function redactKnownSecrets(value: string, secrets: string[]) {
  return secrets.reduce((text, secret) => secret ? text.split(secret).join('<redacted>') : text, redactCodexSecrets(value));
}

function definedHeaders(headers: Record<string, string | undefined> | undefined) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function headersObject(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
