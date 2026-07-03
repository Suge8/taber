<script lang="ts">
	import { CollapsibleTrigger } from "$lib/components/ui/collapsible/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
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
	class={cn("group flex w-full items-center justify-between gap-3 p-3", className)}
	{...restProps}
>
	<div class="flex min-w-0 items-center gap-2.5">
		<span class="bg-surface-2 ring-line/60 flex size-7 shrink-0 items-center justify-center rounded-xl ring-1">
			<ActionIcon class={cn("size-3.5", iconClass)} />
		</span>
		<span class="min-w-0 truncate text-[12.5px] font-medium leading-5">{type}</span>
	</div>
	<div class="flex shrink-0 items-center gap-2">
		<Badge class="gap-1 rounded-full px-2 py-0.5 text-[11px]" variant="secondary">
			<StatusIcon
				class={cn(
					"size-3",
					state === "input-available" && "animate-pulse",
					state === "output-available" && "text-green-600",
					state === "output-warning" && "text-warn",
					state === "output-error" && "text-red-600"
				)}
			/>
			{getStatusBadge.label}
		</Badge>
		<ChevronDownIcon
			class="text-muted-foreground size-3.5 transition-transform group-data-[state=open]:rotate-180"
		/>
	</div>
</CollapsibleTrigger>
