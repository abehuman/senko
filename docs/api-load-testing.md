# Senko API load profiles

This document defines reproducible, content-free load inputs for the managed API. Adding the tool does not authorize a
staging or production run. Every non-local run still requires an approved target, account, cost ceiling, observation
window, stop condition, and operator.

## Safety boundary

- The default target is `http://127.0.0.1:8787`.
- Remote targets must use HTTPS and require both `--allow-remote` and the exact
  `SENKO_LOAD_TEST_ALLOW_REMOTE=I_UNDERSTAND_THIS_SENDS_TRAFFIC` confirmation.
- The customer API key is read only from `SENKO_LOAD_TEST_API_KEY`; it is never accepted as a command argument or
  included in the result.
- Target URLs cannot include credentials, paths, queries, or fragments.
- HTTP redirects are rejected and never followed, so an approved target cannot forward the credential or traffic to a
  different origin.
- A run is capped at 10,000 requests, 200 concurrent requests, a five-minute per-request deadline, and 9 MiB read per
  response.
- The synthetic prompt contains no customer content. Output contains aggregate status, latency, throughput, byte, and
  transport-failure counts only.
- A non-local run must use an isolated load-test account with explicit token/spend ceilings. Stop the run on unexpected
  spend, database/provider saturation, sustained 5xx responses, alert delivery failure, or customer impact.

## Profiles

| Profile | Default requests / concurrency | Purpose | Accepted statuses |
| --- | ---: | --- | --- |
| `authentication` | 200 / 20 | API-key lookup and model-list authentication | 200 |
| `admission` | 24 / 12 | R0 request/concurrency admission behavior | 200 and 429 both required |
| `streaming` | 10 / 2 | Full SSE consumption, lease lifecycle, and terminal stream handling within one-key concurrency/RPM guards | 200 |
| `settlement` | 20 / 2 | Non-streaming reservation and terminal settlement within one-key concurrency/RPM guards | 200 |

These are source baselines, not capacity or SLO claims. R2/R3 values must be revised from an approved traffic model and
real staging evidence. The admission profile fails unless at least one request succeeds, at least one request is denied
with `429`, and every denial has Senko's `rate_limit_exceeded` code plus `Retry-After`. Results split latency by HTTP
status or transport failure so fast rejections cannot be reported as generation latency.

## Usage

Inspect a plan without a credential or traffic:

```sh
pnpm --filter @senkocode/api load:profile -- --profile authentication --dry-run
```

For a local Worker, place `SENKO_LOAD_TEST_API_KEY` in the invoking process environment through the approved secret
workflow, then run:

```sh
pnpm --filter @senkocode/api load:profile -- --profile authentication
```

Overrides are bounded:

```sh
pnpm --filter @senkocode/api load:profile -- \
  --profile streaming \
  --requests 10 \
  --concurrency 2 \
  --timeout-ms 30000
```

Before an approved remote run, record the deployed commit/config/migrations, test account and limits, provider route,
expected status mix, monitoring links, stop conditions, approver, and rollback contact in Kanbria. Run profiles one at a
time, preserve only the aggregate JSON result, then reconcile Senko usage against the provider and database evidence.
