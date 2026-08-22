# Senko

[日本語](README.md) | English

Senko is a free, Japanese-capable AI coding agent for macOS and Linux terminals. Built on the
[Pi coding-agent SDK](https://github.com/earendil-works/pi), it can connect to any OpenAI-compatible endpoint.

> [!WARNING]
> Senko currently runs `read`, `write`, `edit`, and `shell` tools automatically with the same host permissions as the
> terminal process. There is no sandbox or per-tool approval prompt yet. Run it only in workspaces and environments
> you trust.

## Installation

Senko requires Node.js 22.19.0 or newer and supports macOS and Linux.

```sh
npm install --global @senkocode/cli
```

## Quick start

The Senko API is not available yet. Configure the URL and API key for an OpenAI-compatible API. The CLI itself is
free, but the external API provider may charge for usage.

```sh
export SENKO_BASE_URL=https://api.example.com/v1
export SENKO_API_KEY=your-key

senko --model your-model
```

## Usage

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

Inside the interactive TUI, `/` or the Japanese full-width `；` opens the command menu. Full-width Latin letters also
filter the menu, while completed command names remain ASCII. `/compact` compacts the current context on demand.
`/clear` starts a new session and `/new` is its alias. `/resume` opens the saved-session picker. `/exit` ends Senko and
`/quit` is its alias. `/model` and `/plan` are not implemented and display guidance without contacting the model.

Long sessions automatically compact before reaching the context limit. Progress stays in the TUI or goes to stderr
in print mode without mixing into assistant stdout. `Escape` or `Ctrl+C` cancels active manual or automatic
compaction.

## Configuration

Each setting uses the following precedence:

| Setting | Precedence |
| --- | --- |
| API root | `--base-url` → `SENKO_BASE_URL` → `baseUrl` → `https://api.senkocode.com/v1` |
| API protocol | `--api` → `SENKO_API` → `api` → `openai-completions` |
| Model | `--model` → `model` → `fast` |
| Interface language | `--language` → `SENKO_LANGUAGE` → `language` → OS locale detection → English |
| API key | `SENKO_API_KEY` only |
| `contextWindow` | Configuration file → `32768` |
| `maxOutputTokens` | Configuration file → `4096` |
| `reasoning` | Configuration file → `false` |

In the table, `baseUrl`, `api`, `model`, and `language` are fields in the XDG configuration file. Model selection has
no environment-variable override.

The interface supports Japanese (`ja`) and English (`en`). Without an explicit choice, Senko detects `LC_ALL`,
`LC_MESSAGES`, `LANGUAGE`, `LANG`, then Node.js's runtime locale. `LANGUAGE` may contain a colon-separated preference
list. Locale aliases such as `ja_JP.UTF-8` and `en_US.UTF-8` are accepted. Commands, option names, environment
variables, and raw tool output remain unchanged across languages.

The non-secret configuration file is `$XDG_CONFIG_HOME/senko/config.json`, or
`~/.config/senko/config.json` when `XDG_CONFIG_HOME` is unset:

```json
{
  "language": "ja",
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

Senko's built-in base instructions live in [`apps/cli/src/prompts/base.md`](apps/cli/src/prompts/base.md) and are
bundled with the CLI. Senko also reads portable instructions from `AGENTS.md` files between the repository root and
the working directory. It discovers skills from repository `.agents/skills/` directories and from
`~/.agents/skills/`. It does not load `.pi`, `.claude`, `.opencode`, or `.senko` project resources.

## Development

Development uses pnpm 10.34.1.

```sh
pnpm install
pnpm build
pnpm test
pnpm dev -- --help
```

```sh
pnpm dev:website
pnpm check
pnpm smoke:pack
pnpm bench
```

See the [architecture](docs/architecture.md), [benchmark definitions](benchmarks/README.md), and
[release guide](docs/releasing.md) for contributor documentation.
