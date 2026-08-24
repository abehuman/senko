# Senko API Production Release Project

| Field | Value |
| --- | --- |
| Status | Planning |
| Current release stage | R0 (local implementation only) |
| Baseline commit | `2a04dd2` |
| Last updated | 2026-08-24 |
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

The following is confirmed in the baseline commit:

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
- [x] Unit/injected-provider tests and Wrangler deployment dry-run.

The following is not yet provided by the baseline:

- [ ] Persistent accounts, teams, account-owned API keys, scopes, rotation, revocation, and audit history.
- [ ] Account-level entitlements, usage ledger, cost reservation/settlement, spend ceilings, and billing.
- [ ] Full structured application events, metrics, dashboards, and production alerts.
- [ ] Provider response adapters, normalized terminal events, multi-provider routing, or fallback.
- [ ] Isolated staging/production deployment configuration, WAF policy, CI rollout, dependency-health checks, and
  canaries.
- [ ] Real Durable Object integration, provider contract, load, soak, failover, staging E2E, or production synthetic tests.
- [ ] Customer dashboard, support tooling, policy/retention decisions, operational runbooks, or OpenAPI policy.

## Workstream summary

| ID | Workstream | Priority | Status | Required for |
| --- | --- | --- | --- | --- |
| GOV | Product, architecture, and release decisions | P0 | In progress | R1 |
| IAM | Accounts, teams, and API keys | P0 | In progress | R1 |
| ADP | Provider adapters and fallback routing | P0 | Not started | R2; redundancy required for R3 |
| USG | Usage, quota, and cost control | P0 | Not started | R2 |
| OBS | Application observability and alerting | P0 | Partial | R1/R2 |
| ENV | Staging/production boundaries and delivery | P0 | Not started | R1 |
| VER | Integration, contract, load, and E2E verification | P0 | Partial | Every stage |
| OPS | Billing and customer/operational release work | P0 | Not started | R3 |
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

- [ ] Add persistent account and team records with explicit status and plan/entitlement references.
- [ ] Add account membership and administrative roles; define who can issue, list, rotate, and revoke keys.
- [ ] Generate cryptographically random API keys with a versioned prefix and sufficient entropy.
- [ ] Display the full key exactly once and never make it retrievable afterward.
- [ ] Store only a lookup-safe hash/HMAC, non-secret prefix, owner, scopes, status, creation time, optional expiry,
  revocation time, and last-used time.
- [ ] Define scopes for model listing, inference protocols, administration, and future capabilities.
- [ ] Implement immediate revocation and overlapping rotation without an outage window.
- [ ] Make last-used updates bounded and failure-tolerant so they cannot block inference.
- [ ] Add model and plan entitlements at the account level and optional narrower restrictions at the key level.
- [ ] Enforce account-level request, concurrency, token, and spend limits independently of key count.
- [ ] Add append-only administrative audit events for key and entitlement changes.
- [ ] Design a controlled migration away from `SENKO_API_KEYS`; retain no silent permanent bootstrap bypass.

### Security and verification

- [ ] Threat-model key generation, storage lookup, timing behavior, logs, caches, rotation, and compromised-key handling.
- [ ] Test unknown, expired, revoked, wrong-scope, disabled-account, and cross-account access.
- [ ] Test concurrent rotation/revocation while requests are waiting, admitted, and streaming.
- [ ] Verify raw keys and authorization headers cannot appear in application, Cloudflare, CI, or support logs.
- [ ] Add an administrative recovery procedure with least-privilege access and audit evidence.

Exit criteria:

- Bootstrap keys are no longer the normal authentication source in the target environment.
- Every accepted request resolves to one internal account and key ID with enforced account-level ceilings.
- Revocation is effective immediately for new requests and is visible in the audit history.

## ADP — Provider adapters and fallback routing

Status: **Not started**

### Normalized provider boundary

- [ ] Define a provider-adapter interface for request construction, response validation, usage extraction, error mapping,
  model resolution, and cancellation.
- [ ] Validate non-streaming JSON instead of forwarding a successful provider body unchanged.
- [ ] Parse and validate Chat Completions SSE, including tool calls, finish reasons, terminal usage, and `[DONE]`.
- [ ] Parse and validate Responses SSE, including terminal response events, function calls/outputs, errors, and usage.
- [ ] Emit the contractually required resolved model ID and normalized fields for every supported response path.
- [ ] Reject malformed, incompatible, oversized, incomplete, or unsupported provider events safely.
- [ ] Preserve stream backpressure, cancellation, first-byte, idle, total, event-size, and response-size limits.
- [ ] Maintain protocol fixtures for every supported provider/model combination.

### Routing and fallback

- [ ] Configure at least two validated provider routes for each model alias that requires an availability promise.
- [ ] Track provider health, recent failures, latency, rate-limit state, and circuit-breaker state.
- [ ] Represent provider RPM/TPM and concurrency capacity separately from customer quota.
- [ ] Select routes using auditable health, capacity, cost, latency, model, region, and entitlement inputs.
- [ ] Allow safe fallback only before any response byte is delivered.
- [ ] Prohibit silent retry or route changes after streaming begins.
- [ ] Ensure every attempted route has one Senko request ID and distinct provider-attempt metadata for reconciliation.
- [ ] Test circuit opening/closing, partial outage, rate limiting, fallback success, and no-retry-after-stream-start.

Exit criteria:

- Both protocols satisfy Senko's published contract independent of provider-specific response variations.
- R3 aliases with availability claims have at least two tested routes and an observable, deterministic fallback policy.

## USG — Usage, quota, and cost control

Status: **Not started**

### Reservation and settlement

- [ ] Define an append-only, idempotent usage ledger keyed by Senko request ID and provider attempt.
- [ ] Record account, key, model alias, resolved model, provider route, pricing version, and reservation state without
  content.
- [ ] Estimate input and maximum output tokens before provider forwarding.
- [ ] Calculate and atomically reserve the maximum request cost against account limits before generation starts.
- [ ] Reject a request before forwarding when its reservation would exceed token or spend limits.
- [ ] Extract actual input/output/cache/reasoning usage from validated terminal provider data.
- [ ] Atomically settle actual cost and release unused reservation capacity.
- [ ] Define conservative settlement for cancellation, timeout, malformed terminal data, and missing usage.
- [ ] Make reserve, settle, release, retry, and webhook/reconciliation writes idempotent.
- [ ] Prevent concurrent requests or multiple keys from overspending the same account budget.

### Limits and reconciliation

- [ ] Enforce per-minute token quotas and daily/monthly account spend ceilings.
- [ ] Support narrower per-key ceilings without weakening the account ceiling.
- [ ] Add account suspension, plan enforcement, and a global emergency inference kill switch.
- [ ] Import or query provider invoice/usage data and reconcile it against the Senko ledger.
- [ ] Alert on missing usage, stale reservations, duplicate settlement attempts, reconciliation drift, and sudden cost
  increases.
- [ ] Test reservation races, retries, crashes between provider completion and settlement, and reconciliation repair.

Exit criteria:

- Every forwarded generation has one durable reservation and eventually reaches a reconciled terminal ledger state.
- Demonstrated race tests cannot exceed account ceilings through concurrency, retries, or multiple keys.
- Operators can suspend one account or all inference immediately without redeployment.

## OBS — Application observability and alerting

Status: **Partial** — Cloudflare observability is enabled, but application coverage is limited to lease warnings.

### Structured events

- [ ] Define a versioned event schema and failure-category taxonomy.
- [ ] Emit request start/finish, authentication, admission, route selection, provider headers, first token, terminal usage,
  cancellation, timeout, stream failure, lease renewal/release, reservation, and settlement outcomes.
- [ ] Include only request ID, internal account/key ID, model/route identifiers, outcome, HTTP status, failure category,
  timings, usage totals, and calculated cost where applicable.
- [ ] Record provider latency, time to first token, and total stream duration separately.
- [ ] Record fallback and circuit-breaker decisions with redacted reason codes.
- [ ] Add central redaction helpers and negative tests for prompts, generated text, tool arguments/results, authorization
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

Status: **Not started**

### Environment isolation

- [ ] Create explicit staging and production Worker configurations and names.
- [ ] Use separate bindings, Durable Object namespaces/state, provider keys, API-key storage, ledgers, model catalogs,
  observability destinations, and alert channels.
- [ ] Set production `workers_dev: false` and `preview_urls: false` explicitly.
- [ ] Configure `api.senkocode.com` as the production custom domain only after the production gate is approved.
- [ ] Document which non-secret variables are configuration-as-code and which remain Dashboard-managed.
- [ ] Add a secret inventory, rotation owner, rotation procedure, and no-downtime provider-key rotation test.
- [ ] Confirm production has no path to staging data and staging has no production provider/account credentials.

### Edge, CI, and rollout

- [ ] Add WAF and invalid-auth abuse controls before application authentication.
- [ ] Use least-privilege, environment-scoped CI deployment credentials.
- [ ] Require lint, typecheck, unit/integration tests, migration checks, and a Worker dry-run before deployment.
- [ ] Run authenticated staging smoke/contract tests before production promotion.
- [ ] Define controlled rollout size, health criteria, automatic/manual stop conditions, and rollback procedure.
- [ ] Run post-deploy liveness, dependency-health, authentication, inference, usage-settlement, and alert synthetic
  checks.
- [ ] Record deployed commit, configuration version, migration version, operator, checks, and rollback target.

### Health model

- [x] Keep public `/health` limited to Worker liveness.
- [ ] Add a protected dependency-health check for required configuration, identity storage, admission, and ledger
  dependencies.
- [ ] Add an external scheduled provider canary with a strict cost ceiling and no customer data.
- [ ] Ensure a provider outage affects dependency/route health without turning Worker liveness into a dependency fan-out.

Exit criteria:

- R1 can be deployed, tested, observed, and rolled back without sharing production state or credentials.
- Production promotion is repeatable and requires explicit approval plus recorded evidence.

## VER — Integration, contract, load, and E2E verification

Status: **Partial** — unit/injected-provider coverage exists; real runtime and external verification remain.

### Cloudflare runtime and state

- [ ] Add Workerd/Miniflare tests using the real Durable Object binding and SQLite migration.
- [ ] Test concurrent acquire/renew/release, idempotent release, expiry, controller restart, and persisted-state migration.
- [ ] Test identity, quota, reservation, settlement, and audit persistence across Worker/DO restarts.
- [ ] Test cancellation before provider headers, between headers and first event, and during streaming.

### Provider robustness and contracts

- [ ] Test slow headers, slow chunks, malformed JSON/SSE, oversized events/bodies, abrupt termination, and never-ending
  responses.
- [ ] Run real-provider Chat Completions contract tests for each supported route.
- [ ] Run real-provider Responses contract tests for each supported route.
- [ ] Test text, reasoning, parallel tool calls, tool results, stop reasons, resolved models, and usage events.
- [ ] Verify fallback before headers and verify no fallback/retry after response bytes.
- [ ] Verify provider cancellation and Senko deadline behavior with external requests.

### Capacity and release verification

- [ ] Establish reproducible load profiles for authentication, admission, streaming, and settlement.
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

Status: **Not started**

### Billing and customer controls

- [ ] Implement subscription/customer lifecycle and idempotent, signature-verified billing webhooks.
- [ ] Handle provisioning, plan changes, renewal, payment failure, grace periods, suspension, cancellation, refunds, and
  disputes consistently with entitlements and spend controls.
- [ ] Build a customer dashboard for account usage, spend, limits, keys, rotation, revocation, and audit history.
- [ ] Build least-privilege support tooling keyed by Senko request ID, account ID, and ledger state.
- [ ] Prevent support tools from exposing prompts, outputs, tool data, full keys, or provider credentials.

### Policy and operations

- [ ] Publish a privacy policy consistent with actual retention, provider transfer, training/ZDR choices, staff access,
  deletion, backups, subprocessors, and regional requirements.
- [ ] Define abuse handling, rate-limit escalation, account suspension, appeals, and compromised-key response.
- [ ] Write and exercise incident, provider-outage, secret-rotation, billing-reconciliation, data-correction, and rollback
  runbooks.
- [ ] Define on-call/support ownership, severity levels, response targets, customer communication, and incident review.
- [ ] Publish an OpenAPI specification for the supported contract.
- [ ] Publish compatibility, versioning, model-alias change, deprecation, and breaking-change policies.
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

- [ ] Define a measured trigger using sustained traffic, queueing, p95/p99 admission latency, error rate, and planned
  limit increases.
- [ ] Partition accurate request, token, spend, and concurrency ownership by account/tenant Durable Object.
- [ ] Coordinate provider-pool RPM/TPM/concurrency capacity separately from account quota.
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
   controlled bootstrap path for local development.
2. **Provider contract layer:** implement one adapter for both protocols, normalize terminal usage/model/error behavior,
   and add malformed/incomplete-stream fixtures before adding a second route.
3. **Usage ledger:** add idempotent reservation and settlement with account token/spend ceilings and failure-state tests.
4. **Operational events:** emit the minimum complete redacted event set and build staging dashboards/alerts.
5. **Staging boundary:** create isolated Cloudflare configuration, real Durable Object tests, dependency-health/canary
   checks, and a controlled staging deployment workflow.
6. **Redundant routing and launch work:** add the second route, failover/circuit behavior, billing, customer controls,
   runbooks, and the R2/R3 verification suites.

The next coding slice should review and apply the IAM migration to development/test, then add the database access and API
key lifecycle boundary. Production migration and backup policy remain separate R2 release operations.

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

## Risk register

| Risk | Impact | Control/workstream | Status |
| --- | --- | --- | --- |
| Multiple keys multiply account quota | Unbounded cost | IAM + USG account-level atomic ceilings | Open |
| Missing/incorrect terminal usage | Underbilling or budget drift | ADP validation + USG conservative settlement/reconciliation | Open |
| Fallback creates duplicate generations/cost | Double charge and inconsistent output | ADP pre-byte-only fallback + attempt ledger | Open |
| Customer content reaches logs | Privacy/security incident | OBS schema, central redaction, negative tests | Open |
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

## Progress log

| Date | Change | Next action |
| --- | --- | --- |
| 2026-08-23 | Established R0-R3 gates, nine workstreams, baseline status, dependencies, risks, and evidence rules | Resolve D-002 storage and the IAM account/key ownership model |
| 2026-08-24 | Renamed the project and file to use direct production-release wording | Resolve D-002 storage and the IAM account/key ownership model |
| 2026-08-24 | Selected Railway managed PostgreSQL as the system of record and kept PlanetScale as a future migration option | Confirm Railway region/backup policy and define the IAM schema and account ownership model |
| 2026-08-24 | Recorded the Singapore Railway topology and implemented the initial IAM schema/migration locally | Apply the migration to development/test with explicit approval, then implement the database/key lifecycle boundary |
| 2026-08-24 | Added Test DB Public TCP Access and applied and independently verified the IAM migration | Implement the direct Worker database access and API-key lifecycle boundary; keep production unmigrated |
