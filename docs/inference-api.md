# Senko Inference API Contract

Status: milestone 1 design contract. The CLI defaults to `https://api.senkocode.com/v1`; implementing and deploying
that service remain separate milestones.

## Goals

The future Senko inference API is a Cloudflare Worker optimized for a small, curated catalog focused primarily on
open-weight coding models. Model selection and routing prioritize cost, latency, and operational stability instead of
catalog size. The product direction includes multiple managed inference routes so that one upstream outage or period
of congestion does not stop a team's work.

The first implementation may still have one server-configured upstream provider and a deterministic fake upstream for
tests. Client requests cannot choose an arbitrary upstream provider; Senko owns the curated catalog and managed
routing policy.

The service exposes OpenAI-compatible streaming interfaces so Senko and other standard clients can use it without a
proprietary transport.

## Authentication

Every `/v1/*` request requires:

```http
Authorization: Bearer <senko-api-key>
```

Invalid or missing credentials return `401`. Authorization failures must not reveal whether an account or key once
existed. Upstream credentials remain Worker secrets and are never sent to clients.

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

The Worker propagates client cancellation to the active upstream request. It never silently retries a request after
stream bytes have been delivered. Logs use request IDs and resolved model IDs but exclude authorization headers,
prompt content, tool arguments, tool results, and generated text by default.

## Deferred work

This contract does not yet define billing, account management, API-key issuance, multi-provider routing,
per-member team plan assignment, user-supplied upstream keys, dashboards, or deployment. Those are part of the wider
product direction where noted in [the product positioning](positioning.md), but require separate milestones and
explicit operational decisions.
