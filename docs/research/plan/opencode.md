# OpenCode Plan Agent

updated: 20260821

---

OpenCode separates planning from implementation by changing the active primary agent.

Source: [OpenCode Agents documentation](https://opencode.ai/docs/agents/).

## Entry and behavior

OpenCode has two built-in primary agents:

* **Build** is the default and has full tool access.
* **Plan** is selected with `Tab` (or the configured agent-switch key) and is intended for analysis,
  suggestions, and planning without changing the codebase.

The planning role remains part of the same main conversation. OpenCode also offers read-only `explore` and
`scout` subagents for codebase and external-document research.

## Permission boundary

The current documentation describes Plan as a restricted primary agent. Its default configuration sets file
edits and bash commands to `ask`; users can override it to deny both. In other words, the default is a
permission boundary with confirmation, not an unconditional guarantee that writes cannot happen.

This is flexible for teams that want a planning agent to run a harmless command, but it is a poor fit for
Senko's initial full-auto tool model: Senko has no per-command confirmation workflow to supply the missing
boundary.

## Lessons for Senko

* Switching a visible, long-lived mode is clearer than treating the word “plan” as prompt text.
* Reuse the conversation when changing mode; a separate session is unnecessary.
* Keep the v1 policy more restrictive than OpenCode's default: disable both `bash` and all mutation tools,
  while retaining dedicated local search tools.
