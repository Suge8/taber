<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import CaretLeft from 'phosphor-svelte/lib/CaretLeft';

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
  class="text-muted-foreground/65 hover:bg-surface-2/60 hover:text-foreground -ml-1 size-8 rounded-full"
  aria-label={label}
  {onclick}
>
  <CaretLeft class="size-3.5" />
</Button>
