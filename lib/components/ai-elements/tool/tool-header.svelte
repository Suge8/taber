<script lang="ts">
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { cn } from "$lib/utils";
	import type { Component } from "svelte";

	import CheckCircleIcon from "@lucide/svelte/icons/check-circle";
	import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
	import CircleIcon from "@lucide/svelte/icons/circle";
	import ClockIcon from "@lucide/svelte/icons/clock";
	import WrenchIcon from "@lucide/svelte/icons/wrench";
	import XCircleIcon from "@lucide/svelte/icons/x-circle";

	type ToolUIPartType = string;
	type ToolUIPartState =
		| "input-streaming"
		| "input-available"
		| "output-available"
		| "output-warning"
		| "output-error";

	interface ToolHeaderProps {
		type: ToolUIPartType;
		state: ToolUIPartState;
		labels?: Record<'pending' | 'running' | 'completed' | 'error', string> & Partial<Record<'warning', string>>;
		icon?: Component<{ class?: string }>;
		iconClass?: string;
		class?: string;
		[key: string]: any;
	}

	let {
		type,
		state,
		labels = { pending: "Pending", running: "Running", completed: "Completed", error: "Error", warning: "Needs action" },
		icon: ActionIcon = WrenchIcon,
		iconClass = "text-muted-foreground",
		class: className = "",
		...restProps
	}: ToolHeaderProps = $props();

	let getStatusBadge = $derived.by(() => {
		let statusLabels = {
			"input-streaming": labels.pending,
			"input-available": labels.running,
			"output-available": labels.completed,
			"output-warning": labels.warning ?? "Needs action",
			"output-error": labels.error,
		} as const;

		let icons = {
			"input-streaming": CircleIcon,
			"input-available": ClockIcon,
			"output-available": CheckCircleIcon,
			"output-warning": XCircleIcon,
			"output-error": XCircleIcon,
		} as const;

		let IconComponent = icons[state];
		let label = statusLabels[state];

		return { IconComponent, label };
	});
	let StatusIcon = $derived(getStatusBadge.IconComponent);

	let id = $props.id();
</script>

<CollapsibleTrigger
	{id}
	class={cn("group flex w-full items-center justify-between gap-2 px-2.5 py-1.5", className)}
	{...restProps}
>
	<div class="flex min-w-0 items-center gap-2">
		<span class="bg-surface-2/70 ring-line/50 flex size-6 shrink-0 items-center justify-center rounded-lg ring-1">
			<ActionIcon class={cn("size-3", iconClass)} />
		</span>
		<span class="min-w-0 truncate text-[12px] font-medium leading-5">{type}</span>
	</div>
	<div class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[10.5px] leading-none">
		<span class="inline-flex items-center gap-1">
			<StatusIcon
				class={cn(
					"size-3",
					state === "input-available" && "animate-pulse text-primary",
					state === "output-available" && "text-success",
					state === "output-warning" && "text-warn",
					state === "output-error" && "text-danger"
				)}
			/>
			<span>{getStatusBadge.label}</span>
		</span>
		<ChevronDownIcon
			class="size-3 transition-transform group-data-[state=open]:rotate-180"
		/>
	</div>
</CollapsibleTrigger>
