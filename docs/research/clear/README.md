# `/clear` research

updated: 20260821

---

`/clear` must start a fresh session; it must not delete, truncate, or mutate the prior
transcript. Senko's registry already defines `/new` as `/clear`, so v1 should expose both
spellings as exact aliases rather than make them subtly different operations.

## Research summary

| Tool | Canonical command | Terminal behavior | Session behavior |
| --- | --- | --- | --- |
| [Codex](codex.md) | `/clear` | Clears terminal output | Creates a fresh chat; its `/new` preserves terminal output |
| [OpenCode](opencode.md) | `/new` | Not separately documented | `/clear` is an alias for a new session |
| [Pi 0.84.2](pi.md) | `/new` | Not separately documented | Replaces the live session through `AgentSessionRuntime.newSession()` |

## Recommendation for Senko v1

Implement `/clear` and `/new` as interactive-only, idle-only aliases with this contract:

1. **Create a session; do not erase one.** The active session remains available to `senko sessions`,
   `--continue`, and `--resume`. A persisted run receives a new empty session file; `--no-session`
   receives a new in-memory session and never writes to disk.
2. **Clear the terminal and transcript view.** After the new session is active, clear the terminal
   screen, remove the rendered transcript and all transient stream/tool/compaction components, clear
   the editor text, and render the new session's (initially empty) history. Preserve the header and
   the interactive process itself.
3. **Use the replacement runtime.** Refactor Senko to construct Pi's public
   `AgentSessionRuntime` from its own in-memory settings, provider, resource loader, tool list, and
   XDG session directory. Invoke `await runtime.newSession()`, then rebind the TUI event subscriber
   to `runtime.session`. `AgentSession` itself must not be reused after replacement.
4. **Keep the command local.** Neither spelling sends a model prompt, adds a user or assistant
   transcript entry, invokes tools, or makes an inference request. Reject arguments with a local
   `Usage: /clear` message rather than treating them as a prompt or a session name.
5. **Run only while idle.** While a model turn, tool call, or compaction is active, leave the input
   as a normal busy state and do not switch sessions. Senko already disables editor submit then; the
   slash router must keep that guard.
6. **Switch UI only after runtime success.** Do not discard the visible session before
   `runtime.newSession()` resolves. If the replacement fails after Pi has torn down the old session,
   display the error and end the interactive run rather than leave input attached to a disposed
   session.
7. **Make the footer dynamic.** Recompute the 12-character session ID and all session-bound labels
   after the switch. The current footer closes over the startup ID, so it would otherwise show the
   wrong session after `/clear`.

This deliberately adopts the registry's existing aliases. Codex distinguishes `/clear` from `/new`,
but that distinction is not useful for Senko v1: one predictable reset is faster to learn and avoids
two session-creation paths.

## Existing Senko boundary

[`apps/cli/src/ui/input.ts`](../../../apps/cli/src/ui/input.ts) recognizes both spellings as
not-built placeholders. [`apps/cli/src/ui/interactive.ts`](../../../apps/cli/src/ui/interactive.ts)
receives a fixed `AgentSession`, builds the footer from its startup ID, and holds the event
subscription in a closure. [`apps/cli/src/runtime.ts`](../../../apps/cli/src/runtime.ts) creates that
single session with Senko-owned settings and tools.

`/clear`, `/new`, and the documented `/resume` recommendation therefore share one prerequisite:
make the TUI own a replaceable `AgentSessionRuntime`, centralize teardown/rebind/render in one helper,
and retain the current Senko-controlled construction factory. Do not start Pi's own interactive
mode, read its configuration, or use its default session location.

## Deliberate non-goals for v1

* A confirmation dialog: this operation preserves the prior transcript.
* Naming a fresh session with `/clear <name>` or `/new <name>`.
* A separate terminal-only clear shortcut; terminal emulators already provide one.
* Closing the CLI, deleting the prior session, archive management, forking, or a session picker.
* Changing the behavior of `senko --continue`, `senko --resume`, or `senko sessions`.

## Acceptance checks before implementation

* Each alias creates a different session ID and clears the rendered history, while the old session
  remains selectable through `senko sessions`.
* The newly active session receives the next prompt; the old session receives no entries after the
  reset.
* `/clear` and `/new` produce zero inference requests and no transcript command message.
* The terminal is cleared only after the replacement session becomes active; the header, editor, and
  process remain usable.
* A command argument produces `Usage: /clear` without session or UI mutation.
* `--no-session` stays memory-only across both aliases.
* Running either spelling while busy changes neither session nor visible transcript.
* A forced replacement failure does not leave a session subscription or editor input bound to a
  disposed `AgentSession`.
