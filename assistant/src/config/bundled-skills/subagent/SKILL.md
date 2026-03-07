---
name: subagent
description: Spawn and manage autonomous background agents for parallel work
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🤖","vellum":{"display-name":"Subagent"}}
---

Subagent orchestration -- spawn background agents to work on tasks in parallel.

## Lifecycle

Subagents follow this status flow: `pending` -> `running` -> `completed` / `failed` / `aborted`

- **Spawn**: Use `subagent_spawn` with a label and objective. The subagent runs autonomously.
- **Auto-notification**: The parent session is automatically notified when a subagent reaches a terminal status. Do NOT poll `subagent_status`.
- **Read output**: Use `subagent_read` only after the subagent reaches a terminal status (completed/failed/aborted).

## Ownership

Only the parent session that spawned a subagent can interact with it (check status, send messages, abort, or read output).

## Silent Mode

Set `send_result_to_user: false` when spawning a subagent whose result is for internal processing only. The parent will still be notified on completion, but the notification will instruct it to read the result without presenting it to the user.

## Tips

- Do NOT poll `subagent_status` in a loop. You will be notified automatically when a subagent completes.
- Use `subagent_message` to send follow-up instructions to a running subagent.
- Use `subagent_abort` to cancel a subagent that is no longer needed.
