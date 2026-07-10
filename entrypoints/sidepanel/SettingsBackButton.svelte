<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';

  interface Props {
    label: string;
    onclick: () => void;
  }

  let { label, onclick }: Props = $props();
</script>

<Button
  type="button"
  variant="ghost"
  size="icon-sm"
  class="group text-muted-foreground/65 hover:bg-surface-2/60 hover:text-foreground -ml-1 size-9 rounded-full"
  aria-label={label}
  {onclick}
>
  <ChevronLeft class="size-4 transition-transform duration-150 ease-[var(--ease-out)] group-hover:-translate-x-0.5" strokeWidth={2} />
</Button>
