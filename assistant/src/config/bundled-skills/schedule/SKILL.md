---
name: schedule
description: Recurring and one-shot scheduling - cron, RRULE, or single fire-at time
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📅"
  vellum:
    display-name: "Schedule"
---

Manage scheduled automations. Schedules can be **recurring** (cron or RRULE expression) or **one-shot** (a single `fire_at` timestamp). Both recurring and one-shot schedules support two modes: **execute** (run a message through the assistant) and **notify** (send a notification to the user).

## Schedule Syntax

### Cron

Standard 5-field cron syntax: `minute hour day-of-month month day-of-week`

| Field        | Values        | Special characters |
| ------------ | ------------- | ------------------ |
| Minute       | 0-59          | , - \* /           |
| Hour         | 0-23          | , - \* /           |
| Day of month | 1-31          | , - \* /           |
| Month        | 1-12          | , - \* /           |
| Day of week  | 0-7 (0,7=Sun) | , - \* /           |

Examples:

- `0 9 * * 1-5` - weekdays at 9:00 AM
- `30 8 * * *` - every day at 8:30 AM
- `0 */2 * * *` - every 2 hours
- `0 9 1 * *` - first of every month at 9:00 AM

### RRULE (RFC 5545)

iCalendar recurrence rules for complex patterns. Must include a DTSTART line.

Supported lines (all expressions must include DTSTART + at least one RRULE or RDATE):

| Line      | Purpose                                                 |
| --------- | ------------------------------------------------------- |
| `DTSTART` | Start date/time anchor (required)                       |
| `RRULE:`  | Recurrence rule (multiple lines = union of occurrences) |
| `RDATE`   | Add one-off dates not covered by the pattern            |
| `EXDATE`  | Exclude specific dates from the set                     |
| `EXRULE`  | Exclude an entire recurring series                      |

Exclusions (EXDATE, EXRULE) always take precedence over inclusions (RRULE, RDATE).

#### Basic examples

- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY` - every day at 9:00 AM UTC
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR` - Mon/Wed/Fri at 9:00 AM UTC
- `DTSTART:20250101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1,15` - 1st and 15th of each month

#### Bounded recurrence

- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY;COUNT=30` - daily for 30 occurrences then stop
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250331T235959Z` - every Monday until end of March

#### Set construct examples

- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\nEXDATE:20250120T090000Z` - Mon/Wed/Fri except Jan 20
- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nEXRULE:FREQ=WEEKLY;BYDAY=SA,SU` - every weekday (daily minus weekends)
- `DTSTART:20250101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1\nRDATE:20250704T090000Z` - 1st of each month plus July 4th
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU\nRRULE:FREQ=WEEKLY;BYDAY=TH` - union of Tuesdays and Thursdays

## One-Shot Schedules (Reminders)

To create a one-time schedule that fires once and is done, pass `fire_at` (an ISO 8601 timestamp) instead of an `expression`. This replaces the old reminder concept - "remind me at 3pm" becomes a one-shot schedule with `fire_at`.

One-shot schedules:
- Fire once at the specified time, then are marked as `fired` and disabled.
- Support both `execute` and `notify` modes (see below).
- Can be cancelled before they fire.

Examples:
- "remind me at 3pm" → `schedule_create` with `fire_at: "2025-03-15T15:00:00-05:00"`, `mode: "notify"`
- "at 5pm, check my email and summarize it" → `schedule_create` with `fire_at`, `mode: "execute"`

## Mode

The `mode` parameter controls what happens when a schedule fires:

- **execute** (default) - sends the schedule's message to a background assistant conversation for autonomous handling. The assistant processes the message as if the user sent it.
- **notify** - sends a notification to the user via the notification pipeline. No assistant processing occurs.

Use `notify` for simple reminders ("remind me to take medicine at 9am") and `execute` for tasks that need assistant action ("check my calendar at 8am and send me a digest").

## Routing (notify mode)

Control how notify-mode schedules are delivered at trigger time with `routing_intent`:

- **single_channel** - deliver to one best channel
- **multi_channel** - deliver to a subset of channels
- **all_channels** (default) - deliver to every available channel

Optionally pass `routing_hints` (a JSON object) to influence routing decisions (e.g. preferred channels, exclusions).

### Routing Defaults

- **Default to `all_channels`** for most notifications. Users usually want to be notified wherever they are.
- **Use `single_channel`** only when the user explicitly specifies a single channel (e.g. "remind me on Telegram").
- **Check `user_message_channel` (or `channel` when all channels are the same)** from the turn context. If the user is currently active on a specific channel, include it as a routing hint:
  ```
  routing_hints: { preferred_channels: ["vellum"] }
  routing_intent: "all_channels"
  ```

## Tool Input

Use `syntax` + `expression` to specify the schedule type explicitly, or just `expression` to auto-detect. For one-shot schedules, use `fire_at` instead of `expression`.

## Lifecycle

1. Create a schedule with a name and either an expression (recurring) or fire_at (one-shot), plus a message.
2. At each trigger time, the message is dispatched to the assistant (execute mode) or a notification is sent (notify mode).
3. Schedules can be enabled/disabled, updated, or deleted. One-shot schedules are automatically disabled after firing.

## Tips

- Use `schedule_create` for both recurring automation ("every day at 9am") and one-time reminders ("remind me at 3pm").
- For task tracking ("add to my tasks", "add to my queue"), use task_list_add instead.
- `fire_at` must be a strict ISO 8601 timestamp with timezone offset or Z (e.g. `2025-03-15T09:00:00-05:00`).

### Anchored & Ambiguous Relative Time

Phrases like "at the 45 minute mark", "at the top of the hour", "at noon", or "20 minutes in" are **clock-position or anchored relative time** expressions. Do NOT treat them as offsets from now.

**Resolution rules (in priority order):**

1. **Conversation-anchored expressions** - if the user mentioned a start time earlier in conversation ("I got here at 9", "meeting started at 2:10"), interpret offset-style phrases ("the 45 minute mark", "20 minutes in") as `start_time + offset`.

2. **Clock-position expressions** - when no start time is in context, map directly to a wall-clock time:
   - "top of the hour" → next :00
   - "the X minute mark" → current hour's :XX; if already past, advance one hour
   - "noon" / "midnight" → 12:00 PM or 12:00 AM today; if past, tomorrow

3. **Ask only if truly ambiguous** - if neither rule resolves, ask for clarification. Never silently default to "from now."
- Timezones default to the system timezone if omitted. Use IANA timezone identifiers (e.g. "America/Los_Angeles").
- Prefer RRULE for complex patterns that cron cannot express (e.g. "every other Tuesday", "last weekday of the month").

## Capability Preflight

Before confirming a schedule to the user, you MUST verify that you have the capabilities needed to execute the scheduled message autonomously. Scheduled messages run without user interaction - if a required integration is missing, the schedule will fail silently.

When `schedule_create` returns, it includes an integration status summary. Cross-reference the scheduled task's requirements against the available integrations:

- If the task involves **email** (reading, sending, OTP verification): an email integration must be connected (check the "email" category)
- If the task involves **making calls**: Twilio must be connected
- If the task involves **web browsing or form-filling**: browser automation must be available (check client type)
- If the task involves a **multi-step workflow** (e.g., book appointment → read confirmation email), trace the full dependency chain

If any required capability is missing:

1. **Do NOT tell the user the schedule is ready** - instead, explain what's missing and why the schedule won't work yet
2. Offer to help set up the missing integration first
3. The schedule is still created (so timing is preserved), but make it clear it won't execute successfully until dependencies are resolved

## Delivering Results

Scheduled messages run without user interaction. If the task produces output that the user should see (e.g. a digest, summary, or report), the scheduled message **must** include an explicit instruction to deliver the results. Without this, the output only lives in the conversation log and never reaches the user.

Choose the right delivery tool based on the content:

- **Rich content** (digests, summaries, reports): For Gmail, use `messaging_send` with the target platform and conversation ID. For Slack, use the Slack Web API directly via CLI (`chat.postMessage`). This preserves the full content and posts directly.
- **Short alerts** (status updates, completion notices): Use `send_notification` to let the notification router pick the best channel. Note: the router's decision engine rewrites content into short alerts, so it is not suitable for rich content.

Example schedule message for a Slack digest:

> "Scan my Slack channels for the last 24 hours using slack_scan_digest, then use the Slack Web API via bash (network_mode: proxied, credential_ids: ['slack_channel:bot_token']) to call chat.postMessage with channel 'C0A7STRJ4G5' to post the summary to #alex-agent-messages."
