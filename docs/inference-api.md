# Senko Inference API Contract

Status: milestone 2 initial implementation. The Cloudflare Worker implementation lives in `apps/api`; configuring
production credentials and deploying it remain separate operational steps.

## Goals

The Senko inference API is a Hono Cloudflare Worker optimized for a small, curated catalog focused primarily on
open-weight coding models. Model selection and routing prioritize cost, latency, and operational stability instead of
catalog size. The product direction includes multiple managed inference routes so that one LLM provider outage or period
of congestion does not stop a team's work.

The initial implementation has trusted, server-configured OpenAI-compatible provider destinations, protocol-specific
response adapters, deterministic multi-route priority selection, and route-keyed provider capacity/circuit state.
Client requests cannot choose an arbitrary LLM provider; Senko owns the curated catalog and managed routing policy.
Capacity or circuit-open routes can be skipped before forwarding, while real-provider redundancy and post-attempt
fallback remain unverified and disabled respectively.

The service exposes OpenAI-compatible streaming interfaces so Senko and other standard clients can use it without a
proprietary transport.

## Authentication

Every `/v1/*` request requires:

```http
Authorization: Bearer <senko-api-key>
```

Invalid or missing credentials return `401`. Authorization failures must not reveal whether an account or key once
existed. LLM API credentials remain Worker secrets and are never sent to clients.

`SENKO_AUTH_MODE=database` authenticates account-owned keys through Railway PostgreSQL. Keys use a versioned
`sk-senko-v1-...` format and are stored only as a public lookup ID, display prefix, and versioned HMAC. Authentication
checks key, account, optional team, expiry, and endpoint scope on every request. Invalid, expired, revoked, or
inactive-owner credentials use the same `401` response; a valid key without the required scope returns `403`.

`SENKO_AUTH_MODE=bootstrap` retains the comma/newline-delimited `SENKO_API_KEYS` secret only for local development and
controlled migration. The mode is mandatory, and database failure never silently falls back to bootstrap keys. In
bootstrap mode, the Worker derives a SHA-256 identifier for admission isolation without storing or forwarding the key.

The Railway PostgreSQL schema and generated migrations define users, accounts, teams, memberships, account-owned API
keys, the `models:read`, `inference:chat`, and `inference:responses` scopes, rotation/expiry/revocation metadata, and
administrative audit events, plus account/API-key usage limits, aggregate buckets, immutable provider attempts,
append-only usage events, and content-free final request envelopes independent of usage reservation. The initial IAM migration is applied only to the development/test database; the usage and request-trace migrations have not
been applied to a live database. Direct Worker
connection and identity code are source-complete, but the Worker secret, least-privilege runtime role, deployed
connection, and authenticated external test are not configured yet.

The protected R0 operator boundary can create accounts, list bounded account metadata, create account-owned teams, list and archive/reactivate teams,
suspend/reactivate an account, and issue, list, rotate, and revoke account-owned API keys. Account/team suspension takes
effect for new authentication after the transaction commits; it does not forcibly terminate requests already
authenticated or forwarded. Team archive is reversible and does not revoke its keys, so reactivation restores any
otherwise-valid team keys. Customer users, memberships, administrative roles, and entitlement management remain R2
work and must replace the global operator credential before customer self-service administration.

The same R0 boundary exposes bounded account-owned administrative audit history. Responses contain only the event ID,
account ID, actor type, action, target type/ID, Senko request ID, and timestamp. Stored JSON metadata and actor user/API
key identifiers are deliberately excluded. An allowlist makes unreviewed event shapes fail closed instead of silently
becoming externally visible. Customer-scoped audit access remains part of the future role model.

## Endpoints

### `GET /openapi.json`

Returns the source-controlled OpenAPI 3.1 contract without authentication. The document distinguishes account-owned
Senko API keys from the separate operator credential, declares the required inference scope per operation, and keeps
request schemas aligned with the runtime top-level allowlists. A production URL is not claimed until the Worker and
custom domain are deployed through the separately approved release process.

### `GET /v1/models`

Returns only models approved for Senko's low-latency service. `fast` is a stable alias and may resolve to a different
underlying model as routing policy changes. Model records should additionally expose `context_window`,
`max_output_tokens`, supported protocols, input modalities, and reasoning support.

### `POST /v1/chat/completions`

Implements OpenAI Chat Completions requests, including streamed `text/event-stream` responses, tool definitions,
parallel tool calls, tool results, stop reasons, and usage. Streaming terminates with `data: [DONE]`.

### `POST /v1/responses`

Implements the OpenAI Responses event stream, including output text, reasoning summaries when supported, function
calls, function-call outputs, terminal response events, and usage. Responses streams terminate with a validated typed
terminal event; the Chat Completions-only `[DONE]` sentinel is rejected on this protocol. The official
`response.queued` event is accepted as a nonterminal lifecycle event, but a non-stream queued response is rejected
because this service does not expose background requests.

Both endpoints accept `model: "fast"`. Every response and terminal stream event reports the resolved underlying model
identifier rather than only echoing the alias.

Request bodies are limited to 1 MiB and rejected with `413 request_too_large` before JSON parsing or LLM API forwarding.
Each request is capped at 16,384 output tokens or the selected model's lower `max_output_tokens` value. Chat Completions
supports exactly one choice (`n: 1`) so a client cannot multiply generations inside one admitted request. Provider JSON
and ordinary SSE chunks must contain exactly choice index `0`; only the final usage chunk may have empty `choices`.

The Worker rebuilds requests from protocol-specific top-level allowlists instead of forwarding arbitrary JSON. It
supports the text, reasoning, response-format, prompt-cache-key, and client-defined function-tool fields used by the
Senko CLI. Unknown fields are rejected. Provider-side storage, background requests, service-tier selection, metadata,
conversation/previous-response continuation, long cache-retention selection, hosted files, hosted tools, and input
modalities not declared by the selected model are not available. `model`, output ceilings, `n`, and `store: false` are
server-owned values. Client `OpenAI-Organization` and `OpenAI-Project` headers are never forwarded.

Successful provider JSON is not forwarded unchanged. The adapter validates completed Chat Completions and terminal
completed/incomplete/failed Responses core shapes, rebuilds allowed top-level fields, and replaces provider-reported model names with the
resolved Senko model ID. Streaming data is buffered to event boundaries and re-emitted only after JSON, known event
type, core chunk/response shape, and protocol terminator validation. Unknown, malformed, or unterminated streams are
closed as failed. A successful provider status without a response body is also treated as an invalid provider response
and returned as a Senko-owned `502` error instead of forwarding the provider status. Provider redirects are rejected
instead of forwarding the provider credential or customer request body to an origin outside the trusted registry; full
field-level tool/reasoning fixtures for each eventual provider route remain pending.
The published OpenAPI document describes supported nested messages, content parts, function tools, tool results,
structured-output controls, and normalized JSON success envelopes instead of generic object placeholders.

## Errors and operational metadata

Non-streaming errors use an OpenAI-compatible envelope:

```json
{
  "error": {
    "message": "Human-readable summary",
    "type": "invalid_request_error",
    "code": "invalid_model",
    "param": "model"
  }
}
```

Responses include `x-request-id` plus Senko-owned request/concurrency limit, remaining, and reset headers. Provider
account-wide rate-limit values are not exposed. Usage remains part of the LLM API's compatible response body or stream.
Once streaming has started, a Senko deadline, response limit, admission failure, client cancellation, or LLM API transport
failure closes the stream because its HTTP status can no longer be replaced; clients must treat a stream without its
normal protocol terminator as failed.

The initial Worker generates `x-request-id` itself and preserves `retry-after` on compatible LLM API errors. Before
forwarding inference, one globally named Durable Object enforces fixed safety
ceilings of 20 requests per minute and 2 concurrent requests per API key, 60 requests per minute and 6 concurrent
requests per account, plus 120 requests per minute and 12 concurrent requests across the Worker. Creating more API keys
does not increase an account's ceiling. Rejections return `429 rate_limit_exceeded` with `Retry-After`. A lease has a
90-second TTL,
renews every 30 seconds while its request remains active, and can never outlive that request's absolute five-minute
deadline. A transient renewal failure retries after five seconds. Inference is aborted only when the lease is confirmed
missing or cannot be renewed before a ten-second expiry safety margin. Persisted leases from the previous schema are
migrated without dropping concurrency ownership by using their existing expiry as the deadline and their key ID as a
synthetic account ID. Release is idempotent and
retried up to three times; final renewal/release failure emits a redacted structured warning.

For database-authenticated inference, the selected model must have versioned currency pricing and the account must have
explicit minute-token, maximum-request-cost, daily-cost, and monthly-cost limits. The Worker atomically reserves the
maximum estimated cost before provider forwarding. It settles input/output usage only after a terminal Chat Completions
usage chunk plus `[DONE]`, or a validated terminal Responses event/response with usage, and releases unused capacity.
Missing usage, unconfirmed completion, non-2xx responses, and other uncertain outcomes conservatively settle the full
reservation. Non-2xx reservations are not released until a provider adapter can prove a pre-generation rejection.
Expired reservations are claimed from an expiry-indexed pending queue with `FOR UPDATE SKIP LOCKED` and conservatively
finalized in one bounded transaction by a five-minute scheduled reconciliation. Multiple keys share the same account
buckets. An operator may additionally configure a narrower token/spend policy for an individual account-owned key; it
must use the account currency and cannot exceed any account ceiling. Reservation, terminal settlement, and expiry repair
lock and update the account buckets before the optional key buckets in the same transaction. An unconfigured key uses
only the account policy. Cache/reasoning-specific pricing, provider-invoice reconciliation, and live concurrency/load
evidence remain deferred.

The Worker enables Cloudflare's incoming request signal and combines it with server-owned deadlines: 60 seconds to LLM
API response headers, 45 seconds without a response-body chunk, and five minutes total. It caps every LLM API response at
8 MiB and each SSE event at 256 KiB. It never silently retries an LLM generation. Versioned operational events correlate
request, authentication, admission, route selection, provider headers/first byte/first output delta/completion, and usage reservation/
settlement by request ID. Their runtime allowlist contains internal account/key IDs, Senko model, protocol, attempt,
stable route ID, classified outcome/failure, status, timings, tokens, and reserved/settled cost only. Versioned events
also cover admission renewal/release failure and scheduled usage reconciliation. Authorization headers, raw keys, provider credentials/model IDs, prompt
content, tool arguments/results, and generated text are not logged.

## Worker configuration

`apps/api` reads secrets and text bindings through `c.env`; it does not use `process.env`. The current compatibility date
enables Cloudflare's Node.js compatibility needed by the direct `pg` TCP driver without an extra flag. `SENKO_MODELS` is
a JSON array containing the public model metadata described above,
`SENKO_FAST_MODEL` selects one ID from that array. `SENKO_PROVIDER_ROUTES` defines validated model/protocol routes,
priorities, stable route IDs, upstream model mappings, trusted destinations, and provider RPM/TPM/concurrency capacity.
Trusted destinations fix the HTTPS origin and dedicated secret binding in source. Route choice is deterministic by priority
and route ID, then skips circuit-open or capacity-exhausted candidates before provider forwarding. If it is absent,
`LLM_API_BASE_URL` plus `LLM_API_KEY` provide a bootstrap-mode legacy migration path; database mode rejects that unmanaged
path. No provider request is retried after forwarding begins.
`SENKO_ADMISSION` and per-route `SENKO_PROVIDER_POOLS` are SQLite-backed Durable Object bindings defined by
`wrangler.jsonc`; the same configuration enables `enable_request_signal` and `keep_vars` so deployments receive client
cancellation and preserve Dashboard-managed text bindings. It explicitly disables `workers_dev` and preview URLs.
The admin-token-protected `GET /admin/v1/dependency-health` verifies database-mode configuration, identity/ledger schema,
admission, and route-keyed provider-pool dependencies without sending a generation to a provider; public `/health`
remains liveness only. `SENKO_INFERENCE_ENABLED` must be explicitly set to `true` to serve inference;
`false` is a global emergency stop, and missing, empty, or invalid values fail closed before admission or provider
forwarding.
The same R0 operator boundary protects `GET /admin/v1/requests/{requestId}`, a bounded lookup of the final authenticated
customer API request envelope plus at most 16 provider attempts and their routing/reservation/ledger metadata. The
envelope is persisted in the background independently of usage reservation, so authenticated pre-reservation failures
are traceable after the write completes. Streaming envelopes are finalized after terminal/cancel/error classification,
not when response headers are returned. Unauthenticated traffic remains in structured events and does not cause a
support-database write. The query and response schema exclude prompt/generated/tool content, authorization values,
plaintext API keys, and key hashes, and the response is never cacheable.
See [`apps/api/README.md`](../apps/api/README.md) for the exact setup.

## Deferred work

This contract still does not define customer-facing account management, user identity/login, customer administration
roles, billing, real-provider contract-tested redundancy, latency/cost-aware routing, post-attempt fallback,
per-member team plan assignment, user-supplied LLM API keys, dashboards, or production deployment policy. The current
account/key management routes are protected by a separate R0 admin token for controlled provisioning and support
account creation, one-time key issuance, bounded metadata listing, overlapping rotation, and revocation. Rotation keeps
the source key active until an explicit revoke so clients can move without an outage window. When the source key has an
optional usage-limit policy, rotation copies that policy atomically to the replacement key; prior per-key bucket usage
is not copied. The remaining areas are
part of the wider product direction where noted in [the product positioning](positioning.md). Their implementation,
dependencies, verification evidence, and release gates are tracked in
[the API production release project](api-production-release-plan.md).
