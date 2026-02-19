---
name: "Schedule"
description: "Cron-like recurring automation that dispatches messages on a schedule"
metadata: {"vellum": {"emoji": "\ud83d\udcc5"}}
---

Manage recurring scheduled automations (cron jobs). Each schedule has a cron expression that defines when it fires, and a message that gets dispatched to the assistant at trigger time.

## Cron Expression Format

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

## Lifecycle

1. Create a schedule with a name, cron expression, and message.
2. At each trigger time, the message is dispatched to the assistant as if the user sent it.
3. Schedules can be enabled/disabled, updated, or deleted.

## Tips

- Only use `schedule_create` when the user explicitly wants recurring automation (e.g. "every day at 9am", "weekly on Mondays"). For one-time tasks, use the task list instead.
- Timezones default to the system timezone if omitted. Use IANA timezone identifiers (e.g. "America/Los_Angeles").
