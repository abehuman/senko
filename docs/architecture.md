# Architecture

## Repository boundary

The pnpm workspace contains the published CLI package at `apps/cli`, the Hono Cloudflare Worker at `apps/api`, and the
static product website at `apps/website`. The website is independent of both runtimes and does not expose an inference
endpoint. The CLI defaults to `https://api.senkocode.com/v1`; production deployment of the Worker to that origin is a
separate operational step.

## API runtime

The Worker exposes public root and health checks plus authenticated OpenAI-compatible routes under `/v1`. It validates
client Bearer keys against the `SENKO_API_KEYS` Worker secret, resolves `fast` through a server-owned curated model
catalog, replaces the alias before forwarding, and sends the request to one configured HTTPS LLM API. The Worker
derives a non-secret SHA-256 identifier from each accepted key and acquires an inference lease from one globally named
Durable Object before reading or forwarding the request. That controller enforces fixed per-key and Worker-wide request
and concurrency ceilings across isolates. Requests larger than 1 MiB are rejected before JSON parsing. Output is capped
at 16,384 tokens or the model's lower declared limit, and Chat Completions is restricted to one choice. Together with
the request ceilings, those constraints provide finite input and output exposure for the shared LLM API credential. The
Worker passes the incoming abort signal to the LLM API `fetch`, performs no automatic retries, streams successful
response bodies without buffering, releases the inference lease when the upstream body finishes or is cancelled, and
normalizes non-compatible LLM API errors without exposing their response bodies.

Configuration comes only from typed Cloudflare bindings. LLM API and client keys are secrets; model metadata, the
`fast` target, and LLM API base URL are text variables; and admission state uses a SQLite-backed Durable Object. Wrangler
preserves Dashboard-managed text variables during deploy. Request forwarding does not copy the client Authorization
header, prompt data is not logged by application code, and responses receive a Worker-generated `x-request-id`. Billing,
persistent account/key storage, usage-based plan quotas, and multi-provider routing remain outside this initial runtime.

## Runtime flow

1. Resolve the interface locale from `--language`, `SENKO_LANGUAGE`, or the XDG configuration file. Without an
   explicit choice, detect `LC_ALL`, `LC_MESSAGES`, colon-separated `LANGUAGE` preferences, `LANG`, then the Node.js
   runtime locale before falling back to English. Detection is stateless and repeats on every launch. The best-effort
   bootstrap never prevents help output when configuration is invalid.
2. Parse CLI flags with localized usage errors and decide between help, version, session listing, print mode, and
   interactive mode.
3. Resolve non-secret settings from flags, documented `SENKO_*` environment variables where supported, the XDG
   configuration file, and built-in defaults. The API root defaults to `https://api.senkocode.com/v1`; model
   selection specifically uses `--model`, then the configuration file, then `fast`.
4. Load Senko's built-in base instructions from its bundled Markdown asset and discover portable `AGENTS.md` and
   `.agents/skills` resources without loading vendor-specific directories.
5. Register one in-memory `senko` model provider with Pi's `ModelRuntime`.
6. Select an in-memory or XDG-backed Pi `SessionManager`.
7. Create the Pi `AgentSession` with full-auto read, write, edit, and shell tools.
8. Enable context compaction with one maximum-output response plus Pi's fixed 4,096-token request margin reserved,
   at most 20,000 recent tokens retained, and room left for the generated summary.
9. Project Pi events into either stable stdout/stderr output or Senko's Pi-TUI-based interactive view using the
   selected locale for Senko-owned text while preserving model, provider, tool, and shell output verbatim.

Pi credentials, model files, settings, branded entrypoints, extensions, prompt templates, and themes are not loaded.
Senko owns those policy boundaries while Pi supplies the agent loop, OpenAI-compatible protocols, tools, sessions,
and low-level terminal components.

Before submitting a prompt, Senko estimates its tokens together with the current session usage. If that total exceeds
`contextWindow - maxOutputTokens - 4,096`, Senko compacts first and submits the prompt only after compaction succeeds.
A cancelled or failed preflight compaction does not send the pending prompt. Pi's built-in threshold and one-time
provider-overflow recovery remain enabled as fallbacks while the agent is already working.

## Storage

- Configuration: `$XDG_CONFIG_HOME/senko/config.json`, falling back to `~/.config/senko/config.json`.
- Sessions: `$XDG_STATE_HOME/senko/sessions`, falling back to `~/.local/state/senko/sessions`.
- Credentials: process memory only, sourced from `SENKO_API_KEY`.

Session history records the model and protocol information Pi needs to restore a conversation, but current runtime
configuration controls the endpoint used after resume. Secret values are never placed in session metadata.

## Performance policy

Senko does not perform model discovery, update checks, telemetry, or provider fallback. Normal inference retries are
disabled. Pi's single context-overflow compact-and-retry path is enabled and surfaced in the TUI or print-mode stderr.
Performance measurements are informational in milestone 1; stable budgets will be set after a production inference
endpoint exists.
