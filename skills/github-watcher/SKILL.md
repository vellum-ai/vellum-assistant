---
name: github-watcher
description: Install a recurring GitHub watcher — a scheduled poll of GitHub notifications (review requests, mentions, assignments) that only spends an LLM call when there's something new. Use for ongoing, hands-off GitHub monitoring (e.g. "keep an eye on my repos", "ping me about review requests", "watch my GitHub notifications").
compatibility: Designed for Vellum personal assistants
metadata:
  emoji: "👀"
  vellum:
    category: development
    display-name: "GitHub Watcher"
---

# GitHub Watcher

Polls GitHub notifications on a cron and escalates to your assistant **only when there's new activity** — an empty poll spends zero LLM tokens.

## Prerequisites

- GitHub connected via OAuth. Verify with `assistant oauth status`.

## Setup

```bash
bun scripts/setup.ts                    # poll every 15 minutes (default)
bun scripts/setup.ts --cron "*/5 * * * *"
```

This registers a **script-mode schedule** that runs `scripts/poll.ts` on the cron. On each fire the script polls; it only wakes the assistant when there is new activity.

## How it works

- **Deterministic poll, LLM only on new items.** `scripts/poll.ts` calls `assistant oauth request --provider github /notifications` (the token stays in the daemon — it never enters the script), filters to `review_requested` / `mention` / `assign` / `team_mention`, and dedups against a cursor in the schedule's `state/`. No model call on an empty poll.
- **Fenced escalation.** When there's new activity it creates a fresh conversation and wakes it with the raw notification payload passed via `--external-content` (fenced as data, never instructions); the trusted framing is in `--hint`.
- **Self-contained.** Built-ins + the `assistant` CLI only — no dependencies.

## Customizing

By default the schedule runs the shipped `scripts/poll.ts` **in place**, so it picks up skill updates. To customize (e.g. change `ACTION_PROMPT` or the notification filter), copy the script into the schedule's own dir and point the schedule at the copy:

```bash
cp scripts/poll.ts "$VELLUM_WORKSPACE_DIR/schedules/<id>/poll.ts"
assistant schedules update <id> --script 'cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && bun poll.ts'
```

(`setup.ts` prints the `<id>`; or find it with `assistant schedules list`.) The copy is frozen — it won't receive future skill updates.

## Notes

- Cursor state lives at `schedules/<id>/state/` and is gitignored (the script writes a `state/` `.gitignore` on first run); the schedule dir and that `.gitignore` are versioned, the cursor is not.
- Change the cadence later with `assistant schedules update <id> --expression "<cron>"`; pause with `assistant schedules disable <id>`.
