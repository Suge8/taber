<script lang="ts">
	import { CollapsibleContent } from "$lib/components/ui/collapsible/index.js";
	import { cn } from "$lib/utils";
	import type { Snippet } from "svelte";

	interface ToolContentProps {
		class?: string;
		children?: Snippet;
		[key: string]: any;
	}

	let { class: className = "", children, ...restProps }: ToolContentProps = $props();

	let id = $props.id();
</script>

<CollapsibleContent
	{id}
	class={cn(
		"fx-tool-content text-popover-foreground outline-none",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</CollapsibleContent>
