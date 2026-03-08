---
name: reminder
description: One-time time-based reminders that fire at a specific future time
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🔔","vellum":{"display-name":"Reminder"}}
---

Create, list, and cancel one-time reminders. Reminders fire at a specific future time and either notify the user or execute a message through the assistant.

## Modes

- **notify** (default) — shows a notification to the user when the reminder fires
- **execute** — sends the reminder message to a background assistant conversation for autonomous handling

## Routing

Control how the reminder is delivered at trigger time with `routing_intent`:

- **single_channel** — deliver to one best channel
- **multi_channel** — deliver to a subset of channels
- **all_channels** (default) — deliver to every available channel

Optionally pass `routing_hints` (a JSON object) to influence routing decisions (e.g. preferred channels, exclusions). When omitted, defaults to `{}`.

### Routing Defaults

Use the following heuristics to pick `routing_intent`:

- **Default to `all_channels`** for most reminders. Users setting reminders usually want to be notified wherever they are, and redundant notifications are less harmful than missed ones.
- **Use `single_channel`** only when the user explicitly specifies a single channel (e.g. "remind me on Telegram") or the reminder is low-stakes and noise reduction matters.
- **Check `user_message_channel`** from the turn context. If the user is currently active on a specific channel (e.g. `vellum`), always include that channel. Pass it as a routing hint:
  ```
  routing_hints: { preferred_channels: ["vellum"] }
  routing_intent: "all_channels"
  ```
- **Never use `single_channel` as a passive default.** If you haven't thought about which channel to use, use `all_channels`.

### Examples

| Scenario | routing_intent | routing_hints |
|---|---|---|
| User sets reminder from desktop app | `all_channels` | `{ preferred_channels: ["vellum"] }` |
| User says "remind me on Telegram" | `single_channel` | `{ preferred_channels: ["telegram"] }` |
| User sets reminder from Telegram | `all_channels` | `{ preferred_channels: ["telegram"] }` |
| No channel preference expressed | `all_channels` | `{}` |

## Usage Notes

- Use reminders ONLY for time-triggered notifications (e.g. "remind me at 3pm", "remind me in 2 hours").
- For recurring automation, use schedules instead.
- For task tracking ("add to my tasks", "add to my queue"), use task_list_add instead.
- `fire_at` must be a strict ISO 8601 timestamp with timezone offset or Z (e.g. `2025-03-15T09:00:00-05:00` or `2025-03-15T09:00:00Z`). Ambiguous timestamps without timezone info will be rejected.
- `label` is a short human-readable summary shown in the notification.

### Anchored & Ambiguous Relative Time

Phrases like "at the 45 minute mark", "at the top of the hour", "on the half-hour", "at noon", "20 minutes in", or "when I hit an hour" are **clock-position or anchored relative time** expressions. Do NOT treat them as offsets from now.

**Resolution rules (in priority order):**

1. **Session-anchored expressions** — if the user mentioned a start time earlier in conversation ("I got here at 9", "meeting started at 2:10"), interpret offset-style phrases ("the 45 minute mark", "20 minutes in", "when I hit an hour") as `start_time + offset`. This takes precedence because the conversational anchor overrides any wall-clock interpretation.

2. **Clock-position expressions** — when no start time is in context, map directly to a wall-clock time:
   - "top of the hour" / "on the hour" → next :00 (e.g. 10:00 AM)
   - "the X minute mark" / "at :XX" → current hour's :XX; if already past, advance one hour
   - "the half-hour mark" / "half past" → nearest upcoming :30
   - "noon" / "midnight" → 12:00 PM or 12:00 AM today; if past, tomorrow
   - "quarter past" / "quarter to" → :15 or :45 of current or next hour

3. **Ask only if truly ambiguous** — if neither rule 1 nor rule 2 resolves, ask: "Do you mean [clock time] or [X minutes from now]?" Never silently default to "from now."

**Examples:**
- "meeting started at 2:10, remind me at the 45 minute mark" → 2:55 PM (start + 45 min)
- "20 minutes in, I started at 2pm" → 2:20 PM (start + 20 min)
- "at the 45 min mark" (no start time, now: 9:39) → 9:45 AM (wall-clock)
- "at the 45 min mark" (no start time, now: 9:50) → 10:45 AM (wall-clock, next hour)
- "top of the hour" (now: 9:39) → 10:00 AM
- "at noon" → 12:00 PM today
- "at the hour mark" with no start time → ask for clarification
