# Architecture

## Repository boundary

The pnpm workspace contains the published CLI package at `apps/cli`, the Hono Cloudflare Worker at `apps/api`, and the
static product website at `apps/website`. The website is independent of both runtimes and does not expose an inference
endpoint. The CLI defaults to `https://api.senkocode.com/v1`; production deployment of the Worker to that origin is a
separate operational step.

## API runtime

The Worker exposes public root and health checks plus authenticated OpenAI-compatible routes under `/v1`. Its explicit
authentication mode uses either account-owned Railway PostgreSQL keys or local/migration-only `SENKO_API_KEYS` bootstrap
keys, with no automatic fallback. Database authentication checks lifecycle and endpoint scope, then resolves every
accepted request to internal account/key IDs. It resolves `fast` through a server-owned curated model catalog, replaces
the alias before forwarding, and sends the request to one configured HTTPS LLM API. The Worker acquires an inference
lease for the resolved account/key IDs from one globally named Durable Object before reading or forwarding the request.
Bootstrap keys use their non-secret digest as both a synthetic account and key ID. The controller enforces fixed
per-key, per-account, and Worker-wide request and concurrency ceilings across isolates, so issuing more keys does not
multiply an account's request capacity. Requests larger than 1 MiB are rejected before JSON parsing. Output is capped
at 16,384 tokens or the model's lower declared limit, Chat Completions is restricted to one choice, provider responses are
capped at 8 MiB, and individual SSE events are capped at 256 KiB. Protocol-specific top-level allowlists rebuild the LLM
API request, force provider storage off, accept only client-defined function tools, reject unsupported hosted/stateful
features, and never forward client organization/project routing headers. Together with the request ceilings, those
constraints provide finite input and output exposure for the shared LLM API credential. The Worker combines Cloudflare's
incoming request signal with 60-second response-header, 45-second stream-idle, and five-minute total deadlines, performs
no automatic generation retries, and streams compatible successful response bodies without buffering.

Admission leases have a 90-second TTL, renew every 30 seconds without exceeding the request's absolute deadline, and are
released when the response body finishes or is cancelled. Transient renewal failures retry after five seconds; only a
confirmed missing lease or failure to renew before the ten-second expiry safety margin aborts inference. Persisted leases
from the previous schema retain their existing expiry as their migration deadline and use their former key ID as a
synthetic account ID until they expire. Idempotent release calls retry three
times and final renewal/release failures generate redacted warnings. Compatible provider 4xx errors are reconstructed
from only `message`, `type`, `code`, and `param`; provider account rate-limit headers and additional error metadata are not
exposed.

Configuration comes only from typed Cloudflare bindings. LLM API credentials, database URL, API-key HMAC secret,
management token, and bootstrap keys are secrets; the authentication mode, model metadata, `fast` target, and LLM API
base URL are text variables; and admission state uses a SQLite-backed Durable Object. Wrangler
preserves Dashboard-managed text variables during deploy and enables incoming request cancellation signals. Request
forwarding does not copy the client Authorization or provider-routing headers, prompt data is not logged by application
code, and responses receive a Worker-generated `x-request-id` plus Senko-owned rate-limit metadata. Billing,
user login and customer-facing management, usage-based account quotas, and multi-provider routing remain outside this
runtime.

Railway managed PostgreSQL in Singapore is the system of record for persistent identity. Production
and development/test databases are separate services in the same Railway project and environment. The versioned Drizzle
schema and generated migration define users, accounts, teams, memberships, account-owned API keys/scopes, and
administrative audit events with composite account-boundary constraints. The Worker uses the `pg` driver directly over
Railway's public PostgreSQL endpoint, creates and closes a bounded client per identity operation, and does not use a
process-global pool. Account creation, one-time API-key issuance, and revocation use a separate management Bearer token
and append an audit event in the same transaction. Raw keys are never persisted; request authentication uses public-ID
lookup plus HMAC verification and coalesces non-blocking `last_used_at` updates. Connection pooling is deferred until
measured latency or connection pressure justifies it. The initial migration is applied only to the development/test
database; production is unmigrated, and runtime secrets/role plus live Worker connectivity remain unconfigured.

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
