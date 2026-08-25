# Senko API provider canary

This canary sends exactly one content-free inference request through a deployed Senko API and validates the normalized
response, usage, request ID, and output-token ceiling. Adding the script does not authorize a remote run or schedule.

## Safety boundary

- The default target is `http://127.0.0.1:8787`; inspect it first with `--dry-run`.
- A remote target must be an HTTPS origin and requires both `--allow-remote` and the exact
  `SENKO_CANARY_ALLOW_REMOTE=I_UNDERSTAND_THIS_SENDS_PROVIDER_TRAFFIC` confirmation.
- `SENKO_CANARY_API_KEY` is read only from the process environment. It is not accepted as an argument or printed.
- Redirects are rejected, the request is limited to one non-streaming call and eight output tokens, the deadline is
  bounded to two minutes, and at most 1 MiB of response data is read.
- The fixed prompt contains no customer content. Results include only status, timing, Senko request ID, resolved model,
  usage counts, and response bytes; generated content is never retained or printed.
- An approved remote run must use a dedicated synthetic account/key with an account cost ceiling and a selected route.
  It is an availability signal, not a capacity or customer-data test.

## Usage

Validate the plan without a secret or traffic:

```sh
pnpm --filter @senkocode/api canary:provider -- --dry-run
```

For an already-running local Worker, provide `SENKO_CANARY_API_KEY` through the approved local secret workflow:

```sh
pnpm --filter @senkocode/api canary:provider -- --protocol responses
pnpm --filter @senkocode/api canary:provider -- --protocol chat-completions
```

Before any remote run or schedule, record the target environment, deployed commit/config/migrations, synthetic account,
account ceiling, route, expected protocol/model, monitoring link, stop condition, owner, and approver in Kanbria. Store
only the content-free JSON result. Scheduling, Cloudflare secrets, alert routing, and staging/production execution remain
separate approval-gated operations.
