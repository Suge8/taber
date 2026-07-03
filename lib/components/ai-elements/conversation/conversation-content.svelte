<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils";
	import type { HTMLAttributes } from "svelte/elements";
	import type { Snippet } from "svelte";

	export interface ConversationContentProps extends WithElementRef<
		HTMLAttributes<HTMLDivElement>
	> {
		children?: Snippet;
	}
</script>

<script lang="ts">
	import { getStickToBottomContext } from "./stick-to-bottom-context.svelte.js";
	import { watch } from "runed";

	let {
		class: className,
		children,
		ref = $bindable(null),
		...restProps
	}: ConversationContentProps = $props();

	const context = getStickToBottomContext();
	let element: HTMLDivElement;

	watch(
		() => element,
		() => {
			if (element) {
				context.setElement(element);
				// Initial scroll to bottom
				context.scrollToBottom("smooth");
			}
		}
	);
</script>

<div
	bind:this={element}
	bind:this={ref}
	class={cn("flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto overscroll-contain p-4 [scrollbar-gutter:stable]", className)}
	{...restProps}
>
	{@render children?.()}
</div>
