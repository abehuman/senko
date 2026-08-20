# Senko

Senko is a fast AI coding agent for macOS and Linux terminals. Its first milestone embeds the
[Pi coding-agent SDK](https://github.com/earendil-works/pi) behind a small Senko-owned CLI and user interface.

> [!WARNING]
> Senko currently runs read, write, edit, and shell tools automatically with the same host permissions as the
> terminal process. There is no sandbox or per-tool approval prompt yet. Run it only in workspaces and environments
> you trust.

## Requirements

- Node.js 22.19.0 or newer
- pnpm 10.34.1 for development
- macOS or Linux

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm dev -- --help
```

Run every local verification step with:

```sh
pnpm check
pnpm smoke:pack
```

Record a non-gating local performance baseline with:

```sh
pnpm bench
```

## CLI usage

```text
senko [initial prompt]
senko --print <prompt>
senko --continue
senko --resume <session-id>
senko sessions
senko --help
senko --version
```

A non-TTY stdin stream automatically selects print mode. New sessions persist by default; use `--no-session` for an
ephemeral run. `--continue` selects the newest session for the current working directory, while `--resume` accepts an
exact session ID or a unique prefix.

## Configuration

Senko resolves settings from CLI flags, then `SENKO_*` environment variables, then the XDG configuration file.
There is no compiled production endpoint yet.

```sh
export SENKO_BASE_URL=https://example.com/v1
export SENKO_API_KEY=your-key
export SENKO_MODEL=fast
export SENKO_API=openai-completions

pnpm dev -- --print "Summarize this repository"
```

The non-secret configuration file is `$XDG_CONFIG_HOME/senko/config.json`, or
`~/.config/senko/config.json` when `XDG_CONFIG_HOME` is unset:

```json
{
  "baseUrl": "https://example.com/v1",
  "api": "openai-completions",
  "model": "fast",
  "contextWindow": 32768,
  "maxOutputTokens": 4096,
  "reasoning": false
}
```

API keys are accepted only through `SENKO_API_KEY`; they are never read from the configuration file or written to
session files. Loopback endpoints can run without a user-supplied key. `baseUrl` is the complete API root: Senko
removes one trailing slash but never appends `/v1`.

Sessions are stored under `$XDG_STATE_HOME/senko/sessions`, or `~/.local/state/senko/sessions` when
`XDG_STATE_HOME` is unset.

## Agent resources

Senko reads portable instructions from `AGENTS.md` files between the repository root and the working directory. It
discovers skills from repository `.agents/skills/` directories and from `~/.agents/skills/`. It does not load
`.pi`, `.claude`, `.opencode`, or `.senko` project resources.

See [the architecture](docs/architecture.md), [benchmark definitions](benchmarks/README.md), and
[future inference API contract](docs/inference-api.md) for details.

## Distribution

The CLI package is prepared as `@senko/cli` with the executable name `senko`. Milestone 1 does not publish it.
