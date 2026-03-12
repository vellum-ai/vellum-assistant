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

<!-- vellum-update-release:git-hooks-trust-prompt -->

### Git hook trust prompt — auto-commits are now fail-closed by default

The assistant auto-commit system (turn checkpoints, heartbeat safety net, and shutdown commits) no longer runs git hooks unless you explicitly trust the project.

**What changed:**

- **Default behavior is fail-closed.** When the assistant commits workspace changes, it suppresses all git hooks (`core.hooksPath=/dev/null`) unless you have explicitly said to trust the project's hooks. This prevents untrusted hook scripts from executing arbitrary code during routine auto-commits.
- **New trust prompt.** When the assistant detects a workspace with git hooks configured, it will ask you once: "This project has git hooks. Do you trust this project and want to enable hooks for assistant auto-commits?" Answering yes stores an explicit allow decision; answering no (or dismissing the prompt) keeps hooks suppressed.
- **Per-project decisions.** Trust decisions are scoped to each workspace directory. Trusting one project does not affect others.
- **No impact on your manual git workflow.** Only the assistant's auto-commits are affected. Your own `git commit` commands run hooks as normal.

<!-- /vellum-update-release:git-hooks-trust-prompt -->

<!-- vellum-update-release:schedule-reminder-unification -->

### Reminders are now one-shot schedules

The separate reminder system has been unified into the schedule system. What this means:

- **`reminder_create`, `reminder_list`, and `reminder_cancel` tools no longer exist.** Do not attempt to use them.
- **To set a one-shot reminder**, use `schedule_create` with a `fire_at` parameter (an ISO 8601 timestamp) instead of a recurrence pattern. This replaces `reminder_create`.
- **To list or cancel reminders**, use `schedule_list` and `schedule_delete` — they now cover both recurring schedules and one-shot reminders.
- Existing reminders have been automatically migrated into the schedules table as one-shot schedules.

<!-- /vellum-update-release:schedule-reminder-unification -->
