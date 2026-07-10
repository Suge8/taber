<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { slide } from 'svelte/transition';
  import {
    PromptInput,
    PromptInputBody,
    PromptInputTextarea,
    PromptInputToolbar,
    PromptInputTools,
    PromptInputSubmit,
    type PromptInputMessage,
    type ChatStatus,
  } from '$lib/components/ai-elements/prompt-input/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import { createIntentPrompt, quickActionOrder, type IntentQuickActionMode, type QuickActionMode } from '$lib/sidepanel-view.ts';
  import { deleteSkill, listSkills, setSkillEnabled } from '$lib/skills.ts';
  import { builtinSkillDisplay } from '$lib/skills-seeds.ts';
  import type { Skill } from '$lib/db.ts';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import CodeXml from '@lucide/svelte/icons/code-xml';
  import MessageCircleMore from '@lucide/svelte/icons/message-circle-more';
  import MonitorPlay from '@lucide/svelte/icons/monitor-play';
  import Plane from '@lucide/svelte/icons/plane';
  import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
  import Ticket from '@lucide/svelte/icons/ticket';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { reasoningEffortOptionsForModel, type ProviderWithModels, type ReasoningEffort } from '$lib/provider-store.ts';
  import type { Notify } from './toast.ts';
  import Bot from '@lucide/svelte/icons/bot';
  import BrainCircuit from '@lucide/svelte/icons/brain-circuit';
  import Check from '@lucide/svelte/icons/check';
  import CaretDown from '@lucide/svelte/icons/chevron-down';
  import GlobeSimple from '@lucide/svelte/icons/globe';
  import MousePointerClick from '@lucide/svelte/icons/mouse-pointer-click';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Rocket from '@lucide/svelte/icons/rocket';
  import Scale from '@lucide/svelte/icons/scale';
  import Search from '@lucide/svelte/icons/search';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Square from '@lucide/svelte/icons/square';
  import Summary from '@lucide/svelte/icons/summary';
  import X from '@lucide/svelte/icons/x';

  export type WindowTab = { id: number; title: string; url: string; favIconUrl?: string; active?: boolean };


  interface Props {
    locale: Locale;
    disabled?: boolean;
    running: boolean;
    showQuickActions: boolean;
    providers: ProviderWithModels[];
    selectedModelId: number | null;
    selectedModelLabel: string;
    missingModel: boolean;
    reasoningEffort: ReasoningEffort;
    onSelectModel: (id: number) => void | Promise<void>;
    onSelectReasoningEffort: (value: ReasoningEffort) => void | Promise<void>;
    onMissingModel: () => void;
    onSubmit: (text: string) => void | Promise<void>;
    onStop: () => void | Promise<void>;
    onAttachFile?: (file: File) => Promise<string | undefined>;
    listWindowTabs: () => Promise<WindowTab[]>;
    notify?: Notify;
  }

  let {
    locale,
    disabled = false,
    running,
    showQuickActions,
    providers,
    selectedModelId,
    selectedModelLabel,
    missingModel,
    reasoningEffort,
    onSelectModel,
    onSelectReasoningEffort,
    onMissingModel,
    onSubmit,
    onStop,
    onAttachFile,
    listWindowTabs,
    notify,
  }: Props = $props();

  let t = $derived(messages[locale].composer);
  let q = $derived(messages[locale].quick);
  let p = $derived(messages[locale].prompts);
  let providerText = $derived(messages[locale].provider);
  let status = $derived<ChatStatus>(running ? 'streaming' : 'ready');
  let draft = $state('');
  let activeIntent = $state<IntentQuickActionMode | null>(null);
  let tabs = $state<WindowTab[]>([]);
  let selectedTabIds = $state<Set<number>>(new Set());
  let loadingTabs = $state(false);
  let tabsVisible = $state(false);
  let modelPickerOpen = $state(false);
  let reasoningPickerOpen = $state(false);
  let skillsOpen = $state(false);
  let skillList = $state<Skill[]>([]);
  let attachedNames = $state<string[]>([]);
  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  let tabsLoadToken = 0;

  const icons = { summarize: Summary, research: Search, skills: BookOpen, compare: Scale } as const;

  const microSlide = { duration: 160, easing: cubicOut };
  const baseSlide = { duration: 180, easing: cubicOut };

  const suggestions = $derived(quickActionOrder.map((mode) => ({ mode, icon: icons[mode] })));
  const selectedTabs = $derived.by(() => tabs.filter((tab) => selectedTabIds.has(tab.id)));
  const orderedTabs = $derived([...tabs].sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active))));
  const tabsMenuClass = $derived(!loadingTabs && tabs.length === 0 ? 'min-w-32 rounded-2xl p-1.5' : 'w-[min(18rem,calc(100vw-2rem))] rounded-2xl p-2');
  const submitDisabled = $derived(disabled || (!activeIntent && draft.trim().length === 0));
  const selectedModel = $derived(providers.flatMap((provider) => provider.models).find((model) => model.id === selectedModelId));
  const reasoningOptions: { value: ReasoningEffort; label: string }[] = $derived(
    reasoningEffortOptionsForModel(selectedModel).map((value) => ({ value, label: reasoningOptionLabel(value) })),
  );

  $effect(() => {
    if (activeIntent && tabsVisible) void refreshTabs();
  });

  function suggestionLabel(mode: QuickActionMode) {
    if (mode === 'summarize') return q.summarize;
    if (mode === 'skills') return q.skills;
    if (mode === 'compare') return q.compare;
    return q.research;
  }

  async function runQuickAction(mode: QuickActionMode) {
    if (mode === 'summarize') {
      cancelIntent();
      await submitPrompt(p.summarize);
      return;
    }
    if (mode === 'skills') {
      skillsOpen = true;
      skillList = await listSkills();
      return;
    }
    await openIntent(mode);
  }

  async function toggleSkill(skill: Skill) {
    await setSkillEnabled(skill.id, !skill.enabled);
    skillList = await listSkills();
  }

  async function removeSkill(skill: Skill) {
    await deleteSkill(skill.id);
    skillList = await listSkills();
  }

  // Skills panel grouping: what Taber learned on its own ("custom") leads and
  // stays visible even when empty so users discover that Taber accumulates site
  // experience; builtin categories follow in a fixed order.
  const SKILL_GROUP_ORDER = ['custom', 'ticketing', 'shopping', 'social', 'video', 'travel', 'developer', 'reference'] as const;
  type SkillGroupKey = (typeof SKILL_GROUP_ORDER)[number];
  type SkillGroup = { key: SkillGroupKey; skills: Skill[]; enabledCount: number };
  const skillGroupIcons = { custom: Sparkles, ticketing: Ticket, shopping: ShoppingCart, social: MessageCircleMore, video: MonitorPlay, travel: Plane, developer: CodeXml, reference: BookOpen } as const;

  let skillGroups = $derived(groupSkills(skillList));
  let openSkillGroups = $state<Record<string, boolean>>({});

  function toggleSkillGroupOpen(key: SkillGroupKey) {
    openSkillGroups = { ...openSkillGroups, [key]: !openSkillGroups[key] };
  }

  function groupSkills(skills: Skill[]): SkillGroup[] {
    const byKey = new Map<SkillGroupKey, Skill[]>();
    for (const skill of skills) {
      const key: SkillGroupKey = skill.category ?? 'custom';
      byKey.set(key, [...(byKey.get(key) ?? []), skill]);
    }
    return SKILL_GROUP_ORDER
      .filter((key) => key === 'custom' || (byKey.get(key)?.length ?? 0) > 0)
      .map((key) => {
        const groupSkills = byKey.get(key) ?? [];
        return { key, skills: groupSkills, enabledCount: groupSkills.filter((skill) => skill.enabled).length };
      });
  }

  async function toggleSkillGroup(group: SkillGroup) {
    // Any disabled member ⇒ enable all; fully enabled ⇒ disable all.
    const enable = group.enabledCount < group.skills.length;
    await Promise.all(group.skills.filter((skill) => skill.enabled !== enable).map((skill) => setSkillEnabled(skill.id, enable)));
    skillList = await listSkills();
  }

  function skillDisplayName(skill: Skill) {
    if (locale === 'zh' && skill.source === 'builtin') return builtinSkillDisplay(skill.name)?.nameZh ?? skill.name;
    return skill.name;
  }

  function skillDisplayDescription(skill: Skill) {
    if (locale === 'zh' && skill.source === 'builtin') return builtinSkillDisplay(skill.name)?.descriptionZh ?? skill.description;
    return skill.description;
  }

  async function openIntent(mode: IntentQuickActionMode) {
    activeIntent = activeIntent === mode ? null : mode;
    tabsVisible = false;
    selectedTabIds = new Set();
    if (activeIntent) await refreshTabs();
  }

  async function refreshTabs() {
    const token = ++tabsLoadToken;
    loadingTabs = true;
    try {
      const nextTabs = await listWindowTabs();
      if (token !== tabsLoadToken) return;
      tabs = nextTabs;
    } catch (error) {
      if (token !== tabsLoadToken) return;
      tabs = [];
      notify?.({ tone: 'error', icon: 'browser', text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (token === tabsLoadToken) loadingTabs = false;
    }
  }

  function cancelIntent() {
    activeIntent = null;
    tabsVisible = false;
    selectedTabIds = new Set();
  }

  async function sendIntent(text: string) {
    if (!activeIntent) return;
    const sent = await submitPrompt(createIntentPrompt(activeIntent, text, selectedTabs, p));
    if (!sent) return;
    cancelIntent();
  }

  async function handleFilesPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    for (const file of input.files ?? []) {
      const name = await onAttachFile?.(file);
      if (name && !attachedNames.includes(name)) attachedNames = [...attachedNames, name];
    }
    input.value = '';
  }

  async function submitPrompt(text: string) {
    if (missingModel) {
      onMissingModel();
      return false;
    }
    const prompt = attachedNames.length > 0
      ? `${text}\n\n[Attached files in /workspace: ${attachedNames.join(', ')}]`
      : text;
    await onSubmit(prompt);
    draft = '';
    attachedNames = [];
    return true;
  }

  async function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if (activeIntent) {
      await sendIntent(text);
      return;
    }
    if (!text) return;
    await submitPrompt(text);
  }

  function toggleTab(id: number) {
    const next = new Set(selectedTabIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedTabIds = next;
  }

  function tabHost(url: string) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function reasoningOptionLabel(value: ReasoningEffort) {
    if (value === 'none') return t.reasoningNone;
    if (value === 'minimal') return t.reasoningMinimal;
    if (value === 'low') return t.reasoningLow;
    if (value === 'medium') return t.reasoningMedium;
    if (value === 'high') return t.reasoningHigh;
    if (value === 'xhigh') return t.reasoningXHigh;
    return t.reasoningDefault;
  }

  function reasoningLabel(value: ReasoningEffort) {
    if (missingModel) return t.reasoningNone;
    return reasoningOptions.find((item) => item.value === value)?.label ?? t.reasoningDefault;
  }

  function providerLabel(provider: ProviderWithModels) {
    if (provider.kind === 'openaiCodex') return providerText.codexProviderName;
    if (provider.kind === 'xaiSub') return providerText.xaiProviderName;
    return provider.name;
  }

  function quickActionGridClass() {
    return locale === 'en' ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-4 gap-2';
  }

  function quickActionClass(mode: QuickActionMode, selected: boolean) {
    const base = 'inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-2xl px-3 text-[13px] font-medium ring-1 transition-[background-color,color,box-shadow,opacity,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]';
    if (activeIntent && !selected) return `${base} pointer-events-none invisible scale-[0.98] bg-surface text-muted-foreground opacity-0 ring-line/60`;
    if (selected) return `${base} ${activeIntent ? '' : 'fx-enter'} bg-primary text-primary-foreground ring-primary/20 shadow-[0_6px_18px_oklch(0_0_0_/_0.06)]`;
    if (mode === 'summarize') return `${base} fx-enter quick-action-summarize`;
    if (mode === 'skills') return `${base} fx-enter quick-action-skills`;
    return `${base} fx-enter bg-surface ring-line/60 text-muted-foreground shadow-[0_4px_14px_oklch(0_0_0_/_0.018)] hover:bg-surface-2 hover:text-foreground hover:ring-line`;
  }

</script>

{#if !running && showQuickActions}
  <div class="{activeIntent ? 'mb-0' : 'mb-2'} -mx-1 space-y-2 overflow-hidden px-1 py-1" transition:slide={microSlide}>
    <div class={quickActionGridClass()}>
      {#each suggestions as item, index (item.mode)}
        {@const selected = activeIntent === item.mode}
        <button
          type="button"
          class={quickActionClass(item.mode, selected)}
          style="--fx-index: {index}"
          title={suggestionLabel(item.mode)}
          aria-pressed={selected}
          disabled={Boolean(activeIntent && !selected)}
          aria-hidden={Boolean(activeIntent && !selected)}
          onclick={() => void runQuickAction(item.mode)}
        >
          <item.icon class="fx-icon-draw size-[17px] shrink-0" strokeWidth={1.9} />
          <span class="truncate">{suggestionLabel(item.mode)}</span>
        </button>
      {/each}
    </div>
  </div>
{/if}

{#snippet skillSwitch(checked: boolean, label: string, onToggle: () => void)}
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    title={label}
    class="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-150 ease-[var(--ease-out)] active:scale-[0.94] {checked ? 'bg-primary' : 'bg-surface-2 ring-line/80 ring-1 ring-inset'}"
    onclick={onToggle}
  >
    <span class="bg-surface pointer-events-none absolute left-0.5 size-3 rounded-full shadow-[0_1px_2px_oklch(0_0_0_/_0.18)] transition-transform duration-150 ease-[var(--ease-out)] {checked ? 'translate-x-3' : ''}"></span>
  </button>
{/snippet}

<Dialog.Root bind:open={skillsOpen}>
  <Dialog.Content class="min-h-56 w-[min(92vw,26rem)] gap-0 overflow-hidden rounded-2xl p-0">
    <header class="px-5 pb-3 pt-5">
      <Dialog.Title class="text-[16px] font-semibold tracking-tight text-foreground">{q.skills}</Dialog.Title>
      <Dialog.Description class="text-muted-foreground pt-1 text-[12.5px]">{q.skillsHint}</Dialog.Description>
    </header>
    <div class="min-h-44 max-h-[64vh] space-y-1.5 overflow-y-auto px-3 pb-4 pt-1 [scrollbar-gutter:stable]">
      {#each skillGroups as group, groupIndex (group.key)}
        {@const GroupIcon = skillGroupIcons[group.key]}
        {@const open = openSkillGroups[group.key] === true}
        <section class="fx-enter ring-line/60 overflow-hidden rounded-xl ring-1" style="--fx-index: {groupIndex}">
          <div class="hover:bg-surface-2/60 flex w-full items-center gap-2.5 px-2.5 py-2 transition-colors duration-150 ease-[var(--ease-out)]">
            <button
              type="button"
              class="group/head flex min-w-0 flex-1 items-center gap-2.5 text-left"
              aria-expanded={open}
              onclick={() => toggleSkillGroupOpen(group.key)}
            >
              <span class="bg-surface-2 text-muted-foreground group-hover/head:text-primary grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-150 ease-[var(--ease-out)]">
                <GroupIcon class="size-[18px]" strokeWidth={1.9} />
              </span>
              <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{q.skillCategories[group.key]}</span>
              <span class="bg-surface-2 text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[10.5px] tabular">{group.enabledCount}/{group.skills.length}</span>
              <CaretDown class="text-muted-foreground size-3.5 shrink-0 transition-transform duration-[var(--d-base)] ease-[var(--ease-out)] {open ? 'rotate-180' : ''}" />
            </button>
            {#if group.skills.length > 0}
              {@render skillSwitch(group.enabledCount === group.skills.length, q.skillCategoryToggle, () => void toggleSkillGroup(group))}
            {/if}
          </div>
          <div
            class="grid transition-[grid-template-rows,opacity] duration-[var(--d-base)] ease-[var(--ease-out)] {open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}"
            inert={!open}
            aria-hidden={!open}
          >
            <div class="min-h-0 overflow-hidden">
              {#if group.skills.length === 0}
                <p class="text-muted-foreground px-3 pb-3 pt-1 text-[11.5px] leading-relaxed">{q.skillCustomEmpty}</p>
              {:else}
                <ul class="space-y-0.5 pb-1">
                  {#each group.skills as skill (skill.id)}
                    <li class="rounded-lg px-2.5 py-2 transition-[background-color,opacity] duration-200 ease-[var(--ease-out)] hover:bg-surface-2/50 {skill.enabled ? '' : 'opacity-50'}">
                      <div class="flex items-center justify-between gap-2.5">
                        <div class="min-w-0 flex-1">
                          <p class="flex min-w-0 items-baseline gap-1.5">
                            <span class="shrink-0 text-[13px] font-medium text-foreground">{skillDisplayName(skill)}</span>
                            <span class="text-muted-foreground/70 min-w-0 truncate text-[11px]">{skill.hosts.join(' · ')}</span>
                          </p>
                          <p class="text-muted-foreground mt-0.5 line-clamp-1 text-[11.5px] leading-snug" title={skillDisplayDescription(skill)}>{skillDisplayDescription(skill)}</p>
                        </div>
                        <div class="flex shrink-0 items-center gap-1">
                          {#if skill.source !== 'builtin'}
                            <button
                              type="button"
                              class="hover:bg-surface-2 text-muted-foreground/70 hover:text-destructive rounded-lg p-1 transition-colors duration-150 ease-[var(--ease-out)]"
                              aria-label={q.skillDelete}
                              title={q.skillDelete}
                              onclick={() => void removeSkill(skill)}
                            >
                              <Trash2 class="fx-icon-wiggle size-3.5" strokeWidth={1.9} />
                            </button>
                          {/if}
                          {@render skillSwitch(skill.enabled, skill.enabled ? q.skillDisable : q.skillEnable, () => void toggleSkill(skill))}
                        </div>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          </div>
        </section>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>

<div class="composer-shell ring-line/80 ring-1 {running ? 'is-running' : ''} {activeIntent ? 'is-intent' : ''}">
  <div class="composer-shell-input" inert={running} aria-hidden={running}>
  <PromptInput
    class="h-full min-h-[7rem] rounded-none border-0 bg-transparent shadow-none ring-0"
    clearOnSubmit={false}
    onSubmit={handleSubmit}
  >
    <PromptInputBody>
      {#if activeIntent}
        <div class="overflow-hidden" transition:slide={baseSlide}>
          <div class="flex items-center justify-between gap-2 px-3.5 pt-3">
            <div class="flex min-w-0 items-center">
              <DropdownMenu.Root bind:open={tabsVisible}>
                <DropdownMenu.Trigger class="hover:bg-surface-2 text-muted-foreground hover:text-foreground ring-line/60 flex min-w-0 max-w-[150px] items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] ring-1 transition-colors duration-150 ease-[var(--ease-out)]">
                  <GlobeSimple class="size-3.5 shrink-0" />
                  <span class="truncate">{selectedTabs.length ? q.selectedTabs(selectedTabs.length) : q.pickTabs}</span>
                  <CaretDown class="size-3 shrink-0 opacity-60 transition-transform {tabsVisible ? 'rotate-180' : ''}" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content side="top" align="start" sideOffset={8} class={tabsMenuClass}>
                  {#if loadingTabs}
                    <p class="text-muted-foreground px-2 py-2 text-xs">…</p>
                  {:else if tabs.length === 0}
                    <p class="text-muted-foreground whitespace-nowrap px-2 py-1.5 text-xs">{q.noTabs}</p>
                  {:else}
                    <div class="max-h-44 space-y-1 overflow-y-auto">
                      {#each orderedTabs as tab (tab.id)}
                        {@const tabSelected = selectedTabIds.has(tab.id)}
                        <button
                          type="button"
                          class="hover:bg-surface-2 flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors duration-150 ease-[var(--ease-out)]"
                          aria-pressed={tabSelected}
                          onclick={(event) => { event.stopPropagation(); toggleTab(tab.id); }}
                        >
                          <span class="bg-surface-2 ring-line/60 relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1">
                            <GlobeSimple class="size-3 text-muted-foreground" />
                            {#if tab.favIconUrl}<img src={tab.favIconUrl} alt="" class="absolute inset-1 size-4 rounded-[4px] object-contain" />{/if}
                          </span>
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-[12px] text-foreground">{tab.title || tabHost(tab.url)}</span>
                            <span class="block truncate text-[10.5px] text-muted-foreground">{tabHost(tab.url)}</span>
                          </span>
                          <span class={tabSelected ? 'bg-primary text-primary-foreground flex size-4 items-center justify-center rounded-full transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out)] scale-100' : 'border-line flex size-4 items-center justify-center rounded-full border transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out)] scale-95'}>
                            <Check class="size-2.5 transition-[opacity,transform] duration-150 ease-[var(--ease-out)] {tabSelected ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}" strokeWidth={2.2} />
                          </span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </div>
            <button type="button" class="group/close hover:bg-surface-2 text-muted-foreground hover:text-foreground rounded-lg p-2 transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]" aria-label={q.cancel} onclick={cancelIntent}>
              <X class="size-4 transition-transform duration-[var(--d-base)] ease-[var(--ease-out)] group-hover/close:rotate-90" />
            </button>
          </div>
        </div>
      {/if}
      <PromptInputTextarea placeholder={activeIntent === 'research' ? q.researchPlaceholder : activeIntent === 'compare' ? q.comparePlaceholder : t.placeholder} disabled={disabled || running} bind:value={draft} class={`text-[14px] leading-relaxed transition-[min-height,padding] duration-[var(--d-base)] ease-[var(--ease-out)] ${activeIntent ? 'min-h-11 px-4 pb-2.5 pt-2.5' : 'min-h-16 px-4 py-4'}`} />
    </PromptInputBody>
    {#if attachedNames.length > 0}
      <div class="flex flex-wrap gap-1 px-3 pb-1" transition:slide={microSlide}>
        {#each attachedNames as name (name)}
          <span class="bg-surface-2 text-muted-foreground ring-line/60 flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] ring-1">
            <Paperclip class="size-3" />{name}
            <button type="button" class="hover:text-foreground" aria-label={q.cancel} onclick={() => { attachedNames = attachedNames.filter((existing) => existing !== name); }}>
              <X class="size-3" />
            </button>
          </span>
        {/each}
      </div>
    {/if}
    <PromptInputToolbar class="flex-wrap gap-1.5 px-3 pb-3 pt-0">
      <PromptInputTools class="min-w-0 flex-1 flex-wrap gap-1">
        {#if onAttachFile}
          <input bind:this={fileInput} type="file" class="hidden" multiple accept=".pdf,.docx,.md,.txt,.html,.csv,.json" onchange={handleFilesPicked} />
          <button
            type="button"
            class="hover:bg-surface-2 text-muted-foreground hover:text-foreground rounded-xl p-2 transition-[background-color,color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
            aria-label={q.attach}
            title={q.attach}
            disabled={disabled || running}
            onclick={() => fileInput?.click()}
          >
            <Paperclip class="fx-icon-wiggle size-4" />
          </button>
        {/if}
        {#if !activeIntent}
          <div class="flex min-w-0 flex-wrap gap-1 overflow-hidden" transition:slide={microSlide}>
            <DropdownMenu.Root bind:open={modelPickerOpen}>
              <DropdownMenu.Trigger class="hover:bg-surface-2 flex max-w-[165px] items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12.5px] transition-[background-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] {modelPickerOpen ? 'bg-surface-2 text-foreground shadow-[0_2px_8px_oklch(0_0_0_/_0.04)]' : 'text-muted-foreground hover:text-foreground'}">
                <Bot class="fx-icon-draw size-4 shrink-0" strokeWidth={1.9} />
                {#key selectedModelLabel}<span class="fx-label-swap truncate">{selectedModelLabel}</span>{/key}
                <CaretDown class="size-3 shrink-0 opacity-60 transition-transform duration-150 ease-[var(--ease-out)] {modelPickerOpen ? 'rotate-180' : ''}" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" class="min-w-[260px] rounded-2xl p-2">
                <DropdownMenu.Label class="text-[11px] text-muted-foreground">{t.model}</DropdownMenu.Label>
                {#if providers.length === 0}
                  <DropdownMenu.Item onclick={() => onMissingModel()} class="text-xs">{t.configureModel}</DropdownMenu.Item>
                {:else}
                  {#each providers as provider (provider.id)}
                    {@const availableModels = provider.models.filter((model) => !model.unavailable && model.visibility !== 'hide')}
                    {#if availableModels.length > 0}
                      <DropdownMenu.Group>
                        <DropdownMenu.GroupHeading class="text-[10px] text-muted-foreground/70">{providerLabel(provider)}</DropdownMenu.GroupHeading>
                        {#each availableModels as model (model.id)}
                          <DropdownMenu.Item onclick={() => void onSelectModel(model.id)} class="gap-2 rounded-xl text-xs">
                            <span class={selectedModelId === model.id ? 'bg-primary size-1.5 rounded-full' : 'border-line size-1.5 rounded-full border'}></span>
                            <span class="min-w-0 flex-1 truncate text-foreground">{model.displayName ?? model.name}</span>
                            {#if selectedModelId === model.id}<Check class="size-3" />{/if}
                          </DropdownMenu.Item>
                        {/each}
                      </DropdownMenu.Group>
                    {/if}
                  {/each}
                {/if}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            <DropdownMenu.Root bind:open={reasoningPickerOpen}>
              <DropdownMenu.Trigger disabled={missingModel} class="hover:bg-surface-2 flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-[12.5px] transition-[background-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.97] disabled:cursor-default {reasoningPickerOpen ? 'bg-surface-2 text-foreground shadow-[0_2px_8px_oklch(0_0_0_/_0.04)]' : 'text-muted-foreground hover:text-foreground'}">
                <BrainCircuit class="fx-icon-draw size-4 shrink-0" strokeWidth={1.9} />
                {#key `${missingModel}:${reasoningEffort}`}<span class="fx-label-swap">{reasoningLabel(reasoningEffort)}</span>{/key}
                {#if !missingModel}<CaretDown class="size-3 shrink-0 opacity-60 transition-transform duration-150 ease-[var(--ease-out)] {reasoningPickerOpen ? 'rotate-180' : ''}" />{/if}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" class="min-w-[150px] rounded-2xl p-2">
                <DropdownMenu.Label class="text-[11px] text-muted-foreground">{t.reasoning}</DropdownMenu.Label>
                {#each reasoningOptions as option (option.value)}
                  <DropdownMenu.Item onclick={() => void onSelectReasoningEffort(option.value)} class="rounded-xl text-xs">
                    <span class={reasoningEffort === option.value ? 'bg-primary size-1.5 rounded-full' : 'border-line size-1.5 rounded-full border'}></span>
                    {option.label}
                    {#if reasoningEffort === option.value}<Check class="ml-auto size-3" />{/if}
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </div>
        {/if}
      </PromptInputTools>
      <PromptInputSubmit
        {status}
        onStop={() => void onStop()}
        submitLabel={t.submit}
        stopLabel={t.stop}
        disabled={running || submitDisabled}
        class="group/send size-11 rounded-full shadow-[0_1px_2px_oklch(0_0_0_/_0.08)] transition-[transform,background-color,box-shadow] duration-150 ease-[var(--ease-out)] hover:shadow-[0_4px_14px_oklch(0_0_0_/_0.14)] active:scale-[0.96]"
      >
        <Rocket class="size-5 transition-transform duration-[var(--d-base)] ease-[var(--ease-out)] group-hover/send:-translate-y-0.5 group-hover/send:translate-x-0.5 group-hover/send:scale-110" strokeWidth={2} />
      </PromptInputSubmit>
    </PromptInputToolbar>
  </PromptInput>
  </div>
  <section class="composer-shell-running" inert={!running} aria-hidden={!running}>
    <div class="col-start-2 flex min-w-0 items-center gap-3 px-2 py-2">
      <span class="fx-beam bg-primary/10 text-primary relative flex size-10 shrink-0 items-center justify-center rounded-2xl shadow-[inset_0_1px_0_oklch(1_0_0_/_0.08)]">
        <span class="fx-running-pulse bg-primary/15 absolute inset-1.5 rounded-xl"></span>
        <MousePointerClick class="fx-running-cursor relative size-6" strokeWidth={1.9} />
      </span>
      <p class="fx-shimmer-text truncate text-[15px] font-semibold tracking-[-0.01em]">{t.runningTitle}</p>
    </div>
    <button
      type="button"
      class="bg-surface ring-line/80 hover:bg-[var(--danger-bg)] hover:text-danger hover:ring-danger/35 col-start-3 flex size-10 shrink-0 items-center justify-center justify-self-end rounded-full text-foreground ring-1 transition-[background-color,color,box-shadow,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
      aria-label={t.stop}
      title={t.stop}
      onclick={() => void onStop()}
    >
      <Square class="size-4" fill="currentColor" strokeWidth={1.8} />
    </button>
  </section>
</div>
