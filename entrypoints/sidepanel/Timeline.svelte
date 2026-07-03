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
  import ArrowClockwise from 'phosphor-svelte/lib/ArrowClockwise';
  import ArrowLeft from 'phosphor-svelte/lib/ArrowLeft';
  import ArrowRight from 'phosphor-svelte/lib/ArrowRight';
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
  import type { AssistantTimelineTurn, TimelineEntry, ToolTimelineItem } from '$lib/sidepanel-view.ts';
  import { domainFromUrl, formatRawEvidence } from '$lib/sidepanel-view.ts';
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
  const toolOutputLabels = $derived({ error: t.tool.error, result: t.tool.result });

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
    if (tool.toolName === 'navigate') return readString(input?.action) || 'open';
    if (tool.toolName === 'getDocument') return readString(input?.source) || readString(output?.source) || 'currentPage';
    if (tool.toolName === 'extractImage') return readString(input?.source) || readString(output?.source) || 'viewport';
    if (tool.toolName === 'debugger') return 'debugger';
    if (tool.toolName === 'browserRepl') return browserReplAction(readString(input?.code));
    return 'tool';
  }

  function actionLabel(tool: ToolTimelineItem) {
    const key = actionKey(tool);
    return t.tool.actions[key as keyof typeof t.tool.actions] ?? t.tool.actions.tool;
  }

  function toolSummary(tool: ToolTimelineItem) {
    if (tool.status === 'failed') return t.tool.summary.failed(errorSummary(tool));
    const input = readRecord(tool.input);
    const output = readRecord(tool.output);
    if (isRecoverableOutput(output)) return t.tool.summary.failed(errorSummary(tool));
    if (tool.toolName === 'navigate') return t.tool.summary.open(shortTarget(readString(output?.url) || readString(readRecord(output?.tab)?.url) || readString(input?.url)));
    if (tool.toolName === 'getDocument') return t.tool.summary.read(sourceTarget(input, output, 'currentPage'), contentSize(output));
    if (tool.toolName === 'extractImage') return t.tool.summary.image(sourceTarget(input, output, 'viewport'), imageSize(output));
    if (tool.toolName === 'debugger') return t.tool.summary.debug(debugTarget(input), debugResult(output));
    if (tool.toolName === 'browserRepl') return t.tool.summary.inspect(browserReplAction(readString(input?.code)));
    return t.tool.summary.generic(actionLabel(tool));
  }

  function sourceTarget(input: Record<string, unknown> | undefined, output: Record<string, unknown> | undefined, fallbackSource: string) {
    const url = readString(output?.url) || readString(input?.url);
    if (url) return shortTarget(url);
    return sourceLabel(readString(output?.source) || readString(input?.source) || fallbackSource);
  }

  function sourceLabel(source: string) {
    return t.tool.actions[source as keyof typeof t.tool.actions] ?? source;
  }

  function debugTarget(_input: Record<string, unknown> | undefined) {
    return t.tool.actions.debugger;
  }

  function contentSize(output: Record<string, unknown> | undefined) {
    const content = readString(output?.content) || readString(output?.text) || readString(output?.markdown) || readString(output?.article);
    if (!content) return '';
    return t.tool.words(compactNumber(content.length));
  }

  function imageSize(output: Record<string, unknown> | undefined) {
    if (!output) return '';
    const width = typeof output.width === 'number' ? output.width : undefined;
    const height = typeof output.height === 'number' ? output.height : undefined;
    return width && height ? `${width}×${height}` : '';
  }

  function debugResult(output: Record<string, unknown> | undefined) {
    const logs = Array.isArray(output?.logs) ? output.logs.length : 0;
    const requests = Array.isArray(output?.requests) ? output.requests.length : 0;
    const count = logs || requests;
    return count ? t.tool.errorCount(count) : '';
  }

  function shortTarget(url: string | undefined) {
    if (!url) return locale === 'zh' ? '当前页' : 'page';
    return domainFromUrl(url) || truncate(url, 24);
  }

  function compactNumber(value: number) {
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
    return String(value);
  }

  function browserReplAction(code: string | undefined) {
    if (!code) return 'browserRepl';
    if (/\b(click|fill|press|scroll|waitFor)\s*\(/.test(code)) return 'observe';
    return 'browserRepl';
  }

  function errorSummary(tool: ToolTimelineItem) {
    const recoverable = readRecord(tool.output);
    if (isRecoverableOutput(recoverable)) return recoverableErrorSummary(recoverable);

    const error = tool.error ?? '';
    if (/timeout|timed out/i.test(error)) return t.tool.errors.timeout;
    if (/Element not found|Unknown element|selector/i.test(error)) return t.tool.errors.elementNotFound;
    if (/Navigation failed/i.test(error)) return t.tool.errors.navigationFailed;
    if (/no readable text|returned no text/i.test(error)) return t.tool.errors.noReadableText;
    if (/permission|access|denied/i.test(error)) return t.tool.errors.accessLimited;
    if (tool.toolName === 'getDocument') return t.tool.errors.readFailed;
    if (tool.toolName === 'navigate') return t.tool.errors.navigateFailed;
    if (tool.toolName === 'extractImage') return t.tool.errors.imageFailed;
    if (tool.toolName === 'browserRepl') return t.tool.errors.inspectFailed;
    if (tool.toolName === 'debugger') return t.tool.errors.debugFailed;
    return t.tool.errors.genericFailed;
  }

  function recoverableErrorSummary(output: Record<string, unknown>) {
    const code = readString(output.code);
    const message = code ? recoverableErrorLabel(code) || readString(output.message) : readString(output.message);
    return code && message ? `${code}: ${message}` : message || t.tool.errors.genericFailed;
  }

  function recoverableErrorLabel(code: string) {
    if (code === 'NO_SELECTION') return t.tool.errors.noSelection;
    if (code === 'NO_READABLE_CONTENT') return t.tool.errors.noReadableText;
    if (code === 'REMOTE_FETCH_FAILED') return t.tool.errors.remoteFetchFailed;
    if (code === 'ELEMENT_NOT_FOUND') return t.tool.errors.elementNotFound;
    if (code === 'INVALID_SELECTOR') return t.tool.errors.invalidSelector;
    if (code === 'SCREENSHOT_UNAVAILABLE') return t.tool.errors.screenshotUnavailable;
    if (code === 'PAGE_ACCESS_REQUIRED') return t.tool.errors.pageAccessRequired;
    return undefined;
  }

  function rawDetails(tool: ToolTimelineItem) {
    const details: Record<string, unknown> = { input: tool.input };
    if (tool.output !== undefined) details.output = tool.output;
    if (tool.error) details.error = tool.error;
    return formatRawEvidence(details);
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
    if (tool.status === 'running') return 'text-primary fx-breathe';
    if (isRecoverableOutput(readRecord(tool.output))) return 'text-warn';
    return 'text-success';
  }

  function toolState(tool: ToolTimelineItem) {
    if (tool.status === 'failed') return 'output-error';
    if (tool.status === 'running') return 'input-available';
    if (isRecoverableOutput(readRecord(tool.output))) return 'output-warning';
    return 'output-available';
  }

  function truncate(value: string, max: number) {
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
              <MessageContent class="text-foreground">
                <div class="space-y-3.5 py-0.5">
                  {#each entry.turn.parts as part (part.id)}
                    {#if part.kind === 'tool'}
                      {@const tool = part.tool}
                      {@const ActionIcon = actionIcon(tool)}
                      <Tool.Root class="rounded-2xl border-0 bg-surface/95 shadow-[0_8px_24px_oklch(0_0_0_/_0.03)] ring-1 ring-line/70">
                        <Tool.Header type={toolSummary(tool)} state={toolState(tool)} labels={toolLabels} icon={ActionIcon} iconClass={statusClass(tool)} class="px-3 py-2.5" />
                        <Tool.Content class="rounded-b-2xl border-t border-line/50 bg-surface/70">
                          <Tool.Input input={tool.inputSummary} label={t.tool.input} />
                          <Tool.Output output={tool.outputSummary} errorText={tool.error} labels={toolOutputLabels} />
                          <details class="px-4 pb-4 group/details">
                            <summary class="text-muted-foreground hover:text-foreground inline-flex list-none items-center gap-1 rounded-md px-1 py-0.5 text-[11.5px] transition-colors duration-150 ease-[var(--ease-out)] marker:hidden">
                              <CaretDown class="size-3 transition-transform group-open/details:rotate-180" />
                              {t.tool.technicalDetails}
                            </summary>
                            <pre class="bg-surface text-foreground/90 ring-line/60 mt-2 max-h-72 overflow-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed ring-1">{rawDetails(tool)}</pre>
                          </details>
                        </Tool.Content>
                      </Tool.Root>
                    {:else}
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
