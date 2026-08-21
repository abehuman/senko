# Pi /compact feature

updated: 20260821

---

Pi’s `/compact` works by:

> Sending the older portion to a separate LLM call for summarization → adding a summary entry to the session → rebuilding the context visible to the Agent as `summary + recent history`.

## Processing flow

```text
/compact [additional instructions]
  ↓
AgentSession.compact()
  ↓
Abort the current execution
  ↓
Split old messages from recent messages to retain
  ↓
Call the summarization LLM
  ↓
Append a CompactionEntry to the session JSONL
  ↓
Replace the Agent's messages with "summary + retained recent portion"
```

The main implementation locations are:

* [`slash-commands.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/slash-commands.ts): Registers `/compact`
* [`agent-session.ts`](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/src/core/agent-session.ts): Controls manual and automatic compaction
* [`compaction.ts`](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/src/core/compaction/compaction.ts): Splitting, prompt generation, and the LLM call
* [`utils.ts`](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/src/core/compaction/utils.ts): Conversation serialization and the system prompt
* [`session-manager.ts`](https://raw.githubusercontent.com/earendil-works/pi/refs/heads/main/packages/coding-agent/src/core/session-manager.ts): Rebuilds the context after compaction

## How much of the conversation is compacted?

The default settings are:

```ts
reserveTokens: 16384
keepRecentTokens: 20000
```

The automatic compaction condition is approximately:

```ts
contextTokens > contextWindow - reserveTokens
```

During summarization, Pi walks backward from the newest messages, estimates token usage, and retains roughly `keepRecentTokens` worth of recent context.

The boundary is selected from user/assistant message boundaries and similar points. It does not split in the middle of a tool result.

If a single very large turn is split in the middle, Pi:

1. Summarizes the conversation before that turn.
2. Separately summarizes the prefix of the split turn.
3. Combines both summaries.

## The prompt sent to the LLM

Pi creates a dedicated summarization request instead of using the normal Agent system prompt and tools.

The system prompt’s meaning is:

> Read the conversation and output only a structured summary in the specified format. Do not continue the conversation or answer questions from it.

The user message is conceptually structured like this:

```text
<conversation>
[User]: ...
[Assistant thinking]: ...
[Assistant]: ...
[Assistant tool calls]: ...
[Tool result]: ...
</conversation>

<previous-summary>
The summary from the previous compaction
</previous-summary>

Create a structured checkpoint summary.
```

The `<previous-summary>` section is included only after the first compaction.

The summary format contains these sections:

```text
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context
```

The model is instructed to preserve file paths, function names, and error messages exactly. If you run `/compact foo`, the additional instruction is appended to the prompt as an extra focus.

The conversation is not sent directly to the LLM. Pi first converts it into its own plain-text representation:

* User messages, assistant text, thinking, and tool calls are serialized with labels.
* Tool results are truncated to a maximum of 2,000 characters for summarization.
* Images and other content are included in token estimation.
* `toolChoice: "none"` disables tool calls.
* `cacheRetention: "none"` is specified.
* If the summarization result contains a tool call, Pi treats it as an error.

## How previous summaries are updated

When a previous compaction exists, Pi does not summarize the entire old conversation again. Instead, it sends:

```text
previous summary + messages since the previous compaction
```

The LLM is instructed to:

* Preserve existing information.
* Move completed items from `In Progress` to `Done`.
* Add new decisions and progress.
* Update `Next Steps`.

## File information is preserved separately

In addition to the LLM-generated summary, Pi extracts file operations from assistant tool calls such as `read`, `write`, and `edit`.

It adds information similar to this to the final summary:

```xml
<read-files>
...
</read-files>

<modified-files>
...
</modified-files>
```

This means that even if the LLM omits a file list, Pi separately preserves which files were read and modified.

## What happens to the session after compaction?

The old history is not physically deleted from the JSONL session. Pi adds a `CompactionEntry` and changes only the context presented to the next Agent request.

The resulting context is roughly:

```text
[compaction summary message]
[retained recent messages]
[messages added after compaction]
```

So compaction is not really “deleting history.” It is changing the view of the history presented to the Agent.

Automatic compaction also has a recovery path: if the context limit causes a request to fail, Pi compacts the context and retries once.

More details are available in the official [Compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).
