# Codex `/clear`

updated: 20260821

---

The official [Developer commands reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
defines `/clear` as a full fresh-chat action:

1. It clears the terminal.
2. It resets the visible transcript and chat context.
3. It starts a fresh chat in the same CLI process.

It can take a name for the new chat, for example `/clear release prep`. The command is unavailable
while a task runs.

## Important distinction

Codex separates the two operations that Senko's v1 registry combines:

| Operation | Terminal view | Chat/session |
| --- | --- | --- |
| `Ctrl+L` | Clears only terminal output | Keeps the current chat |
| `/clear` | Clears terminal output | Starts a fresh chat |
| `/new` | Keeps terminal output | Starts a fresh chat |

The reference says `/new` can also name the new chat, but it intentionally does not clear terminal
output first.

## Senko takeaway

Senko must never implement `/clear` as a terminal escape sequence alone. It needs an actual session
replacement and transcript reset. Senko v1 intentionally makes `/new` an exact `/clear` alias instead
of importing Codex's terminal-view distinction; see the [recommendation](README.md).
