# Senko API Production Release Project

| Field | Value |
| --- | --- |
| Status | In progress |
| Current release stage | R0 (local implementation only) |
| Baseline commit | `2a04dd2` |
| Last updated | 2026-08-25 |
| Owner | TBD |
| Target date | TBD |

## Purpose

This document is the source of truth for taking the Senko managed inference API from its initial Cloudflare Worker
implementation to a production service. It tracks engineering, security, operations, billing, customer support, and
release evidence in one place.

The API contract remains in [`inference-api.md`](inference-api.md). Runtime boundaries remain in
[`architecture.md`](architecture.md). This document tracks work and release decisions; it must not describe planned
behavior as if it were already implemented.

## How to maintain this document

- Use `[x]` only when implementation and the stated verification evidence both exist.
- Keep unfinished work as `[ ]`; add **IN PROGRESS** or **BLOCKED** after the item when needed.
- Update the workstream summary, detailed checklist, evidence log, and `Last updated` date in the same change.
- Link a commit, test result, dashboard, runbook, or decision record when closing an item.
- Keep source-complete, staging-verified, and production-verified status separate.
- A deploy, secret change, migration, billing change, or production test requires its own explicit approval.

## Release stages

| Stage | Meaning | Current status |
| --- | --- | --- |
| R0 | Local implementation; no deployed service is promised | **Current** |
| R1 | Isolated authenticated staging with synthetic provider checks | Not started |
| R2 | Invite-only beta with enforced account budgets and operational support | Not started |
| R3 | Paid/public API with billing, provider redundancy, published compatibility policy, and runbooks | Not started |

Passing a local test suite does not advance a release stage by itself. Each stage requires its release gate below.
If Senko accepts payment or makes an availability promise before R3, that earlier stage inherits the relevant R3
billing, policy, redundancy, and operational requirements regardless of its beta label.

## Non-negotiable production rules

- Senko, not the client, owns provider credentials, organization/project selection, model routing, and cost controls.
- Account limits cannot be multiplied by creating more API keys.
- Usage settlement and billing mutations are idempotent and auditable by Senko request ID.
- Fallback is allowed only before response bytes are sent; generation is never silently retried after streaming starts.
- Prompts, generated text, tool arguments/results, raw authorization headers, and provider credentials are never logged.
- Staging and production use separate Workers, secrets, bindings, Durable Objects, model catalogs, and alert destinations.
- Edge rate limiting may absorb abuse but is never the source of truth for quota, usage, or billing.
- `/health` is liveness only. Dependency-health checks and provider canaries are separate and protected appropriately.
- Production rollout, rollback, incident response, compromised-key response, and billing reconciliation must be operable
  without changing application code.

## Current baseline

The following is confirmed in the current source tree; the table above retains the original hardening baseline commit:

- [x] Hono Cloudflare Worker with `/health`, `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.
- [x] Bootstrap Bearer authentication through the `SENKO_API_KEYS` Worker secret.
- [x] Server-owned curated model catalog and `fast` alias resolution.
- [x] Fixed request-rate and concurrency admission through one SQLite-backed Durable Object.
- [x] Request-body, output-token, provider-response-byte, SSE-event, first-byte, idle-stream, and total-time limits.
- [x] Protocol-specific request allowlists and rejection of provider-hosted/stateful or unsupported features.
- [x] Server-owned provider organization/project routing and sanitized provider errors/headers.
- [x] Renewable, deadline-bounded leases with transient-renewal retry and legacy-state compatibility.
- [x] Worker-generated request IDs and redacted warnings for final lease renewal/release failures.
- [x] Cloudflare observability configuration enabled.
- [x] Unit/injected-provider tests, real workerd Durable Object integration tests, and Wrangler deployment dry-run.
- [x] Core non-stream/SSE provider response validation, allowlisted normalization, protocol termination, and resolved
  model rewriting.
- [x] Source-complete direct `pg` identity access, explicit database/bootstrap auth modes, one-time HMAC-backed key
  issuance, endpoint scopes, revocation, coalesced last-used updates, and management audit transactions.
- [x] Operator-only bounded API-key metadata listing, overlapping rotation with source-key locking, and a source security
  threat model. Customer management identity and management idempotency remain open.
- [x] Protected R0 team provisioning and idempotent account suspend/reactivate with same-transaction content-free audit
  events. Suspension blocks new authentication after commit; customer roles and in-flight cancellation remain open.
- [x] Trusted multi-route configuration, route-keyed provider RPM/TPM/concurrency leases, circuit breakers, safe
  pre-forward fallback, and versioned redacted operational events.
- [x] Protected dependency-health source checks for production configuration, identity/ledger schema, admission, and
  provider-pool Durable Objects without provider generation.
- [x] Source-controlled binding inventory with typed/README/Wrangler drift tests and an explicit fail-closed inference
  switch. Environment-specific values, owners, and external configuration remain approval-gated.
- [x] A one-request, content-free provider canary source with an eight-token output ceiling, remote double confirmation,
  redirect rejection, bounded response, and normalized contract/usage validation. Scheduling and live runs remain open.

The following is not yet provided:

- [ ] Customer-managed users, teams, memberships, management roles, and entitlement administration. Operator-only key
  metadata listing and overlapping rotation are source-complete.
- [ ] Plan entitlements, provider invoice reconciliation, per-key ceilings, and billing. Base account usage reservation,
  settlement, and token/spend ceilings are source-complete.
- [ ] Metrics, dashboards, production log destinations, and alerts. Core structured application events are source-complete.
- [ ] Real-provider fixtures/routes, latency/cost routing inputs, and post-attempt fallback. Trusted routing and
  health/capacity control are source-complete.
- [ ] Isolated staging/production deployment configuration, WAF policy, CI rollout, dependency-health checks, and
  canaries.
- [ ] Real provider contracts, PostgreSQL integration, load, soak, staging E2E, or production synthetic tests. Initial
  workerd Durable Object concurrency/reload persistence tests are source-complete.
- [ ] Customer dashboard, least-privilege customer support roles, policy/retention decisions, runbook exercises, approved
  compatibility policy, or production OpenAPI publication. A bounded R0 operator lookup, source runbooks, the
  compatibility-policy draft, and OpenAPI discovery are complete.

## Workstream summary

| ID | Workstream | Priority | Status | Required for |
| --- | --- | --- | --- | --- |
| GOV | Product, architecture, and release decisions | P0 | In progress | R1 |
| IAM | Accounts, teams, and API keys | P0 | In progress | R1 |
| ADP | Provider adapters and fallback routing | P0 | Partial — trusted routing, adapters, and provider-pool control implemented | R2; redundancy required for R3 |
| USG | Usage, quota, and cost control | P0 | Partial — local source complete for base reservation/settlement | R2 |
| OBS | Application observability and alerting | P0 | Partial | R1/R2 |
| ENV | Staging/production boundaries and delivery | P0 | Partial — local safety config and dependency check implemented | R1 |
| VER | Integration, contract, load, and E2E verification | P0 | Partial | Every stage |
| OPS | Billing and customer/operational release work | P0 | In progress — source runbooks and compatibility draft exist | R3 |
| SCL | Admission-control scaling | P1, threshold-triggered | Not started | Before exceeding validated singleton capacity |

## Dependency order

1. GOV decides persistent storage, billing ownership, supported service levels, and environment topology.
2. IAM establishes the account/key identity used by quotas, usage, logs, support, and billing.
3. ADP establishes trusted terminal usage and normalized provider behavior.
4. USG reserves and settles spend using IAM ownership and ADP usage.
5. OBS records redacted outcomes from IAM, ADP, USG, and admission control.
6. ENV provides isolated staging where the integrated service can be verified.
7. VER must pass the gate for each target release stage.
8. OPS is required before accepting payment or making an availability promise.
9. SCL starts before traffic or configured limits outgrow the validated global Durable Object design.

ADP, USG, OBS, and ENV may be developed in parallel after their shared GOV/IAM contracts are stable. Their release gates
remain dependent even when implementation overlaps.

## GOV — Product, architecture, and release decisions

Status: **In progress**

- [x] Define the initial protocol surface and server-owned model catalog in `inference-api.md`.
- [x] Define initial fixed request, concurrency, size, and deadline safety limits.
- [x] Use Railway managed PostgreSQL as the system of record for accounts, keys, audit events, and the usage ledger;
  isolate production and development/test with separate database services.
- [x] Record Singapore as the Railway database region and use separate production and development/test Postgres services
  in the same project/environment.
- [x] Defer backups during R0 while no external migration or production data exists.
- [ ] Enable and restore-test backup/PITR before R2, and define the availability target and maintenance/upgrade procedure.
- [ ] Decide the billing provider and authoritative mapping from plans to model/price entitlements.
- [ ] Define which provider price source, versioning scheme, currency, and rounding rules are authoritative.
- [ ] Define R2 beta terms: supported users, models, protocols, regions, support hours, and whether beta is free or paid.
- [ ] Define R3 service objectives and the exact availability claims Senko is willing to make.
- [ ] Define data retention, deletion, provider data-processing, regional, and legal-review requirements.
- [ ] Define owners for API engineering, security, billing reconciliation, support, and incident command.
- [ ] Record the production Cloudflare account, Worker naming, custom-domain, and environment strategy without secrets.

Exit criteria:

- Required decisions have an owner and recorded outcome; no downstream P0 design depends on an unresolved implicit
  assumption.
- R1, R2, and R3 each have measurable acceptance criteria and an accountable release approver.

## IAM — Accounts, teams, and API keys

Status: **In progress**

- [x] Define a versioned Drizzle PostgreSQL schema and generated migration for users, accounts, teams, account/team
  memberships, account-owned API keys/scopes, and administrative audit events.
- [x] Add schema tests for raw-key exclusion, initial scope restrictions, and composite account-boundary foreign keys.
- [x] Apply the migration to the development/test Railway Postgres service after explicit approval and verify the live
  schema independently.

### Data and key lifecycle

- [x] Add protected R0 provisioning for persistent account records with explicit status and plan reference.
- [x] Add a protected, bounded R0 account metadata inventory so operators can recover account IDs without database
  access or unrestricted joins.
- [x] Add protected R0 provisioning, bounded metadata listing, and reversible archive/reactivate for account-owned team
  records.
- [ ] Add model/plan entitlement records.
- [ ] Add account membership and administrative roles; define who can issue, list, rotate, and revoke keys.
- [x] Generate cryptographically random API keys with a versioned prefix and sufficient entropy.
- [x] Display the full key exactly once and never make it retrievable afterward.
- [x] Store only a lookup-safe hash/HMAC, non-secret prefix, owner, scopes, status, creation time, optional expiry,
  revocation time, and last-used time.
- [x] Define and enforce initial scopes for model listing and both inference protocols.
- [ ] Define administration and future capability scopes.
- [x] Implement immediate revocation for new requests.
- [x] Implement operator-only bounded key metadata listing and overlapping rotation without an outage window; the source
  key remains active until separately revoked.
- [x] Preserve an optional per-key usage-limit policy during rotation under the shared account-policy/key-policy lock
  order; replacement-key usage buckets start empty.
- [x] Make last-used updates bounded and failure-tolerant so they cannot block inference.
- [ ] Add model and plan entitlements at the account level and optional narrower restrictions at the key level.
- [x] Enforce fixed account-level request and concurrency safety ceilings independently of key count.
- [x] Enforce account-level token and spend limits independently of key count through reservation and settlement.
- [x] Add append-only administrative audit events in the same transaction as account/team creation, account/team
  suspend/reactivate, and key issue/rotation/revoke.
- [x] Add operator-only, account-bound, bounded content-free administrative audit history without returning stored JSON
  metadata or actor user/API-key identifiers.
- [ ] Make plaintext-returning key issue/rotation requests retry-safe with a bounded management idempotency contract.
- [ ] Add entitlement-change audit events when entitlements are implemented.
- [x] Design a controlled migration away from `SENKO_API_KEYS`; explicit modes retain no silent bootstrap fallback.

### Security and verification

- [x] Threat-model key generation, storage lookup, timing behavior, logs, caches, rotation, and compromised-key handling;
  staging validation and external review remain open.
- [x] Unit-test unknown, expired, revoked, wrong-scope, disabled-account, and cross-account access.
- [x] Verify concurrent rotation and reservation plus replacement-key limit enforcement against an isolated schema on
  the development/test Railway PostgreSQL service.
- [ ] Repeat lifecycle and cross-account checks against the migrated development/test database and staging Worker.
- [ ] Test concurrent rotation/revocation while requests are waiting, admitted, and streaming.
- [ ] Verify raw keys and authorization headers cannot appear in application, Cloudflare, CI, or support logs.
- [ ] Add an administrative recovery procedure with least-privilege access and audit evidence.

Exit criteria:

- Bootstrap keys are no longer the normal authentication source in the target environment.
- Every accepted request resolves to one internal account and key ID with enforced account-level ceilings.
- Revocation is effective immediately for new requests and is visible in the audit history.

## ADP — Provider adapters and fallback routing

Status: **Partial** — request/response allowlists, response size/deadline controls, conservative protocol-terminal usage
gates, trusted multi-route configuration, provider-pool capacity/circuit coordination, and safe pre-forward selection are
implemented; complete provider fixtures, real routes, latency/cost inputs, and post-attempt fallback remain open.

### Normalized provider boundary

- [ ] Define a provider-adapter interface for request construction, response validation, usage extraction, error mapping,
  model resolution, and cancellation.
- [x] Validate non-streaming JSON instead of forwarding a successful provider body unchanged.
- [x] Parse and validate Chat Completions SSE, including tool calls, finish reasons, terminal usage, and `[DONE]`.
- [x] Parse and validate Responses SSE, including terminal response events, function calls/outputs, errors, and usage.
- [x] Emit the contractually required resolved model ID and normalized core fields for every current response path.
- [x] Reject malformed, incompatible, oversized, incomplete, or unsupported provider core events safely.
- [x] Preserve stream backpressure, cancellation, first-byte, idle, total, event-size, and response-size limits.
- [ ] Maintain protocol fixtures for every supported provider/model combination.

### Routing and fallback

- [x] Support validated multi-route declarations and deterministic priority/route-ID selection per model and protocol.
- [ ] Configure at least two real, contract-tested provider routes for each model alias that requires an availability promise.
- [x] Track consecutive route failures and circuit-breaker state in one Durable Object per stable route ID. Latency-based
  scoring and provider-returned rate-limit state remain open.
- [x] Represent provider RPM/TPM and concurrency capacity separately from customer quota.
- [ ] Extend the current redacted, auditable model/protocol/priority selection with health, capacity, cost, latency, region,
  and entitlement inputs.
- [x] Allow capacity/circuit fallback before provider forwarding; post-attempt fallback remains disabled pending distinct
  usage-attempt settlement and contract evidence.
- [x] Prohibit silent retry or route changes after provider forwarding or streaming begins.
- [ ] Ensure every attempted route has one Senko request ID and distinct provider-attempt metadata for reconciliation.
- [x] Unit-test circuit opening/half-open recovery, RPM/TPM/concurrency denial, renewable leases, idempotent release,
  pre-forward fallback, missing-binding fail-closed behavior, and no extra provider request. Real failover/load remains open.

Exit criteria:

- Both protocols satisfy Senko's published contract independent of provider-specific response variations.
- R3 aliases with availability claims have at least two tested routes and an observable, deterministic fallback policy.

## USG — Usage, quota, and cost control

Status: **Partial** — five-table schema, reservation/settlement, account limits, expiry-indexed repair queue, and kill
switch are source-complete locally; live migration, provider-price decision, cache/reasoning pricing, invoice
reconciliation, alerts, and real concurrency/load evidence remain open.

### Reservation and settlement

- [x] Define an append-only, idempotent usage ledger keyed by Senko request ID and provider attempt.
- [x] Record account, key, model alias, resolved model, provider route, pricing version, and reservation state without
  content.
- [x] Estimate input and maximum output tokens before provider forwarding.
- [x] Calculate and atomically reserve the maximum request cost against account limits before generation starts.
- [x] Reject a request before forwarding when its reservation would exceed token or spend limits.
- [ ] Extract actual input/output/cache/reasoning usage from validated terminal provider data.
- [x] Atomically settle actual input/output cost and release unused reservation capacity.
- [x] Define conservative settlement for cancellation, timeout, malformed terminal data, missing usage, and expired
  reservations.
- [ ] Make reserve, settle, release, retry, and webhook/reconciliation writes idempotent. Base reservation, terminal
  settlement, and expiry retry are idempotent; invoice/webhook reconciliation is pending.
- [ ] Prevent concurrent requests or multiple keys from overspending the same account budget. SQL locking is implemented;
  real PostgreSQL race/load evidence is pending.

### Limits and reconciliation

- [x] Enforce per-minute token quotas and daily/monthly account spend ceilings.
- [x] Support narrower per-key ceilings without weakening the account ceiling.
- [ ] Add account suspension, plan enforcement, and a global emergency inference kill switch. Protected account
  suspend/reactivate and the global kill switch are implemented; plan-derived policy remains open. Suspension blocks
  new authentication after commit but intentionally does not terminate an already-forwarded request.
- [ ] Import or query provider invoice/usage data and reconcile it against the Senko ledger.
- [ ] Alert on missing usage, stale reservations, duplicate settlement attempts, reconciliation drift, and sudden cost
  increases.
- [ ] Test reservation races, retries, crashes between provider completion and settlement, and reconciliation repair.

Exit criteria:

- Every forwarded generation has one durable reservation and eventually reaches a reconciled terminal ledger state.
- Demonstrated race tests cannot exceed account ceilings through concurrency, retries, or multiple keys.
- Operators can suspend one account or all inference immediately without redeployment.

## OBS — Application observability and alerting

Status: **Partial** — Cloudflare observability and a versioned, redacted application event schema cover the core request,
provider, admission-lease, usage, and reconciliation lifecycle. Destinations, dashboards, retention, sampling, access
controls, and alerts remain open.

### Structured events

- [x] Define a versioned event schema and failure-category taxonomy.
- [x] Emit request start/finish, authentication, admission, route selection, provider headers/first byte/first output
  delta/completion, cancellation/timeout/stream failure classification, lease renewal/release failure, reservation,
  settlement, and scheduled reconciliation.
- [x] Include only request ID, internal account/key ID, model/route identifiers, outcome, HTTP status, failure category,
  timings, usage totals, and calculated cost where applicable.
- [x] Record provider headers latency, first-body-byte latency, parsed streaming first-output timing, and total duration
  separately for both protocols.
- [x] Record provider-pool admission, pre-forward fallback, circuit state, remaining capacity, lease renewal, and release
  with redacted reason codes.
- [x] Persist authenticated, content-free final customer API request envelopes independently of usage reservation,
  including pre-reservation failures and post-header stream outcomes; keep unauthenticated traffic out of PostgreSQL
  and make persistence failure observable without failing the customer request.
- [x] Add central allowlist/redaction helpers and negative tests for prompts, generated text, tool arguments/results, authorization
  headers, raw API keys, and provider credentials.
- [ ] Define sampling, retention, access control, and separate staging/production destinations.

### Dashboards and alerts

- [ ] Dashboard availability, request volume, status/failure categories, and p50/p95/p99 latency.
- [ ] Dashboard time to first token, stream duration, provider errors, fallback, and circuit state.
- [ ] Dashboard authentication/admission failures, account quota pressure, and lease failures.
- [ ] Dashboard tokens, reservation versus settlement, spend, reconciliation drift, and missing usage.
- [ ] Alert on availability/SLO burn, provider error spikes, admission anomalies, missing usage, reconciliation drift,
  unexpected spend, and kill-switch activation.
- [ ] Route each alert to an owned response procedure and test the route in staging.

Exit criteria:

- Operators can trace any supported request by Senko request ID without seeing customer content or credentials.
- Each R2/R3 service objective and spending risk has an actionable dashboard and tested alert.

## ENV — Staging/production boundaries and delivery

Status: **In progress** — production exposure is disabled by default, the binding inventory and protected
dependency-health source check exist, and inference requires an explicit enabled state; isolated environment
configuration, CI rollout, external verification, and production publication remain.

### Environment isolation

- [ ] Create explicit staging and production Worker configurations and names.
- [ ] Use separate bindings, Durable Object namespaces/state, provider keys, API-key storage, ledgers, model catalogs,
  observability destinations, and alert channels.
- [x] Set production `workers_dev: false` and `preview_urls: false` explicitly.
- [ ] Configure `api.senkocode.com` as the production custom domain only after the production gate is approved.
- [x] Add a machine-readable binding inventory and document that binding schemas/purposes are configuration-as-code
  while current R0 environment values remain Dashboard-managed and versioned in deployment evidence.
- [ ] Add a secret inventory, rotation owner, rotation procedure, and no-downtime provider-key rotation test.
- [ ] Confirm production has no path to staging data and staging has no production provider/account credentials.

### Edge, CI, and rollout

- [ ] Add WAF and invalid-auth abuse controls before application authentication.
- [ ] Use least-privilege, environment-scoped CI deployment credentials.
- [x] Require lint, typecheck, unit/integration tests, migration checks, and a Worker dry-run before deployment through
  the existing least-privilege GitHub Actions `pnpm check` gate. Environment-scoped deployment remains separate.
- [ ] Run authenticated staging smoke/contract tests before production promotion.
- [ ] Define controlled rollout size, health criteria, automatic/manual stop conditions, and rollback procedure.
- [ ] Run post-deploy liveness, dependency-health, authentication, inference, usage-settlement, and alert synthetic
  checks.
- [ ] Record deployed commit, configuration version, migration version, operator, checks, and rollback target.

### Health model

- [x] Keep public `/health` limited to Worker liveness.
- [x] Add a protected dependency-health check for required configuration, identity storage, admission, provider-pool,
  and ledger dependencies. Live staging verification remains open.
- [ ] Add an external scheduled provider canary with a strict cost ceiling and no customer data. The one-request,
  eight-output-token, remote-double-confirmed script and content-free result contract are source-complete; approved
  scheduling, credentials, account ceiling, alert route, and live evidence remain open.
- [ ] Ensure a provider outage affects dependency/route health without turning Worker liveness into a dependency fan-out.

Exit criteria:

- R1 can be deployed, tested, observed, and rolled back without sharing production state or credentials.
- Production promotion is repeatable and requires explicit approval plus recorded evidence.

## VER — Integration, contract, load, and E2E verification

Status: **Partial** — unit/injected-provider coverage and initial workerd Durable Object integration exist; PostgreSQL,
external provider, load, staging, and production verification remain.

### Cloudflare runtime and state

- [x] Add Workerd/Miniflare tests using the real Durable Object bindings and SQLite migrations.
- [x] Test concurrent acquire/renew/release, idempotent release, expiry, controller restart, and persisted-state migration.
  Concurrent acquire/release, deadline-bounded renewal, idempotent release, Worker reload, Durable Object eviction,
  deadline expiry/capacity reclamation, and an actual legacy Worker-to-current Worker storage migration are covered.
- [ ] Test identity, quota, reservation, settlement, and audit persistence across Worker/DO restarts.
- [x] Test cancellation before provider headers, between headers and first event, and during streaming.

### Provider robustness and contracts

- [x] Test slow headers, slow chunks, malformed JSON/SSE, oversized events/bodies, abrupt termination, and never-ending
  responses with local/injected providers. External-provider behavior remains open.
- [ ] Run real-provider Chat Completions contract tests for each supported route.
- [ ] Run real-provider Responses contract tests for each supported route.
- [x] Test text, reasoning, parallel tool calls, tool results, stop reasons, resolved models, and usage events with local
  JSON/SSE fixtures for both supported protocols. Real-provider contract coverage remains separately gated below.
- [x] Verify fallback before headers and verify no fallback/retry after response bytes.
- [ ] Verify provider cancellation and Senko deadline behavior with external requests.

### Capacity and release verification

- [x] Establish source-controlled, localhost-default load profiles for authentication, admission, streaming, and
  settlement with bounded overrides, remote double confirmation, aggregate-only output, and no credential arguments.
- [ ] Run load and soak tests at expected and failure-injection traffic levels.
- [ ] Run provider failover, circuit-breaker recovery, and exhausted-provider-capacity tests.
- [ ] Prove token/spend ceilings under concurrency, retry, cancellation, delayed settlement, and provider mismatch.
- [ ] Run authenticated staging E2E using the released CLI and deployed staging API.
- [ ] Run bounded production synthetic smoke tests after approved deployment.
- [ ] Store test inputs without customer content and retain summarized evidence for the release record.

Verification levels reported at each gate:

1. Static: lint, typecheck, build, schema/config validation.
2. Local runtime: unit, Workerd/Miniflare, Durable Object persistence, failure injection.
3. External integration: real provider contracts, billing sandbox, alert delivery.
4. Authenticated staging E2E: deployed Worker, bindings, migrations, CLI, dashboards.
5. Production synthetic: bounded liveness/dependency-health/inference/settlement checks after explicit deployment
   approval.

Exit criteria:

- The target release stage has passing evidence at every required verification level, with unrun checks explicitly
  recorded rather than inferred from local success.

## OPS — Billing and customer/operational release work

Status: **In progress** — source runbooks, OpenAPI, and a bounded content-free operator lookup exist; billing,
customer administration, dashboards, policy approval, and external exercises remain open.

### Billing and customer controls

- [ ] Implement subscription/customer lifecycle and idempotent, signature-verified billing webhooks.
- [ ] Handle provisioning, plan changes, renewal, payment failure, grace periods, suspension, cancellation, refunds, and
  disputes consistently with entitlements and spend controls.
- [ ] Build a customer dashboard for account usage, spend, limits, keys, rotation, revocation, and audit history.
- [x] Build a bounded operator support lookup keyed by Senko request ID with final status/failure, account/key,
  provider-attempt, reservation, and ledger metadata, including requests that fail before usage reservation.
- [ ] Add customer-management roles and account-level lookup/workflows so support access is least privilege beyond the
  R0 shared operator token.
- [x] Exclude prompts, outputs, tool data, authorization values, full keys, key hashes, and provider credentials from the
  current support query and response contract.

### Policy and operations

- [ ] Publish a privacy policy consistent with actual retention, provider transfer, training/ZDR choices, staff access,
  deletion, backups, subprocessors, and regional requirements.
- [ ] Define abuse handling, rate-limit escalation, account suspension, appeals, and compromised-key response.
- [x] Write source runbooks for incident triage, provider outage, secret rotation, billing reconciliation, data
  correction, and rollback without prompt/output/credential access.
- [ ] Exercise the runbooks in staging with named responders, external contacts, and recorded evidence.
- [ ] Define on-call/support ownership, severity levels, response targets, customer communication, and incident review.
- [x] Implement a source-controlled OpenAPI 3.1 specification and expose it at unauthenticated `GET /openapi.json`,
  with separate customer/admin bearer schemes, required scopes, runtime-aligned request allowlists, and contract tests.
- [ ] Publish and verify the OpenAPI document on the approved production custom domain.
- [x] Draft compatibility, versioning, model-alias change, deprecation, and breaking-change rules as a source-controlled
  approval candidate.
- [ ] Approve and publish the compatibility policy with final owners, notice periods, and communication channels.
- [ ] Complete security, privacy, billing, and legal review appropriate to the launch regions and customer terms.

Exit criteria:

- Billing events, entitlements, usage, and account state reconcile end to end in a billing sandbox and staging.
- Support and incident responders can diagnose and contain failures using approved, content-free tools and runbooks.
- Customer-facing policies match the deployed service and have named owners.

## SCL — Admission-control scaling

Status: **Not started; threshold-triggered**

The current single global Durable Object is acceptable only while traffic remains within its measured capacity and the
fixed 120-request/minute, 12-concurrent-request Worker ceilings. This workstream is not automatically an R2 blocker if
load tests validate those ceilings, but it must complete before materially raising them or making a scale claim.
The current per-key and per-account constants are R0 cost/runaway guardrails, not customer plan entitlements or an
enterprise capacity commitment. They are intentionally insufficient for a large organization and must not be copied
into pricing or availability promises.

- [ ] Define a measured trigger using sustained traffic, queueing, p95/p99 admission latency, error rate, and planned
  limit increases.
- [ ] Partition accurate request, token, spend, and concurrency ownership by account/tenant Durable Object.
- [x] Coordinate provider-pool RPM/TPM/concurrency capacity separately from account quota using one route-keyed Durable
  Object per stable provider route. Load evidence and topology tuning remain open.
- [ ] Use Cloudflare's edge rate-limiting capability only for coarse abuse absorption, never billing/accounting truth.
- [ ] Design idempotent migration from the singleton state without losing active concurrency ownership or quota history.
- [ ] Test hot accounts, many small accounts, controller restarts, migration, and provider-pool contention under load.
- [ ] Update routing, dashboards, runbooks, and rollback procedures for the partitioned topology.

Exit criteria:

- Admission and quota correctness hold under the approved load profile without a global singleton routing bottleneck.
- Migration and rollback preserve active leases and do not allow quota or spend duplication.

## Release gates

### R1 — Authenticated staging

- [ ] GOV decisions required by staging are recorded.
- [ ] Staging is isolated from production credentials and state.
- [ ] IAM resolves each request to a persistent account/key identity.
- [ ] The protected dependency-health check and an external provider canary are operational.
- [ ] Core structured events, content-redaction tests, dashboards, and alert delivery work in staging.
- [ ] Real Durable Object persistence/migration and real-provider contract tests pass.
- [ ] Deployment and rollback procedures have been exercised.

### R2 — Invite-only beta

- [ ] R1 remains passing for the release candidate.
- [ ] Account/key revocation, rotation, scopes, entitlements, and account-level limits pass E2E.
- [ ] Provider adapters validate and normalize every advertised model/protocol combination.
- [ ] Maximum-cost reservation, actual settlement, token/spend ceilings, suspension, and kill switch pass E2E.
- [ ] Reconciliation, missing-usage, cost-anomaly, provider, availability, and admission alerts are exercised.
- [ ] Load/soak results support the beta user and spend caps.
- [ ] Support ownership, beta terms, data handling, and incident procedures are approved.
- [ ] A bounded post-deploy synthetic check passes after explicit deployment approval.

### R3 — Paid/public API or availability promise

- [ ] R2 remains passing for the release candidate.
- [ ] Important advertised aliases have at least two validated routes with safe pre-stream fallback.
- [ ] Billing lifecycle and webhooks reconcile with entitlement and usage state.
- [ ] Customer usage/key dashboard and least-privilege support tooling are available.
- [ ] Privacy, retention, provider-processing, abuse, incident, outage, rotation, reconciliation, and rollback policies are
  approved and exercised.
- [ ] OpenAPI, compatibility, versioning, and deprecation policies are published.
- [ ] Production WAF, least-privilege CI, custom domain, monitoring, alerting, canaries, and rollback are verified.
- [ ] Load, soak, failover, cost-ceiling, authenticated staging E2E, and production synthetic evidence is approved.
- [ ] SCL is complete if the planned traffic or limits exceed the validated singleton capacity.
- [ ] A named release approver accepts the remaining documented risks.

## Recommended first implementation slices

1. **IAM foundation:** apply and verify the reviewed schema in development/test, add the direct Railway PostgreSQL
   access boundary, implement hashed one-time keys, and migrate authentication behind an interface while preserving a
   controlled bootstrap path for local development. **Source-complete; live Worker connection and runtime role pending.**
2. **Provider contract layer:** implement one adapter for both protocols, normalize terminal usage/model/error behavior,
   and add malformed/incomplete-stream fixtures before adding a second route.
3. **Usage ledger:** add idempotent reservation and settlement with account token/spend ceilings and failure-state tests.
   **Base source-complete; live migration, pricing decision, provider reconciliation, and concurrency evidence pending.**
4. **Operational events:** emit the minimum complete redacted event set and build staging dashboards/alerts.
5. **Staging boundary:** create isolated Cloudflare configuration, real Durable Object tests, dependency-health/canary
   checks, and a controlled staging deployment workflow.
6. **Redundant routing and launch work:** add the second route, failover/circuit behavior, billing, customer controls,
   runbooks, and the R2/R3 verification suites.

### Deferred external setup

The following development/test-only work is intentionally deferred while the operator is away from the workstation. It
remains the next external IAM verification slice and requires separate approval before any Railway or Cloudflare change:

- [ ] Create a least-privilege runtime database role on development/test Railway PostgreSQL only.
- [ ] Configure staging-only `SENKO_DATABASE_URL`, `SENKO_API_KEY_HASH_SECRET_V1`, `SENKO_ADMIN_TOKEN`, and
  `SENKO_AUTH_MODE=database` in Cloudflare.
- [ ] From a real staging Worker, verify account creation, one-time key issue, scoped authentication, and immediate
  revocation against the development/test database.
- [ ] Review and separately approve the generated usage-accounting migration for the development/test database.
- [ ] Review and separately approve the generated API-key usage-limit migration `0004` for the development/test
  database.
- [ ] After D-004 is resolved, configure versioned model pricing and explicit account usage limits in staging, then verify
  reservation, terminal settlement, conservative settlement, and scheduled expiry repair end to end.

Production migration, secrets, deployment, and backup policy remain separate release operations and are not authorized
by this deferred task.

## Decision log

| ID | Date | Decision | Status | Notes |
| --- | --- | --- | --- | --- |
| D-001 | 2026-08-23 | Use this document as the production-release source of truth | Accepted | Track contract details in `inference-api.md` |
| D-002 | 2026-08-24 | Use Railway managed PostgreSQL for persistent account/key/ledger storage | Accepted | Singapore; production and development/test are separate services in one project/environment; PlanetScale remains a future migration candidate |
| D-003 | TBD | Billing provider and entitlement ownership | Open | Required before paid beta design is final |
| D-004 | TBD | Provider pricing/version/rounding source | Open | Required for reservation and reconciliation |
| D-005 | TBD | Staging/production Wrangler and Cloudflare topology | Open | Must guarantee state and credential isolation |
| D-006 | TBD | R2 supported models/providers/protocols/regions and beta terms | Open | Determines adapter and verification scope |
| D-007 | TBD | R3 SLO and availability promise | Open | Determines redundancy and operational gates |
| D-008 | 2026-08-24 | Start with direct `pg` connections from Workers to Railway PostgreSQL | Accepted | Defer connection pooling until measured latency or connection pressure justifies it |
| D-009 | 2026-08-24 | Treat fixed admission limits as R0 safety guardrails, not product-plan or enterprise capacity | Accepted | Replace with account entitlements backed by measured provider capacity; partition admission before materially raising limits |
| D-010 | 2026-08-25 | Use immutable usage attempts, append-only phase events, and locked account aggregate buckets | Accepted | Missing or uncertain terminal usage and expired reservations conservatively settle the full reservation; exact provider pricing remains D-004 |

## Risk register

| Risk | Impact | Control/workstream | Status |
| --- | --- | --- | --- |
| Multiple keys multiply account quota | Unbounded cost | IAM fixed request/concurrency ceilings + USG token/spend ceilings | Source-controlled; live race evidence open |
| Missing/incorrect terminal usage | Underbilling or budget drift | ADP validation + USG conservative settlement/reconciliation | Conservative settlement implemented; provider reconciliation open |
| Fallback creates duplicate generations/cost | Double charge and inconsistent output | ADP pre-byte-only fallback + attempt ledger | Open |
| Customer content reaches logs | Privacy/security incident | OBS schema, central redaction, negative tests | Source-controlled; external destinations open |
| Staging accesses production state/secrets | Data or spend incident | ENV isolation and deployment checks | Open |
| Provider price/catalog changes silently | Incorrect reservation or billing | GOV versioned pricing + reconciliation | Open |
| Singleton Durable Object becomes a bottleneck | Availability/latency degradation | VER load thresholds + SCL partitioning | Open |
| Direct PostgreSQL connections exhaust capacity or add latency | Authentication latency or database outage | Bounded clients, connection metrics, load tests, and threshold-triggered pooling | Open |
| Public PostgreSQL TLS does not validate a public CA | Origin impersonation risk | Separate credentials and require a verified transport design before R2 | Open |
| Billing webhook replay or reordering | Incorrect entitlements | OPS idempotent event processing and reconciliation | Open |
| Lease/state migration loses ownership | Concurrency quota bypass | VER persistence/concurrency migration tests | Partially controlled |
| Provider outage is invisible or routes badly | Customer outage | ADP health/circuits + OBS alerts + ENV canary | Open |

## Evidence log

| Date | Scope | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-23 | Baseline API hardening | Commit `2a04dd2`; `pnpm check`; Wrangler dry-run; 16 test files/142 tests | Passed locally; no staging or production verification |
| 2026-08-23 | Production-release tracker | This document created from the reviewed gap list and current repository state | Planning only |
| 2026-08-24 | Terminology update | Renamed the document and replaced ambiguous project wording | Documentation only |
| 2026-08-24 | D-002 storage selection | Railway managed PostgreSQL selected; production and development/test database services separated | Decision recorded; connection and runtime settings not verified |
| 2026-08-24 | IAM schema | Drizzle schema, generated `0000_iam_foundation.sql`, migration check, typecheck, and four schema tests | Passed locally |
| 2026-08-24 | Development/test IAM migration | Target-ID guard; TLS session; one migration; 8 tables; 13 foreign keys; 27 checks; 23 indexes | Applied only to `Senko Test Postgres`; independent verification passed |
| 2026-08-24 | Worker identity source | Direct `pg` dry-run bundle; one-time HMAC keys; database/bootstrap modes; scoped auth; issue/revoke audit transactions; `pnpm check` (23 files/179 tests) | Passed locally; no Cloudflare secrets, runtime DB role, deployment, or external DB E2E |
| 2026-08-24 | Account admission ceilings | Account/key-aware Durable Object state, legacy-state migration, multiple-key isolation tests, and `pnpm check` (23 files/183 tests) | Passed locally; no staging or production changes |
| 2026-08-25 | Base usage accounting source | Five-table schema and generated migrations; locked account reservation buckets; protocol-terminal JSON/SSE usage settlement; expiry-indexed skip-locked repair queue; conservative failure/expiry settlement; usage-limit management API; kill switch; strict review P1 fixes | `pnpm check` passed: 25 files/208 tests, all typechecks/builds, Wrangler dry-run; usage migration, pricing configuration, real PostgreSQL race test, staging, and production remain unverified |
| 2026-08-25 | Core provider response adapter | Completed JSON core validation, allowlisted response/usage rebuild, resolved-model rewriting, event-boundary SSE validation, known-event enforcement, and protocol-terminator rejection tests; strict general/security review has no remaining P0/P1 | `pnpm check` passed: 26 files/213 tests, all typechecks/builds, database migration check, and Wrangler dry-run; focused adapter/usage paths passed 4 files/52 tests; full tool/reasoning fixtures, real provider contracts, routing/fallback, and staging remain unverified |
| 2026-08-25 | Trusted provider routing, provider-pool control, observability, and protected dependency health | Deterministic trusted destinations; outbound redirect rejection; per-route RPM/TPM/concurrency Durable Objects; circuit/half-open behavior; safe pre-forward capacity fallback; JSON/SSE terminal health classification; redacted lifecycle events; admin-token-protected configuration/DB/DO checks | Initial `pnpm check` passed with 31 files/248 tests; the later redirect-boundary regression is covered by the current full check. Real provider contracts, live database schema check, staging, dashboards, and alerts remain unverified |
| 2026-08-25 | Workerd Durable Object integration and cancellation | Wrangler `createTestHarness` loaded the actual config, both SQLite migrations, and real bindings; concurrent admission serialized at the configured limit; active Admission/Provider Pool leases survived Worker reload and Durable Object eviction; provider capacity denial, circuit persistence, deadline-bounded renewal, expiry reclamation, and cancellation lifecycle were exercised through real bindings | Covered by the later 33-file/273-test `pnpm check`; persisted legacy-state migration remains unit-tested only; PostgreSQL, external provider, load, staging, and production remain unverified |
| 2026-08-25 | OpenAPI source contract | Public `GET /openapi.json`; distinct customer/admin bearer schemes; operation scopes; all implemented routes; runtime-shared inference allowlists; bounded management schemas; no secret binding names; strict security review has no remaining P0/P1 | Covered by the later 33-file/273-test `pnpm check`; production custom-domain publication and compatibility-policy approval/publication remain unverified |
| 2026-08-25 | API-key lifecycle, security model, and provider robustness | Account-bound bounded metadata listing; overlapping rotation with locked source validation, inherited ownership/scopes, one-time secret response, replacement metadata, and audit event; security threat model; injected slow/oversized/malformed/abrupt/never-ending provider cases; strict review P1 OpenAPI composition fix; general/security re-review has no remaining P0/P1 | `pnpm check` passed with 33 files/273 tests, all lint/typechecks/builds, migration check, and Wrangler dry-run; management idempotency, customer admin roles, real PostgreSQL races, external log/provider validation, staging, and production remain open |
| 2026-08-25 | Content-free request support trace | Authenticated request envelopes persist final HTTP/failure state independently of usage reservation; bounded admin lookup joins request, provider-attempt, reservation, and ledger metadata; unauthenticated traffic cannot amplify PostgreSQL writes; streaming requests finalize only after body completion; strict review P1 fixes covered pre-reservation failures, unauthenticated write amplification, and premature streaming success; general/security re-review has no remaining P0/P1 | `pnpm check` passed with 34 files/285 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; migration `0003`, retention/access policy, live PostgreSQL, staging, and production remain unverified |
| 2026-08-25 | API-key usage ceilings | Optional account-owned key policies and buckets; management contract; account-first transactional reservation, settlement, and expiry repair; key policy snapshot; cross-account schema guards; narrower-than-account validation; general/security/schema strict review with no P0/P1 | `pnpm check` passed with 34 files/294 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; migration `0004`, real PostgreSQL races, staging, and production remain unverified |
| 2026-08-25 | R0 team and account lifecycle | Protected account-owned team creation; serialized, idempotent account suspend/reactivate; same-transaction content-free audit events; OpenAPI, threat-model, and recovery-runbook boundaries; general/security strict review with no P0/P1 | `pnpm check` passed with 34 files/304 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; live PostgreSQL races, in-flight cancellation policy, staging, and production remain unverified |
| 2026-08-25 | Bounded team lifecycle | Account-bound cursor listing; idempotent archive/reactivate; team-wide new-authentication pause; account/key/team lock ordering for issue/rotation/status races; OpenAPI and recovery semantics; general/security strict review with no P0/P1 | `pnpm check` passed with 34 files/313 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; live PostgreSQL races, staging, and production remain unverified |
| 2026-08-25 | Content-free administrative audit history | Account-bound cursor pagination; strict allowlists for action, actor, target, identifiers, and request IDs; response rebuilding that excludes stored metadata and actor IDs; unknown stored values fail closed; OpenAPI and operator runbook; general/security strict review with no P0/P1 | `pnpm check` passed with 34 files/317 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; live PostgreSQL, external log destination, staging, and production remain unverified |
| 2026-08-25 | Bounded R0 account inventory | Admin-token-protected account metadata only; validated UUID cursor; `(created_at, id)` pagination; 100-record ceiling; no-store response; OpenAPI, observability classification, and operator recovery guidance; general/security strict review with no P0/P1 | `pnpm check` passed with 34 files/320 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; live PostgreSQL, customer-scoped authorization, staging, and production remain unverified |
| 2026-08-25 | Reproducible load-profile source | Authentication, admission, streaming, and settlement profiles; localhost default; bounded traffic/deadline/body; secret only through environment; HTTPS and double confirmation for remote; redirects rejected; admission requires valid 200 and 429 evidence with split latency; strict-review P1 fixes for redirect escape, pnpm invocation, single-key guardrails, and all-denied false success; re-review with no P0/P1 | `pnpm check` passed with 35 files/327 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, and Workerd integration; no staging/production load was sent, and real load/soak/capacity evidence remains unverified |
| 2026-08-25 | Deployment configuration inventory and fail-closed inference switch | Machine-readable inventory covers all typed Worker bindings without values; Wrangler Durable Object and README drift tests; documented Dashboard/config-as-code and environment/rotation boundaries; missing, empty, or invalid `SENKO_INFERENCE_ENABLED` now fails inference and protected dependency health closed; strict review P1 fix and general/security re-review with no remaining P0/P1 | `pnpm check` passed with 36 files/333 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, Workerd integration, and load-profile contract tests; Cloudflare environments, values, owners, routes, WAF, deployment credentials/workflow, and external verification remain unconfigured |
| 2026-08-25 | API-key rotation preserves per-key usage policy | Rotation copies the locked source policy to the replacement key in the same transaction; usage configuration, rotation, and reservation use an account-policy-first lock order; replacement buckets start empty; audit metadata records whether limits were inherited | Unit lock-order/policy-copy regression and isolated-schema concurrency/enforcement test passed on `Senko Test Postgres`; `pnpm check` passed with 37 files/343 tests plus the opt-in PostgreSQL test; staging and production remain unverified |
| 2026-08-25 | Bounded provider canary source and CI gate audit | One Responses or Chat Completions request; fixed content-free prompt; eight-token output ceiling; HTTPS and remote double confirmation; environment-only credential; redirect rejection; two-minute/1-MiB client bounds; request-ID, resolved-model, usage, and known normalized output-item validation without generated-content output; existing GitHub Actions gate confirmed to run the full check on PR/main; strict-review P1 false-positive fix and general/security re-review with no remaining P0/P1 | `pnpm check` passed with 37 files/342 tests, all lint/typechecks/builds, migration check, Wrangler dry-run, Workerd integration, load-profile, and canary contract tests; no provider traffic was sent, and schedule, Cloudflare credentials, account ceiling, alerts, staging, and production remain unconfigured |

## Progress log

| Date | Change | Next action |
| --- | --- | --- |
| 2026-08-23 | Established R0-R3 gates, nine workstreams, baseline status, dependencies, risks, and evidence rules | Resolve D-002 storage and the IAM account/key ownership model |
| 2026-08-24 | Renamed the project and file to use direct production-release wording | Resolve D-002 storage and the IAM account/key ownership model |
| 2026-08-24 | Selected Railway managed PostgreSQL as the system of record and kept PlanetScale as a future migration option | Confirm Railway region/backup policy and define the IAM schema and account ownership model |
| 2026-08-24 | Recorded the Singapore Railway topology and implemented the initial IAM schema/migration locally | Apply the migration to development/test with explicit approval, then implement the database/key lifecycle boundary |
| 2026-08-24 | Added Test DB Public TCP Access and applied and independently verified the IAM migration | Implement the direct Worker database access and API-key lifecycle boundary; keep production unmigrated |
| 2026-08-24 | Implemented direct Worker database access and the initial API-key issue/auth/revoke boundary | Create a least-privilege dev/test runtime DB role and verify the flow from a real staging Worker after separate approval |
| 2026-08-24 | Deferred development/test runtime role, staging secrets, and real Worker identity E2E while the operator is away; implemented fixed account request/concurrency ceilings | Implement account token/spend reservation and settlement; resume the recorded external IAM tasks when authorized |
| 2026-08-25 | Implemented the base usage ledger, account ceilings, conservative expiry repair, and global kill switch; kept live DB and Cloudflare unchanged | Complete strict P0/P1 review, then continue the provider contract adapter while D-004 and external staging work remain with the operator |
| 2026-08-25 | Completed core single-route provider adapter strict general/security review with no remaining P0/P1; `pnpm check` passes | Add provider route configuration, auditable selection, and fallback limited to adapter-proven pre-generation rejection |
| 2026-08-25 | Added trusted multi-route capacity/circuit coordination, strict-reviewed route failure classification, structured events, protected dependency health, and disabled unapproved Workers/preview URLs | Add real Durable Object runtime/persistence tests and isolated staging configuration; external provider routes, secrets, and deployment remain operator-approved work |
| 2026-08-25 | Added real workerd tests for Durable Object binding/migration, concurrent admission, idempotent release, Worker-reload persistence, provider capacity/circuit state, and deadline-bounded renewal; fixed cancellation races so client disconnects remain circuit-neutral; `pnpm check` passes 32 files/254 tests | Extend runtime tests to expiry/eviction/legacy migration, then add Railway PostgreSQL and external provider contracts after approval |
| 2026-08-25 | Added a source-controlled OpenAPI 3.1 discovery route and contract tests for route/auth/scope/allowlist drift; strict security review reports no P0/P1; `pnpm check` passes 33 files/263 tests | Define compatibility/versioning/deprecation policy, then continue safe operational runbooks while publication remains deployment-gated |
| 2026-08-25 | Added account-bound API-key listing, overlapping rotation, security threat model, Durable Object eviction/expiry coverage, and provider failure injection; fixed the strict-review OpenAPI composition P1; `pnpm check` passes 33 files/273 tests | Add content-free support lookup and management mutation idempotency while customer roles and external verification remain human-gated |
| 2026-08-25 | Added authenticated content-free request envelopes and bounded support lookup; fixed strict-review P1s for pre-reservation failures, unauthenticated database writes, and premature stream finalization; `pnpm check` passes 34 files/285 tests | Continue local contract/failure-path verification; management idempotency, retention/access policy, migration, and external verification remain human-gated |
| 2026-08-25 | Added optional API-key token/spend ceilings that can only narrow the account policy, including atomic reservation/settlement/repair and protected management/OpenAPI contracts; general/security/schema review found no P0/P1 and `pnpm check` passed 34 files/294 tests | Continue the next safe local workstream; keep migration `0004` and live race/staging verification human-gated |
| 2026-08-25 | Added protected R0 team creation and serialized, audited, idempotent account suspend/reactivate; general/security review found no P0/P1 and `pnpm check` passed 34 files/304 tests | Add bounded team lifecycle management while customer roles, entitlements, live database races, and staging remain human-gated |
| 2026-08-25 | Added account-bound team listing and audited archive/reactivate; aligned rotation locking with account/team state transitions; general/security review found no P0/P1 and `pnpm check` passed 34 files/313 tests | Add bounded content-free administrative audit history; keep customer roles, entitlements, live database races, and staging human-gated |
| 2026-08-25 | Added bounded account-scoped administrative audit history with strict stored-value validation and no metadata/actor-ID exposure; general/security review found no P0/P1 and `pnpm check` passed 34 files/317 tests | Add a bounded account inventory for R0 operators; keep customer roles, entitlements, live database races, external logs, and staging human-gated |
| 2026-08-25 | Added an admin-token-protected bounded account metadata inventory for operator ID recovery; general/security review found no P0/P1 and `pnpm check` passed 34 files/320 tests | Move to the next safe source workstream; IAM idempotency, customer roles, entitlements, live PostgreSQL, and staging remain human-gated |
| 2026-08-25 | Added safe source-controlled load profiles; fixed strict-review P1s for redirect target escape, broken documented invocation, success-profile guardrail mismatch, and all-denied admission false success; re-review found no P0/P1 and `pnpm check` passed 35 files/327 tests | Add source-controlled environment/configuration inventory; all remote load, soak, and capacity claims remain approval-gated |
| 2026-08-25 | Added the complete typed Worker binding inventory, documented environment/secret ownership boundaries, and made inference enablement explicitly fail closed; strict general/security review found no remaining P0/P1 and `pnpm check` passed 36 files/333 tests | Human owner must choose isolated Cloudflare topology/owners/values before environment-specific Wrangler, CI, WAF, deployment, or external verification can safely proceed |
| 2026-08-25 | Added a one-request content-free provider canary with strict remote/cost/credential/response gates; fixed the strict-review P1 normalized-contract false positive; confirmed the existing PR/main CI runs all required source checks; re-review found no P0/P1 and `pnpm check` passed 37 files/342 tests | Human owner must approve the isolated staging target, synthetic account ceiling, route, secret, monitoring, schedule, alert, and first live run |
