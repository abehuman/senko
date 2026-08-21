# Pi `/new`

updated: 20260821

---

Senko uses `@earendil-works/pi-coding-agent` **0.84.2**. Its bundled
[usage documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md)
lists `/new` as the command that starts a new session. Pi renamed its previous `/clear` spelling to
`/new` in 0.29.0, so `/clear` is not a current built-in command to mirror.

## Runtime requirement

Pi's bundled [session-runtime example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/13-session-runtime.ts)
states that any new-session, resume, fork, or import flow must use `AgentSessionRuntime`. Its core
pattern is:

```ts
await runtime.newSession();
const session = runtime.session;
// rebind subscriptions and session-local UI state to session
```

The active `AgentSession` is replaced. The old event subscription and any UI state that closed over
the old session must be discarded before binding to `runtime.session` again.

## Senko takeaway

Create a Senko-owned `AgentSessionRuntime` factory that reproduces the current explicit provider,
in-memory settings, resource loader, tool allowlist, and XDG session directory on each replacement.
This lets `/clear`, `/new`, and `/resume` share one safe session-transition boundary without loading
Pi configuration or entering Pi's interactive mode.
