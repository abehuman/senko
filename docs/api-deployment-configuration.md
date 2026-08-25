# Senko API deployment configuration

This document defines the source-controlled configuration boundary for the managed API. It does not select the final
Cloudflare account, Worker names, custom domain, provider routes, owners, or secret values. Those decisions and every
external mutation remain approval-gated in Kanbria.

The machine-readable inventory is [`apps/api/config-inventory.json`](../apps/api/config-inventory.json). Tests require it
to cover every typed Worker binding, match Wrangler's Durable Object bindings, stay documented in the API README, and
contain no value/default/example fields.

## Management boundary

| Kind | Current source of values | Repository contents | Required isolation |
| --- | --- | --- | --- |
| Text configuration | Cloudflare Dashboard variable, preserved by `keep_vars` | Binding name, purpose, mode, validation code; never an environment value | Distinct staging/production catalog, routes, auth mode, and kill-switch state |
| Secret | Cloudflare Worker secret | Binding name and rotation requirements only | Distinct database, key-HMAC, R0 admin, and provider credentials per environment |
| Durable Object | Wrangler binding and migration | Binding/class names and migrations | Distinct namespaces/state per environment |

Dashboard-managed text is the present R0 choice because final environment names/topology are not approved. Before R1,
record a reviewed snapshot/version of `SENKO_MODELS`, `SENKO_FAST_MODEL`, `SENKO_PROVIDER_ROUTES`, `SENKO_AUTH_MODE`, and
`SENKO_INFERENCE_ENABLED` with the deployment evidence. Do not copy values between environments as an implicit setup
method. If configuration-as-code values are adopted later, remove the corresponding Dashboard ownership deliberately
and review the effect of `keep_vars`; do not create two competing sources of truth.

## Environment invariants

- Managed staging and production use `SENKO_AUTH_MODE=database`. Bootstrap credentials and `LLM_API_*` must be absent.
- Each environment has its own Railway runtime credential, API-key HMAC secret/version, R0 admin token, provider
  credentials, model/price catalog, route catalog, Durable Object state, log destination, alerts, and customer data.
- A provider route JSON contains a fixed secret binding name, never the secret value.
- `workers_dev` and preview URLs remain disabled. A production route/custom domain is added only after explicit approval.
- Public `/health` checks process liveness. Protected dependency health validates configuration/storage/bindings without
  sending provider traffic. Provider canaries remain separate and cost bounded; the source-controlled one-request
  procedure is documented in [`api-provider-canary.md`](api-provider-canary.md).
- A deployment is not valid merely because Wrangler succeeds: record commit, configuration version, migrations,
  operator, pre/post checks, monitoring window, and rollback target.

## Secret rotation record

Before installing or rotating a secret, identify the environment, binding, owner, reason, new version label, overlap
method, verification, rollback availability, and old-value revocation time. Never record the secret itself in Git,
Kanbria, logs, commands, screenshots, or support artifacts.

`SENKO_API_KEY_HASH_SECRET_V1` cannot be replaced in place: introduce a new hash version and verification/migration
path. Provider credentials should overlap where supported, move bounded contract traffic to the new credential, observe
errors and spend, then revoke the old credential. The database URL requires a distinct least-privilege role and verified
new connection before old-role revocation. The R0 admin token requires protected endpoint checks and a tightly bounded
overlap; its long-term replacement is account-scoped customer administration.

Named owners, staging/production topology, environment values, provider selection, and actual rotation exercises are
still human decisions. They are tracked in Kanbria's `人間阿部がやるタスク` task.
