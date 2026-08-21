# Pi 0.84.2 capabilities for Senko Plan Mode

updated: 20260821

---

Senko uses `@earendil-works/pi-coding-agent@0.84.2`. This installed version has the primitives needed for a
hard tool boundary; Senko needs to add only its mode state, command routing, UI state, and planning prompt
policy.

## Tool registry and active tools

Pi's `AgentSession` creates definitions for these built-in tools:

```text
read, bash, edit, write, grep, find, ls
```

`AgentSession.setActiveToolsByName(toolNames)` changes the active tool list for the next turn and rebuilds the
model-visible system prompt to match it. Pi's `createReadOnlyTools()` factory is exactly:

```text
read, grep, find, ls
```

The relevant installed implementation is:

* `apps/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`
  (`setActiveToolsByName`)
* `apps/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`
  (`createAllToolDefinitions` and runtime rebuilding)
* `apps/cli/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js`
  (`createReadOnlyTools`)

## Current Senko boundary

Senko currently creates every session with only the coding set enabled:

```ts
tools: ["read", "write", "edit", "bash"]
```

See [`apps/cli/src/runtime.ts`](../../apps/cli/src/runtime.ts). `/plan` is still handled by the placeholder
path in [`apps/cli/src/ui/input.ts`](../../apps/cli/src/ui/input.ts), and no mode state is shown in
[`apps/cli/src/ui/interactive.ts`](../../apps/cli/src/ui/interactive.ts).

The session's internal registry already contains `grep`, `find`, and `ls`, despite not activating them at
startup. A Plan Mode controller can therefore switch to the read-only set without recreating the model,
resource loader, or session.

## Constraint to preserve

`setActiveToolsByName()` gives an enforcement boundary, but it does not itself express why the model is in
plan mode or prescribe the output format. Senko must add one planning instruction for every planning turn.
That instruction is complementary to, not a replacement for, the active-tool allowlist.

Pi's session APIs also need a targeted follow-up investigation before mode persistence is added. Do not encode
the mode by inserting fake natural-language user or assistant messages, because those messages would alter the
conversation the model receives.
