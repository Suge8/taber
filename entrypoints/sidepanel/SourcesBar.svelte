<script lang="ts">
  import ArrowSquareOut from 'phosphor-svelte/lib/ArrowSquareOut';
  import GlobeSimple from 'phosphor-svelte/lib/GlobeSimple';
  import ImageIcon from 'phosphor-svelte/lib/Image';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import type { ImagePreview, SourceLink } from '$lib/sidepanel-view.ts';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';

  interface Props {
    locale: Locale;
    sources: SourceLink[];
    imagePreview?: ImagePreview;
    onOpenSource?: (source: SourceLink) => void | Promise<void>;
  }

  let { locale, sources, imagePreview, onOpenSource }: Props = $props();
  let t = $derived(messages[locale].sources);
  let previewOpen = $state(false);
  let thumbnailFailed = $state(false);
  let previewFailed = $state(false);
  const current = $derived(sources[0]);

  $effect(() => {
    imagePreview?.src;
    thumbnailFailed = false;
    previewFailed = false;
  });

  function hideBrokenImage(event: Event) {
    if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.hidden = true;
  }

  function openSource(source: SourceLink) {
    if (onOpenSource) {
      void onOpenSource(source);
      return;
    }
    window.open(source.url, '_blank', 'noopener');
  }
</script>

{#if sources.length > 0 || imagePreview}
  <section class="fx-enter shrink-0 px-3 pb-0.5 pt-1.5">
    <div class="bg-surface ring-line/70 flex min-h-9 items-center gap-2 rounded-2xl px-2.5 py-1.5 text-[12px] shadow-[0_8px_24px_oklch(0_0_0_/_0.035)] ring-1">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="hover:bg-surface-2 flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 ease-[var(--ease-out)]">
          <span class="bg-surface-2 ring-line/60 relative flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1">
            <GlobeSimple class="text-muted-foreground size-3" />
            {#if current?.faviconUrl}
              <img
                src={current.faviconUrl}
                alt="{current.domain || current.label} favicon"
                class="absolute inset-1 size-3 rounded-[3px] object-contain"
                onerror={hideBrokenImage}
              />
            {/if}
          </span>
          <span class="min-w-0 flex-1 truncate text-foreground/90">
            {#if current}{t.currentTab} · {current.domain || current.label}{:else}{t.noPage}{/if}
          </span>
          {#if sources.length > 0}<span class="text-muted-foreground shrink-0">{t.sourceCount(sources.length)}</span>{/if}
          {#if imagePreview}<span class="text-muted-foreground shrink-0">{t.imageCount(1)}</span>{/if}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" sideOffset={8} class="w-[min(22rem,calc(100vw-2rem))] rounded-2xl p-2 shadow-[0_18px_50px_oklch(0_0_0_/_0.12)]">
          <DropdownMenu.Label class="text-[11px] text-muted-foreground">{t.viewSources}</DropdownMenu.Label>
          {#each sources as source (source.url)}
            <DropdownMenu.Item
              class="gap-2 rounded-xl px-2 py-2 text-xs"
              onclick={() => openSource(source)}
            >
              <span class="bg-surface-2 ring-line/60 relative flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-lg ring-1">
                <ArrowSquareOut class="size-3 text-muted-foreground" />
                {#if source.faviconUrl}
                  <img
                    src={source.faviconUrl}
                    alt="{source.domain || source.label} favicon"
                    class="absolute inset-1 size-4 rounded-[4px] object-contain"
                    onerror={hideBrokenImage}
                  />
                {/if}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-foreground">{source.label}</span>
                <span class="block truncate text-muted-foreground">{source.domain || source.url}</span>
              </span>
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      {#if imagePreview}
        <button
          type="button"
          class="group/preview hover:bg-surface-2 ring-line/60 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-xl ring-1 transition-[background-color,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.96]"
          aria-label={t.previewImage}
          onclick={() => (previewOpen = true)}
        >
          {#if thumbnailFailed}
            <ImageIcon class="size-3.5 text-muted-foreground transition-transform duration-200 ease-[var(--ease-out)] group-hover/preview:scale-105" />
          {:else}
            <img
              src={imagePreview.src}
              alt={imagePreview.alt}
              class="size-full object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] transition-transform duration-200 ease-[var(--ease-out)] group-hover/preview:scale-[1.04] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
              onerror={() => (thumbnailFailed = true)}
            />
          {/if}
        </button>
      {/if}
    </div>
  </section>
{/if}

<Dialog.Root bind:open={previewOpen}>
  <Dialog.Content class="max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-3 sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-sm">{imagePreview?.label ?? t.image}</Dialog.Title>
      <Dialog.Description class="text-xs text-muted-foreground">{imagePreview?.alt ?? t.imageAlt}</Dialog.Description>
    </Dialog.Header>
    {#if imagePreview}
      {#if previewFailed}
        <div class="bg-surface-2 ring-line/70 flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl text-xs text-muted-foreground ring-1">
          <ImageIcon class="size-5" />
          <span>{t.imageAlt}</span>
        </div>
      {:else}
        <img
          src={imagePreview.src}
          alt={imagePreview.alt}
          class="max-h-[70vh] w-full rounded-xl object-contain shadow-[0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)]"
          onerror={() => (previewFailed = true)}
        />
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
