<script lang="ts">
  import DownloadSimple from 'phosphor-svelte/lib/DownloadSimple';
  import FileArrowDown from 'phosphor-svelte/lib/FileArrowDown';
  import Printer from 'phosphor-svelte/lib/Printer';
  import TrashSimple from 'phosphor-svelte/lib/TrashSimple';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import { messages, type Locale } from '$lib/sidepanel-i18n.ts';
  import type { WorkspaceFile } from '$lib/db.ts';

  interface Props {
    locale: Locale;
    files: WorkspaceFile[];
    onDelete: (file: WorkspaceFile) => void | Promise<void>;
  }

  let { locale, files, onDelete }: Props = $props();
  let t = $derived(messages[locale].files);

  function formatSize(bytes: number) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${bytes}B`;
  }

  function printable(file: WorkspaceFile) {
    return file.mimeType === 'text/markdown' || file.mimeType === 'text/html' || file.mimeType === 'text/plain';
  }

  function download(file: WorkspaceFile) {
    const url = URL.createObjectURL(new Blob([file.data], { type: file.mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function exportPdf(file: WorkspaceFile) {
    window.open(`${location.origin}/print.html?file=${file.id}`, '_blank', 'noopener');
  }
</script>

{#if files.length > 0}
  <section class="shrink-0 px-3 pt-1.5" aria-label={t.title}>
    <div class="flex flex-wrap items-center gap-1.5">
      {#each files as file (file.id)}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger class="hover:bg-surface-2 text-muted-foreground hover:text-foreground ring-line/60 flex max-w-[14rem] items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] ring-1 transition-colors duration-150 ease-[var(--ease-out)]">
          <FileArrowDown class="size-3.5 shrink-0" />
          <span class="truncate">{file.name}</span>
          <span class="shrink-0 opacity-60">{formatSize(file.size)}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content side="top" align="start" sideOffset={6} class="min-w-36 rounded-xl p-1">
            <DropdownMenu.Item onclick={() => download(file)}>
              <DownloadSimple class="size-3.5" />{t.download}
            </DropdownMenu.Item>
            {#if printable(file)}
              <DropdownMenu.Item onclick={() => exportPdf(file)}>
                <Printer class="size-3.5" />{t.exportPdf}
              </DropdownMenu.Item>
            {/if}
            <DropdownMenu.Item class="text-destructive" onclick={() => onDelete(file)}>
              <TrashSimple class="size-3.5" />{t.delete}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/each}
    </div>
  </section>
{/if}
