---
name: notifications
description: Send notifications through the unified notification router
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔔"
  vellum:
    display-name: "Notifications"
---

Send user-facing alerts and notifications using the `assistant notifications send` CLI command via `bash`. This routes through the unified notification pipeline, which handles channel selection, delivery, deduplication, and audit logging.

## Sending Notifications

```bash
assistant notifications send \
  --message "Your flight to SFO departs in 2 hours" \
  --source-channel assistant_tool \
  --source-event-name user.send_notification
```

### Command Reference

| Flag                          | Required | Description                                                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `--message <message>`         | Yes      | Notification message the user should receive                             |
| `--source-channel <channel>`  | Yes      | Source channel identifier (use `assistant_tool` when the LLM is sending) |
| `--source-event-name <name>`  | Yes      | Event name for audit and grouping (default: `user.send_notification`)    |
| `--title <title>`             | No       | Optional notification title                                              |
| `--urgency low\|medium\|high` | No       | Urgency hint (default: `medium`)                                         |
| `--requires-action`           | No       | Whether the notification expects user action (default: `true`)           |
| `--no-requires-action`        | No       | Explicitly mark as not requiring action                                  |
| `--is-async-background`       | No       | Mark as asynchronous/background work (default: `false`)                  |
| `--no-is-async-background`    | No       | Explicitly mark as not background work                                   |
| `--visible-in-source-now`     | No       | User is already viewing the source context (default: `false`)            |
| `--no-visible-in-source-now`  | No       | Explicitly mark source as not visible                                    |
| `--deadline-at <epoch-ms>`    | No       | Optional deadline timestamp in epoch milliseconds                        |
| `--preferred-channels <list>` | No       | Comma-separated routing hints: `vellum,telegram,slack`                   |
| `--session-id <id>`           | No       | Optional source session ID for notification context                      |
| `--dedupe-key <key>`          | No       | Optional dedupe key to suppress duplicate notifications                  |
| `--deep-link-metadata <json>` | No       | Optional JSON metadata clients can use for deep linking                  |
| `--json`                      | No       | Output machine-readable JSON                                             |

### Examples

```bash
# Simple notification
assistant notifications send \
  --message "Reminder: standup in 5 minutes" \
  --source-channel assistant_tool \
  --source-event-name user.send_notification \
  --json

# High-urgency notification with a deadline
assistant notifications send \
  --message "PR review requested — merge deadline approaching" \
  --title "PR Review Needed" \
  --source-channel assistant_tool \
  --source-event-name user.send_notification \
  --urgency high \
  --deadline-at 1714000000000 \
  --json

# Background notification with preferred channel
assistant notifications send \
  --message "Backup completed successfully" \
  --source-channel assistant_tool \
  --source-event-name system.backup_complete \
  --urgency low \
  --no-requires-action \
  --is-async-background \
  --preferred-channels vellum,slack \
  --json

# Notification with deduplication
assistant notifications send \
  --message "New reply in thread: Project Planning" \
  --source-channel assistant_tool \
  --source-event-name dog.news.thread.reply \
  --dedupe-key "thread-reply-abc123" \
  --json
```

### Response Format

```json
{ "ok": true, "signalId": "...", "dispatched": true }
```

## Listing Notifications

```bash
assistant notifications list --json
```

## Routing Behavior

- `preferred_channels` are **routing hints**, not hard channel forcing. The notification router makes the final delivery decision based on user preferences, channel availability, and urgency.
- Channel selection and delivery are handled entirely by the notification router — do not attempt to control delivery manually.

## Deduplication (`dedupe_key`)

- `dedupe_key` suppresses duplicate signals **permanently**. A second notification with the same key is **dropped entirely** for the lifetime of the assistant's event store. Once a key has been used, it cannot be reused — any future notification with the same key will be silently discarded.
- Never reuse a `dedupe_key` across logically distinct notifications, even if they are related. The key means "this exact event already fired," not "these events are in the same category."
- If you omit `dedupe_key`, the LLM decision engine may generate one automatically based on signal context. This means even keyless signals can be deduplicated if the engine considers them duplicates of a recent event.

## Conversation Grouping

Conversation grouping is handled by the LLM-powered decision engine, not by any parameter you pass. There is no explicit "post to conversation X" parameter — conversation reuse is inferred, not commanded.

**How it works:** The engine evaluates recent notification conversation candidates and decides whether a new signal is a continuation of an existing conversation based on `source_event_name`, provenance metadata, and message content. Use natural, descriptive titles and bodies — the engine groups by semantic relatedness, not string matching.

**`source_event_name` is the primary grouping signal.** Use a stable event name for notifications that belong to the same logical stream (e.g. `dog.news.thread.reply` for all replies in a thread). Use a distinct event name when the notification represents a genuinely different kind of event.

**Practical constraints:**

- Conversation candidates are scoped to the **last 24 hours** (max 5 per channel). You cannot reuse an old conversation from days ago.
- The engine will only reuse conversations originally created by the notification system (`source === 'notification'`). It will never append to a user-initiated conversation, even if it looks related.

## Important

- Do **NOT** use AppleScript `display notification` or other OS-level notification commands for assistant-managed alerts. Always use `assistant notifications send`.
- For sending rich content (digests, summaries, reports) to a specific chat or email destination, use the appropriate platform's API directly. For Gmail, use `messaging_send`. For Slack, use the Slack Web API directly (see the **slack** skill). The decision engine rewrites notification content into short alerts, which strips rich formatting.
- Send notifications that fire **immediately** with no delay capability. For one-time future alerts, use `schedule_create` with `fire_at`. For recurring alerts, use `schedule_create` with an expression (cron/RRULE).
