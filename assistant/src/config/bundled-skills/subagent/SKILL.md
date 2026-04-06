---
name: subagent
description: Spawn and manage autonomous background agents for parallel work
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🤖"
  vellum:
    display-name: "Subagent"
    activation-hints:
      - "Run tasks in parallel, delegate work to background agents, or do multiple things at once"
      - "Spawn a researcher, coder, or planner agent for independent work"
---

Subagent orchestration -- spawn background agents to work on tasks in parallel.

## Lifecycle

Subagents follow this status flow: `pending` -> `running` -> `completed` / `failed` / `aborted`

- **Spawn**: Use `subagent_spawn` with a label, objective, and role. The subagent runs autonomously.
- **Mid-run communication**: Subagents can send notifications to the parent via `notify_parent` while still running -- useful for sharing interim findings or signaling that they are blocked.
- **Auto-notification**: The parent conversation is automatically notified when a subagent reaches a terminal status (completed/failed/aborted). Do NOT poll `subagent_status`.
- **Read output**: Use `subagent_read` after the subagent reaches a terminal status to retrieve its full output.

## Roles

Each subagent is spawned with a role that determines its tool access. Choose the most restrictive role that can accomplish the task.

| Role | Tools | When to use |
|---|---|---|
| `general` | Full tool access | Task genuinely needs unrestricted capabilities (rare -- prefer a specialized role) |
| `researcher` | `web_search`, `web_fetch`, `file_read`, `file_list`, `recall`, `notify_parent` | Information gathering, web research, codebase exploration, reading documentation |
| `coder` | `bash`, `file_read`, `file_write`, `file_edit`, `web_search`, `recall`, `notify_parent` | Code changes, file editing, running commands, build/test tasks |
| `planner` | `file_read`, `file_list`, `web_search`, `web_fetch`, `recall`, `notify_parent` | Analysis, planning, synthesizing information, reviewing approaches |

All specialized roles (`researcher`, `coder`, `planner`) include `notify_parent` for mid-run communication with the parent.

## Parent Communication

Subagents use `notify_parent` to send messages to the parent conversation while still running. Each notification has an urgency level:

- **`info`** -- Progress updates, minor findings. The parent is informed but does not need to act.
- **`important`** -- Key findings, significant results. The parent should review when convenient.
- **`blocked`** -- The subagent needs guidance or a decision from the parent to continue.

Use notifications judiciously -- one per major finding or milestone. Do not send a notification for every small step.

## Naming

Subagents can be referenced by label instead of UUID. The `label` parameter is accepted on `subagent_message`, `subagent_status`, `subagent_read`, and `subagent_abort` as an alternative to `subagent_id`. Label lookup is case-insensitive.

Use descriptive labels when spawning subagents (e.g., "research-auth-libraries", "implement-login-form") so they are easy to reference later.

## Reading Output

`subagent_read` returns the subagent's assistant text output. Use the `last_n` parameter to retrieve only the most recent N assistant messages instead of the full history. This is useful for large outputs where you only need the final result.

## Ownership

Only the parent conversation that spawned a subagent can interact with it (check status, send messages, abort, or read output).

## Silent Mode

Set `send_result_to_user: false` when spawning a subagent whose result is for internal processing only. The parent will still be notified on completion, but the notification will instruct it to read the result without presenting it to the user.

## Tips

- Do NOT poll `subagent_status` in a loop. You will be notified automatically when a subagent completes.
- Use roles to scope tool access and minimize blast radius. Default to the most restrictive role that works.
- Spawn a `researcher` and `coder` in parallel for research-then-implement workflows -- the researcher gathers context while the coder starts on the known parts.
- Use `notify_parent` for interim findings instead of waiting for completion. This lets the parent act on partial results early.
- Use `subagent_message` to send follow-up instructions to a running subagent.
- Use `subagent_abort` to cancel a subagent that is no longer needed.
