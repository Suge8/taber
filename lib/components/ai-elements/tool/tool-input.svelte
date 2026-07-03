<script lang="ts">
  import { cn } from '$lib/utils';

  interface ToolInputProps {
    class?: string;
    input: unknown;
    label?: string;
  }

  let { class: className = '', input, label = 'Input' }: ToolInputProps = $props();

  let formatted = $derived.by(() => {
    if (input === undefined || input === null) return '—';
    if (typeof input === 'string') return input;
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  });
</script>

<div class={cn('space-y-1.5 px-4 pb-3 pt-3', className)}>
  <h4 class="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.04em]">{label}</h4>
  <pre class="bg-muted/50 text-foreground/90 max-h-56 overflow-auto rounded-md p-2.5 font-mono text-[11px] leading-relaxed">{formatted}</pre>
</div>
