---
name: perception
description: Query the assistant's recent ambient perception context, such as active app and window changes, to answer questions like what the user was working on moments ago. Use when the user asks about recent activity, context, focus, or what was happening on their computer.
compatibility: "Designed for Vellum personal assistants. Requires the assistant's perception feature flag and a connected local desktop client."
metadata:
  emoji: "👁️"
  vellum:
    display-name: "Perception"
    activation-hints:
      - "User asks what they were just doing or working on"
      - "User asks about recent computer context, app focus, or window changes"
      - "User asks the assistant to use ambient context from the desktop"
    avoid-when:
      - "The user asks about conversation history rather than host context"
      - "The task requires screenshots, OCR, or audio context; Phase 1 only exposes active app/window events"
featureFlag: perception
---

## Overview

Use this skill to inspect the assistant's recent **structured perception context**.
The context is memory-only and now includes:

- `app_focus_changed` — active app and redacted window title changes.
- Interpreted perception signals such as `task_detected`, `meeting_started`,
  and `code_edited` (when emitted by the local interpreter).
- Phase 5 personal-knowledge read surfaces (entities, episodes, preferences)
  populated by relevance-gated perception summaries.

Raw screenshots, audio, OCR, URLs, process ids, and file paths are intentionally not available through this skill.

## Query Recent Context

Use the bundled script. The assistant injects `$INTERNAL_GATEWAY_BASE_URL`, so
do not hardcode localhost or ask the user to export a runtime URL.

```bash
bun ./skills/perception/scripts/recent-context.ts --window-ms 300000 --limit 20
```

Options:

- `--window-ms <ms>`: only return events received within the last N milliseconds.
- `--limit <n>`: maximum number of events, most recent first.
- `--kind app_focus_changed`: restrict to one perception event kind.
- `--runtime-url <url>`: override the gateway URL when explicitly needed.
- `--token <jwt>`: override the bearer token.

The script calls `GET /v1/perception/recent`. If perception is disabled or not yet started, the response is:

```json
{ "enabled": false, "entries": [] }
```

## Query Personal Knowledge (Phase 5)

Use the bundled script to read personal-knowledge snapshots inferred from
relevance-scored perception events.

```bash
bun ./skills/perception/scripts/personal-knowledge.ts --mode entities --query "typescript" --limit 10
```

Other modes:

```bash
bun ./skills/perception/scripts/personal-knowledge.ts --mode episodes --limit 20
bun ./skills/perception/scripts/personal-knowledge.ts --mode preferences --limit 20
```

Options:

- `--mode entities|episodes|preferences`: selects PKB endpoint.
- `--query <text>`: required for `--mode entities`.
- `--limit <n>`: maximum rows returned.
- `--runtime-url <url>`: override the gateway URL when explicitly needed.
- `--token <jwt>`: override the bearer token.

These map to:

- `GET /v1/personal-knowledge/entities`
- `GET /v1/personal-knowledge/episodes`
- `GET /v1/personal-knowledge/preferences`

## Response Interpretation

When answering the user:

1. State the time window you inspected.
2. Summarize app/window changes in plain language.
3. Be explicit when the buffer is empty or disabled.
4. Do not infer sensitive details from redacted titles.
5. Do not claim access to screenshots, audio, or exact document paths in Phase 1.

## Security Rules

- Treat perception context as local, privacy-sensitive data.
- Do not ask the user for tokens or secrets in chat. Use the runtime-provided environment when available.
- Do not attempt host actions from this skill. This skill is read-only.
- If the output says `enabled: false`, tell the user perception is not enabled instead of trying to bypass the gate.
