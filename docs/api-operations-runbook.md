# Senko API Operations Runbook

Status: **Source runbook; external accounts, contacts, and approvals pending**

This runbook covers content-free triage and containment for the Senko managed inference API. It must never instruct an
operator to inspect or copy prompts, generated text, tool arguments/results, raw API keys, provider credentials, or
database connection URLs. Correlate incidents using the Senko request ID and internal account/key IDs emitted by the
structured operational events.

Production mutations, deployments, secret changes, database migrations, and customer communication require the
authority recorded for the target environment. If that authority or the target is unclear, stop after read-only triage.

## First response

1. Record start time, reporter, affected environment, request IDs, observed status/error code, and scope.
2. Confirm public `GET /health` for Worker liveness.
3. With the operator credential, check `GET /admin/v1/dependency-health`. Record only each bounded status:
   `ok`, `failed`, or `not_checked`.
4. For a reported Senko request ID, use `GET /admin/v1/requests/<request-id>` with the operator credential to review
   bounded routing, reservation, pending, and ledger metadata. Then correlate structured event counts and timings by
   request ID, account ID, route ID, status, and failure category. Do not enable body/header logging.
5. Determine whether the failure is authentication, account admission, usage reservation/settlement, provider capacity,
   provider protocol/transport, database, or deployment/configuration.
6. Name an incident commander before any containment action that changes external state.

## Severity proposal

Final severity targets and response promises require operator approval.

| Level | Working definition | Initial action |
| --- | --- | --- |
| SEV-1 | Broad inference outage, uncontrolled spend, cross-account exposure, credential compromise, or integrity loss | Stop expansion, appoint incident commander, consider emergency inference stop |
| SEV-2 | Material subset of accounts/models unavailable, repeated incorrect charging, or one required dependency failing | Contain affected route/feature and start frequent status review |
| SEV-3 | Degraded latency/capacity or isolated customer failure with a workaround | Track scope, mitigate safely, schedule root-cause work |

## Emergency inference stop

`SENKO_INFERENCE_ENABLED` must be explicitly set to `true` to serve inference. Setting it to `false` stops new inference
before admission/provider forwarding while leaving liveness and protected dependency checks available; missing, empty,
or invalid values fail closed with a configuration error. Use the switch only after confirming the Worker and
environment. Record approver, time, reason, expected customer impact, and restoration criteria. Existing external
requests may still need provider-side or deployment-specific handling.

Restore inference only when:

- the triggering risk is contained;
- required configuration and dependencies pass;
- usage reservation/settlement integrity is understood;
- a bounded smoke test and rollback path are approved;
- the restoration decision is recorded.

## Provider outage or malformed responses

1. Confirm `provider_completed` failure categories and stable route IDs; do not inspect content.
2. Check provider-pool admission, circuit state, remaining capacity, and fallback events.
3. Determine whether failure began before any provider bytes. Senko does not retry or silently fallback after forwarding
   starts.
4. If another adapter-verified route exists, confirm model/protocol/region/price compatibility and available capacity
   before changing priority or disabling a route.
5. Treat authentication, credit exhaustion, provider `429`, `5xx`, transport timeout, oversized/malformed response, and
   protocol-terminal failures according to their recorded route-health classification.
6. Verify recovery through a bounded staging canary before restoring production traffic. A real generation canary is an
   external, chargeable action and requires approval.

## Database or usage-ledger failure

1. Check bounded `identity_storage` and `usage_ledger` dependency statuses.
2. Confirm whether failures occur during authentication, reservation, settlement, or reconciliation.
3. Do not bypass database authentication, account limits, or conservative settlement to restore traffic.
4. Use `GET /admin/v1/requests/<request-id>` to record that request's pending-reservation state and ledger outcomes.
   Aggregate pending counts/age still require a separately approved metadata-only query path.
5. Before a repair or migration, confirm the exact Railway project/environment/service ID, database name, migration
   range, backup/rollback position, and operator approval.
6. Re-run idempotent settlement/reconciliation rather than editing aggregate balances manually. Any data correction must
   create an audit record and preserve the original ledger history.

When changing an API-key usage ceiling, confirm the account and key IDs, then use the protected key-specific management
route. A key policy must use the account currency and every ceiling must be no greater than the corresponding account
ceiling. Never compensate for a key policy by raising the account budget during incident response. Verify the returned
policy version and audit event without inspecting customer content.

## Suspected API-key compromise

1. Identify the key by public prefix/internal key ID; never request or paste the full key.
2. Revoke the affected account-owned key through the approved management path.
3. Issue a new key once, deliver it through the approved secret channel, and use an overlap window only when risk allows.
4. Review content-free usage, IP/edge metadata if retained by approved policy, scopes, and timestamps for affected
   account/key IDs.
5. Suspend the account or stop inference if unauthorized usage is ongoing and existing controls cannot contain it.
6. Record customer notification and billing-correction decisions separately; do not delete ledger/audit evidence.

## Account suspension and recovery

Use the protected `POST /admin/v1/accounts/<account-id>/suspend` route when a whole account must stop starting new
authenticated requests. Confirm the exact environment and internal account ID first. The operation is idempotent,
records a content-free audit event only on a state change, and takes effect for authentication after the database
transaction commits.

Suspension does not forcibly terminate a request that already passed authentication and began provider forwarding. For
an active compromise or uncontrolled spend, also assess the emergency inference stop and provider-side containment;
record the wider customer impact before applying either. Do not delete or individually rewrite account keys as a
substitute for preserving the incident trail.

Reactivate through `POST /admin/v1/accounts/<account-id>/reactivate` only when the triggering risk is contained, key and
provider credentials are known-safe, ledger integrity is understood, and the approver is recorded. A `closed` account
cannot be reopened by this R0 route. Verify recovery with a new bounded authentication request; do not infer recovery
from the management response alone.

For an incident limited to one team, use the account-bound team archive route after confirming both IDs. Archive blocks
new authentication with that team's keys after commit but does not revoke the keys or stop already-forwarded requests.
Before reactivation, inventory the team's bounded key metadata and revoke every expired-purpose or compromised key;
otherwise any unexpired, unrevoked key becomes valid again. A team cannot be reactivated while its account is not
active. Record `team.archived` / `team.reactivated` audit evidence and verify with a new bounded authentication request.

Use `GET /admin/v1/accounts` to recover an internal account ID from the bounded R0 metadata inventory. Do not build
support exports by joining keys, usage, or audit metadata into this response. Then use
`GET /admin/v1/accounts/<account-id>/audit-events` to collect bounded lifecycle evidence by internal account ID.
Record event/request IDs, actions, targets, actor types, and timestamps only. The endpoint intentionally excludes stored
metadata and actor user/key identifiers; do not bypass that boundary with an unrestricted database export. Customer
access to audit history is not authorized until account-scoped roles and retention/access policy are approved.

## Provider or Worker secret rotation

1. Confirm environment, binding name, secret owner, rotation reason, and rollback value availability without recording
   either secret value.
2. For customer key hashing, do not replace an in-use HMAC version without a versioned verification/migration plan.
3. For provider keys, install the new secret in the approved environment and run a bounded staging contract check.
4. Roll out through the approved deployment path, observe authentication/provider failures, then revoke the old value.
5. Record timestamps and secret versions/labels only. Never put credentials in Git, Kanbria, logs, or incident notes.

## Deployment rollback

1. Identify the failed deployment and last known good artifact; do not infer from a local worktree.
2. Confirm whether the release included PostgreSQL or Durable Object migrations. Code rollback does not automatically
   reverse state migrations.
3. Stop or drain risky traffic if required and approved.
4. Roll back the Worker using the approved Cloudflare release procedure, then verify liveness, protected dependencies,
   authentication, admission, and one bounded inference/settlement path.
5. Record the rollback, verification level, remaining data risk, and follow-up owner.

## Billing reconciliation

The provider invoice/usage source and billing provider are not selected yet. Until they are approved, do not present
local ledger totals as invoice reconciliation. When available, compare immutable provider attempt IDs, model/route,
terminal state, token dimensions, pricing version, currency, and amount. Differences must produce an append-only
correction/audit event; never rewrite the original usage event.

## Closure evidence

An incident can close only when scope and timeline are recorded, containment is removed or intentionally retained,
usage/account integrity is reconciled, required verification has passed, customer communication decisions are recorded,
and follow-up tasks have owners. External contacts, on-call ownership, alert channels, SLOs, retention, and legal review
remain tracked in Kanbria under `人間阿部がやるタスク`.
