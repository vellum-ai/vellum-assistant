---
name: schedule
description: Recurring automation that dispatches messages on a cron or RRULE schedule
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"📅","vellum":{"display-name":"Schedule"}}
---

Manage recurring scheduled automations. Each schedule has an expression (cron or RRULE) that defines when it fires, and a message that gets dispatched to the assistant at trigger time.

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

- `0 9 * * 1-5` — weekdays at 9:00 AM
- `30 8 * * *` — every day at 8:30 AM
- `0 */2 * * *` — every 2 hours
- `0 9 1 * *` — first of every month at 9:00 AM

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

- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY` — every day at 9:00 AM UTC
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR` — Mon/Wed/Fri at 9:00 AM UTC
- `DTSTART:20250101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1,15` — 1st and 15th of each month

#### Bounded recurrence

- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY;COUNT=30` — daily for 30 occurrences then stop
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250331T235959Z` — every Monday until end of March

#### Set construct examples

- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR\nEXDATE:20250120T090000Z` — Mon/Wed/Fri except Jan 20
- `DTSTART:20250101T090000Z\nRRULE:FREQ=DAILY\nEXRULE:FREQ=WEEKLY;BYDAY=SA,SU` — every weekday (daily minus weekends)
- `DTSTART:20250101T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1\nRDATE:20250704T090000Z` — 1st of each month plus July 4th
- `DTSTART:20250101T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU\nRRULE:FREQ=WEEKLY;BYDAY=TH` — union of Tuesdays and Thursdays

## Tool Input

Use `syntax` + `expression` to specify the schedule type explicitly, or just `expression` to auto-detect.

## Lifecycle

1. Create a schedule with a name, expression, and message.
2. At each trigger time, the message is dispatched to the assistant as if the user sent it.
3. Schedules can be enabled/disabled, updated, or deleted.

## Tips

- Only use `schedule_create` when the user explicitly wants recurring automation (e.g. "every day at 9am", "weekly on Mondays"). For one-time tasks, use the task list instead.
- Timezones default to the system timezone if omitted. Use IANA timezone identifiers (e.g. "America/Los_Angeles").
- Prefer RRULE for complex patterns that cron cannot express (e.g. "every other Tuesday", "last weekday of the month").

## Capability Preflight

Before confirming a schedule to the user, you MUST verify that you have the capabilities needed to execute the scheduled message autonomously. Scheduled messages run without user interaction — if a required integration is missing, the schedule will fail silently.

When `schedule_create` returns, it includes an integration status summary. Cross-reference the scheduled task's requirements against the available integrations:

- If the task involves **email** (reading, sending, OTP verification): an email integration must be connected (check the "email" category)
- If the task involves **tweeting or reading Twitter**: Twitter must be connected
- If the task involves **sending SMS or making calls**: SMS/Twilio must be connected
- If the task involves **web browsing or form-filling**: browser automation must be available (check client type)
- If the task involves a **multi-step workflow** (e.g., book appointment → read confirmation email), trace the full dependency chain

If any required capability is missing:

1. **Do NOT tell the user the schedule is ready** — instead, explain what's missing and why the schedule won't work yet
2. Offer to help set up the missing integration first
3. The schedule is still created (so timing is preserved), but make it clear it won't execute successfully until dependencies are resolved

## Delivering Results

Scheduled messages run without user interaction. If the task produces output that the user should see (e.g. a digest, summary, or report), the scheduled message **must** include an explicit instruction to deliver the results. Without this, the output only lives in the conversation log and never reaches the user.

Choose the right delivery tool based on the content:

- **Rich content** (digests, summaries, reports): Use `messaging_send` with the target platform and conversation ID. This preserves the full content and posts directly.
- **Short alerts** (status updates, completion notices): Use `send_notification` to let the notification router pick the best channel. Note: the router's decision engine rewrites content into short alerts, so it is not suitable for rich content.

Example schedule message for a Slack digest:

> "Scan my Slack channels for the last 24 hours using slack_scan_digest, then use messaging_send with platform 'slack' and conversation_id 'C0A7STRJ4G5' to post the summary to #alex-agent-messages."
