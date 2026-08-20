# Benchmarks

Run the informational benchmark after building the CLI:

```sh
pnpm bench
```

The benchmark is deliberately not a CI timing gate. It records:

- `cold_start_p50_ms`: median wall time from five fresh `senko --help` processes.
- `tui_readiness_ms`: fresh-process time until Senko's TUI module and Pi TUI dependencies are loaded.
- `mock_time_to_first_token_ms`: fresh-process time until the first assistant byte from a local SSE endpoint. The
  fake endpoint adds a deterministic 10 ms delay.
- `tool_turnaround_ms`: wall time for a fresh agent process, one local shell tool call, its result round trip, and the
  final mock assistant response.

Initial development baseline, measured on 2026-08-20 with Darwin 25.5.0 arm64 and Node.js 24.16.0:

| Metric | Baseline |
| --- | ---: |
| Cold startup p50 | 71.5 ms |
| TUI readiness | 183.8 ms |
| Mock time to first token | 2,968.6 ms |
| Tool turnaround | 2,043.7 ms |

These values describe one development machine and should be compared only with repeated runs in a similar
environment. The production inference service is not involved.
