---
name: tasks
description: Two-layer task system with reusable templates and a prioritized work queue
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "✅"
  vellum:
    display-name: "Tasks"
    activation-hints:
      - "User wants to add, check, or manage items on their to-do list or task queue"
      - "For one-off action items, not recurring automations (use schedule for those)"
    avoid-when:
      - "User wants recurring/scheduled automation — use the schedule skill instead"
---

Two-layer task system: **task templates** (reusable definitions with input placeholders) and **work items** (instances in the Task Queue with priority tiers and status tracking).

## Task Templates

Templates are reusable definitions saved from conversations. They capture the conversation pattern with placeholders that can be run later with different inputs. Manage templates with the `assistant task` CLI:

```bash
# Save the current conversation as a reusable task template
assistant task save --conversation-id <id> --title "Weekly report"

# List all saved task templates
assistant task list

# Run a saved template with specific inputs
assistant task run --name "Weekly report" --inputs '{"team": "engineering"}'

# Delete a task template by ID
assistant task delete <id>
```

## Work Items (Task Queue)

Work items are the user-facing "Tasks" managed through conversation. They track status and priority:

- **Priority tiers**: 0 = high, 1 = medium (default), 2 = low
- **Status flow**: queued -> running -> awaiting_review -> done
- **Resolution precedence**: work_item_id > task_id > task_name > title

Manage the queue with `assistant task queue`:

```bash
# View the current task queue
assistant task queue show

# Add an item to the queue (ad-hoc or from a template)
assistant task queue add --title "Review Q2 metrics" --required-tools host_bash web_search

# Update a work item's status
assistant task queue update --work-item-id <id> --status done

# Remove a work item from the queue
assistant task queue remove --work-item-id <id>

# Run a specific work item from the queue
assistant task queue run --work-item-id <id>
```

## Tips

- When the user says "add to my tasks" or "add to my queue", use `assistant task queue add` (NOT schedule).
- Use `assistant task save` only when the user wants to capture a conversation pattern as a reusable template.
- `assistant task list` shows saved templates; `assistant task queue show` shows the active work queue.
- **Always specify `--required-tools`** when running `assistant task queue add`. Think about what tools the task will need at execution time and list them explicitly (e.g. `host_bash` for shell commands, `host_file_read host_file_write` for file operations, `web_search web_fetch` for web lookups). The user must approve these tools before the task can run -- omitting them forces a fallback to all tools, which is noisy and may miss non-standard tools the task actually needs.
