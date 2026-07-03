<script lang="ts">
  import ChatCircle from 'phosphor-svelte/lib/ChatCircle';
  import Plus from 'phosphor-svelte/lib/Plus';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import type { SessionListItem } from '$lib/db.ts';
  import { formatTime, messages, type Locale } from '$lib/sidepanel-i18n.ts';

  interface Props {
    locale: Locale;
    sessions: SessionListItem[];
    currentSessionId: number | null;
    onSelect: (sessionId: number) => void | Promise<void>;
    onNew: () => void | Promise<void>;
  }

  let { locale, sessions, currentSessionId, onSelect, onNew }: Props = $props();
  let t = $derived(messages[locale].history);
  let open = $state(false);

  async function selectSession(sessionId: number) {
    open = false;
    await onSelect(sessionId);
  }

  async function newSession() {
    open = false;
    await onNew();
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger class="text-muted-foreground hover:text-foreground flex size-8 items-center justify-center rounded-full transition-[color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]" aria-label={t.aria}>
    <ChatCircle class="size-3.5" weight="duotone" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="max-h-[340px] min-w-[244px] overflow-y-auto p-1.5">
    <DropdownMenu.Item
      class="group/new text-primary bg-primary/8 hover:bg-primary/12 data-highlighted:bg-primary/12 data-highlighted:text-primary w-full gap-2 rounded-md px-2.5 py-2 text-xs font-medium transition-[background-color,box-shadow,transform] duration-150 ease-[var(--ease-out)] hover:shadow-[0_3px_10px_oklch(0_0_0_/_0.04)] active:scale-[0.98]"
      onclick={() => void newSession()}
    >
      <Plus class="size-3.5 transition-transform duration-150 ease-[var(--ease-out)] group-hover/new:scale-110" weight="bold" />
      {t.newSession}
    </DropdownMenu.Item>
    {#if sessions.length > 0}
      <DropdownMenu.Separator class="my-1.5" />
      {#each sessions as session (session.id)}
        {@const active = currentSessionId === session.id}
        <DropdownMenu.Item onclick={() => void selectSession(session.id)} class="items-start gap-2 rounded-md text-xs transition-colors duration-150 ease-[var(--ease-out)]">
          <span class={active ? 'bg-primary mt-1.5 size-1.5 shrink-0 scale-100 rounded-full transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out)]' : 'border-line mt-1.5 size-1.5 shrink-0 scale-90 rounded-full border transition-[background-color,border-color,transform] duration-150 ease-[var(--ease-out)]'}></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate">{session.title}</span>
            <span class="text-muted-foreground/80 mt-0.5 block text-[10px] tabular">
              {session.pinned ? `${t.pinned} · ` : ''}{formatTime(locale, session.updatedAt)}
            </span>
          </span>
        </DropdownMenu.Item>
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
