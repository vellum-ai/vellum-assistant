---
name: notifications
description: Send notifications through the unified notification router
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔔"
  vellum:
    display-name: "Notifications"
---

Call this when something happened that the user would want to know about — a completed task with a notable outcome, an interesting observation, a positive trend you noticed in monitored data, useful research worth surfacing, a workflow that got blocked, a credential or token failure, etc. Do not call it for routine task completions where nothing notable happened. When in doubt and you have a real observation to share, share it.

## Sending Notifications

```bash
assistant notifications send \
  --title "Short headline" \
  --message "Your verbatim observation in your own words"
```

For time-sensitive items:

```bash
assistant notifications send --title "..." --message "..." --urgent
```

### Command Reference

| Flag                  | Required | Description                                  |
| --------------------- | -------- | -------------------------------------------- |
| `--message <message>` | Yes      | Notification message the user should receive |
| `--title <title>`     | No       | Short headline (≤ 8 words). Strongly recommended — auto-derived from `--message` if omitted. |
| `--urgent`            | No       | Mark as needing attention now/soon           |
| `--json`              | No       | Output machine-readable JSON                 |

### Title

Include a deliberate `--title` whenever you can. It's what the user sees in the lock-screen popup and notification list, so a short headline (noun phrase, ≤ 8 words) is much easier to scan than an auto-derived snippet from the message body. Avoid restating the first sentence of `--message` verbatim — the title should add scannability, not duplicate.

### Urgent semantics

Use `--urgent` for items needing attention now/soon (blocked work, broken auth, time-sensitive issues). Skip for items the user should see when they have time.

### Examples

```bash
# Plain notification
assistant notifications send \
  --title "Backup complete" \
  --message "Nightly backup finished — 12.4 GB archived to cold storage."

# Urgent notification
assistant notifications send \
  --title "Auth token expired" \
  --message "Sync is paused until you reauthenticate the GitHub integration." \
  --urgent
```

### Response Format

```json
{ "ok": true, "signalId": "...", "dispatched": true }
```

## Reading Surfaced Notifications

```bash
assistant notifications list --json
```

Reads from the user's home feed (`~/.vellum/workspace/data/home-feed.json`) — the inbox that mirrors background and async notifications surfaced via the unified pipeline. Real-time chat pushes that did not mirror to the feed (direct Telegram/Slack/Vellum-chat sends without `--is-async-background`) will not appear here.

### When to call

- **Before sending**: check whether you already surfaced a similar item recently (filter by `--conversation-id` or `--after` to dedupe).
- **Catch-up summaries**: when the user asks "what did I miss" or returns after a session break, list the items they haven't dismissed.
- **Lookup**: when the user references a past notification ("the email thing you flagged earlier"), find it by `--conversation-id` or date range.

### Filters

| Flag | Purpose |
| --- | --- |
| `--all` | Include dismissed items (default: excluded — assistant cares about outstanding work) |
| `--status <s>` | Filter by status (`new` / `seen` / `acted_on` / `dismissed`); repeatable. Overrides the `--all` default. |
| `--before <iso>` / `--after <iso>` | ISO-8601 createdAt bounds (strict; `=` is excluded). |
| `--urgency <u>` | Filter by urgency (`low` / `medium` / `high` / `critical`); repeatable. |
| `--category <c>` | Filter by category (`security` / `scheduling` / `background` / `email` / `system`); repeatable. |
| `--conversation-id <id>` | Only items tied to this conversation. |
| `--from-assistant` | Only items the assistant herself emitted. |
| `--noteworthy` | Only items flagged as noteworthy. |
| `--limit <n>` | Default 20, max 200. |
| `--offset <n>` | Pagination offset. Combine with `--limit` to walk older pages. |

### Examples

```bash
# What's outstanding right now (defaults: skip dismissed, newest first)
assistant notifications list --json

# Everything you've shown the user today
assistant notifications list --after 2026-05-28T00:00:00Z --all --json

# Only high-stakes items
assistant notifications list --urgency high --urgency critical --json

# Pre-send dedupe: anything you already surfaced for this conversation
assistant notifications list --conversation-id 7fab234c --after 2026-05-28T00:00:00Z --json

# Walk older pages
assistant notifications list --limit 20 --offset 20 --json
```

### Response shape

```json
{
  "ok": true,
  "items": [ /* FeedItem records: id, title?, summary, status, urgency?, category?, conversationId?, createdAt, ... */ ],
  "total": 12,
  "returned": 3,
  "hasMore": true,
  "updatedAt": "2026-05-28T10:30:00.000Z"
}
```

## Important

- Do **NOT** use AppleScript `display notification` or other OS-level notification commands for assistant-managed alerts. Always use `assistant notifications send`.
- For sending rich content (digests, summaries, reports) to a specific chat or email destination, use the appropriate platform's API directly. For Gmail, use `messaging_send`. For Slack, use the Slack Web API directly (see the **slack** skill).
- Send notifications that fire **immediately** with no delay capability. For one-time future alerts, use `schedule_create` with `fire_at`. For recurring alerts, use `schedule_create` with an expression (cron/RRULE).
