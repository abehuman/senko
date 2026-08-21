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
senko --language ja
senko --help
senko --version
```

A non-TTY stdin stream automatically selects print mode. New sessions persist by default; use `--no-session` for an
ephemeral run. `--continue` selects the newest session for the current working directory, while `--resume` accepts an
exact session ID or a unique prefix.

Senko automatically compacts long sessions with the active model before their configured context limit. Before each
prompt, it includes the pending prompt in its estimate and keeps `maxOutputTokens` plus Pi's 4,096-token request
safety margin free. It preserves up to 20,000 recent tokens, leaves room for the generated summary, and replaces older
model-visible history with that persisted summary. The TUI shows compaction progress; print mode writes it to stderr
without mixing it into assistant stdout. If a provider still reports an early context overflow, Senko visibly
compacts and retries once.

Inside the interactive TUI, `/compact` performs the same compaction on demand and does not accept additional
instructions. `Escape` or `Ctrl+C` cancels an active manual or automatic compaction. `/exit` ends Senko and `/quit` is
its alias. The planned `/model`, `/new`, `/clear`, `/plan`, and `/resume` commands are recognized as placeholders and
currently display `This feature is not built yet.` without contacting the model.

## Configuration

Senko resolves settings from CLI flags, then `SENKO_*` environment variables, then the XDG configuration file.
There is no compiled production endpoint yet.

The interface supports English (`en`), Simplified Chinese (`zh-CN`), Traditional Chinese (`zh-TW`), and Japanese
(`ja`). Set it with `--language`, `SENKO_LANGUAGE`, or the `language` configuration field. When none is set, Senko
detects `LC_ALL`, `LC_MESSAGES`, `LANGUAGE`, `LANG`, then Node.js's runtime locale and falls back to English.
`LANGUAGE` may contain a colon-separated preference list. Detection is stateless and repeats on every launch until an
explicit language is set. Locale aliases such as `ja_JP.UTF-8`, `zh_CN`, `zh_Hans`, and `zh_Hant` are accepted.
Commands, option names, environment variables, and raw tool output remain unchanged across languages.

```sh
export SENKO_BASE_URL=https://example.com/v1
export SENKO_API_KEY=your-key
export SENKO_MODEL=fast
export SENKO_API=openai-completions
export SENKO_LANGUAGE=ja

pnpm dev -- --print "Summarize this repository"
```

The non-secret configuration file is `$XDG_CONFIG_HOME/senko/config.json`, or
`~/.config/senko/config.json` when `XDG_CONFIG_HOME` is unset:

```json
{
  "language": "ja",
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

`maxOutputTokens` must be at least 2, and `contextWindow` must be greater than `maxOutputTokens` plus the 4,096-token
request safety margin.

Sessions are stored under `$XDG_STATE_HOME/senko/sessions`, or `~/.local/state/senko/sessions` when
`XDG_STATE_HOME` is unset.

## Agent resources

Senko reads portable instructions from `AGENTS.md` files between the repository root and the working directory. It
discovers skills from repository `.agents/skills/` directories and from `~/.agents/skills/`. It does not load
`.pi`, `.claude`, `.opencode`, or `.senko` project resources.

See [the architecture](docs/architecture.md), [benchmark definitions](benchmarks/README.md), and
[future inference API contract](docs/inference-api.md) for details.

## Distribution

The CLI package is prepared as `@senkocode/cli` version `0.1.0`, with the executable name `senko`. It has not been
published from this repository yet. Follow the [release guide](docs/releasing.md) to verify and publish it.
