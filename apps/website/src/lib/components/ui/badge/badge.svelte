<script lang="ts">
	import type { HTMLAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn } from "$lib/utils";

	const badgeVariants = tv({
		base: "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold tracking-[0.04em]",
		variants: {
			variant: {
				default: "border-foreground/15 bg-primary text-primary-foreground",
				muted: "border-border bg-transparent text-muted-foreground",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});

	type Variant = VariantProps<typeof badgeVariants>;

	type Props = {
		class?: string;
		children?: import("svelte").Snippet;
		variant?: Variant["variant"];
	} & Omit<HTMLAttributes<HTMLSpanElement>, "class">;

	let { class: className, children, variant = "default", ...restProps }: Props = $props();
</script>

<span class={cn(badgeVariants({ variant }), className)} {...restProps}>
	{@render children?.()}
</span>
