# OpenCode `/new` and `/clear`

updated: 20260821

---

The current [OpenCode TUI documentation](https://dev.opencode.ai/docs/tui/) defines:

```text
/new    Start a new session
/clear  Alias for /new
```

Its session selector is a separate command, `/sessions`, with `/resume` and `/continue` as aliases.
That makes the boundary explicit: starting a new session and selecting an existing session are
different actions.

## Senko takeaway

This matches Senko's existing registry: `/clear` and `/new` should be aliases, while `/resume`
remains a separately researched session-picker workflow. In both cases, prior history remains a saved
session rather than being overwritten by the new-session action.
