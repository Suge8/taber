<script lang="ts">
  import { fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { cubicOut, quintOut } from 'svelte/easing';
  import Bot from '@lucide/svelte/icons/bot';
  import CircleCheckBig from '@lucide/svelte/icons/circle-check-big';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Database from '@lucide/svelte/icons/database';
  import Globe from '@lucide/svelte/icons/globe';
  import Info from '@lucide/svelte/icons/info';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { ToastNotice, ToastTone } from './toast.ts';

  interface Props {
    items: ToastNotice[];
  }

  let { items }: Props = $props();

  function iconFor(item: ToastNotice) {
    const icon = item.icon ?? item.tone;
    if (icon === 'browser') return Globe;
    if (icon === 'database') return Database;
    if (icon === 'model') return Bot;
    if (icon === 'task') return Sparkles;
    if (icon === 'success') return CircleCheckBig;
    if (icon === 'error') return CircleX;
    if (icon === 'warning') return TriangleAlert;
    return Info;
  }

  function toneIconClass(tone: ToastTone) {
    if (tone === 'success') return 'bg-[var(--permission-success-badge)] text-[var(--permission-success-ink)]';
    if (tone === 'error') return 'bg-[color-mix(in_oklch,var(--danger-bg)_76%,var(--surface))] text-danger';
    if (tone === 'warning') return 'bg-[color-mix(in_oklch,var(--warn-bg)_76%,var(--surface))] text-warn';
    return 'bg-[color-mix(in_oklch,var(--accent)_10%,var(--surface-2))] text-foreground';
  }

  function toneSurfaceClass(tone: ToastTone) {
    if (tone === 'success') return 'bg-[var(--permission-success-card)] ring-[var(--permission-success-border)]';
    if (tone === 'error') return 'bg-[color-mix(in_oklch,var(--surface)_72%,var(--danger-bg))] ring-[color-mix(in_oklch,var(--danger-ink)_36%,transparent)]';
    if (tone === 'warning') return 'bg-[color-mix(in_oklch,var(--surface)_72%,var(--warn-bg))] ring-[color-mix(in_oklch,var(--warn-ink)_36%,transparent)]';
    return 'bg-[color-mix(in_oklch,var(--surface)_88%,var(--accent))] ring-[color-mix(in_oklch,var(--accent)_16%,transparent)]';
  }
</script>

<div class="pointer-events-none fixed inset-x-3 top-3 z-[70] flex flex-col items-end gap-2" aria-live="polite" aria-atomic="false">
  {#each items as item (item.id)}
    {@const Icon = iconFor(item)}
    <div
      role={item.tone === 'error' || item.tone === 'warning' ? 'alert' : 'status'}
      class="text-foreground pointer-events-auto flex max-w-[min(22rem,calc(100vw-1.5rem))] items-start gap-2.5 rounded-2xl px-3.5 py-3 text-[13px] shadow-[0_18px_50px_oklch(0_0_0_/_0.14)] ring-1 backdrop-blur-md {toneSurfaceClass(item.tone)}"
      in:fly={{ y: -10, duration: 220, easing: quintOut }}
      out:fly={{ y: -6, duration: 150, easing: cubicOut }}
      animate:flip={{ duration: 200, easing: cubicOut }}
    >
      <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full {toneIconClass(item.tone)}">
        <Icon class="size-4" strokeWidth={1.9} />
      </span>
      <span class="min-w-0 flex-1 text-pretty leading-relaxed">{item.text}</span>
    </div>
  {/each}
</div>
