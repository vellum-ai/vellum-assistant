---
name: "Schedule"
description: "Recurring automation that dispatches messages on a cron or RRULE schedule"
metadata: {"vellum": {"emoji": "\ud83d\udcc5"}}
---

Manage recurring scheduled automations. Each schedule has an expression (cron or RRULE) that defines when it fires, and a message that gets dispatched to the assistant at trigger time.

## Schedule Syntax

### Cron

Standard 5-field cron syntax: `minute hour day-of-month month day-of-week`

| Field         | Values        | Special characters |
|---------------|---------------|--------------------|
| Minute        | 0-59          | , - * /            |
| Hour          | 0-23          | , - * /            |
| Day of month  | 1-31          | , - * /            |
| Month         | 1-12          | , - * /            |
| Day of week   | 0-7 (0,7=Sun) | , - * /            |

Examples:
- `0 9 * * 1-5` — weekdays at 9:00 AM
- `30 8 * * *` — every day at 8:30 AM
- `0 */2 * * *` — every 2 hours
- `0 9 1 * *` — first of every month at 9:00 AM

### RRULE (RFC 5545)

iCalendar recurrence rules for complex patterns. Must include a DTSTART line.

Examples:
- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY` — every day at 9:00 AM UTC
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR` — Mon/Wed/Fri at 9:00 AM UTC
- `DTSTART:20250101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1,15` — 1st and 15th of each month

## Tool Input

Use `syntax` + `expression` to specify the schedule type explicitly, or just `expression` to auto-detect. The legacy `cron_expression` field is still accepted as a cron alias.

## Lifecycle

1. Create a schedule with a name, expression, and message.
2. At each trigger time, the message is dispatched to the assistant as if the user sent it.
3. Schedules can be enabled/disabled, updated, or deleted.

## Tips

- Only use `schedule_create` when the user explicitly wants recurring automation (e.g. "every day at 9am", "weekly on Mondays"). For one-time tasks, use the task list instead.
- Timezones default to the system timezone if omitted. Use IANA timezone identifiers (e.g. "America/Los_Angeles").
- Prefer RRULE for complex patterns that cron cannot express (e.g. "every other Tuesday", "last weekday of the month").
