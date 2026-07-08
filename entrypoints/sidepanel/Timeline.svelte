<script lang="ts">
  import {
    Conversation,
    ConversationContent,
    ConversationEmptyState,
    ConversationScrollButton,
  } from '$lib/components/ai-elements/conversation/index.js';
  import { Message, MessageContent } from '$lib/components/ai-elements/message/index.js';
  import { Response } from '$lib/components/ai-elements/response/index.js';
  import * as Tool from '$lib/components/ai-elements/tool/index.js';
  import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '$lib/components/ui/collapsible/index.js';
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import ArrowLeft from 'phosphor-svelte/lib/ArrowLeft';
  import ArrowRight from 'phosphor-svelte/lib/ArrowRight';
  import Brain from 'phosphor-svelte/lib/Brain';
  import Bug from 'phosphor-svelte/lib/Bug';
  import CaretDown from 'phosphor-svelte/lib/CaretDown';
  import Check from 'phosphor-svelte/lib/Check';
  import Clipboard from 'phosphor-svelte/lib/Clipboard';
  import CursorClick from 'phosphor-svelte/lib/CursorClick';
  import FileText from 'phosphor-svelte/lib/FileText';
  import Image from 'phosphor-svelte/lib/Image';
  import List from 'phosphor-svelte/lib/List';
  import NavigationArrow from 'phosphor-svelte/lib/NavigationArrow';
  import SidebarSimple from 'phosphor-svelte/lib/SidebarSimple';
  import TerminalWindow from 'phosphor-svelte/lib/TerminalWindow';
  import X from 'phosphor-svelte/lib/X';
  import { rawToolDetails, toolHeaderSummary } from '$lib/sidepanel-tool-presentation.ts';
  import type { AssistantTimelineTurn, TimelineEntry, ToolTimelineItem } from '$lib/sidepanel-view.ts';
  import { formatTime, messages, type Locale } from '$lib/sidepanel-i18n.ts';

  interface Props {
    locale: Locale;
    entries: TimelineEntry[];
  }

  type RecoverableOutput = Record<string, unknown> & { ok: false };

  let { locale, entries }: Props = $props();
  let t = $derived(messages[locale]);
  let copiedMessageId = $state<string | null>(null);
  const toolLabels = $derived({ pending: t.tool.pending, running: t.tool.running, completed: t.tool.completed, error: t.tool.error, warning: t.tool.warning });

  async function copyMessage(id: string, text: string) {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    copiedMessageId = id;
    window.setTimeout(() => {
      if (copiedMessageId === id) copiedMessageId = null;
    }, 1200);
  }

  function assistantTurnText(turn: AssistantTimelineTurn) {
    return turn.parts.filter((part) => part.kind === 'text').map((part) => part.message.text).join('\n\n').trim();
  }

  function actionKey(tool: ToolTimelineItem) {
    const input = readRecord(tool.input);
    const output = readRecord(tool.output);
    if (tool.toolName === 'navigate') return readString(input?.action) || readString(output?.action) || 'open';
    if (tool.toolName === 'getDocument') return readString(input?.source) || readString(output?.source) || 'currentPage';
    if (tool.toolName === 'extractImage') return readString(input?.source) || readString(output?.source) || 'viewport';
    if (tool.toolName === 'browser') return readString(input?.action) || readString(output?.action) || 'browser';
    if (tool.toolName === 'debugger') return 'debugger';
    if (tool.toolName === 'browserRepl') return 'browserRepl';
    return 'tool';
  }

  function actionIcon(tool: ToolTimelineItem) {
    const key = actionKey(tool);
    if (key === 'back') return ArrowLeft;
    if (key === 'forward') return ArrowRight;
    if (key === 'reload') return ArrowClockwise;
    if (key === 'listTabs') return List;
    if (key === 'switchTab' || key === 'currentTab') return SidebarSimple;
    if (key === 'closeTab') return X;
    if (tool.toolName === 'navigate') return NavigationArrow;
    if (tool.toolName === 'getDocument') return FileText;
    if (tool.toolName === 'extractImage') return Image;
    if (tool.toolName === 'browserRepl') return CursorClick;
    if (tool.toolName === 'debugger') return Bug;
    return TerminalWindow;
  }

  function statusClass(tool: ToolTimelineItem) {
    if (tool.status === 'failed') return 'text-danger';
    if (tool.status === 'pending' || tool.status === 'running') return 'text-primary fx-breathe';
    if (isRecoverableOutput(readRecord(tool.output))) return 'text-warn';
    return 'text-success';
  }

  function toolState(tool: ToolTimelineItem) {
    if (tool.status === 'failed') return 'output-error';
    if (tool.status === 'pending') return 'input-streaming';
    if (tool.status === 'running') return 'input-available';
    if (isRecoverableOutput(readRecord(tool.output))) return 'output-warning';
    return 'output-available';
  }

  function reasoningDetail(text: string) {
    return text.trim() || t.reasoning.empty;
  }

  function readRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  function readString(value: unknown) {
    return typeof value === 'string' ? value : undefined;
  }

  function isRecoverableOutput(output: Record<string, unknown> | undefined): output is RecoverableOutput {
    return output?.ok === false;
  }
</script>

<Conversation class="bg-bg h-full">
  <ConversationContent class="gap-4 px-4 pb-4 pt-2">
    {#if entries.length === 0}
      <ConversationEmptyState class="relative overflow-hidden text-muted-foreground">
        <div aria-hidden="true" class="taber-logo-image taber-logo-watermark pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"></div>
      </ConversationEmptyState>
    {:else}
      {#each entries as entry, index (entry.id)}
        <div class="fx-enter" style="--fx-index: {Math.min(index, 6)}">
          {#if entry.kind === 'message'}
            <Message from={entry.message.role === 'user' ? 'user' : 'assistant'} class="group/message max-w-full gap-0">
              <MessageContent class={entry.message.role === 'user'
                ? 'bg-surface text-foreground ring-line/70 rounded-2xl rounded-tr-md px-3.5 py-3 shadow-[0_8px_24px_oklch(0_0_0_/_0.035)] ring-1'
                : 'text-foreground'}>
                {#if entry.message.role === 'assistant'}
                  <Response content={entry.message.text} />
                {:else}
                  <div class="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{entry.message.text}</div>
                {/if}
              </MessageContent>
              {#if entry.message.role === 'assistant'}
                <div class="mt-1 flex h-7 items-center gap-2 pl-1 text-[10.5px] text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100 tabular">
                  <button
                    type="button"
                    class="hover:bg-surface hover:text-foreground inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
                    aria-label={t.tool.copy}
                    onclick={() => void copyMessage(entry.id, entry.message.text)}
                  >
                    {#if copiedMessageId === entry.id}<Check class="size-3" weight="bold" />{t.tool.copied}{:else}<Clipboard class="size-3" />{t.tool.copy}{/if}
                  </button>
                  <span aria-hidden="true">·</span>
                  <span>{formatTime(locale, entry.message.createdAt)}</span>
                </div>
              {/if}
            </Message>
          {:else}
            {@const copyText = assistantTurnText(entry.turn)}
            <Message from="assistant" class="group/message max-w-full gap-0">
              <MessageContent class="w-full text-foreground">
                <div class="w-full space-y-3.5 py-0.5">
                  {#each entry.turn.parts as part (part.id)}
                    {#if part.kind === 'tool'}
                      {@const tool = part.tool}
                      {@const ActionIcon = actionIcon(tool)}
                      <Tool.Root class="rounded-xl border-0 bg-surface/75 shadow-none ring-1 ring-line/55">
                        <Tool.Header type={toolHeaderSummary(tool, t, locale)} state={toolState(tool)} labels={toolLabels} icon={ActionIcon} iconClass={statusClass(tool)} class="px-2.5 py-1.5" />
                        <Tool.Content class="rounded-b-xl border-t border-line/40 bg-surface/40">
                          <div class="space-y-2 px-3 pb-3 pt-2">
                            <h4 class="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.04em]">{t.tool.details}</h4>
                            <pre class="bg-muted/40 text-foreground/85 max-h-56 overflow-auto rounded-lg p-2 font-mono text-[10.5px] leading-relaxed ring-1 ring-line/35">{rawToolDetails(tool)}</pre>
                          </div>
                        </Tool.Content>
                      </Tool.Root>
                    {:else if part.kind === 'reasoning'}
                      <Collapsible class="not-prose w-full rounded-xl bg-surface/70 shadow-none ring-1 ring-line/55">
                        <CollapsibleTrigger class="group flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left">
                          <span class="flex min-w-0 items-center gap-2">
                            <span class="bg-primary/10 text-primary flex size-6 shrink-0 items-center justify-center rounded-lg ring-1 ring-primary/15 {part.reasoning.status === 'running' ? 'fx-breathe' : ''}"><Brain class="size-3" /></span>
                            <span class="min-w-0 truncate text-[12px] font-medium leading-5">{t.reasoning.summary}</span>
                          </span>
                          <CaretDown class="text-muted-foreground size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                        </CollapsibleTrigger>
                        <CollapsibleContent class="fx-tool-content rounded-b-xl border-t border-line/40 bg-surface/40 text-muted-foreground">
                          <div class="px-3 pb-3 pt-2">
                            <Response content={reasoningDetail(part.reasoning.text)} class="text-[11.5px] leading-[1.65]" />
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    {:else if part.kind === 'text'}
                      <Response content={part.message.text} />
                    {/if}
                  {/each}
                </div>
              </MessageContent>
              {#if entry.turn.status !== 'running'}
                <div class="mt-1 flex h-7 items-center gap-2 pl-1 text-[10.5px] text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-within:opacity-100 tabular">
                  {#if copyText}
                    <button
                      type="button"
                      class="hover:bg-surface hover:text-foreground inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
                      aria-label={t.tool.copy}
                      onclick={() => void copyMessage(entry.id, copyText)}
                    >
                      {#if copiedMessageId === entry.id}<Check class="size-3" weight="bold" />{t.tool.copied}{:else}<Clipboard class="size-3" />{t.tool.copy}{/if}
                    </button>
                    <span aria-hidden="true">·</span>
                  {/if}
                  <span>{formatTime(locale, entry.turn.updatedAt)}</span>
                </div>
              {/if}
            </Message>
          {/if}
        </div>
      {/each}
    {/if}
  </ConversationContent>
  <ConversationScrollButton />
</Conversation>
