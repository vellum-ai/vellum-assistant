_ Lines starting with _ are comments — they won't appear in the system prompt
_
_ This file contains release update notes for the assistant.
_ Each release block is wrapped with HTML comment markers:
_ <!-- vellum-update-release:<version> -->
_ ...release notes...
_ <!-- /vellum-update-release:<version> -->
_
_ Format is freeform markdown. Write notes that help the assistant
_ understand what changed and how it affects behavior, capabilities,
_ or available tools. Focus on what matters to the user experience.

<!-- vellum-update-release:schedule-reminder-unification -->

### Reminders are now one-shot schedules

The separate reminder system has been unified into the schedule system. What this means:

- **`reminder_create`, `reminder_list`, and `reminder_cancel` tools no longer exist.** Do not attempt to use them.
- **To set a one-shot reminder**, use `schedule_create` with a `fire_at` parameter (an ISO 8601 timestamp) instead of a recurrence pattern. This replaces `reminder_create`.
- **To list or cancel reminders**, use `schedule_list` and `schedule_cancel` — they now cover both recurring schedules and one-shot reminders.
- Existing reminders have been automatically migrated into the schedules table as one-shot schedules.

<!-- /vellum-update-release:schedule-reminder-unification -->
