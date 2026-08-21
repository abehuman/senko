# `@senkocode/cli`

The Senko terminal coding agent.

```sh
npm install --global @senkocode/cli
export SENKO_BASE_URL=https://example.com/v1
export SENKO_API_KEY=your-key
senko
```

Senko runs coding tools automatically without a sandbox or approval prompt. See the repository README for the full
configuration, resource, and session documentation.

Long sessions automatically compact before a pending prompt would cross the configured model context limit, with the
maximum response and Pi's 4,096-token request safety margin reserved. Progress stays in the TUI or stderr, so
print-mode assistant stdout remains script-friendly. In the interactive TUI, run `/compact` to compact on demand; the
command does not accept additional instructions. `Escape` or `Ctrl+C` cancels active compaction.
