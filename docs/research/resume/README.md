# `/resume` research

updated: 20260821

---

`/resume` is a session switch, not a prompt. It must replace the active agent runtime with a selected persisted
conversation, show that conversation's transcript, and make the next user turn append to that conversation.
Selecting a session must never send a model request.

## Research summary

| Tool | Interactive entry | Scope | Transcript policy |
| --- | --- | --- | --- |
| [Codex](codex.md) | `/resume` opens a saved-session picker | Current directory by default; broader selection is explicit | Reloads the selected chat and keeps its prior history |
| [OpenCode](opencode.md) | Its terminal launcher accepts continuation or an explicit session ID | Session listing is separate; continuation can explicitly fork | A fork is opt-in rather than an accidental consequence of resume |
| [Pi 0.84.2](pi.md) | Senko must provide the picker and command routing | `SessionManager.list(cwd, sessionsDir)` supplies project sessions | `AgentSessionRuntime.switchSession()` replaces the active runtime |

## Recommendation for Senko v1

Implement `/resume` as an interactive-only, idle-only session picker with this contract:

1. **Project scope only.** List sessions with `SessionManager.list(cwd, sessionsDir)` and do not offer an
   all-project search in v1. Senko already stores all persisted sessions beneath its XDG state directory, while
   the session metadata retains the project directory. This keeps a session's tool working directory unambiguous.
2. **Use a compact, deterministic picker.** Sort newest first, then display a 12-character ID prefix, modified
   time, message count, and the saved name or first prompt. `Esc` cancels; `Enter` resumes the highlighted
   session. An empty list should say that no saved sessions exist for this directory.
3. **Resume only while idle.** Do not let `/resume` interrupt a model turn or tool call. It opens no prompt and
   creates no transcript entry. If selection is cancelled, the active session and its footer remain unchanged.
4. **Switch the complete runtime.** Give the TUI an `AgentSessionRuntime`, call
   `runtime.switchSession(selected.path)`, rebind its event subscription, and render `runtime.session.messages`.
   Pi tears down the old runtime and reconstructs the selected one; keeping a stale `AgentSession` reference is
   unsafe after that transition.
5. **Use the current Senko configuration for future turns.** The selected transcript retains the earlier model and
   protocol entries needed to reconstruct its context, but new inference must use the current `SENKO_*`, config,
   and command-line settings. Make the footer show the current configuration, not a historical promise.
6. **Keep `--no-session` ephemeral.** In that mode, `/resume` must explain that saved-session resume is disabled.
   Switching into a persisted session would violate the flag's existing memory-only contract.
7. **Handle failed activation cleanly.** Validate the selected file before switching. If Pi cannot reconstruct the
   replacement runtime, show a clear error and leave no interactive input bound to the disposed session; restarting
   Senko is safer than continuing from a stale view.

## Existing Senko boundary

Senko already has non-interactive selection paths:

* `senko sessions` lists sessions for the current directory.
* `senko --continue` opens the newest session for that directory.
* `senko --resume <id-or-unique-prefix>` opens one selected session.

These are implemented in [`apps/cli/src/sessions.ts`](../../../apps/cli/src/sessions.ts) using the XDG directory
from [`apps/cli/src/paths.ts`](../../../apps/cli/src/paths.ts). `/resume` should reuse those selectors and their
exact-prefix error behavior, rather than creating a second session format or reading Pi's own configuration.

The current interactive loop receives only an `AgentSession`, so it cannot safely replace that session in place.
Refactor the runtime boundary to retain Pi's public `AgentSessionRuntime` and pass it to the TUI. Construct it with
Senko's in-memory settings, provider, resource loader, and explicit XDG session directory; do not invoke Pi's CLI
interactive mode or load any Pi configuration.

## Deliberate non-goals for v1

* An argument form such as `/resume <id>`.
* Searching or resuming another project’s sessions.
* Forking, renaming, exporting, importing, archiving, deleting, or sharing sessions.
* A transcript preview pane, full-text search, pagination, or background indexing.
* Resuming a saved session from `--no-session` mode.
* Changing the established command-line `--continue` and `--resume` behavior.

## Acceptance checks before implementation

* With multiple sessions in the current directory, the picker is newest-first and exposes only the documented
  compact metadata.
* Cancelling does not change the active session ID, transcript, footer, or make an inference request.
* Selecting a session rebuilds and renders its saved transcript; the next prompt is appended to that selected
  session, not the one that was active before selection.
* `/resume` while busy and while `--no-session` each return an explanatory local UI message without changing
  session state.
* A missing or unreadable session file fails visibly without presenting input attached to a disposed runtime.
* Existing CLI tests for `sessions`, `--continue`, `--resume`, and `--no-session` continue to pass.
