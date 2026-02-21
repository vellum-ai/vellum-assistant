---
name: "Tasks"
description: "Two-layer task system with reusable templates and a prioritized work queue"
metadata: {"vellum": {"emoji": "\u2705"}}
---

Two-layer task system: **task templates** (reusable definitions with input placeholders) and **work items** (instances in the Task Queue with priority tiers and status tracking).

## Task Templates

Templates are reusable definitions saved from conversations via `task_save`. They capture the conversation pattern with placeholders that can be run later with different inputs via `task_run`. List templates with `task_list`, delete with `task_delete`.

## Work Items (Task Queue)

Work items are the user-facing "Tasks" shown in the Tasks panel. They track status and priority:

- **Priority tiers**: 0 = high, 1 = medium (default), 2 = low
- **Status flow**: queued -> running -> awaiting_review -> done
- **Resolution precedence**: work_item_id > task_id > task_name > title

Use `task_list_add` to enqueue items (ad-hoc or from a template), `task_list_show` to view the queue, `task_list_update` to modify, and `task_list_remove` to remove.

## Tool Routing: Tasks vs Schedules vs Reminders

These three systems serve different purposes. Choose the right one based on user intent:

### Task Queue (task_list_add / task_list_show / task_list_update / task_list_remove)
For tracking things the user wants to do or remember. Use when the user says:
- "Add to my tasks", "add to my queue", "put this on my task list"
- "Track this", "I need to do X", "queue this up"
- Any request to add a one-off item to their personal to-do list

To modify an existing task, use `task_list_update`:
- "Bump the priority on X", "make X high priority", "move this up"
- "Change the status of X", "mark X as done"
- "Update the notes on X"
Do NOT use `task_list_add` for updates — it will detect duplicates and suggest using `task_list_update` instead.

To remove a task from the queue, use `task_list_remove`:
- "Remove X from my tasks", "delete that task", "clean up the duplicate"
- "Take this off the list", "drop this task"

You can create ad-hoc work items by providing just a `title` to `task_list_add` — no existing task template is needed. A lightweight template is auto-created behind the scenes. For reusable task definitions with templates and input schemas, use `task_save` first.

**IMPORTANT:** When you call `task_list_show`, the Tasks window opens automatically on the client AND the tool returns the current task list. Present a brief summary of the tasks in your chat response so the user can see them inline. Do NOT also create a separate surface/UI (via `ui_show` or `app_create`) to display the task queue — that causes duplicate windows.

### Schedules (schedule_create / schedule_list / schedule_update / schedule_delete)
For recurring automated jobs that run on a recurrence schedule (cron or RRULE). Use ONLY when the user explicitly wants:
- Recurring automation: "every day at 9am", "weekly on Mondays", "every hour"
- Complex recurrence patterns: "every other Tuesday", "last weekday of the month" (use RRULE)
- Bounded recurrence: "every day for 30 days", "weekly until March" (RRULE with COUNT or UNTIL)
- Periodic background tasks: "check my email every morning", "run this report weekly"

#### RRULE Set Constructs
When building RRULE expressions, these set lines are supported:
- **RRULE** — one or more recurrence rules (multiple RRULE lines form a union of occurrences)
- **RDATE** — add one-off dates that are not covered by the RRULE pattern
- **EXDATE** — exclude specific dates from the recurrence set
- **EXRULE** — exclude an entire series of dates defined by a recurrence pattern

Exclusions (EXDATE, EXRULE) take precedence over inclusions (RRULE, RDATE). All RRULE expressions must include a DTSTART line and at least one RRULE or RDATE inclusion.

### Reminders (reminder_create / reminder_list / reminder_cancel)
For one-time time-triggered notifications. Use ONLY when the user wants:
- A notification at a specific future time: "remind me at 3pm", "remind me in 2 hours"
- A timed alert, not a tracked task

### Common mistakes to avoid
- "Add this to my tasks" → task_list_add (NOT schedule_create or reminder_create)
- "What's on my task list?" → task_list_show (NOT schedule_list)
- "Remind me to buy groceries" without a time → task_list_add (it's a task, not a timed reminder)
- "Remind me at 5pm to buy groceries" → reminder_create (explicit time trigger)
- "Check my inbox every morning at 8am" → schedule_create (recurring automation, cron)
- "Every other Tuesday at 10am" → schedule_create (recurring automation, RRULE)
- "Every weekday except holidays" → schedule_create (RRULE with EXDATE for exclusions)
- "Daily for the next 30 days" → schedule_create (RRULE with COUNT=30)
- "Bump priority on X" → task_list_update (NOT task_list_add)
- "Move this up" / "change this task priority" → task_list_update (NOT task_list_add)
- "Mark X as done" → task_list_update (NOT task_list_add)
- "Remove X from my tasks" → task_list_remove (NOT task_list_update)
- "Delete that task" / "clean up the duplicate" → task_list_remove

### Entity type routing: work items vs task templates

There are two entity types with separate ID spaces:
- **Work items** (the user's task queue) — managed by task_list_add, task_list_show, task_list_update, task_list_remove
- **Task templates** (reusable definitions) — managed by task_save, task_list, task_run, task_delete

Do NOT pass a work item ID to a task template tool or vice versa:
- Deleting a work item from the queue → task_list_remove (NOT task_delete)
- Deleting a task template → task_delete (NOT task_list_remove)
- Running a task template → task_run with task_id (NOT a work item ID)
- Updating a work item → task_list_update with work_item_id (NOT a task template ID)

If an error says "entity mismatch", read the corrective action and selector fields it provides to pick the right tool.

## Tips

- Use `task_save` only when the user wants to capture a conversation pattern as a reusable template.
- `task_list` shows saved templates; `task_list_show` shows the active work queue.
- **Always specify `required_tools`** when calling `task_list_add`. Think about what tools the task will need at execution time and list them explicitly (e.g. `["host_bash"]` for shell commands, `["host_file_read", "host_file_write"]` for file operations, `["web_search", "web_fetch"]` for web lookups). The user must approve these tools before the task can run — omitting them forces a fallback to all tools, which is noisy and may miss non-standard tools the task actually needs.
