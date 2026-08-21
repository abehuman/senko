# `/plan` research

updated: 20260821

---

`/plan` should be a safe, sticky planning state, rather than a magic prompt that merely asks the model to
be careful. The common shape is:

```text
enter a read-only mode
  -> inspect the codebase and discuss trade-offs
  -> present a concrete, file-level plan
  -> user explicitly switches or approves into an editing mode
```

The details vary among tools, but their safety boundary is consistent: planning must not leave normal write
or shell execution available just because the model was told not to use them.

## Research summary

| Tool | Entry | Safety boundary | Handoff |
| --- | --- | --- | --- |
| [OpenCode](opencode.md) | Switch from Build to the Plan primary agent | Permission policy asks before edits and shell commands | Switch back to Build after reviewing the proposal |
| [Pi 0.84.2](pi.md) | Senko must provide the command and mode state | `AgentSession` can activate a read-only tool set | Senko must provide its own UI and transition policy |

## Recommendation for Senko v1

Use an interactive-only, session-scoped mode with the following contract:

1. **Default to editing.** A new interactive session starts in edit mode with Senko's existing `read`,
   `bash`, `edit`, and `write` tools.
2. **Enter before submitting a goal.** `/plan <goal>` changes the mode first, then sends `<goal>` to the
   model. Bare `/plan` only changes mode. This avoids one turn that can still mutate the workspace.
3. **Make planning hard read-only.** In plan mode, activate only Pi's `read`, `grep`, `find`, and `ls`
   tools. Do not leave `bash` enabled with a prompt-only promise to use read-only commands: it can write,
   execute programs, or reach the network.
4. **State the planning contract in every planning turn.** The model should report findings, a concrete
   ordered approach, validation, and unresolved decisions. It must not claim it made changes or offer to
   continue directly into implementation.
5. **Show and control the mode clearly.** The footer should say `plan · read-only`; bare `/plan` while
   planning returns to `edit`. No model call is needed for either toggle.
6. **Keep approval explicit.** An approved plan remains a normal assistant response in the session. The
   user returns to edit mode and submits an implementation request. V1 does not write a plan artifact or
   infer approval from prose such as “looks good”.

Senko currently has no editable plan-artifact or per-action approval UI, so an automatic plan-to-edit handoff
would create a larger policy surface than a first `/plan` command needs.

## Senko implementation implications

Senko currently passes `read`, `write`, `edit`, and `bash` to Pi when it creates the session in
[`apps/cli/src/runtime.ts`](../../apps/cli/src/runtime.ts). Pi's `AgentSession` owns the active tool set and
rebuilds the model-visible system prompt when that set changes. The implementation should therefore:

```text
PlanModeController
  owns: "edit" | "plan"

enter plan
  -> session.setActiveToolsByName(["read", "grep", "find", "ls"])
  -> update TUI footer and the per-turn planning instruction

leave plan
  -> session.setActiveToolsByName(["read", "bash", "edit", "write"])
  -> update TUI footer
```

The per-turn planning instruction is still necessary for useful output, but it is not the safety mechanism;
the active-tool change is. Before implementation, verify how to record the mode outside model-visible
messages so that resuming a session cannot silently re-enable editing. The existing Pi custom-message and
session-entry APIs need a focused investigation for that follow-up.

## Deliberate non-goals for v1

* Plan files, an external-editor workflow, or a durable plan registry.
* A separate planning model or model-routing policy.
* Running tests, package scripts, Git commands, web requests, or any other shell command in plan mode.
* Automatic mode changes based on model text or natural-language approval.
* Changing non-interactive `--print` behavior.
