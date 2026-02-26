---
name: "Reminder"
description: "One-time time-based reminders that fire at a specific future time"
metadata: {"vellum": {"emoji": "🔔"}}
---

Create, list, and cancel one-time reminders. Reminders fire at a specific future time and either notify the user or execute a message through the assistant.

## Modes

- **notify** (default) — shows a notification to the user when the reminder fires
- **execute** — sends the reminder message to a background assistant conversation for autonomous handling

## Routing

When creating a reminder, you can specify how it should be delivered at trigger time:

- **`routing_intent`** — controls how many channels receive the reminder:
  - `single_channel` (default) — deliver to the originating channel only
  - `multi_channel` — deliver to a subset of available channels
  - `all_channels` — deliver to every connected channel
- **`routing_hints`** — optional free-form JSON object with hints for trigger-time routing (e.g. preferred channels, fallback order). These are model-authored and not parsed server-side.

If `routing_intent` is omitted, it defaults to `single_channel`.

## Usage Notes

- Use reminders ONLY for time-triggered notifications (e.g. "remind me at 3pm", "remind me in 2 hours").
- For recurring automation, use schedules instead.
- For task tracking ("add to my tasks", "add to my queue"), use task_list_add instead.
- `fire_at` must be a strict ISO 8601 timestamp with timezone offset or Z (e.g. `2025-03-15T09:00:00-05:00` or `2025-03-15T09:00:00Z`). Ambiguous timestamps without timezone info will be rejected.
- `label` is a short human-readable summary shown in the notification.
