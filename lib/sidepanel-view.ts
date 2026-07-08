import {
  domainFromUrl,
  formatPayload,
  formatRawEvidence,
  hideReasoningText,
  projectAgentEvents,
  sourceFromBrowserContext,
  type AgentEventProjection,
  type ProjectedAssistantTimelineTurn,
  type ProjectedConversationMessage,
  type ProjectedReasoningRun,
  type ProjectedSource,
  type ProjectedTimelineEntry,
  type ProjectedToolRun,
} from './agent-event-projection.ts';
import type { AgentEvent } from './db.ts';

export { domainFromUrl, formatPayload, formatRawEvidence, hideReasoningText };

export type SidebarTaskStatus = 'idle' | 'running' | 'failed' | 'cancelled';
export type SidebarTaskDetailKey = 'ready' | 'running' | 'failed' | 'cancelled' | 'completed';

export type SidebarTaskView = {
  status: SidebarTaskStatus;
  label: string;
  detail: string;
  detailKey: SidebarTaskDetailKey;
  context?: Record<string, unknown>;
};

export type ConversationMessage = ProjectedConversationMessage;

export type ToolTimelineItem = ProjectedToolRun & {
  inputSummary: string;
  outputSummary?: string;
};

export type SourceLink = { label: string; url: string; domain: string; faviconUrl?: string; tabId?: number; windowId?: number };
export type ImagePreview = { src: string; label: string; alt: string };
export type QuickActionMode = 'summarize' | 'research' | 'skills' | 'compare';
export type IntentQuickActionMode = Extract<QuickActionMode, 'research' | 'compare'>;
export type SettingsTab = 'preferences' | 'providers';
export type ProviderSetupAdvanceInput = {
  settingsOpen: boolean;
  promptedForBrowserControl: boolean;
  missingBrowserControl: boolean;
  hasAnyModel: boolean;
  promptedForMissingModel: boolean;
};
export type QuickActionTab = { title: string; url: string };
export type QuickActionPromptSet = {
  researchPage: string;
  researchTopic: (topic: string) => string;
  researchTabs: (tabs: string) => string;
  researchTabsTopic: (topic: string, tabs: string) => string;
  comparePage: string;
  compareTopic: (topic: string) => string;
  compareTabs: (tabs: string) => string;
  compareTabsTopic: (topic: string, tabs: string) => string;
};

export type ReasoningTimelineItem = ProjectedReasoningRun;

export type AssistantTimelinePart =
  | { kind: 'tool'; id: string; createdAt: number; tool: ToolTimelineItem }
  | { kind: 'reasoning'; id: string; createdAt: number; reasoning: ReasoningTimelineItem }
  | { kind: 'text'; id: string; createdAt: number; message: ConversationMessage };

export type AssistantTimelineTurn = Omit<ProjectedAssistantTimelineTurn, 'parts'> & {
  parts: AssistantTimelinePart[];
};

export type TimelineEntry =
  | { kind: 'message'; id: string; createdAt: number; message: ConversationMessage }
  | { kind: 'assistantTurn'; id: string; createdAt: number; turn: AssistantTimelineTurn };

const shopPattern = /(?:shop|store|product|item|sku|cart|checkout|price|taobao|tmall|jd|amazon|ebay|etsy|1688|aliexpress|walmart)/i;
const researchPattern = /(?:search|wiki|paper|scholar|arxiv|research|论文|百科|搜索|调研)/i;
const articlePattern = /(?:blog|article|docs?|guide|post|news|medium|substack|文档|文章|博客|新闻)/i;

export function sidebarTaskViewFromProjection(projection: AgentEventProjection): SidebarTaskView {
  const task = projection.currentTask;
  if (!task) return { status: 'idle', label: 'Idle', detail: 'Ready for a supervised browser task.', detailKey: 'ready' };
  if (task.status === 'running') return { status: 'running', label: 'Running', detail: 'Working. Stop interrupts the active task.', detailKey: 'running', context: task.context };
  if (task.status === 'failed') return { status: 'failed', label: 'Failed', detail: task.error || 'Task failed.', detailKey: 'failed', context: task.context };
  if (task.status === 'cancelled') return { status: 'cancelled', label: 'Cancelled', detail: 'Stopped by the user.', detailKey: 'cancelled', context: task.context };
  return { status: 'idle', label: 'Idle', detail: 'Last task completed.', detailKey: 'completed', context: task.context };
}

export function deriveSidebarTaskView(events: AgentEvent[]): SidebarTaskView {
  return sidebarTaskViewFromProjection(projectAgentEvents(events));
}

export function conversationFromProjection(projection: AgentEventProjection): ConversationMessage[] {
  return projection.conversation;
}

export function deriveConversation(events: AgentEvent[]): ConversationMessage[] {
  return conversationFromProjection(projectAgentEvents(events));
}

export function toolTimelineFromProjection(projection: AgentEventProjection): ToolTimelineItem[] {
  return projection.tools.map(toolTimelineItemFromProjection);
}

export function deriveToolTimeline(events: AgentEvent[]): ToolTimelineItem[] {
  return toolTimelineFromProjection(projectAgentEvents(events));
}

export function timelineFromProjection(projection: AgentEventProjection): TimelineEntry[] {
  const toolsById = new Map(toolTimelineFromProjection(projection).map((tool) => [tool.id, tool]));
  return projection.timeline.map((entry) => timelineEntryFromProjection(entry, toolsById));
}

export function deriveTimeline(events: AgentEvent[]): TimelineEntry[] {
  return timelineFromProjection(projectAgentEvents(events));
}

export function sourcesFromProjection(
  projection: AgentEventProjection,
  labels = { currentTab: 'Current tab', tool: 'Tool' },
  context?: Record<string, unknown>,
): SourceLink[] {
  return mergedSources(projection, context).map((source) => sourceLinkFromProjection(source, labels));
}

export function controlledTargetFromContext(context: Record<string, unknown> | undefined, labels: { currentTab: string; tool: string; controlledPage?: string } = { currentTab: 'Controlled page', tool: 'Tool' }): SourceLink | undefined {
  const source = sourceFromBrowserContext(context);
  return source ? sourceLinkFromProjection(source, { currentTab: labels.controlledPage ?? labels.currentTab, tool: labels.tool }) : undefined;
}

export function deriveSources(
  context: Record<string, unknown> | undefined,
  events: AgentEvent[],
  labels = { currentTab: 'Current tab', tool: 'Tool' },
): SourceLink[] {
  return sourcesFromProjection(projectAgentEvents(events), labels, context);
}

export function imagePreviewFromProjection(projection: AgentEventProjection, labels = { image: 'image', imageAlt: 'Extracted browser image' }): ImagePreview | undefined {
  const image = projection.image;
  if (!image) return undefined;
  const size = Number.isFinite(image.width) && Number.isFinite(image.height) ? `${image.width}×${image.height}` : '';
  return { src: image.src, label: [image.source || labels.image, size].filter(Boolean).join(' · '), alt: image.alt || labels.imageAlt };
}

export function latestImagePreview(events: AgentEvent[], labels = { image: 'image', imageAlt: 'Extracted browser image' }): ImagePreview | undefined {
  return imagePreviewFromProjection(projectAgentEvents(events), labels);
}

export function settingsTabStartsBrowserControlGuide(tab: SettingsTab, missingBrowserControl: boolean): boolean {
  return tab === 'preferences' && missingBrowserControl;
}

export function shouldAdvanceToProviderSetup(input: ProviderSetupAdvanceInput): boolean {
  return input.settingsOpen && input.promptedForBrowserControl && !input.missingBrowserControl && !input.hasAnyModel && !input.promptedForMissingModel;
}

export function orderQuickActions(context: Record<string, unknown> | undefined): QuickActionMode[] {
  const text = `${readString(context?.title) ?? ''} ${readString(context?.url) ?? ''}`;
  if (shopPattern.test(text)) return ['compare', 'summarize', 'skills', 'research'];
  if (researchPattern.test(text)) return ['research', 'summarize', 'skills', 'compare'];
  if (articlePattern.test(text)) return ['summarize', 'skills', 'research', 'compare'];
  return ['summarize', 'skills', 'research', 'compare'];
}

export function createIntentPrompt(mode: IntentQuickActionMode, topic: string, tabs: QuickActionTab[], prompts: QuickActionPromptSet): string {
  const normalizedTopic = topic.trim();
  const tabList = formatQuickActionTabs(tabs);
  if (mode === 'research') {
    if (normalizedTopic && tabList) return prompts.researchTabsTopic(normalizedTopic, tabList);
    if (tabList) return prompts.researchTabs(tabList);
    if (normalizedTopic) return prompts.researchTopic(normalizedTopic);
    return prompts.researchPage;
  }
  if (normalizedTopic && tabList) return prompts.compareTabsTopic(normalizedTopic, tabList);
  if (tabList) return prompts.compareTabs(tabList);
  if (normalizedTopic) return prompts.compareTopic(normalizedTopic);
  return prompts.comparePage;
}

export function formatQuickActionTabs(tabs: QuickActionTab[]): string {
  return tabs.map((tab) => `- ${tab.title.trim() || domainFromUrl(tab.url) || tab.url} — ${tab.url}`).join('\n');
}

function toolTimelineItemFromProjection(tool: ProjectedToolRun): ToolTimelineItem {
  return {
    ...tool,
    inputSummary: formatPayload(tool.input),
    outputSummary: tool.status === 'completed' ? formatPayload(tool.output) : undefined,
  };
}

function timelineEntryFromProjection(entry: ProjectedTimelineEntry, toolsById: Map<string, ToolTimelineItem>): TimelineEntry {
  if (entry.kind === 'message') return entry;
  return {
    kind: 'assistantTurn',
    id: entry.id,
    createdAt: entry.createdAt,
    turn: {
      ...entry.turn,
      parts: entry.turn.parts.map((part): AssistantTimelinePart => {
        if (part.kind === 'text' || part.kind === 'reasoning') return part;
        return { kind: 'tool', id: part.id, createdAt: part.createdAt, tool: toolsById.get(part.tool.id) ?? toolTimelineItemFromProjection(part.tool) };
      }),
    },
  };
}

function sourceLinkFromProjection(source: ProjectedSource, labels: { currentTab: string; tool: string }): SourceLink {
  return { label: source.label || source.fallbackText || labels[source.fallbackLabel], url: source.url, domain: source.domain, faviconUrl: source.faviconUrl, tabId: source.tabId, windowId: source.windowId };
}

function mergedSources(projection: AgentEventProjection, context: Record<string, unknown> | undefined): ProjectedSource[] {
  const sources = new Map<string, ProjectedSource>();
  const contextSource = sourceFromBrowserContext(context);
  if (contextSource) sources.set(contextSource.url, contextSource);
  for (const source of projection.sources) if (!sources.has(source.url)) sources.set(source.url, source);
  return [...sources.values()].slice(0, 5);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
