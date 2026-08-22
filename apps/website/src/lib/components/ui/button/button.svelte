<script lang="ts">
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn } from "$lib/utils";

	const buttonVariants = tv({
		base: "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground hover:bg-[#8fe762]",
				outline: "border border-foreground/20 bg-transparent text-foreground hover:border-foreground hover:bg-card",
				ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
			},
			size: {
				default: "h-11 px-5",
				sm: "h-9 px-3.5 text-xs",
				lg: "h-12 px-6 text-base",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	type Variant = VariantProps<typeof buttonVariants>;

	type Props = {
		class?: string;
		children?: import("svelte").Snippet;
		href?: string;
		rel?: string;
		target?: string;
		variant?: Variant["variant"];
		size?: Variant["size"];
		type?: "button" | "submit" | "reset";
	};

	let {
		class: className,
		children,
		href,
		rel,
		target,
		variant = "default",
		size = "default",
		type = "button",
	}: Props = $props();
</script>

{#if href}
	<a class={cn(buttonVariants({ variant, size }), className)} {href} {rel} {target}>
		{@render children?.()}
	</a>
{:else}
	<button class={cn(buttonVariants({ variant, size }), className)} {type}>
		{@render children?.()}
	</button>
{/if}
