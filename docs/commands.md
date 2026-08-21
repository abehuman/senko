# Commands run with slash

Typing `/` in the interactive editor opens the command menu. Continue typing to filter it, then use
Up/Down and Enter (or Tab) to choose a command. For example, `/c` selects `/compact` first.

- `/model` ... change model and effort
- `/compact` ... compact context current session using AI
- `/clear` ... clear the current entire session from ui and start a new chat session
- `/new` ... call `/clear`
- `/plan` ... switch between edit mode and read-only plan mode
- `/resume` … resume past sessions
- `/exit` ... end cli app
- `/quit`... call `/exit`

## Implementation status to release

- [ ] `/model`
- [x] `/compact`
- [x] `/clear`
- [x] `/new`
- [ ] `/plan`
- [x] `/resume`
- [x] `/exit`
- [x] `/quit`

## Research before implementation

Research each command before implementing it. Detailed findings belong under `docs/research/<command>/`. Codex, Pi, OpenCode are target repo to research.

| Command | Research |
| --- | --- |
| `/model` | Not started |
| `/compact` | [`docs/research/compact`](research/compact/) |
| `/clear` | [`docs/research/clear`](research/clear/README.md) |
| `/new` | Covered by [`docs/research/clear`](research/clear/README.md); exact alias |
| `/plan` | [`docs/research/plan`](research/plan/README.md) |
| `/resume` | [`docs/research/resume`](research/resume/README.md) |
| `/exit` | Not needed; implemented |
| `/quit` | Not needed; implemented alias |
