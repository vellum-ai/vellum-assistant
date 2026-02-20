---
name: "Reminder"
description: "One-time time-based reminders that fire at a specific future time"
metadata: {"vellum": {"emoji": "🔔"}}
---

Create, list, and cancel one-time reminders. Reminders fire at a specific future time and either notify the user or execute a message through the assistant.

## Modes

- **notify** (default) — shows a notification to the user when the reminder fires
- **execute** — sends the reminder message to a background assistant conversation for autonomous handling

## Usage Notes

- Use reminders ONLY for time-triggered notifications (e.g. "remind me at 3pm", "remind me in 2 hours").
- For recurring automation, use schedules instead.
- For task tracking ("add to my tasks", "add to my queue"), use task_list_add instead.
- `fire_at` must be a strict ISO 8601 timestamp with timezone offset or Z (e.g. `2025-03-15T09:00:00-05:00` or `2025-03-15T09:00:00Z`). Ambiguous timestamps without timezone info will be rejected.
- `label` is a short human-readable summary shown in the notification.
