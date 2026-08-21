# Pi session runtime support

Sources: Pi's [session manager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)
and [agent session runtime](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session-runtime.ts).
Findings below were checked against Senko's installed `@earendil-works/pi-coding-agent` version `0.84.2`.

## Persistent session primitives

Pi's `SessionManager` persists append-only JSONL session trees. Its relevant public APIs are:

```ts
SessionManager.list(cwd, sessionsDir)
SessionManager.open(path, sessionsDir, cwdOverride?)
SessionManager.continueRecent(cwd, sessionsDir)
SessionManager.listAll(sessionsDir?)
```

`SessionInfo` includes `path`, `id`, `cwd`, `name`, `created`, `modified`, `messageCount`, and the first/all
message text. That is enough to build Senko's compact project-local picker without parsing session files itself.

Senko already wraps `list`, `open`, and `continueRecent` in
[`apps/cli/src/sessions.ts`](../../../apps/cli/src/sessions.ts). In particular, it supports exact IDs and an
unambiguous ID prefix, which `/resume` should preserve if it later gains a text argument.

## Correct session replacement API

Pi exposes `AgentSessionRuntime` specifically to own an active `AgentSession` plus its cwd-bound services.
`switchSession(sessionPath)` tears down the current runtime, builds a replacement from the stored factory, and
rebinds the current session. The runtime's factory is reused for new, resume, fork, and import flows.

This is the correct seam for Senko. Replacing only a `SessionManager` or mutating a reference held by the TUI would
leave stale event subscriptions, tools, resource loading, and model state attached to the prior session.

Pi documents that replacement creation errors propagate after teardown. Senko must therefore remove old TUI bindings
before switching and display a safe terminal error if activation fails. A cancellation returned by Pi, in contrast,
leaves the current runtime usable.

## Senko integration constraint

Senko currently calls `createAgentSession()` and passes its `AgentSession` directly to
[`apps/cli/src/ui/interactive.ts`](../../../apps/cli/src/ui/interactive.ts). Move that boundary to
`createAgentSessionRuntime()` with a Senko-controlled factory. The factory must retain the existing guarantees:

* `SettingsManager.inMemory()` and Senko's explicit tool set.
* Senko's provider and `SENKO_*` configuration resolution.
* Senko's portable resource loader.
* The explicit `$XDG_STATE_HOME/senko/sessions` directory.

Do not import Pi's own interactive mode or default session directory. Pi should supply the durable session and
replacement primitives only; Senko continues to own command parsing, the picker UI, configuration isolation, and
error presentation.
