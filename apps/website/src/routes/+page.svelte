<script lang="ts">
	import {
		ArrowRight,
		Code2,
		Command,
		Gauge,
		GitFork,
		Globe2,
		Layers3,
		LockKeyhole,
		Terminal,
		Zap,
	} from "lucide-svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";

	const targetProblems = [
		{
			number: "01",
			title: "厳しい利用上限とコスト",
			copy: "チーム全員が日常的に使うほど、利用上限による待ち時間と追加コストが開発速度に影響します。",
		},
		{
			number: "02",
			title: "単一プロバイダーへの依存",
			copy: "障害や混雑が起きたとき、接続先の選択肢がなければ、AIを前提にした開発フロー全体が止まります。",
		},
	];

	const currentFeatures = [
		{
			icon: Gauge,
			title: "日本語で使える無料CLI",
			copy: "CLI自体は無料です。ヘルプ、設定エラー、セッション、ターミナルUIを日本語で表示できます。",
		},
		{
			icon: Globe2,
			title: "接続先を自由に選べる",
			copy: "base URL、APIキー、モデルを指定して、Senko以外のOpenAI互換LLM APIにも接続できます。",
		},
		{
			icon: Layers3,
			title: "セッション保存",
			copy: "セッションは既定で保存されます。長い会話はコンテキスト上限に達する前に圧縮します。",
		},
	];

	const plannedFeatures = [
		{
			number: "01",
			title: "日本語向けショートカット",
			copy: "日本語ユーザーが少ない入力で日常の操作を実行できる、コマンドショートカットなどを追加します。",
		},
		{
			number: "02",
			title: "厳選モデルサービス",
			copy: "オープンウェイトモデルを中心に、コスト、速度、安定性を重視して厳選。複数の推論基盤を活用します。",
		},
		{
			number: "03",
			title: "メンバーごとのプラン管理",
			copy: "利用量に合わせた複数のサブスクリプションプランを、チームのメンバーごとに割り当てられるようにします。",
		},
	];
</script>

<svelte:head>
	<title>Senko — 日本の開発チーム向けAIコーディングエージェント</title>
	<meta
		name="description"
		content="Claude CodeやCodexを日常利用する日本企業の開発チーム向けに、無料の日本語対応CLIと厳選モデルを提供するAIコーディングエージェント。"
	/>
	<meta property="og:title" content="Senko — 日本の開発チーム向けAIコーディングエージェント" />
	<meta property="og:description" content="AIコーディングを、利用上限や障害で止めない。" />
	<meta name="theme-color" content="#f5f5f1" />
</svelte:head>

<div class="min-h-screen overflow-hidden bg-background text-foreground">
	<header class="border-b border-border/80">
		<div class="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
			<a class="group flex items-center gap-2.5" href="#top" aria-label="Senko ホーム">
				<span class="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
					<Zap class="size-[1.05rem] fill-current" strokeWidth={2.5} />
				</span>
				<span class="text-lg font-semibold tracking-[-0.045em]">senko</span>
			</a>

			<nav class="hidden items-center gap-7 text-sm text-muted-foreground md:flex" aria-label="メインナビゲーション">
				<a class="transition-colors hover:text-foreground" href="#target">対象チーム</a>
				<a class="transition-colors hover:text-foreground" href="#current">現在のCLI</a>
				<a class="transition-colors hover:text-foreground" href="#planned">提供予定</a>
				<a class="transition-colors hover:text-foreground" href="#configuration">接続方法</a>
			</nav>

			<a
				class="inline-flex items-center gap-2 text-sm font-semibold transition-colors hover:text-muted-foreground"
				href="https://github.com/abehuman/senko"
				target="_blank"
				rel="noreferrer"
			>
				<GitFork class="size-4" />
				GitHub
				<ArrowRight class="hidden size-3.5 sm:block" />
			</a>
		</div>
	</header>

	<main id="top">
		<section class="border-b border-border">
			<div class="mx-auto grid max-w-7xl items-center gap-16 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[1.04fr_0.96fr] lg:px-10 lg:py-32">
				<div class="min-w-0 max-w-2xl">
					<Badge class="animate-in"><span class="size-1.5 rounded-full bg-foreground"></span> 日本企業の開発チーム向け・開発中</Badge>
					<h1 class="animate-in delay-1 mt-7 text-balance text-5xl font-semibold leading-[1.08] tracking-[-0.065em] sm:text-6xl lg:text-7xl">
						AIコーディングを、<span class="whitespace-nowrap bg-primary px-1 text-foreground">利用上限や障害</span>で止めない。
					</h1>
					<p class="animate-in delay-2 mt-7 max-w-xl text-base leading-8 text-muted-foreground sm:text-lg">
						Claude CodeやCodexを日常利用するチームに、もう一つの実行経路を。既存ツールを使い続けながら、コストと単一プロバイダーへの依存を分散できます。
					</p>
					<div class="animate-in delay-3 mt-9 flex flex-col items-start gap-3 sm:flex-row">
						<Button href="https://github.com/abehuman/senko" target="_blank" rel="noreferrer" size="lg">
							<GitFork class="size-4" /> GitHubで見る <ArrowRight class="size-4" />
						</Button>
						<Button href="#current" variant="outline" size="lg"><Terminal class="size-4" /> 現在のCLI</Button>
					</div>
				</div>

				<div class="animate-in delay-2 relative min-w-0 lg:ml-auto lg:w-full lg:max-w-xl">
					<div class="absolute -left-3 -top-3 size-24 rounded-lg bg-primary sm:-left-5 sm:-top-5" aria-hidden="true"></div>
					<div class="relative overflow-hidden rounded-xl border border-black/15 bg-[#181a18] text-[#f5f5f1] shadow-[0_24px_60px_rgb(0_0_0_/_12%)]">
						<div class="flex items-center justify-between border-b border-white/10 px-4 py-3.5 sm:px-5">
							<div class="flex gap-1.5" aria-hidden="true">
								<span class="size-2.5 rounded-full bg-white/30"></span>
								<span class="size-2.5 rounded-full bg-white/30"></span>
								<span class="size-2.5 rounded-full bg-primary"></span>
							</div>
							<div class="flex items-center gap-2 font-mono text-[0.66rem] text-white/55">
								<Command class="size-3" /> senko / project
							</div>
						</div>
						<div class="overflow-x-auto p-5 font-mono text-xs leading-7 sm:p-7 sm:text-sm">
							<div class="text-white/45"># npmからインストール</div>
							<div class="mt-3 whitespace-nowrap"><span class="mr-3 text-primary">$</span>npm install --global @senkocode/cli</div>
							<div class="whitespace-nowrap text-white/70"><span class="mr-3 text-primary">$</span>export SENKO_API_KEY=your-key</div>
							<div class="mt-3 whitespace-nowrap"><span class="mr-3 text-primary">$</span>senko "このリポジトリを要約してください"</div>
						</div>
					</div>
				</div>
			</div>
		</section>

		<section id="target" class="bg-card">
			<div class="mx-auto grid max-w-7xl gap-14 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-[0.72fr_1.28fr] lg:gap-24 lg:px-10">
				<div class="min-w-0">
					<Badge variant="muted">対象チーム</Badge>
					<h2 class="mt-6 text-balance text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">Claude CodeかCodexを、すでに日常利用しているチームへ。</h2>
					<p class="mt-5 max-w-md leading-7 text-muted-foreground">Senkoは既存のツールを置き換えるのではなく、必要なときに選べる第二の選択肢を提供します。</p>
				</div>

				<div class="divide-y divide-border border-y border-border">
					{#each targetProblems as problem}
						<article class="grid grid-cols-[3rem_1fr] gap-5 py-8 sm:grid-cols-[4rem_1fr] sm:gap-7 sm:py-10">
							<p class="pt-1 font-mono text-xs font-semibold text-muted-foreground">{problem.number}</p>
							<div>
								<h3 class="text-xl font-semibold tracking-[-0.035em]">{problem.title}</h3>
								<p class="mt-2 max-w-xl text-sm leading-7 text-muted-foreground">{problem.copy}</p>
							</div>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="current" class="border-t border-border bg-background">
			<div class="mx-auto grid max-w-7xl gap-14 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-[0.72fr_1.28fr] lg:gap-24 lg:px-10">
				<div class="min-w-0">
					<Badge variant="muted">現在利用できます</Badge>
					<h2 class="mt-6 text-balance text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">無料で使える日本語対応CLI</h2>
					<p class="mt-5 max-w-md leading-7 text-muted-foreground">Senkoの管理サービスに契約せず、macOSとLinuxで利用できます。外部LLM APIの利用料は各提供元から別途発生します。</p>
				</div>

				<div class="divide-y divide-border border-y border-border">
					{#each currentFeatures as feature}
						<article class="grid grid-cols-[3rem_1fr] gap-5 py-7 sm:grid-cols-[4rem_1fr] sm:gap-7 sm:py-9">
							<div class="flex size-11 items-center justify-center rounded-lg bg-primary/25 text-foreground sm:size-12">
								<svelte:component this={feature.icon} class="size-5" strokeWidth={1.8} />
							</div>
							<div>
								<h3 class="text-xl font-semibold tracking-[-0.035em]">{feature.title}</h3>
								<p class="mt-2 max-w-xl text-sm leading-7 text-muted-foreground">{feature.copy}</p>
							</div>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="planned" class="border-y border-border bg-muted">
			<div class="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-32 lg:px-10">
				<div class="grid gap-5 lg:grid-cols-[0.72fr_1.28fr] lg:gap-24">
					<div><Badge variant="muted">未実装</Badge></div>
					<div>
						<h2 class="text-balance text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">これから提供するチーム向け機能</h2>
						<p class="mt-5 leading-7 text-muted-foreground">以下は現在のCLIには含まれておらず、まだ利用できません。</p>
					</div>
				</div>

				<div class="mt-14 divide-y divide-border border-y border-border lg:grid lg:grid-cols-3 lg:divide-x lg:divide-y-0">
					{#each plannedFeatures as feature, index}
						<article class={`py-7 lg:px-7 lg:py-9 ${index === 0 ? "lg:pl-0" : ""}`}>
							<p class="font-mono text-xs font-semibold text-muted-foreground">{feature.number}</p>
							<h3 class="mt-9 max-w-xs text-xl font-semibold tracking-[-0.035em]">{feature.title}</h3>
							<p class="mt-3 max-w-sm text-sm leading-7 text-muted-foreground">{feature.copy}</p>
						</article>
					{/each}
				</div>
			</div>
		</section>

		<section id="configuration" class="bg-[#181a18] text-[#f5f5f1]">
			<div class="mx-auto grid max-w-7xl items-center gap-14 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-[0.86fr_1.14fr] lg:gap-24 lg:px-10">
				<div class="min-w-0">
					<Badge class="border-white/15 bg-transparent text-white/60"><Code2 class="size-3" /> 現在の接続方法</Badge>
					<h2 class="mt-6 max-w-xl text-balance text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">Senko以外のLLM APIも選べます。</h2>
					<p class="mt-6 max-w-lg leading-7 text-white/55">base URL、APIキー、モデルを変更して任意のOpenAI互換APIに接続できます。管理モデルサービスはまだ提供していません。</p>
					<Button class="mt-9" href="https://github.com/abehuman/senko" target="_blank" rel="noreferrer">
						<GitFork class="size-4" /> ソースコードを見る <ArrowRight class="size-4" />
					</Button>
				</div>

				<div class="min-w-0 rounded-xl border border-white/12 bg-black/20 p-5 sm:p-8">
					<div class="flex items-center gap-2 font-mono text-[0.68rem] text-white/50"><Code2 class="size-3.5 text-primary" /> 接続設定</div>
					<pre class="mt-6 overflow-x-auto font-mono text-xs leading-7 text-white/70 sm:text-sm"><code><span class="text-primary">export</span> SENKO_BASE_URL=https://api.example.com/v1
<span class="text-primary">export</span> SENKO_API_KEY=your-key
<span class="text-primary">export</span> SENKO_API=openai-responses

senko <span class="text-white">"このリポジトリを要約してください"</span></code></pre>
					<div class="mt-7 flex items-start gap-3 border-t border-white/10 pt-5 text-xs leading-6 text-white/50">
						<LockKeyhole class="mt-1 size-3.5 shrink-0 text-primary" />
						CLIは無料です。外部LLM APIの料金は各提供元の契約に従います。APIキーは設定ファイルやセッションには保存しません。
					</div>
				</div>
			</div>
		</section>
	</main>

	<footer class="border-t border-border bg-background">
		<div class="mx-auto flex max-w-7xl flex-col items-start justify-between gap-5 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:items-center sm:px-8 lg:px-10">
			<p>Senko</p>
			<div class="flex items-center gap-5">
				<a class="transition-colors hover:text-foreground" href="https://github.com/abehuman/senko" target="_blank" rel="noreferrer">GitHub</a>
				<a class="transition-colors hover:text-foreground" href="https://github.com/abehuman/senko/blob/main/LICENSE" target="_blank" rel="noreferrer">MITライセンス</a>
			</div>
		</div>
	</footer>
</div>

<style>
	.animate-in {
		animation: enter 0.6s both;
	}

	.delay-1 {
		animation-delay: 70ms;
	}

	.delay-2 {
		animation-delay: 140ms;
	}

	.delay-3 {
		animation-delay: 210ms;
	}

	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.animate-in {
			animation: none;
		}
	}
</style>
