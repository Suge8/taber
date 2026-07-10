<script lang="ts">
  import { Input } from '$lib/components/ui/input/index.js';
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import KeyRound from '@lucide/svelte/icons/key-round';

  interface Props {
    id?: string;
    value: string;
    visible: boolean;
    disabled?: boolean;
    placeholder: string;
    showLabel: string;
    hideLabel: string;
    ariaLabel: string;
  }

  let {
    id,
    value = $bindable(),
    visible = $bindable(),
    disabled = false,
    placeholder,
    showLabel,
    hideLabel,
    ariaLabel,
  }: Props = $props();
</script>

<div class="relative">
  <KeyRound class="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
  <Input
    {id}
    type={visible ? 'text' : 'password'}
    bind:value
    {placeholder}
    {disabled}
    aria-label={ariaLabel}
    class="rounded-xl pl-10 pr-10 font-mono placeholder:font-sans"
  />
  <button
    type="button"
    class="hover:bg-surface-2 text-muted-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-xl transition-colors"
    aria-label={visible ? hideLabel : showLabel}
    onclick={() => (visible = !visible)}
  >
    {#if visible}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}
  </button>
</div>
