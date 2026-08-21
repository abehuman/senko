# OpenCode session continuation

Source: [OpenCode CLI documentation](https://opencode.ai/docs/cli/).

## Session controls

OpenCode's terminal launcher distinguishes three choices:

* `--continue` (`-c`) continues the last session.
* `--session` (`-s`) continues the explicitly selected session ID.
* `--fork` is an explicit modifier to either continuation path.

The same three controls are available when using the non-interactive `run` command. Session browsing is a separate
operation, `opencode session list`, rather than an implicit part of every launch.

## What Senko should take from it

The important boundary is that reopening a session and making a fork are distinct. Senko's `/resume` should keep
that property: select an existing session and continue it in place. Forking should wait until Senko has a clear
interactive design for branch history.

OpenCode's command-line options also reinforce Senko's existing split: `--continue` is the fast path for the most
recent project session, while a picker is the discoverable interactive path for choosing another saved session.
