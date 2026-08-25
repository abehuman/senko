# Senko API Security Threat Model

Status: **R0 source model; staging and production validation pending**

This document covers the managed Senko inference API. It focuses on account isolation, API-key lifecycle, provider
credentials, usage integrity, and content-free operations. It does not claim that Cloudflare, Railway, provider, CI, or
support-system settings have been verified until the corresponding environment evidence exists.

## Security objectives

- A request is attributed to exactly one internal account and API key before it can consume provider capacity or spend.
- Creating more keys does not increase the owning account's concurrency, token, or spend ceiling.
- Raw customer and provider keys are never stored in retrievable form, logged, returned by listing, or sent to the wrong
  boundary.
- Prompt, generated text, tool arguments/results, and authorization values do not enter operational events or support
  tooling.
- Account/key lifecycle, usage reservation/settlement, and administrative mutations remain auditable and fail closed.
- One account, team, key, provider route, or environment cannot access another one's state through an identifier change.

## Assets and trust boundaries

| Asset | Boundary | Required protection |
| --- | --- | --- |
| Customer API key | Customer secret channel to Worker authentication | One-time display, TLS, no logs/cache, HMAC lookup only |
| Provider credential | Cloudflare secret to trusted provider adapter | Server-selected destination, never client-visible or logged |
| Account/key metadata | Railway PostgreSQL | Account-bound foreign keys, least-privilege runtime role, audited mutations |
| Usage ledger and limits | Railway PostgreSQL | Locked account aggregates, idempotent events, append-only history |
| Admission/provider leases | Durable Objects | Stable owner IDs, deadline-bounded renewal, durable/idempotent release |
| Operator credential | Operator secret channel to `/admin/v1/*` | Separate from customer keys, minimum length, restricted distribution |
| Customer content | Worker-to-provider request and response stream | Bounded processing, no application logging or support exposure |

The public Worker, Railway public TCP endpoint, Cloudflare control plane, provider HTTPS endpoint, operator workstation,
CI, and future customer dashboard are separate trust boundaries. A credential valid at one boundary must not silently
be accepted at another.

## Threats, current controls, and remaining work

### Key generation, storage, and lookup

- Guessing or enumerating keys is limited by cryptographically random key material and a public lookup ID that is not an
  authenticator. Authentication always verifies the versioned HMAC with constant-time digest comparison.
- Unknown, malformed, expired, revoked, disabled-account, and disabled-team keys return the same authentication result.
- PostgreSQL stores the HMAC, non-secret display prefix, status, ownership, timestamps, and scopes; it does not store the
  raw key. Metadata listing excludes both raw keys and HMAC values.
- The HMAC secret must be versioned and rotated through a migration that can verify old versions. Replacing it in place
  would invalidate all keys and is prohibited.
- Edge invalid-auth throttling, credential-stuffing telemetry, and verification of Cloudflare/CI log settings remain
  staging and production work.

### Issuance, rotation, revocation, and recovery

- Issue and rotation return the new raw key once with `Cache-Control: no-store`; all later reads return metadata only.
- Rotation locks and revalidates the source key and owning account/team in one transaction, copies scopes and ownership,
  records the replacement relation and audit event, and leaves the source active for an overlap window.
- Revocation is account-bound, idempotent, audited, and effective for new requests on the next database authentication.
- A compromised source key must not use the normal overlap procedure: operators revoke it immediately, then issue a
  replacement through the approved secret channel.
- Plaintext-returning issue/rotation calls are not yet retry-safe. Before customer administration or automated clients,
  require an idempotency contract that cannot duplicate keys or expose a cached secret to a different caller.
- Concurrent rotation/revocation still requires real PostgreSQL and staging race tests.

### Account and tenant isolation

- API-key lookup resolves internal account/key IDs from the database; caller-supplied account IDs are not used for
  inference ownership.
- Management queries and foreign keys include the owning account ID for team, scope, replacement, and revocation paths.
- Admission concurrency and usage limits are account-owned, so multiple keys cannot multiply account capacity or spend.
- Protected account suspension serializes against account-owned team/key issuance, is audited with its state change,
  and makes subsequent database authentication fail closed. It does not revoke keys or terminate requests that already
  passed authentication; incident response must account for that bounded in-flight window.
- Team listing and status mutations require both the account and team IDs, and database queries bind them together.
  Archive/reactivate is audited and serializes with team-owned key issuance/rotation. Archive is a reversible pause,
  not key revocation: reactivation restores otherwise-valid keys, so compromised keys require explicit revoke.
- The R0 operator token is globally privileged. Customer-facing administration requires authenticated users,
  account/team memberships, explicit roles, and authorization checks before R2.

### Provider boundary and spend abuse

- Clients cannot select provider credentials, origins, organization/project headers, hosted tools, storage, background
  work, unsupported modalities, or arbitrary request fields.
- Provider subrequests reject redirects, so an initially trusted destination cannot forward the provider credential or
  customer request body to a different origin.
- Senko reserves maximum cost before forwarding and conservatively settles uncertain outcomes. Provider pool capacity
  and circuits are distinct from customer quota.
- Only adapter-validated, pre-forward route selection may fall back; no route is retried after forwarding starts.
- Real provider contract tests, invoice reconciliation, anomaly alerts, and approved pricing sources remain open.

### Logging, errors, and support access

- Structured operational events use allowlisted metadata and negative tests; they exclude request/response content,
  tool data, authorization values, full keys, provider credentials, database URLs, and raw dependency errors.
- Authenticated database-mode customer routes persist one final content-free envelope independently of usage
  reservation. It contains only request/account/key IDs, endpoint/method, final HTTP status/failure category, and
  timestamps; SSE finalization waits for terminal/cancel/error classification. Unauthenticated traffic never triggers
  this PostgreSQL write. The operator lookup joins bounded usage metadata and returns `Cache-Control: no-store`.
- Provider errors and headers are rebuilt from bounded allowlists. Senko emits its own rate-limit headers rather than
  provider-account limits.
- Administrative audit listing binds both cursor and rows to the route account, caps each page, and rebuilds a
  content-free response. Stored JSON metadata and actor user/API-key identifiers are not returned by the R0 endpoint;
  unreviewed action/actor/target/identifier shapes fail closed.
- The global R0 account inventory is admin-token protected, cursor bounded, and limited to account metadata. It does
  not join API keys, usage, teams, audit metadata, or customer content; account-scoped roles must replace it before
  customer self-service administration.
- Request-trace retention/deletion, invalid-auth write-abuse protection, Cloudflare log destinations, sampling, staff
  access, incident exports, and future customer-scoped support authorization must be configured and tested before
  staging or production claims.

### Availability and failure handling

- External request bodies, provider response bytes, SSE events, output tokens, and first-byte/idle/total durations are
  bounded. Client cancellation reaches provider streams and releases renewable deadline-bounded leases.
- Database-mode authentication, usage reservation, missing bindings, invalid configuration, and uncertain settlement
  fail closed. Bootstrap credentials are an explicit local/migration mode and never an implicit fallback.
- Dependency health is protected and bounded; public health is process liveness only. Provider canaries, alert delivery,
  load/soak evidence, and recovery exercises remain environment work.

## Required verification before customer administration

1. Apply the reviewed schema to an isolated development/test database and use a least-privilege runtime role.
2. Race rotation, revocation, authentication, and account limit reservation on real PostgreSQL.
3. Verify no raw key or authorization value appears in Worker, Railway, CI, dashboard, alert, or support logs.
4. Add and test management idempotency for one-time-secret responses.
5. Replace the global R0 operator token with account-scoped user/session authorization and audited roles.
6. Exercise compromised-key response, provider-secret rotation, database failure, and rollback runbooks in staging.
7. Complete an external security review after the deployed boundaries and customer administration flow exist.

## Review triggers

Review this model whenever authentication mode, key format/HMAC version, management identity, database topology,
provider adapter, logging destination, support tooling, billing ownership, tenancy model, or deployment boundary changes.
Record newly accepted risks and owners in Kanbria; do not silently weaken a control to restore availability.
