---
name: "Time-Based Actions"
description: "Unified routing guide for reminders, schedules, notifications, and tasks — prevents common misrouting"
metadata: {"vellum": {"emoji": "\u23f0"}}
---

Quick-reference decision guide for choosing the right tool when users ask about time-triggered actions, recurring automation, notifications, or task tracking.

## Decision Tree

1. **Does the request have a specific future time AND should fire only once?**
   - YES -> `reminder_create`
   - Examples: "remind me at 3pm", "remind me in 5 minutes", "alert me tomorrow at 9am"

2. **Does the request have a recurring pattern?**
   - YES -> `schedule_create`
   - Examples: "every day at 9am", "weekly on Mondays", "every 2 hours"

3. **Does the request need an alert RIGHT NOW (no delay)?**
   - YES -> `send_notification`
   - Examples: "send me a notification", "alert me now", "ping me"

4. **Is the request about tracking work with no time trigger?**
   - YES -> `task_list_add`
   - Examples: "add to my tasks", "remind me to do X" (no time), "put this on my list"

## Critical Warning: `send_notification` is IMMEDIATE-ONLY

`send_notification` fires **instantly** when called. It has **NO delay, scheduling, or future-time capability**. NEVER use it for:
- "Remind me in 5 minutes" -> use `reminder_create`
- "Alert me at 3pm" -> use `reminder_create`
- "Notify me tomorrow" -> use `reminder_create`

If you use `send_notification` for any of these, the notification fires immediately and the user misses their intended reminder.

## Critical Warning: `task_list_add` has NO time trigger

`task_list_add` creates a work queue item. It does **NOT** fire at a specific time. NEVER use it as a workaround for delayed notifications. If the user wants a timed alert, use `reminder_create`.

## Relative Time Parsing

When the user says "in X minutes/hours", compute the ISO 8601 timestamp yourself:
- Take the current time
- Add the offset
- Format as ISO 8601 with timezone: `2025-03-15T09:05:00-05:00`
- Pass to `reminder_create` as `fire_at`

## "Remind me to X" Disambiguation

The word "remind" is ambiguous. Route based on whether a time is specified:

| User says | Time present? | Tool |
|-----------|--------------|------|
| "Remind me to buy milk" | No | `task_list_add` |
| "Remind me to buy milk at 5pm" | Yes | `reminder_create` |
| "Remind me in 10 minutes to check the oven" | Yes (relative) | `reminder_create` |
| "Remind me every morning to take vitamins" | Yes (recurring) | `schedule_create` |

## Reminder Modes

`reminder_create` supports two modes:
- **`notify`** (default) — shows a notification to the user when the reminder fires
- **`execute`** — sends the reminder message to a background assistant conversation for autonomous handling

Use `notify` for simple alerts. Use `execute` when the reminder should trigger the assistant to do something (e.g., "in 30 minutes, check if the build passed").

## Reminder Routing

`reminder_create` supports a `routing_intent` parameter that controls how the reminder is delivered at trigger time:
- **`single_channel`** (default) — deliver to one best channel
- **`multi_channel`** — deliver to a subset of channels
- **`all_channels`** — deliver to every available channel

You can also pass `routing_hints` (a JSON object) to influence routing decisions (e.g. preferred channels, exclusions).

## Tool Summary

| Tool | Timing | Recurrence | Purpose |
|------|--------|------------|---------|
| `reminder_create` | Future time (one-shot) | No | Timed notification or timed autonomous action |
| `schedule_create` | Recurring pattern | Yes (cron/RRULE) | Recurring automated jobs |
| `send_notification` | **Immediate only** | No | Alert the user right now |
| `task_list_add` | **No time trigger** | No | Track work in the task queue |
