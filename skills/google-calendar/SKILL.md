---
name: google-calendar
description: View, create, and manage Google Calendar events and check availability
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📅"
  vellum:
    display-name: "Google Calendar"
    user-invocable: true
---

## Script Reference

All operations use a single CLI script that returns JSON:

- **Success**: `{ "ok": true, "data": ... }`
- **Failure**: `{ "ok": false, "error": "..." }`

| Script            | Subcommand     | Description                                                    |
| ----------------- | -------------- | -------------------------------------------------------------- |
| `scripts/gcal.ts` | `list`         | List events within a date range                                |
| `scripts/gcal.ts` | `get`          | Get full details of a specific event                           |
| `scripts/gcal.ts` | `create`       | Create a new event (**requires user confirmation**)            |
| `scripts/gcal.ts` | `availability` | Check free/busy times across calendars                         |
| `scripts/gcal.ts` | `rsvp`         | Respond to an event invitation (accepted, declined, tentative) |

## Usage Examples

```bash
# List events in a date range
bun scripts/gcal.ts list --time-min "2024-01-15T00:00:00Z" --time-max "2024-01-22T00:00:00Z"

# Get full details of a specific event
bun scripts/gcal.ts get --event-id "abc123"

# Create a new event (gates on assistant ui confirm)
bun scripts/gcal.ts create --summary "Team Meeting" --start "2024-01-15T09:00:00-05:00" --end "2024-01-15T10:00:00-05:00" --timezone "America/New_York"

# Check availability for a day
bun scripts/gcal.ts availability --time-min "2024-01-15T00:00:00Z" --time-max "2024-01-15T23:59:59Z"

# RSVP to an event invitation
bun scripts/gcal.ts rsvp --event-id "abc123" --response accepted
```

## Connection Setup

1. **Check connection health first.** Run `assistant oauth status google`. This checks whether the user's Google account is connected and the token is valid. Google Calendar shares the same OAuth connection as Gmail -- if the user already connected Gmail, calendar access is included.
2. **If no connection is found or the status check fails:** Call the `ui_show` tool with the following JSON to render an inline setup card, then end your turn immediately. Do not load the settings or OAuth setup skills until the user clicks a button.

```json
{
  "surface_type": "card",
  "display": "inline",
  "await_action": false,
  "data": {
    "title": "Connect Google",
    "body": "Connect Google once to use Google Calendar and Gmail."
  },
  "actions": [
    {
      "id": "setup_google_here",
      "label": "Set Up Here",
      "style": "primary",
      "data": {
        "provider": "google",
        "intent": "connect_in_chat",
        "setupMode": "managed_preferred",
        "services": ["google-calendar", "gmail"]
      }
    },
    {
      "id": "open_integrations_settings",
      "label": "Open Settings",
      "style": "secondary",
      "data": {
        "_action": "navigate_settings",
        "tab": "Integrations"
      }
    },
    {
      "id": "setup_google_own_app",
      "label": "Use Own App",
      "style": "secondary",
      "data": {
        "provider": "google",
        "intent": "connect_in_chat",
        "setupMode": "your_own_app",
        "services": ["google-calendar", "gmail"]
      }
    }
  ]
}
```

3. **If the user chooses Set Up Here or Use Own App:** Load the `vellum-oauth-integrations` skill and follow the selected setup mode. Use the "your-own" Google Cloud app path only when `setupMode` is `your_own_app` or the user explicitly asks for it.
4. **Fallback:** If inline UI is unavailable, briefly offer to open Settings > Integrations or continue setup in chat. Load `vellum-oauth-integrations` only if they choose the conversational path or the settings path fails.

## Scheduling Playbook

When the user wants to schedule something:

1. **Always check availability first** before proposing times. Use `bun scripts/gcal.ts availability` to find free slots.
2. Propose 2-3 available time options to the user.
3. Once the user picks a time, create the event with `bun scripts/gcal.ts create`.
4. If adding other attendees, mention that they'll receive an invitation email.

## Date & Time Handling

- Use ISO 8601 format for dates and times (e.g., `2024-01-15T09:00:00-05:00`).
- For all-day events, use date-only format (e.g., `2024-01-15`).
- Always ask the user for their timezone if it's not already known from context or their profile.
- When listing events, display times in the user's local timezone.

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

1. **Try to reconnect silently.** Run `assistant oauth ping google`. This often resolves expired tokens automatically.
2. **If reconnection fails, go straight to the inline setup card.** Don't ask which route the user prefers or explain what went wrong technically. Briefly say Google Calendar needs to be reconnected, render the card from Connection Setup, and stop. Load `vellum-oauth-integrations` only after the user chooses a chat-based setup action.
3. **Never try alternative approaches.** Don't use curl, browser automation, or any workaround. If the scripts can't do it, the reconnection flow is the answer.
4. **Never expose error details.** The user doesn't need to see error messages about tokens, OAuth, or API failures. Translate errors into plain language.
