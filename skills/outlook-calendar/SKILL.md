---
name: outlook-calendar
description: View, create, and manage Outlook Calendar events and check availability
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📅"
  vellum:
    display-name: "Outlook Calendar"
    user-invocable: true
---

## Script Reference

All operations use a single CLI script that returns JSON:

- **Success**: `{ "ok": true, "data": ... }`
- **Failure**: `{ "ok": false, "error": "..." }`

| Script                   | Subcommand     | Description                                                    |
| ------------------------ | -------------- | -------------------------------------------------------------- |
| `scripts/outlook-cal.ts` | `list`         | List events within a date range (supports OData `$filter`)     |
| `scripts/outlook-cal.ts` | `get`          | Get full details of a specific event                           |
| `scripts/outlook-cal.ts` | `create`       | Create a new event (**requires user confirmation**)            |
| `scripts/outlook-cal.ts` | `availability` | Check free/busy times across calendars                         |
| `scripts/outlook-cal.ts` | `rsvp`         | Respond to an event invitation (accepted, declined, tentative) |

## Usage Examples

```bash
# List events in a date range
bun scripts/outlook-cal.ts list --start-date-time "2024-01-15T00:00:00Z" --end-date-time "2024-01-22T00:00:00Z"

# List events with an OData filter
bun scripts/outlook-cal.ts list --filter "subject eq 'Team Meeting'"

# Get full details of a specific event
bun scripts/outlook-cal.ts get --event-id "AAMkAD..."

# Create a new event (gates on assistant ui confirm)
bun scripts/outlook-cal.ts create --subject "Team Meeting" --start "2024-01-15T09:00:00-05:00" --end "2024-01-15T10:00:00-05:00" --timezone "America/New_York"

# Check availability for a day
bun scripts/outlook-cal.ts availability --start "2024-01-15T00:00:00Z" --end "2024-01-15T23:59:59Z"

# RSVP to an event invitation
bun scripts/outlook-cal.ts rsvp --event-id "AAMkAD..." --response accepted
```

## Connection Setup

1. **Check connection health first.** Run `assistant oauth status outlook`. This checks whether the user's Outlook/Microsoft account is connected and the token is valid. Outlook Calendar shares the same OAuth connection as Outlook email — if the user already connected Outlook email, calendar access is included.
2. **If no connection is found or the status check fails:** Load the `vellum-oauth-integrations` skill. The skill will evaluate whether managed or your-own mode is appropriate and guide the user accordingly.

## Scheduling Playbook

When the user wants to schedule something:

1. **Always check availability first** before proposing times. Use `bun scripts/outlook-cal.ts availability` to find free slots.
2. Propose 2-3 available time options to the user.
3. Once the user picks a time, create the event with `bun scripts/outlook-cal.ts create`.
4. If adding other attendees, mention that they'll receive an invitation email.

## Date & Time Handling

- Use ISO 8601 format for dates and times (e.g., `2024-01-15T09:00:00-05:00`).
- For all-day events, Outlook uses `dateTime` with an `isAllDay` flag — set the start and end as date-only values (e.g., `2024-01-15`).
- Always ask the user for their timezone if it's not already known from context or their profile.
- When listing events, display times in the user's local timezone.
- **Timezone edge case**: When `dateTime` already includes a UTC offset (e.g., `2024-01-15T09:00:00-05:00`), do not send a separate `timeZone` parameter — the offset in the datetime string is authoritative and sending both can cause conflicts.

## Confidence & Safety

Create and RSVP are **medium-risk** operations:

- **Create**: The `create` subcommand gates on `assistant ui confirm` — it presents a confirmation dialog to the user and only proceeds if approved. Pass `--skip-confirm` when the user has already given explicit confirmation in the conversation.
- **RSVP**: The `rsvp` subcommand gates on `assistant ui confirm` — it presents a confirmation dialog showing the event, current status, and new response. Pass `--skip-confirm` when the user has already given explicit confirmation in the conversation.

Confidence scores for medium-risk operations:

- **0.9-1.0**: User explicitly requested this exact action
- **0.7-0.8**: Action is strongly implied by context
- **0.5-0.6**: Reasonable inference but some ambiguity
- **Below 0.5**: Ask the user to confirm before proceeding

## Error Recovery

When a calendar script fails with a token or authorization error:

1. **Try to reconnect silently.** Run `assistant oauth ping outlook`. This often resolves expired tokens automatically.
2. **If reconnection fails, go straight to setup.** Don't present options, ask which route the user prefers, or explain what went wrong technically. Just tell the user briefly (e.g., "Outlook Calendar needs to be reconnected - let me set that up") and immediately load the `vellum-oauth-integrations` skill. The user came to you to get something done, not to troubleshoot - make it seamless.
3. **Never try alternative approaches.** Don't use curl, browser automation, or any workaround. If the scripts can't do it, the reconnection flow is the answer.
4. **Never expose error details.** The user doesn't need to see error messages about tokens, OAuth, or API failures. Translate errors into plain language.
