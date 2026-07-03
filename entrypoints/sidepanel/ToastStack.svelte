<script lang="ts">
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import CheckCircle from 'phosphor-svelte/lib/CheckCircle';
  import Info from 'phosphor-svelte/lib/Info';
  import WarningCircle from 'phosphor-svelte/lib/WarningCircle';
  import type { ToastNotice, ToastTone } from './toast.ts';

  interface Props {
    items: ToastNotice[];
    placement?: 'viewport' | 'dialog';
  }

  let { items, placement = 'viewport' }: Props = $props();

  const stackClass = $derived(placement === 'dialog'
    ? 'pointer-events-none absolute right-3 top-12 z-[60] flex max-w-[calc(100%-1.5rem)] flex-col items-end gap-2'
    : 'pointer-events-none fixed inset-x-3 top-3 z-[70] flex flex-col items-end gap-2');

  function iconFor(tone: ToastTone) {
    if (tone === 'success') return CheckCircle;
    if (tone === 'error') return WarningCircle;
    return Info;
  }

  function toneIconClass(tone: ToastTone) {
    if (tone === 'success') return 'bg-success/10 text-success';
    if (tone === 'error') return 'bg-danger/10 text-danger';
    return 'bg-surface-2 text-muted-foreground';
  }

  function toneSurfaceClass(tone: ToastTone) {
    if (tone === 'success') return 'bg-[color-mix(in_oklch,var(--surface)_92%,var(--success-bg))] ring-success/20';
    if (tone === 'error') return 'bg-[color-mix(in_oklch,var(--surface)_90%,var(--danger-bg))] ring-danger/20';
    return 'bg-surface/94 ring-line/80';
  }
</script>

<div class={stackClass} aria-live="polite" aria-atomic="false">
  {#each items as item (item.id)}
    {@const Icon = iconFor(item.tone)}
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      class="text-foreground pointer-events-auto flex max-w-[min(22rem,calc(100vw-1.5rem))] items-start gap-2.5 rounded-2xl px-3 py-2.5 text-[12.5px] shadow-[0_18px_50px_oklch(0_0_0_/_0.14)] ring-1 backdrop-blur-md {toneSurfaceClass(item.tone)}"
      transition:fly={{ y: -8, duration: 180, easing: cubicOut }}
    >
      <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full {toneIconClass(item.tone)}">
        <Icon class="size-3.5" weight="duotone" />
      </span>
      <span class="min-w-0 flex-1 text-pretty leading-relaxed">{item.text}</span>
    </div>
  {/each}
</div>
