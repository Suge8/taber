<script lang="ts">
  import { cn } from '$lib/utils';

  interface ToolOutputProps {
    class?: string;
    output?: unknown;
    errorText?: string;
    labels?: Record<'error' | 'result', string>;
  }

  let { class: className = '', output, errorText, labels = { error: 'Error', result: 'Result' } }: ToolOutputProps = $props();

  let formatted = $derived.by(() => {
    if (output === undefined || output === null) return undefined;
    if (typeof output === 'string') return output;
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  });

  let shouldRender = $derived(Boolean(errorText) || formatted !== undefined);
</script>

{#if shouldRender}
  <div class={cn('space-y-1.5 px-4 pb-4 pt-2', className)}>
    <h4 class="text-muted-foreground text-[10px] font-semibold uppercase tracking-[0.04em]">
      {errorText ? labels.error : labels.result}
    </h4>
    {#if errorText}
      <div class="bg-danger/10 text-danger rounded-md p-2.5 text-xs">{errorText}</div>
    {:else}
      <pre class="bg-muted/50 text-foreground/90 max-h-72 overflow-auto rounded-md p-2.5 font-mono text-[11px] leading-relaxed">{formatted}</pre>
    {/if}
  </div>
{/if}
