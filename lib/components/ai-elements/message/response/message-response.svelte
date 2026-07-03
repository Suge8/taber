<script lang="ts">
  import Response from '../../response/response.svelte';

  interface Props {
    content?: string;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { content, children, class: className }: Props = $props();
</script>

<Response {content} class={className}>
  {#if children}{@render children()}{/if}
</Response>
