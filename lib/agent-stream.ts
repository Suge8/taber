export type AgentStreamPart = { type: string; [key: string]: unknown };

export type AgentStreamResult = {
  fullStream: AsyncIterable<AgentStreamPart>;
  text: PromiseLike<string> | string;
};

export type AgentTextEvents = {
  createMessage: () => Promise<void>;
  appendText: (delta: string) => Promise<void>;
  startReasoning?: (input: { reasoningId: string }) => Promise<void>;
  appendReasoning?: (input: { reasoningId: string; delta: string }) => Promise<void>;
  completeReasoning?: (input: { reasoningId: string }) => Promise<void>;
  startToolInput?: (input: { toolCallId: string; toolName: string; title?: string }) => Promise<void>;
  appendToolInput?: (input: { toolCallId: string; delta: string }) => Promise<void>;
  completeToolInput?: (input: { toolCallId: string; toolName: string; input: unknown; title?: string }) => Promise<void>;
  failToolCall?: (input: { toolCallId: string; toolName: string; error: string }) => Promise<void>;
};

/** Total silence means the upstream connection stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
export const MAX_TOOL_INPUT_CHARS = 2_000_000;
export const MAX_STEP_OUTPUT_CHARS = 4_000_000;
export const MAX_CONSECUTIVE_CONTENT_WHITESPACE_CHARS = 512;
export const MAX_TOOL_INPUT_STRUCTURAL_WHITESPACE_CHARS = 512;

type AgentStreamOptions = {
  abortSignal?: AbortSignal;
  idleTimeoutMs?: number;
  maxToolInputChars?: number;
  maxStepOutputChars?: number;
  maxConsecutiveContentWhitespaceChars?: number;
  maxToolInputStructuralWhitespaceChars?: number;
  onHealthFailure?: (error: string) => void;
};

type JsonPrefixState = {
  started: boolean;
  complete: boolean;
  inString: boolean;
  escaped: boolean;
  closers: string[];
  structuralWhitespaceChars: number;
};

type ActiveToolInput = {
  toolCallId: string;
  toolName: string;
  chars: number;
  json: JsonPrefixState;
};

type StreamHealthState = {
  activeToolInputs: Map<string, ActiveToolInput>;
  contentWhitespaceChars: Map<string, number>;
  stepOutputChars: number;
};

class AgentStreamHealthError extends Error {}

export async function emitAgentEventFailClosed(emitEvent: () => Promise<void>, onPersistenceFailure: () => Promise<void>) {
  try {
    await emitEvent();
  } catch (error) {
    await onPersistenceFailure();
    throw error;
  }
}

export async function collectAgentResponseText(result: AgentStreamResult, events: AgentTextEvents, options?: AgentStreamOptions) {
  const idleTimeoutMs = options?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const limits = {
    toolInputChars: options?.maxToolInputChars ?? MAX_TOOL_INPUT_CHARS,
    stepOutputChars: options?.maxStepOutputChars ?? MAX_STEP_OUTPUT_CHARS,
    contentWhitespaceChars: options?.maxConsecutiveContentWhitespaceChars ?? MAX_CONSECUTIVE_CONTENT_WHITESPACE_CHARS,
    toolInputStructuralWhitespaceChars: options?.maxToolInputStructuralWhitespaceChars ?? MAX_TOOL_INPUT_STRUCTURAL_WHITESPACE_CHARS,
  };
  const health: StreamHealthState = { activeToolInputs: new Map(), contentWhitespaceChars: new Map(), stepOutputChars: 0 };
  let text = '';
  let messageCreated = false;

  const iterator = result.fullStream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextWithIdleTimeout(iterator, idleTimeoutMs);
      if (next.done) break;
      const part = next.value;
      const healthFailure = inspectStreamHealth(part, health, limits);
      if (healthFailure) throw new AgentStreamHealthError(healthFailure);
      const failure = streamFailureMessage(part, options?.abortSignal?.aborted === true);
      if (failure) {
        const ErrorType = part.type === 'abort' && !options?.abortSignal?.aborted ? AgentStreamHealthError : Error;
        throw new ErrorType(failure);
      }
      await emitProgressEvent(part, events);
      if (part.type !== 'text-delta' || typeof part.text !== 'string') continue;
      if (!messageCreated) {
        await events.createMessage();
        messageCreated = true;
      }
      text += part.text;
      await events.appendText(part.text);
    }
  } catch (error) {
    if (error instanceof AgentStreamHealthError) {
      options?.onHealthFailure?.(error.message);
      await failActiveToolInputs(health.activeToolInputs, events, error.message);
    }
    throw error;
  }

  if (messageCreated) return text;

  text = await result.text;
  if (!text) return '';
  await events.createMessage();
  await events.appendText(text);
  return text;
}

function inspectStreamHealth(
  part: AgentStreamPart,
  state: StreamHealthState,
  limits: { toolInputChars: number; stepOutputChars: number; contentWhitespaceChars: number; toolInputStructuralWhitespaceChars: number },
) {
  if (part.type === 'start-step') {
    state.stepOutputChars = 0;
    state.contentWhitespaceChars.clear();
  }
  const delta = generatedDelta(part);
  if (delta) {
    state.stepOutputChars += delta.length;
    if (state.stepOutputChars > limits.stepOutputChars) return `Model step output exceeded ${limits.stepOutputChars} characters; stopped runaway generation.`;
  }
  return inspectContentWhitespace(part, state.contentWhitespaceChars, limits.contentWhitespaceChars)
    ?? inspectToolInput(part, state.activeToolInputs, limits.toolInputChars, limits.toolInputStructuralWhitespaceChars);
}

function generatedDelta(part: AgentStreamPart) {
  if (part.type === 'text-delta' || part.type === 'reasoning-delta') return readString(part.text) ?? readString(part.delta);
  if (part.type === 'tool-input-delta') return readString(part.delta) ?? readString(part.inputTextDelta);
  return undefined;
}

function inspectContentWhitespace(part: AgentStreamPart, counts: Map<string, number>, maxChars: number) {
  if (part.type !== 'text-delta' && part.type !== 'reasoning-delta') return;
  const delta = readString(part.text) ?? readString(part.delta);
  if (!delta) return;
  const id = readString(part.id) ?? 'current';
  const key = `${part.type === 'text-delta' ? 'text' : 'reasoning'}:${id}`;
  const trailing = trailingWhitespaceChars(delta, counts.get(key) ?? 0);
  counts.set(key, trailing);
  if (trailing > maxChars) return `${part.type === 'text-delta' ? 'text' : 'reasoning'} output exceeded ${maxChars} consecutive whitespace characters; stopped degenerate model output.`;
}

function inspectToolInput(part: AgentStreamPart, active: Map<string, ActiveToolInput>, maxChars: number, maxStructuralWhitespaceChars: number) {
  if (part.type === 'tool-input-start') {
    const toolCallId = readString(part.id) ?? readString(part.toolCallId);
    const toolName = readString(part.toolName);
    if (toolCallId && toolName) active.set(toolCallId, { toolCallId, toolName, chars: 0, json: createJsonPrefixState() });
    return;
  }
  const toolCallId = readString(part.id) ?? readString(part.toolCallId);
  if (part.type === 'tool-call') {
    if (toolCallId) active.delete(toolCallId);
    return;
  }
  if (part.type !== 'tool-input-delta' || !toolCallId) return;
  const input = active.get(toolCallId);
  const delta = readString(part.delta) ?? readString(part.inputTextDelta);
  if (!input || !delta) return;
  input.chars += delta.length;
  if (input.chars > maxChars) return `Tool input for call ${toolCallId} exceeded ${maxChars} characters; stopped runaway model output.`;
  return inspectJsonPrefix(delta, input.json, toolCallId, maxStructuralWhitespaceChars);
}

function inspectJsonPrefix(delta: string, state: JsonPrefixState, toolCallId: string, maxStructuralWhitespaceChars: number) {
  for (const char of delta) {
    if (!state.inString && isJsonWhitespace(char)) {
      state.structuralWhitespaceChars += 1;
      if (state.structuralWhitespaceChars > maxStructuralWhitespaceChars) return `Tool input for call ${toolCallId} exceeded ${maxStructuralWhitespaceChars} consecutive structural whitespace characters; stopped degenerate model output.`;
      continue;
    }
    if (state.complete) return `Tool input for call ${toolCallId} continued after complete JSON; stopped malformed model output.`;
    if (!state.inString) state.structuralWhitespaceChars = 0;
    const failure = consumeJsonChar(char, state);
    if (failure) return `Tool input for call ${toolCallId} ${failure}; stopped malformed model output.`;
  }
}

function consumeJsonChar(char: string, state: JsonPrefixState) {
  if (state.inString) {
    if (state.escaped) state.escaped = false;
    else if (char === '\\') state.escaped = true;
    else if (char === '"') state.inString = false;
    return;
  }
  if (!state.started) {
    if (isJsonWhitespace(char)) return;
    state.started = true;
    if (char === '{') state.closers.push('}');
    else if (char === '[') state.closers.push(']');
    else return 'did not start with a JSON object or array';
    return;
  }
  if (char === '"') state.inString = true;
  else if (char === '{') state.closers.push('}');
  else if (char === '[') state.closers.push(']');
  else if (char === '}' || char === ']') {
    if (state.closers.pop() !== char) return 'produced mismatched JSON delimiters';
    if (state.closers.length === 0) state.complete = true;
  }
}

function createJsonPrefixState(): JsonPrefixState {
  return { started: false, complete: false, inString: false, escaped: false, closers: [], structuralWhitespaceChars: 0 };
}

function trailingWhitespaceChars(delta: string, previous: number) {
  const count = delta.match(/\s+$/u)?.[0].length ?? 0;
  return count === delta.length ? previous + count : count;
}

function isJsonWhitespace(char: string) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

async function failActiveToolInputs(active: Map<string, ActiveToolInput>, events: AgentTextEvents, error: string) {
  for (const input of active.values()) {
    await events.failToolCall?.({ toolCallId: input.toolCallId, toolName: input.toolName, error });
  }
  active.clear();
}

async function emitProgressEvent(part: AgentStreamPart, events: AgentTextEvents) {
  if (part.type === 'reasoning-start') {
    const reasoningId = readString(part.id);
    if (reasoningId) await events.startReasoning?.({ reasoningId });
    return;
  }
  if (part.type === 'reasoning-delta') {
    const reasoningId = readString(part.id);
    const delta = readString(part.text) ?? readString(part.delta);
    if (reasoningId && delta) await events.appendReasoning?.({ reasoningId, delta });
    return;
  }
  if (part.type === 'reasoning-end') {
    const reasoningId = readString(part.id);
    if (reasoningId) await events.completeReasoning?.({ reasoningId });
    return;
  }
  if (part.type === 'tool-input-start') {
    const toolCallId = readString(part.id) ?? readString(part.toolCallId);
    const toolName = readString(part.toolName);
    if (toolCallId && toolName) await events.startToolInput?.({ toolCallId, toolName, title: readString(part.title) });
    return;
  }
  if (part.type === 'tool-input-delta') {
    const toolCallId = readString(part.id) ?? readString(part.toolCallId);
    const delta = readString(part.delta) ?? readString(part.inputTextDelta);
    if (toolCallId && delta) await events.appendToolInput?.({ toolCallId, delta });
    return;
  }
  if (part.type === 'tool-call') {
    const toolCallId = readString(part.toolCallId) ?? readString(part.id);
    const toolName = readString(part.toolName);
    if (!toolCallId || !toolName) return;
    await events.completeToolInput?.({ toolCallId, toolName, input: part.input, title: readString(part.title) });
    // Invalid tool inputs never reach execute(); surface them as failures so the
    // timeline does not show the call as pending forever and the error is persisted.
    if (part.invalid === true) await events.failToolCall?.({ toolCallId, toolName, error: stringifyError(part.error) });
  }
}

function nextWithIdleTimeout(iterator: AsyncIterator<AgentStreamPart>, timeoutMs: number) {
  return new Promise<IteratorResult<AgentStreamPart>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentStreamHealthError(`Model stream stalled: no output received for ${Math.round(timeoutMs / 1000)}s. Stop and retry the task.`)), timeoutMs);
    iterator.next().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function streamFailureMessage(part: AgentStreamPart, taskAborted = false) {
  if (part.type === 'error') return stringifyError(part.error);
  if (part.type === 'abort') {
    const reason = part.reason === undefined ? 'Task aborted' : String(part.reason);
    return !taskAborted && /abort|timeout/i.test(reason) ? 'Agent execution timed out.' : reason;
  }
  if (part.type === 'finish' && part.finishReason === 'error') return 'Model response failed.';
  if (part.type === 'finish' && part.finishReason === 'tool-calls') return 'Agent reached its tool-loop limit before producing a final response. Retry with a narrower task.';
  return undefined;
}

const ERROR_RESPONSE_BODY_MAX_CHARS = 600;

function stringifyError(error: unknown) {
  const message = error instanceof Error ? error.message : isRecord(error) ? readString(error.message) ?? String(error) : String(error);
  // Provider errors (AI SDK APICallError) carry the upstream response body;
  // surface it so failures like "Model not found" are diagnosable from logs.
  const responseBody = isRecord(error) ? readString(error.responseBody) : undefined;
  if (responseBody && !message.includes(responseBody)) {
    return `${message} | response: ${responseBody.slice(0, ERROR_RESPONSE_BODY_MAX_CHARS)}`;
  }
  return message;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
