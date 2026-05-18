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
assistant notifications send --message "Your verbatim observation in your own words"
```

For time-sensitive items:

```bash
assistant notifications send --message "..." --urgent
```

### Command Reference

| Flag                  | Required | Description                                  |
| --------------------- | -------- | -------------------------------------------- |
| `--message <message>` | Yes      | Notification message the user should receive |
| `--title <title>`     | No       | Optional notification title                  |
| `--urgent`            | No       | Mark as needing attention now/soon           |
| `--json`              | No       | Output machine-readable JSON                 |

### Urgent semantics

Use `--urgent` for items needing attention now/soon (blocked work, broken auth, time-sensitive issues). Skip for items the user should see when they have time.

### Examples

```bash
# Plain notification
assistant notifications send --message "Backup completed successfully"

# Urgent notification
assistant notifications send --message "Auth token expired — sync paused" --urgent
```

### Response Format

```json
{ "ok": true, "signalId": "...", "dispatched": true }
```

## Listing Notifications

```bash
assistant notifications list --json
```

## Important

- Do **NOT** use AppleScript `display notification` or other OS-level notification commands for assistant-managed alerts. Always use `assistant notifications send`.
- For sending rich content (digests, summaries, reports) to a specific chat or email destination, use the appropriate platform's API directly. For Gmail, use `messaging_send`. For Slack, use the Slack Web API directly (see the **slack** skill).
- Send notifications that fire **immediately** with no delay capability. For one-time future alerts, use `schedule_create` with `fire_at`. For recurring alerts, use `schedule_create` with an expression (cron/RRULE).
