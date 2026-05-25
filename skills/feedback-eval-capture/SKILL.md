---
name: feedback-eval-capture
description: Turn a user-feedback export tarball into a replayable eval case. Extracts the conversation, walks the developer through identifying the failing assistant turn and the expected behavior, and writes a deterministic snapshot to ~/.vellum/workspace/evals/<slug>/ so the same prefix can be re-run against different models. Use when triaging a report from #user-feedback or any time a developer hands you a `vellum-export-*.tar.gz` and wants to capture it as a regression test.
compatibility: Designed for Vellum personal assistants
metadata:
  emoji: "🧪"
  vellum:
    display-name: "Feedback → Eval Capture"
---

## When to use this skill

A user submits feedback through the assistant (the `assistant feedback submit` flow, or any in-app "report a bug" affordance). The feedback ships as a `tar.gz` produced by the `POST /v1/export` route, containing the conversation, audit data, and a sanitized config snapshot.

You — the developer-facing assistant — get handed that tarball and a vague complaint ("the agent did X when it should have done Y"). Your job is to pin down the failure point and capture the conversation prefix as a deterministic eval case so the same starting state can be re-played against different models.

The runner that actually re-plays the case is intentionally out of scope here. Capture first, replay later.

## What the tarball contains

The export route (`assistant/src/runtime/routes/log-export-routes.ts`) writes the staging directory below into a `tar.gz`:

```
audit-data.json            # tool invocation rows
messages.json              # DB rows (present when conversationId or full=true)
llm-request-logs.json      # per-LLM-call log rows
llm-usage-events.json      # per-call usage / cost rows
daemon-logs/               # rotating logs (filtered to conversationId when present)
workspace/conversations/<ISO-with-dashes>_<conversationId>/
  meta.json                # conversation metadata
  messages.jsonl           # one JSON record per message, oldest first
  attachments/             # files referenced by messages
config-snapshot.json       # redacted workspace config
export-manifest.json       # { type, conversationId?, assistantVersion, commitSha, ... }
```

The eval case uses the `workspace/conversations/<...>/messages.jsonl` view — one row per message, with `role`, `ts`, `content`, optional `toolCalls`, `toolResults`, `attachments`, and `metadata`. Each row in that file is one message; one user-visible "assistant turn" can span multiple rows when the agent loop iterates through tool calls.

## Workflow

You drive a short interview. The script does the deterministic file shuffling.

### 1. Ask the developer for the tarball

If they haven't already, prompt them to share the export tarball path. It's whatever `vellum-export-*.tar.gz` they downloaded from Slack, email, or the feedback endpoint. A local absolute path is the only accepted form.

### 2. Inspect the tarball

```bash
bun run scripts/capture.ts inspect --tar /path/to/feedback.tar.gz
```

This extracts the tarball to a temp directory and prints a JSON summary:

- the `export-manifest.json` (assistant version, commit SHA, time window)
- every conversation directory found in `workspace/conversations/`
- the first user message of each conversation as a preview

If there's exactly one conversation, you can proceed straight to step 3. If there are several, ask the developer which conversation is the one with the failure and pass `--conversation-id <id>` to the next step.

### 3. Walk the conversation

```bash
bun run scripts/capture.ts messages --tar /path/to/feedback.tar.gz [--conversation-id <id>]
```

Prints the conversation as a numbered timeline — one entry per row in `messages.jsonl`, with role, timestamp, a short content preview, and any tool calls. Read it out to the developer, or summarize it, so they can pinpoint where the failure happened.

### 4. Pin down the failure

Have a short back-and-forth with the developer. You need three things:

1. **The failure index.** Which row in `messages.jsonl` is the first turn that went wrong? Refer back to the numbered timeline. Usually it's an assistant row that emitted the wrong tool call, said the wrong thing, or (in the silent-turn case) is the row where a response *should have appeared but didn't*. For silent-turn failures, point at the index *where the assistant turn was missing* — i.e. the row immediately after the last user message; the capture script will record an empty failing turn placeholder.
2. **Expected behavior.** What should have happened at that point? Keep it short and concrete — one or two sentences. This is the developer's signal to the eventual runner about whether a re-play succeeded.
3. **Notes.** Any extra context worth keeping with the case: hypotheses, related tickets, links to in-flight PRs.

Don't guess any of these. If the developer is fuzzy on the failure index, walk the timeline together until they're sure.

### 5. Capture the eval case

```bash
bun run scripts/capture.ts capture \
  --tar /path/to/feedback.tar.gz \
  [--conversation-id <id>] \
  --failure-index <n> \
  --expected "<short expected-behavior sentence>" \
  [--notes "<freeform developer notes>"] \
  [--name <slug>] \
  [--out <dir>]
```

The script writes (deterministically) to `~/.vellum/workspace/evals/<slug>/`:

```
case.json          # structured metadata for the runner
messages.jsonl     # conversation prefix (rows 0..failure_index-1) verbatim
failing-turn.json  # the original row at index = failure_index (for comparison)
notes.md          # markdown notes file with expected behavior + developer notes
source/
  export-manifest.json   # copied from tarball
  meta.json              # conversation metadata copied from tarball
attachments/      # copy of any attachments referenced by the prefix
```

If `--name` is omitted the slug defaults to `<short-conversation-id>-<failure-ts>`. If `--out` is omitted the eval lands in `~/.vellum/workspace/evals/`.

## Determinism guarantees

Given the same `--tar`, `--conversation-id`, and `--failure-index`, the output is byte-for-byte stable:

- `messages.jsonl` is copied row-by-row in source order with no re-ordering or pretty-printing.
- `case.json` is written with stable key ordering and a fixed schema version.
- `failing-turn.json` is the verbatim row at the failure index (parsed and re-serialized with stable key ordering).
- attachment filenames are taken from the source `messages.jsonl` rows; on collision the script errors rather than rename, to keep the eval reproducible.

Re-running `capture` against the same inputs overwrites the eval directory atomically.

## Out of scope

- **The runner.** Re-playing an eval case against a different model belongs in a separate command (`assistant evals run --case <slug> --model <name>` is one shape under discussion). This skill stops at "the case is on disk."
- **Non-tar feedback sources.** Slack thread links, screenshot-only reports, or pasted transcripts — none of those land here. If the developer has only a Slack link, ask them to grab the `vellum-export-*.tar.gz` the user submitted alongside the feedback.
- **Multi-conversation cases.** One eval case == one conversation prefix. If the tarball happens to contain several, pick one and capture it; repeat for the others.

## Failure modes to watch for

- **No `workspace/conversations/` in the tar.** The export was a global-only export without conversation data; ask the developer for a per-conversation export.
- **`messages.jsonl` missing for the chosen conversation.** Same root cause — the developer needs to re-export with `conversationId` set.
- **Attachment file referenced but absent.** Logged as a warning; the eval case is still written but flagged in `case.json` under `prefix.missingAttachments`.
- **Failure index out of range.** Hard error before any output is written.
