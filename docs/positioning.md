# Product Positioning

## Target customer

Senko is for development teams at Japanese companies that already use Claude Code or Codex in their daily work and
want an additional coding-agent option. The primary buyer is a team, rather than an individual developer trying an AI
coding agent for the first time.

These teams are concerned about:

1. Strict usage limits and the resulting cost of keeping every team member productive.
2. Outages and operational risk caused by depending on a single model or inference provider.

## Positioning

Senko is a second execution path for AI-assisted development. It complements Claude Code and Codex rather than asking
teams to replace them.

The primary Japanese message is:

> AIコーディングを、利用上限や障害で止めない。

The supporting message is:

> Claude CodeやCodexを日常利用する日本企業の開発チームに、無料で使える日本語対応CLIと、コスト・速度・安定性を重視した厳選モデルを提供します。

## Product pillars

### 1. Free, provider-flexible CLI for Japanese users

The Senko CLI can be used in Japanese and connects to configurable OpenAI-compatible endpoints. The CLI itself is
free to use: teams can change the base URL, API key, protocol, and model without purchasing Senko's managed model
service. Any fees charged by a selected external API provider remain the user's responsibility.

This provider flexibility also supports authorized defensive security work. Claude and GPT models may refuse some
cybersecurity implementations because of abuse-prevention safeguards, even when the intended use is defensive. Senko
should explain that teams can choose a model suited to implementing security controls in systems they are authorized
to test. Do not frame this as bypassing another provider's safeguards or imply that Senko removes the selected model's
own safety controls.

Japanese-native command shortcuts and other workflows tailored to Japanese users are part of the product direction.
They must be described as planned until they are implemented.

### 2. Curated managed models

Senko will provide a small, curated catalog focused primarily on open-weight coding models. Selection and routing
should optimize for cost, speed, and operational stability rather than catalog size. Multiple inference routes should
reduce the likelihood that one upstream outage or period of congestion stops a team's work.

### 3. Per-member subscription plans

A team administrator will be able to assign a subscription plan to each member. Different members may receive
different plans so that spend and capacity can match how each person uses coding agents.

## Messaging rules

- Lead with continuity and risk distribution for existing Claude Code and Codex users.
- Present Senko as an additional option, not a universal replacement or a first-time AI coding tutorial.
- Keep the free CLI distinct from paid inference. Never imply that third-party LLM usage is free.
- Describe cybersecurity use cases as authorized defensive implementation, not unrestricted offensive capability or a
  way to bypass model safeguards.
- Describe Japanese interface features that exist today separately from Japanese-specific shortcuts that are planned.
- Describe the managed model service and team subscriptions as planned until they are actually available.
- Treat speed as one service attribute alongside cost and stability, not as Senko's entire category or positioning.
- Avoid presenting Senko as a broad model marketplace. Curation is part of the value proposition.
