<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
    ref?: HTMLDivElement | null;
  }

  let { children, ref = $bindable(null) }: Props = $props();
</script>

<div bind:this={ref} class="settings-action-bar">
  <div class="settings-action-bar__content">
    {@render children()}
  </div>
</div>

<style>
  .settings-action-bar {
    display: flex;
    justify-content: flex-end;
  }

  .settings-action-bar__content {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
