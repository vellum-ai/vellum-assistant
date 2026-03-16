---
name: followups
description: Track sent messages awaiting responses across communication channels
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📨"
  vellum:
    display-name: "Followups"
---

Track messages sent on external channels (email, Slack, WhatsApp, etc.) that are awaiting a response.

## Lifecycle

Each follow-up moves through these states:

- **pending** -- waiting for a response
- **overdue** -- past the expected response deadline with no reply
- **nudged** -- a reminder was sent after becoming overdue
- **resolved** -- a response was received or the follow-up was manually closed

## Auto-Deadline

When `expected_response_hours` is set, the follow-up automatically becomes overdue after that window. If a `contact_id` is provided, the contact's importance score can inform grace period decisions.

## Resolution

Follow-ups can be resolved in two ways:
1. **By ID** -- resolve a specific follow-up directly
2. **By conversation** -- provide channel + conversation_id to auto-resolve all matching pending follow-ups (useful when a response arrives on a conversation)

## Tips

- Use `followup_list` with `overdue_only: true` to find conversations that need attention.
- Attach a `reminder_schedule_id` to link a recurring reminder schedule to a follow-up.
- Filter by channel, status, or contact to narrow results.
