# Senko Inference API Contract

Status: milestone 2 initial implementation. The Cloudflare Worker implementation lives in `apps/api`; configuring
production credentials and deploying it remain separate operational steps.

## Goals

The Senko inference API is a Hono Cloudflare Worker optimized for a small, curated catalog focused primarily on
open-weight coding models. Model selection and routing prioritize cost, latency, and operational stability instead of
catalog size. The product direction includes multiple managed inference routes so that one LLM provider outage or period
of congestion does not stop a team's work.

The initial implementation has one server-configured OpenAI-compatible LLM API and deterministic injected LLM API
handlers for tests. Client requests cannot choose an arbitrary LLM provider; Senko owns the curated catalog and
managed routing policy.

The service exposes OpenAI-compatible streaming interfaces so Senko and other standard clients can use it without a
proprietary transport.

## Authentication

Every `/v1/*` request requires:

```http
Authorization: Bearer <senko-api-key>
```

Invalid or missing credentials return `401`. Authorization failures must not reveal whether an account or key once
existed. LLM API credentials remain Worker secrets and are never sent to clients.

Until API-key issuance and account storage are designed, accepted client keys are loaded from the `SENKO_API_KEYS`
Worker secret as a comma- or newline-delimited list. The Worker derives a SHA-256 identifier for the matched key so that
admission limits can be isolated without storing or forwarding the key itself. This is an operational bootstrap, not
the future account model.

## Endpoints

### `GET /v1/models`

Returns only models approved for Senko's low-latency service. `fast` is a stable alias and may resolve to a different
underlying model as routing policy changes. Model records should additionally expose `context_window`,
`max_output_tokens`, supported protocols, input modalities, and reasoning support.

### `POST /v1/chat/completions`

Implements OpenAI Chat Completions requests, including streamed `text/event-stream` responses, tool definitions,
parallel tool calls, tool results, stop reasons, and usage. Streaming terminates with `data: [DONE]`.

### `POST /v1/responses`

Implements the OpenAI Responses event stream, including output text, reasoning summaries when supported, function
calls, function-call outputs, terminal response events, and usage.

Both endpoints accept `model: "fast"`. Every response and terminal stream event reports the resolved underlying model
identifier rather than only echoing the alias.

Request bodies are limited to 1 MiB and rejected with `413 request_too_large` before JSON parsing or LLM API forwarding.
Each request is capped at 16,384 output tokens or the selected model's lower `max_output_tokens` value. Chat Completions
supports exactly one choice (`n: 1`) so a client cannot multiply generations inside one admitted request.

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

Once streaming has started, errors are emitted as protocol-appropriate terminal events before the stream closes.
Responses include `x-request-id` and standard rate-limit limit, remaining, and reset headers. Usage reports input,
cached-input when available, reasoning when available, and output tokens.

The initial Worker generates `x-request-id` itself and forwards standard `x-ratelimit-*` and `retry-after` headers
when the LLM API provides them. Before forwarding inference, one globally named Durable Object enforces fixed safety
ceilings of 20 requests per minute and 2 concurrent requests per API key, plus 120 requests per minute and 12 concurrent
requests across the Worker. Rejections return `429 rate_limit_exceeded` with `Retry-After`. Leases are released when the
upstream response body finishes or is cancelled, and abandoned leases expire after 10 minutes. Billing and usage-based
plan quotas remain deferred, but a client key cannot send unbounded traffic through the shared LLM API credential.

The Worker propagates client cancellation to the active LLM API request. It never silently retries a request after
stream bytes have been delivered. Logs use request IDs and resolved model IDs but exclude authorization headers,
prompt content, tool arguments, tool results, and generated text by default.

## Worker configuration

`apps/api` reads secrets and text bindings through `c.env`; it does not use `process.env` or enable Node.js
compatibility. `SENKO_MODELS` is a JSON array containing the public model metadata described above,
`SENKO_FAST_MODEL` selects one ID from that array, and `LLM_API_BASE_URL` plus the `LLM_API_KEY` secret define the LLM
API that receives inference requests. `SENKO_ADMISSION` is the SQLite-backed Durable Object binding defined by
`wrangler.jsonc`; the same configuration enables `keep_vars` so deployments preserve Dashboard-managed text bindings.
See [`apps/api/README.md`](../apps/api/README.md) for the exact setup.

## Deferred work

This contract does not yet define billing, account management, API-key issuance, multi-provider routing,
per-member team plan assignment, user-supplied LLM API keys, dashboards, or production deployment policy. Those are
part of the wider product direction where noted in [the product positioning](positioning.md), but require separate
milestones and explicit operational decisions.
