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

## Tips

- When the user says "add to my tasks" or "add to my queue", use `task_list_add` (NOT schedule_create or reminder_create).
- Use `task_save` only when the user wants to capture a conversation pattern as a reusable template.
- `task_list` shows saved templates; `task_list_show` shows the active work queue.
