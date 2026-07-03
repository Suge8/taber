import { generateText, type LanguageModel } from 'ai';
import type { AgentEvent } from './db.ts';
import { compactableTaskGroups, deriveModelMessages, estimateModelPromptTokens, latestCompactionSummary, serializeTaskGroupsForCompaction } from './model-context.ts';

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

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

export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

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

const CONTEXT_TOO_LARGE_ERROR = 'Context is too large for the selected model. Choose a larger context model or start a new session.';

export type ContextBudget = {
  contextWindowTokens: number;
  instructions: string;
  toolPromptText: string;
};

export function contextLimit(contextWindowTokens: number) {
  return Math.floor(contextWindowTokens * 0.9);
}

export function needsCompaction(events: AgentEvent[], currentTaskId: string, budget: ContextBudget) {
  const messages = deriveModelMessages(events, currentTaskId);
  return estimateModelPromptTokens({ instructions: budget.instructions, toolPromptText: budget.toolPromptText, messages }) > contextLimit(budget.contextWindowTokens);
}

export async function compactContext(options: {
  events: AgentEvent[];
  currentTaskId: string;
  model: LanguageModel;
  modelName: string;
  budget: ContextBudget;
  appendCompaction: (payload: { fromEventId: number; toEventId: number; text: string; model: string }) => Promise<void>;
}) {
  if (!needsCompaction(options.events, options.currentTaskId, options.budget)) return false;

  const groups = compactableTaskGroups(options.events, options.currentTaskId);
  if (groups.length === 0) throw new Error(CONTEXT_TOO_LARGE_ERROR);

  const previous = latestCompactionSummary(options.events);
  const transcript = serializeTaskGroupsForCompaction(groups);
  const result = await generateText({
    model: options.model,
    system: previous ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT,
    messages: [{ role: 'user', content: previous ? `<previous-summary>\n${previous.text}\n</previous-summary>\n\n${transcript}` : transcript }],
  });
  const text = result.text.trim();
  if (!text) throw new Error('Compaction returned an empty summary');

  await options.appendCompaction({
    fromEventId: previous?.fromEventId ?? groups[0].started.id,
    toEventId: Math.max(...groups.flatMap((group) => group.events.map((event) => event.id))),
    text,
    model: options.modelName,
  });
  return true;
}
