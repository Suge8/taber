<script lang="ts">
  import DOMPurify from 'dompurify';
  import { marked } from 'marked';
  import { cn } from '$lib/utils';
  import { hideReasoningText } from '$lib/sidepanel-view.ts';

  interface Props {
    content?: string;
    children?: import('svelte').Snippet;
    class?: string;
  }

  let { content, children, class: className }: Props = $props();

  const html = $derived(content === undefined ? '' : renderMarkdown(content));

  function renderMarkdown(value: string) {
    const rawHtml = marked.parse(hideReasoningText(value), { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'img'],
    });
  }
</script>

<div class={cn('taber-markdown text-sm leading-relaxed break-words', className)}>
  {#if content !== undefined}{@html html}{:else if children}{@render children()}{/if}
</div>

<style>
  .taber-markdown :global(:first-child) {
    margin-top: 0;
  }
  .taber-markdown :global(:last-child) {
    margin-bottom: 0;
  }
  .taber-markdown :global(p),
  .taber-markdown :global(ul),
  .taber-markdown :global(ol),
  .taber-markdown :global(pre) {
    margin: 0.55rem 0;
  }
  .taber-markdown :global(ul),
  .taber-markdown :global(ol) {
    padding-left: 1.1rem;
  }
  .taber-markdown :global(ul) {
    list-style: disc;
  }
  .taber-markdown :global(ol) {
    list-style: decimal;
  }
  .taber-markdown :global(code) {
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface-2);
    padding: 0.08rem 0.25rem;
    font-family: var(--font-mono);
    font-size: 0.88em;
  }
  .taber-markdown :global(pre) {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-2);
    padding: 0.75rem;
  }
  .taber-markdown :global(pre code) {
    border: 0;
    background: transparent;
    padding: 0;
  }
  .taber-markdown :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
