# Model context and onboarding plan

## Goal

Make Taber a real multi-turn supervised browser Agent.

Current problem: the sidepanel displays a multi-turn conversation, but `ToolLoopAgent.generate()` only receives the current `prompt`. The model cannot see previous user requests, previous assistant answers, or the page context captured in earlier tasks.

Target architecture:

```txt
agentEvents = single source of truth
  -> model context projection
  -> token estimate against selected model contextWindowTokens
  -> task-level compaction at 90%
  -> ToolLoopAgent.generate({ messages })
```

Also simplify first-run provider setup:

```txt
Onboarding: provider + model + API key
Settings: advanced provider/model/baseURL/contextWindowTokens/catalog refresh
```

## Non-goals

- No hidden background compaction.
- No automatic catalog refresh.
- No provider-specific context-window probing.
- No new production dependency for tokenization or model catalogs.
- No fixed recent-turn limit.
- No UI state as model memory.
- No silent context truncation.

## Decisions

### Event log is the only history source

Use `agentEvents` to derive model context. Do not use a separate chat history source.

Reasons:

- Sidepanel already derives conversation and tool timeline from `agentEvents`.
- Tool evidence, task lifecycle, tab context, and future compaction are all events.
- Avoid dual truth between `messages` and `agentEvents`.

### Delete `messages`

Remove the Dexie `messages` table and related code:

- `Message`
- `MessageRole`
- `appendMessage()`
- `SessionSnapshot.messages`
- `database.messages` retention/deletion paths

Keep `message.created` / `message.appended` reading branches in UI only if needed for temporary compatibility, but new code must not write them.

Project is early enough that losing old local `messages` rows is acceptable. Durable conversation history lives in `agentEvents`.

### Model context comes from projection, not UI

Add a pure projection layer:

```txt
lib/model-context.ts
```

Responsibilities:

- build model messages from `agentEvents`
- inject current/historical tab context
- serialize recent tool evidence digest
- estimate token usage
- select completed task groups for compaction
- exclude current running task tool events

### Use AI SDK messages API

Use AI SDK v6 `ToolLoopAgent.generate({ messages })`, not `prompt`.

`prompt` and `messages` are mutually exclusive. `messages` is required for real multi-turn context.

### Current tab context is data, not system instruction

Inject summaries and browser context as `user` messages, not `system`.

Reasons:

- `instructions` stays reserved for Taber behavior rules.
- Browser/page content is untrusted data.
- Page content must not gain system-level authority.

Message shape:

```txt
user:
The conversation history before this point was compacted into the following summary:
<summary>
...
</summary>

user:
[Browser context]
title: ...
url: ...

[User request]
...
```

### Each task snapshots its tab context

Every `task.started` stores the current tab title/url at task start:

```ts
task.started.payload.context = { title, url, id }
```

This is a snapshot, not a live pointer. It must not be updated when the user navigates later.

### Same session can span multiple tabs/sites

Do not split sessions by tab automatically. A session is the user's explicit conversation/task chain. Per-task tab snapshots distinguish which page each turn referred to.

### Running task is excluded from historical context

When building context for `currentTaskId`:

- include latest summary
- include completed/failed/cancelled historical tasks after summary
- include current task user prompt + current tab context
- exclude current task `tool.*`

AI SDK handles current-round tool calls/results inside the active agent loop.

### Failed/cancelled tasks are context

Historical failed and cancelled tasks should be included as context:

```txt
failed task:
  user request + tab context
  tool evidence digest
  [Task failed]: exact error

cancelled task:
  user request + tab context
  tool evidence digest
  [Task cancelled by user]
```

Do not fake failed/cancelled tasks as normal assistant answers.

### Tool evidence enters context as digest

Do not inject raw tool outputs. Inject safe concise evidence digest.

Reasons:

- `getDocument.markdown` can be huge.
- `extractImage.dataUrl` is huge and useless for language context.
- debugger/network output can be long.
- `browserRepl.observe` indexes become stale.

Historical task message shape:

```txt
user:
[Browser context]
title: ...
url: ...

[User request]
...

[Tool evidence]
- getDocument: ...
- browserRepl.observe: saw "使用 Linux Do 登录" button. Element indexes are historical; re-observe before interacting.

assistant:
...
```

Add instruction-level behavior:

```txt
Before interacting with a page based on prior context, re-observe or query the current page state.
```

### Tool evidence digest rules

Use a pure serializer such as:

```ts
serializeToolEventForContext(event)
serializeToolEventForCompaction(event)
```

Each serialized tool event is capped by an internal constant, for example `2000` chars. This is not user-configurable.

Rules by tool:

#### `navigate`

Keep:

- action
- url
- title
- tabId/windowId if useful
- status/error

#### `getDocument`

Keep:

- title
- url
- source
- selection summary
- headings if present
- table summary if present
- markdown excerpt only

Do not keep full page markdown.

#### `browserRepl`

Keep by helper:

- `observe/query`: visible semantic elements, labels, text, roles; cap count/length
- `click/fill/press`: action target + result
- `waitFor`: observed text/state
- `browserjs/sandbox`: stringified result, truncated

Always mark element indexes/stable IDs as historical. The agent must re-observe before interaction.

#### `debugger`

Keep:

- console errors
- failed requests
- status code
- URL
- exact error messages

Truncate long bodies/payloads.

#### `extractImage`

Keep:

- source
- selector
- url if present
- width/height
- alt

Remove:

- `dataUrl`
- base64

### Compaction threshold

Each saved model has:

```ts
contextWindowTokens: number
```

Compress when estimated prompt tokens exceed:

```ts
Math.floor(contextWindowTokens * 0.9)
```

The estimate must include:

- `instructions`
- tool descriptions/schemas
- projected model messages

Do not add `outputTokens` field for now.

### Token estimation

No tokenizer dependency.

Use conservative approximate counting:

```txt
ASCII chars / 4 + non-ASCII chars
```

Exact tokenizer accuracy is not required for this phase.

### Compaction happens only at task start

Flow:

```txt
startTask
  -> append task.started with prompt + tab context
  -> build projected messages
  -> estimate prompt tokens
  -> if > 90%, compact old completed task groups
  -> append context.compacted
  -> rebuild projected messages
  -> ToolLoopAgent.generate({ messages })
```

No compaction after `task.completed`. No timer. No idle/background model calls.

### Compaction boundaries are task-level

Group events by `taskId` / task lifecycle.

Compress older completed task groups. Keep recent task groups raw as budget allows.

Do not cut through a task group. Do not cut a single tool event. Do not compact the current task.

If a single current request makes the context too large and there is no compressible old task, fail the task with:

```txt
Context is too large for the selected model. Choose a larger context model or start a new session.
```

No silent truncation.

### Compaction includes tool evidence, not raw outputs

The compaction model input includes:

- task started prompt + tab context
- assistant final answers
- failed/cancelled status
- safe tool evidence digest

It does not include:

- raw page markdown
- image data URLs
- full network dumps
- reasoning text
- cookies
- prior `context.compacted` as a normal event

### Compaction uses append-only events

Append a new event:

```ts
{
  type: 'context.compacted',
  payload: {
    fromEventId: 1,
    toEventId: 42,
    text: '## Goal...',
    model: 'gpt-4o-mini'
  }
}
```

Do not mutate old compaction events. Latest compaction wins for projection. Raw events remain the archive.

### Incremental summary update

If no previous compaction exists, summarize compacted task groups with `SUMMARIZATION_PROMPT`.

If previous compaction exists, provide latest summary in `<previous-summary>` tags and summarize only new events after the previous `toEventId` with `UPDATE_SUMMARIZATION_PROMPT`.

### Compaction failure is task failure

If compaction is required but fails:

- model call fails
- output is empty
- `context.compacted` write fails
- rebuilt context still cannot fit and no more old task groups are compressible

Then fail the current task. Do not silently drop history or downgrade to a recent-turn window.

### `context.compacted` is hidden in UI for now

Do not show compaction events in the normal timeline. They remain available in `agentEvents` for debugging and future UI.

## Compaction prompts

Use these prompts as the baseline.

### `SUMMARIZATION_PROMPT`

```ts
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
```

### `UPDATE_SUMMARIZATION_PROMPT`

```ts
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
```

## Provider and model configuration

### Model stores context window

Extend `Model`:

```ts
type Model = {
  id: number;
  providerId: number;
  name: string;
  contextWindowTokens: number;
};
```

Runtime budget source is the saved `Model.contextWindowTokens` only.

Priority when creating/editing a model:

```txt
user manual value
> cached models.dev catalog value
> built-in preset value
> default 128000
```

Remote catalog updates must not silently alter existing saved model behavior.

### Onboarding is minimal

First-run setup shows only:

```txt
Provider select
Model select
API key input
Connect button
```

Do not show:

- provider name
- baseURL
- contextWindowTokens
- custom provider
- custom model

Onboarding uses only built-in provider/model presets. It must not call `/models` or `models.dev`.

### Settings is advanced

Settings may show:

- provider name
- baseURL
- API key
- saved models
- `contextWindowTokens`
- custom provider
- custom model
- test connection
- refresh model catalog

### Built-in onboarding presets

Keep the first list small. Suggested initial set:

```txt
OpenAI
- gpt-4o-mini
- gpt-4.1

OpenRouter
- openai/gpt-4o-mini
- anthropic/claude-sonnet-4
- google/gemini-2.5-pro

DeepSeek
- deepseek-v4-pro
- deepseek-chat

Qwen / DashScope
- qwen-plus
- qwen-max
```

Each preset includes:

- provider id
- label
- baseURL
- model name
- contextWindowTokens

### Model catalog refresh

Do not add a library.

Use manual Settings action:

```txt
Refresh model catalog
```

Fetch:

```txt
https://models.dev/api.json
```

Cache result in `settings.modelCatalog`, not a new table.

Shape:

```ts
{
  fetchedAt: number;
  providers: Array<{
    id: string;
    name: string;
    baseURL?: string;
    models: Array<{
      name: string;
      contextWindowTokens: number;
      outputTokens?: number;
    }>;
  }>;
}
```

Rules:

- no automatic refresh
- no startup refresh
- no onboarding refresh
- fetch failure is visible but does not affect existing config
- user manual model context window is never overwritten

## Implementation slices

### 1. Database schema

Files:

- `lib/db.ts`
- `docs/local-database.md`
- database tests

Changes:

- Dexie schema version bump
- remove `messages`
- add `models.contextWindowTokens`
- update session pruning transaction to delete only `toolRuns` and `agentEvents`
- update snapshots and tests

### 2. Provider store

Files:

- `lib/provider-store.ts`
- provider tests

Changes:

- require/default `contextWindowTokens` on `saveModel()`
- support updating model context window
- preserve selected model behavior
- add catalog cache read/write helpers if needed

### 3. Model presets and catalog

Suggested file:

```txt
lib/model-catalog.ts
```

Responsibilities:

- built-in onboarding presets
- default context window
- normalize cached `models.dev` data
- merge built-in + cached catalog for Settings

No production dependency.

### 4. Model context projection

Suggested file:

```txt
lib/model-context.ts
```

Exports may include:

```ts
deriveModelMessages(options)
estimateModelPromptTokens(options)
selectTaskGroupsForCompaction(options)
serializeToolEvidenceForContext(event)
serializeToolEvidenceForCompaction(event)
```

Keep functions pure where possible.

### 5. Compaction

Suggested file:

```txt
lib/context-compaction.ts
```

Responsibilities:

- prepare compaction transcript
- call selected provider/model without tools
- use baseline prompts above
- append `context.compacted`
- return rebuilt model messages

Use current selected model for compaction. Do not introduce a second summarizer model setting.

### 6. Offscreen AgentHost integration

File:

```txt
entrypoints/offscreen/main.ts
```

Changes:

- remove `appendMessage` calls
- create selected provider/model once per task path as needed
- append `task.started` first
- build/compact context
- call:

```ts
agent.generate({ messages, abortSignal })
```

instead of:

```ts
agent.generate({ prompt, abortSignal })
```

### 7. Sidepanel settings/onboarding

Files:

- `entrypoints/sidepanel/ProviderSettings.svelte`
- `entrypoints/sidepanel/SettingsDialog.svelte`
- i18n files

Changes:

- onboarding variant becomes minimal provider/model/key flow
- Settings retains advanced provider editing
- Settings exposes `contextWindowTokens`
- Settings exposes manual catalog refresh

### 8. Tests

Add/update tests for:

- `agentEvents` -> model messages multi-turn projection
- current task excludes its own tool events
- failed/cancelled tasks included correctly
- task-level compaction selection
- latest `context.compacted` projection
- token estimation includes instructions/tool schema estimate
- tool evidence digest strips `dataUrl` and truncates large outputs
- `browserRepl.observe` evidence warns indexes are historical
- DB schema no longer exposes `messages`
- `Model.contextWindowTokens` defaults and persists
- onboarding preset model creation copies context window into saved model
- catalog cache stored in settings and does not overwrite saved model values

## Acceptance criteria

- Follow-up request like `帮我点用 Linux 登录` sees prior Right Code login page context.
- Agent model call uses `messages`, not only current `prompt`.
- No new code writes `messages` table or `appendMessage()`.
- `messages` table is removed from current schema.
- Every task start records current tab context.
- At >90% estimated context, old completed task groups are compacted into `context.compacted`.
- Compaction is append-only and task-level.
- Compaction failure fails the current task, with visible error.
- Tool evidence digest never includes image base64/data URLs.
- Onboarding only requires provider/model/API key.
- Runtime context budget comes from saved `Model.contextWindowTokens`.
- Catalog refresh is manual and cached in `settings.modelCatalog`.

## Verification commands

Run affected tests first, then full unit suite:

```bash
pnpm run test:unit
```

Before merge, run:

```bash
pnpm run test:ci
```
