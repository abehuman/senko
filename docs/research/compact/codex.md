# Codex /compact feature

updated: 20260821

---

I traced the public `openai/codex` repository using this snapshot: [commit `bd194593`](https://github.com/openai/codex/tree/bd19459358f534ed1cae464ec13d56600aeb45f2).

The key point is that Codex currently has three compaction paths:

1. The normal OpenAI path: remote compaction using `compaction_trigger`
2. The legacy remote path: `/responses/compact`
3. The fallback for unsupported providers: a normal LLM call plus a summarization prompt

For the current OpenAI path, Codex generally does not send the old long summarization prompt.

## `/compact` execution path

The TUI flow is:

```text
/compact
  → SlashCommand::Compact
  → AppCommand::Compact
  → thread/compact/start
  → Op::Compact
  → CompactTask
```

Relevant implementations:

* [`slash_dispatch.rs`](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/tui/src/chatwidget/slash_dispatch.rs#L264-L275)
* [`thread_processor.rs`](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/app-server/src/request_processors/thread_processor.rs#L2277-L2288)
* [`session/handlers.rs`](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/session/handlers.rs#L244-L249)

## Current default: Remote Compaction V2

For OpenAI and Azure providers, `RemoteCompactionSupport::V2` is enabled. The `remote_compaction_v2` feature is also enabled by default.

* [Provider capability](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/model-provider/src/provider.rs#L44-L65)
* [Default V2 setting](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/features/src/lib.rs#L1527-L1531)
* [Compaction path selection](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/tasks/compact.rs#L20-L73)

Conceptually, the LLM request looks like this:

```json
{
  "model": "...",
  "instructions": "<normal Codex base instructions>",
  "input": [
    "...conversation history...",
    {
      "type": "compaction_trigger"
    }
  ],
  "tools": ["...model-visible tools..."],
  "parallel_tool_calls": true,
  "reasoning": "..."
}
```

The trigger is serialized exactly as:

```json
{"type":"compaction_trigger"}
```

This is not a normal user message. It is a structured control item sent through the Responses API.

[Implementation](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/compact_remote_v2_attempt.rs#L68-L141)

The LLM/API does not return a normal assistant text response. It returns a `compaction` item. Codex verifies that exactly one such item was returned, then stores its `encrypted_content` as the compacted context.

[Implementation](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/compact_remote_v2.rs#L400-L457)

OpenAI’s official documentation also describes compaction items as opaque and not intended to be directly human-readable. [OpenAI Compaction Guide](https://developers.openai.com/api/docs/guides/compaction)

## Fallback for unsupported providers

When remote compaction is unavailable—for example, with some non-OpenAI providers—Codex uses a normal Responses API call to generate a summary.

The default prompt begins with:

> “You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.”

The full prompt is in [`prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/prompts/templates/compact/prompt.md).

It asks the LLM to produce a concise handoff summary containing:

* Current progress and important decisions
* Context, constraints, and user preferences
* Remaining work and next steps
* Important data, examples, and references needed to continue

The implementation flow is:

```text
Conversation history
  + synthetic user message saying “summarize this context”
  → normal LLM request
  → extract the last assistant message
  → add a summary prefix
  → save it as the new conversation history
```

The relevant implementation is in [`core/src/compact.rs`](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/compact.rs#L111-L240).

## What is retained after compaction?

For local compaction, Codex essentially creates:

```text
Recent user messages
+
The generated summary as a user message
```

Old assistant responses, tool calls, tool outputs, and reasoning items are generally removed.

User messages are selected from newest to oldest, up to a total of 20,000 tokens. If the limit is exceeded, the oldest retained message is truncated.

[Implementation](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/compact.rs#L639-L716)

The summary is stored as a user message rather than an assistant message:

```text
<previous-model handoff marker>
<LLM-generated summary>
```

The prefix lets Codex recognize and exclude previous summaries when performing compaction again, preventing summaries from being recursively summarized.

## Remote V2 history replacement

With Remote V2, Codex extracts relevant user, hook, assistant, and agent information from the original history and retains roughly up to 64,000 tokens.

* Normal tool calls and intermediate artifacts are removed
* Some assistant and agent messages are retained
* Retained history is limited to approximately 64,000 tokens
* The new compaction item is appended at the end
* Token usage is recalculated
* A compaction checkpoint is saved to the rollout

[Remote V2 history reconstruction](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/compact_remote_v2.rs#L459-L487)

If the `token_budget` feature is enabled, Codex can also use a path that does not call an LLM at all. It simply starts a new context window.

[Implementation](https://github.com/openai/codex/blob/bd19459358f534ed1cae464ec13d56600aeb45f2/codex-rs/core/src/compact_token_budget.rs#L21-L45)

So, if you want to implement Codex-like compaction in Senko, the basic architecture is:

```text
Supported OpenAI-style API
  → structured compaction trigger
  → opaque compaction item

Other providers
  → conversation history + summarization prompt
  → LLM-generated summary
  → recent user history + summary saved as the new context
```
